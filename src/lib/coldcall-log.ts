// =============================================================
// The ONE call-logging path for the coldcall module.
//
// Both surfaces write attempts through here — the caller worklist
// (POST /api/coldcall/leads/:id/log) and the admin lead modal
// (POST /api/admin/coldcall-leads/:id/log). A second implementation would
// drift, and the thing that would drift is the ordering guarantee below.
//
// ORDER MATTERS: the activity row is inserted FIRST, then the lead is
// patched. If the patch fails we still hold the record that the call
// happened, which is the append-only half of the contract. Never reorder
// these, and never make the insert conditional on the patch succeeding.
//
// Activity rows are never updated or deleted by this module.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const CALL_OUTCOMES = [
  "no_answer",
  "voicemail_left",
  "gatekeeper",
  "not_interested",
  "interested_followup",
  "meeting_booked",
  "wrong_number",
  "do_not_call",
  // Added 2026-09-01. All callback-shaped (STATUS_FOR_OUTCOME → 'callback').
  // interested_followup_req is deliberately distinct from interested_followup
  // ("Callback booked"): the softer "interested, no firm time" case.
  "interested_followup_req",
  "will_call_back",
  "call_back_tomorrow",
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "callback",
  "meeting",
  "not_interested",
  "bad_number",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Where a lead sits after a given attempt.
 *
 * outcome and status are deliberately different vocabularies (see migration
 * 115): outcome is what happened on ONE call, status is where the lead sits
 * now. This map is the sanctioned translation between them, so a caller picks
 * one thing and both columns stay coherent.
 *
 * It is a DEFAULT, not a rule — the caller can override the status, because
 * "no answer, but the receptionist said call Tuesday" is a callback even
 * though the outcome was no_answer.
 */
export const STATUS_FOR_OUTCOME: Record<CallOutcome, LeadStatus> = {
  no_answer: "contacted",
  voicemail_left: "contacted",
  gatekeeper: "contacted",
  interested_followup: "callback",
  meeting_booked: "meeting",
  not_interested: "not_interested",
  do_not_call: "not_interested",
  wrong_number: "bad_number",
  interested_followup_req: "callback",
  will_call_back: "callback",
  call_back_tomorrow: "callback",
};

/**
 * Outcomes that seed a followup date when the caller didn't set one.
 * "Call back tomorrow" means exactly that — a followup ~24h out — so the lead
 * lands in the followups-due list without the caller re-typing a date. Any
 * explicit followup_at the caller passes still wins (see logCallAttempt).
 */
export const AUTO_FOLLOWUP_OUTCOMES: Partial<Record<CallOutcome, () => string>> = {
  call_back_tomorrow: () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

export interface LogAttemptInput {
  leadId: string;
  /** Whose call this was. Always a real coldcall_callers row. */
  callerId: string;
  outcome: CallOutcome;
  note?: string | null;
  /** Only written when supplied — undefined leaves the lead's status alone. */
  status?: LeadStatus;
  /** undefined leaves any scheduled callback alone; null clears it. */
  followupAt?: string | null;
  /**
   * Who typed it, when that differs from callerId (an admin logging on
   * someone's behalf). Leave undefined when the caller logged their own call —
   * NULL there reads correctly as "the caller entered this".
   */
  loggedByUserId?: string | null;
  /** Columns to return from the updated lead row. */
  leadCols: string;
}

export type LogAttemptResult =
  | { ok: true; activity: Record<string, unknown>; lead: Record<string, unknown> }
  | { ok: false; stage: "activity" | "lead"; message: string; activityId?: string };

export async function logCallAttempt(
  supabase: SupabaseClient,
  input: LogAttemptInput,
): Promise<LogAttemptResult> {
  const {
    leadId, callerId, outcome, note, status, followupAt, loggedByUserId, leadCols,
  } = input;

  // 1. History first.
  const row: Record<string, unknown> = {
    lead_id: leadId,
    caller_id: callerId,
    outcome,
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  };
  // Only set when someone other than the caller typed it, so the common case
  // stays NULL rather than redundantly repeating the caller's own user id.
  if (loggedByUserId) row.logged_by_user_id = loggedByUserId;

  const { data: activity, error: actErr } = await supabase
    .from("coldcall_call_activity")
    .insert(row)
    .select("id, outcome, note, created_at, caller_id, logged_by_user_id")
    .single();

  if (actErr || !activity) {
    return { ok: false, stage: "activity", message: actErr?.message ?? "insert returned no row" };
  }

  // 2. Then advance the lead. last_touched_at always moves; the other two are
  // only touched when the caller actually supplied them.
  const patch: Record<string, unknown> = { last_touched_at: new Date().toISOString() };
  if (typeof status === "string") patch.status = status;
  // An explicit followup_at (string or null) always wins. Only when the caller
  // left it undefined does an auto-followup outcome (e.g. "call back tomorrow")
  // seed a date.
  let effectiveFollowup = followupAt;
  if (effectiveFollowup === undefined) {
    const seed = AUTO_FOLLOWUP_OUTCOMES[outcome];
    if (seed) effectiveFollowup = seed();
  }
  if (effectiveFollowup !== undefined) patch.followup_at = effectiveFollowup;

  const { data: lead, error: updErr } = await supabase
    .from("coldcall_leads")
    .update(patch)
    .eq("id", leadId)
    .select(leadCols)
    .single();

  if (updErr || !lead) {
    return {
      ok: false,
      stage: "lead",
      message: updErr?.message ?? "update returned no row",
      activityId: (activity as { id: string }).id,
    };
  }

  return {
    ok: true,
    activity: activity as Record<string, unknown>,
    lead: lead as unknown as Record<string, unknown>,
  };
}

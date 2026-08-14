// =============================================================
// Coldcall — the internal cold-calling tool's caller-facing API.
// Mounted at /api/coldcall. Every route is gated by requireAuth +
// requireColdcaller (membership in coldcall_callers IS the role).
//
//   GET  /api/coldcall/me                caller identity for the page header
//   GET  /api/coldcall/worklist          assigned leads, call_score desc
//   GET  /api/coldcall/followups         assigned leads with followup_at <= now
//   GET  /api/coldcall/leads/:id         full detail + call_activity history
//   POST /api/coldcall/leads/:id/log     append an attempt, advance the lead
//
// INTERNAL ONLY. This module imports nothing from business route or task code
// — only shared low-level utils (jwt, coldcall-auth, supabase, errors,
// logger). It must stay that way: it is walled off from all client-facing
// query paths on purpose. No LLM calls anywhere in this module.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireColdcaller } from "../lib/coldcall-auth";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);
app.use("*", requireColdcaller);

// Columns the worklist table renders. rating stays NULL when there are no
// reviews — the frontend renders that as "no reviews", never as 0.
const LEAD_LIST_COLS =
  "id, name, phone, category, parish, market, rating, review_count, " +
  "call_score, status, followup_at, last_touched_at";

const LEAD_DETAIL_COLS =
  "id, place_id, name, phone, address, address_flag, category, category_raw, " +
  "parish, market, rating, review_count, call_score, adoption_mindset, " +
  "digital_gap, callable, opening_angle, assigned_to, status, followup_at, " +
  "last_touched_at, created_at, updated_at";

const LEAD_STATUSES = [
  "new",
  "contacted",
  "callback",
  "meeting",
  "not_interested",
  "bad_number",
] as const;

const CALL_OUTCOMES = [
  "no_answer",
  "voicemail_left",
  "gatekeeper",
  "not_interested",
  "interested_followup",
  "meeting_booked",
  "wrong_number",
  "do_not_call",
] as const;

// ── GET /api/coldcall/me ───────────────────────────────────────────────────
// Identity for the page header. Reaching this at all proves the gate passed.
app.get("/me", (c) => {
  const caller = c.get("coldcaller");
  return c.json({ caller });
});

// ── GET /api/coldcall/worklist ─────────────────────────────────────────────
// The caller's own assigned leads, best call_score first. Callable-only by
// default. Filters: parish, market, category, status.
app.get("/worklist", async (c) => {
  const caller = c.get("coldcaller");
  const supabase = createSupabaseClient(c.env);

  const parish = c.req.query("parish");
  const market = c.req.query("market");
  const category = c.req.query("category");
  const status = c.req.query("status");
  // Escape hatch for reviewing leads that were marked un-callable.
  const includeUncallable = c.req.query("callable") === "all";

  if (status && !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
    return c.json(errBody("bad_request", `unknown status '${status}'`), 400);
  }

  let q = supabase
    .from("coldcall_leads")
    .select(LEAD_LIST_COLS)
    .eq("assigned_to", caller.id)
    .order("call_score", { ascending: false })
    .limit(500);

  if (!includeUncallable) q = q.eq("callable", true);
  if (parish) q = q.eq("parish", parish);
  if (market) q = q.eq("market", market);
  if (category) q = q.eq("category", category);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    log.error("[coldcall] worklist_failed", { caller_id: caller.id, err: error.message });
    return c.json(errBody("internal", "worklist_failed"), 500);
  }

  // Status counts across the caller's whole callable book — powers the header
  // chips without a second round trip from the page.
  const { data: allRows, error: countErr } = await supabase
    .from("coldcall_leads")
    .select("status")
    .eq("assigned_to", caller.id)
    .eq("callable", true);
  if (countErr) {
    log.error("[coldcall] worklist_counts_failed", { caller_id: caller.id, err: countErr.message });
    return c.json(errBody("internal", "worklist_counts_failed"), 500);
  }
  const counts: Record<string, number> = {};
  for (const r of (allRows ?? []) as Array<{ status: string }>) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  return c.json({ leads: data ?? [], counts, total: (allRows ?? []).length });
});

// ── GET /api/coldcall/followups ────────────────────────────────────────────
// The caller's leads that are due for a callback now (followup_at <= now).
app.get("/followups", async (c) => {
  const caller = c.get("coldcaller");
  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select(LEAD_LIST_COLS)
    .eq("assigned_to", caller.id)
    .not("followup_at", "is", null)
    .lte("followup_at", new Date().toISOString())
    .order("followup_at", { ascending: true })
    .limit(500);

  if (error) {
    log.error("[coldcall] followups_failed", { caller_id: caller.id, err: error.message });
    return c.json(errBody("internal", "followups_failed"), 500);
  }
  return c.json({ leads: data ?? [] });
});

// ── GET /api/coldcall/leads/:id ────────────────────────────────────────────
// Full lead detail plus its complete attempt history.
app.get("/leads/:id", async (c) => {
  const caller = c.get("coldcaller");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const { data: lead, error } = await supabase
    .from("coldcall_leads")
    .select(LEAD_DETAIL_COLS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    log.error("[coldcall] lead_detail_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "lead_detail_failed"), 500);
  }
  if (!lead) return c.json(errBody("not_found", "lead not found"), 404);

  // History is shown with the caller's name resolved, so a shared lead reads
  // as "who called this before me" rather than a bare uuid.
  const { data: activity, error: actErr } = await supabase
    .from("coldcall_call_activity")
    .select("id, outcome, note, created_at, caller_id, coldcall_callers(name, email)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (actErr) {
    log.error("[coldcall] lead_activity_failed", { lead_id: id, err: actErr.message });
    return c.json(errBody("internal", "lead_activity_failed"), 500);
  }

  return c.json({
    lead,
    // Informational only — the caller can still open and log against a lead
    // that is not theirs (a small team shares one book); the page uses this
    // to show a "assigned to someone else" note.
    is_mine:
      (lead as unknown as { assigned_to: string | null }).assigned_to === caller.id,
    activity: activity ?? [],
    // Vocabularies come from here so the page never hardcodes them.
    outcomes: CALL_OUTCOMES,
    statuses: LEAD_STATUSES,
  });
});

// ── POST /api/coldcall/leads/:id/log ───────────────────────────────────────
// Append one attempt to the append-only history AND advance the lead.
// Activity rows are never updated or overwritten.
app.post("/leads/:id/log", async (c) => {
  const caller = c.get("coldcaller");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: {
    outcome?: unknown;
    note?: unknown;
    status?: unknown;
    followup_at?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  // No-fallbacks: outcome is load-bearing (it IS the history record). A
  // missing or unknown value halts loudly rather than defaulting.
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !CALL_OUTCOMES.includes(outcome as (typeof CALL_OUTCOMES)[number])) {
    return c.json(
      errBody("bad_request", `outcome must be one of: ${CALL_OUTCOMES.join(", ")}`),
      400,
    );
  }

  const status = body.status;
  if (status !== undefined && status !== null) {
    if (typeof status !== "string" || !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
      return c.json(
        errBody("bad_request", `status must be one of: ${LEAD_STATUSES.join(", ")}`),
        400,
      );
    }
  }

  const followupAt = body.followup_at;
  if (followupAt !== undefined && followupAt !== null) {
    if (typeof followupAt !== "string" || Number.isNaN(Date.parse(followupAt))) {
      return c.json(errBody("bad_request", "followup_at must be an ISO timestamp or null"), 400);
    }
  }

  const note = body.note;
  if (note !== undefined && note !== null && typeof note !== "string") {
    return c.json(errBody("bad_request", "note must be a string"), 400);
  }

  // The lead must exist before we write history against it.
  const { data: lead, error: leadErr } = await supabase
    .from("coldcall_leads")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    log.error("[coldcall] log_lead_lookup_failed", { lead_id: id, err: leadErr.message });
    return c.json(errBody("internal", "log_lead_lookup_failed"), 500);
  }
  if (!lead) return c.json(errBody("not_found", "lead not found"), 404);

  // History first — if the lead update fails we still have the record of the
  // attempt, which is the append-only half of the contract.
  const { data: actRow, error: actErr } = await supabase
    .from("coldcall_call_activity")
    .insert({
      lead_id: id,
      caller_id: caller.id,
      outcome,
      note: typeof note === "string" && note.trim() ? note.trim() : null,
    })
    .select("id, outcome, note, created_at")
    .single();

  if (actErr || !actRow) {
    log.error("[coldcall] activity_insert_failed", { lead_id: id, err: actErr?.message });
    return c.json(errBody("internal", "activity_insert_failed"), 500);
  }

  // Then advance the lead. status and followup_at are only touched when the
  // caller actually supplied them; last_touched_at always moves.
  const patch: Record<string, unknown> = {
    last_touched_at: new Date().toISOString(),
  };
  if (typeof status === "string") patch.status = status;
  // An explicit null clears a scheduled callback; undefined leaves it alone.
  if (followupAt !== undefined) patch.followup_at = followupAt;

  const { data: updated, error: updErr } = await supabase
    .from("coldcall_leads")
    .update(patch)
    .eq("id", id)
    .select(LEAD_DETAIL_COLS)
    .single();

  if (updErr || !updated) {
    log.error("[coldcall] lead_update_failed", {
      lead_id: id,
      activity_id: (actRow as { id: string }).id,
      err: updErr?.message,
    });
    return c.json(errBody("internal", "lead_update_failed"), 500);
  }

  log.info("[coldcall] attempt_logged", {
    lead_id: id,
    caller_id: caller.id,
    outcome,
    status: typeof status === "string" ? status : null,
  });

  return c.json({ activity: actRow, lead: updated }, 201);
});

export default app;

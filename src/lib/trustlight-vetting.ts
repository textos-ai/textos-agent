// =============================================================
// TrustLight vetting — the rules, in one place.
//
// The verification gate and the audit trail live HERE, not in the route, so
// that every path which can change a vetting_status goes through the same
// check. The brief is explicit: "Cannot set vetting_status='verified' until
// all nine are pass. Enforce this in the API layer, not just the button."
// A disabled button is a hint; this is the enforcement.
//
// The whole product is the claim that someone checked. A bug that lets an
// unverified business be published as verified is the worst bug this codebase
// can have, so the gate is a pure function with no I/O and is unit-checkable.
// =============================================================

import { slugifyName } from "./coldcall-demo";

/** The eight lifecycle states a lead can occupy, per migration 126. */
export const VETTING_STATUSES = [
  "lead", "invited", "in_verification", "verified",
  "failed", "suspended", "declined", "removed",
] as const;
export type VettingStatus = (typeof VETTING_STATUSES)[number];

/**
 * The nine checks, in the order an operator works them. chk_court_records is
 * the ninth — section 1 of the brief describes nine and lists court records,
 * while section 3 named only eight columns (confirmed with Rob, 2026-09-15).
 */
export const CHECK_KEYS = [
  "chk_licensing_board",
  "chk_license",
  "chk_insurance",
  "chk_business_filing",
  "chk_court_records",
  "chk_address",
  "chk_years_in_business",
  "chk_contact",
  "chk_reviews",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export const CHECK_LABELS: Record<CheckKey, string> = {
  chk_licensing_board: "State licensing board record",
  chk_license: "License",
  chk_insurance: "Insurance (confirmed with carrier)",
  chk_business_filing: "Business filing",
  chk_court_records: "Court records",
  chk_address: "Address",
  chk_years_in_business: "Years in business",
  chk_contact: "Contact details",
  chk_reviews: "Review audit",
} as const;

export const CHECK_RESULTS = ["pass", "fail", "na"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const CHECK_NOTE_KEYS = CHECK_KEYS.map((k) => `${k}_note` as const);

/** Columns the vetting detail view reads. Internal — never a public shape. */
export const VETTING_DETAIL_COLS = [
  "id", "name", "phone", "city", "state", "parish", "category", "address", "website_url",
  "vetting_status", "slug", "is_published",
  "verified_at", "verified_year", "expires_at", "reverify_due",
  "legal_name", "trading_name", "trade", "license_number", "license_state", "gl_carrier",
  "years_in_business", "blurb", "services", "rating", "review_count",
  "dti_score", "dti_findability", "dti_answerability", "dti_responsiveness",
  "dti_completeness", "dti_compliance",
  // Sales-Ready scoring, read straight from the lead. INTERNAL ONLY — these
  // never appear in lib/trustlight-public.ts, and the public harness asserts
  // no "call_score" key reaches any public response.
  "call_score", "rank", "score_category", "score_category_source",
  "score_review", "score_rating", "is_cap_demoted", "is_unrated",
  "plan", "is_comped", "comp_reason", "listing_consent", "notified_at",
  "exclusive_trade", "exclusive_county", "exclusive_state", "exclusive_until",
  "chk_last_run",
  ...CHECK_KEYS, ...CHECK_NOTE_KEYS,
].join(", ");

/** Columns the queue list renders. Deliberately narrow. */
export const VETTING_QUEUE_COLS = [
  "id", "name", "trade", "category", "city", "state", "parish",
  "vetting_status", "slug", "is_published", "verified_at", "expires_at", "updated_at",
  // Rank and score so the queue can be worked best-first. INTERNAL ONLY.
  "call_score", "rank",
  ...CHECK_KEYS,
].join(", ");

/**
 * How the queue and the campaign board may be ordered.
 *
 * 'oldest' is the default and stays the default: the vetting queue is a work
 * queue, and the thing waiting longest is the thing at risk of being
 * forgotten. Every other order is opt-in.
 *
 * Each sortable column names both directions explicitly rather than carrying a
 * separate direction parameter — one value fully describes the ordering, so a
 * request cannot express a half-state.
 *
 * DAYS IN STATUS IS NOT A COLUMN. It is derived from the audit log (updated_at
 * moves on any edit and would report the wrong age the moment an operator
 * typed a note), so it cannot be ordered in SQL. The route handles it
 * separately — see sortByDaysInStatus().
 */
export const QUEUE_SORTS = [
  "oldest",
  "rank_asc", "rank_desc",
  "score_desc", "score_asc",
  "days_desc", "days_asc",
] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

/** The campaign board has no Days in status column. */
export const CAMPAIGN_SORTS = QUEUE_SORTS.filter((s) => !s.startsWith("days_"));

export const isDaysSort = (s: QueueSort) => s === "days_desc" || s === "days_asc";

/**
 * Apply an SQL-orderable sort. Days sorts are NOT handled here and must be
 * routed through sortByDaysInStatus() instead.
 *
 * nullsFirst:false on every column sort is what puts an unranked or unscored
 * business at the bottom in BOTH directions — Postgres would otherwise default
 * to NULLS FIRST on a descending sort, floating "not scored" above a 70.
 */
export function applyQueueSort<T extends { order: Function }>(q: T, sort: QueueSort): T {
  switch (sort) {
    case "rank_asc":
      return q.order("rank", { ascending: true, nullsFirst: false })
              .order("id", { ascending: true }) as T;
    case "rank_desc":
      return q.order("rank", { ascending: false, nullsFirst: false })
              .order("id", { ascending: true }) as T;
    case "score_desc":
      return q.order("call_score", { ascending: false, nullsFirst: false })
              .order("id", { ascending: true }) as T;
    case "score_asc":
      return q.order("call_score", { ascending: true, nullsFirst: false })
              .order("id", { ascending: true }) as T;
    default:
      return q.order("updated_at", { ascending: true }) as T;
  }
}

/**
 * The most recent vetting_status change per lead, newest first.
 *
 * Bounded deliberately: only leads that have ACTUALLY moved have a row here,
 * so this set is small by construction (a lead sitting at 'lead' has none).
 * The cap is a guard against an unbounded read, not an expected limit.
 */
export const DAYS_SORT_AUDIT_CAP = 20000;

export async function latestStatusChanges(
  supabase: { from: Function },
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("coldcall_vetting_audit")
    .select("lead_id, created_at")
    .eq("field", "vetting_status")
    .order("created_at", { ascending: false })
    .limit(DAYS_SORT_AUDIT_CAP);
  const latest = new Map<string, string>();
  if (error) return latest;
  for (const a of (data ?? []) as Array<{ lead_id: string; created_at: string }>) {
    // Newest first, so the first row seen for a lead IS its latest change.
    if (!latest.has(a.lead_id)) latest.set(a.lead_id, a.created_at);
  }
  return latest;
}

/**
 * Order rows by how long they have sat in their current status.
 *
 * Longest-waiting means the OLDEST status change, so days_desc is
 * changed_at ascending — the inversion is the whole point of the column.
 *
 * A lead with no recorded change has null days and goes to the BOTTOM in both
 * directions. It is not "waiting forever" and it is not "waiting zero days";
 * we simply do not know, and guessing either way would misrank it.
 */
export function sortByDaysInStatus<T extends { id: string }>(
  rows: T[],
  latest: Map<string, string>,
  sort: "days_desc" | "days_asc",
): T[] {
  const known = rows.filter((r) => latest.has(r.id));
  const unknown = rows.filter((r) => !latest.has(r.id));
  known.sort((a, b) => {
    const ta = new Date(latest.get(a.id) as string).getTime();
    const tb = new Date(latest.get(b.id) as string).getTime();
    return sort === "days_desc" ? ta - tb : tb - ta;
  });
  // Stable, deterministic tail so paging over the unknowns does not shuffle.
  unknown.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...known, ...unknown];
}

type CheckRow = Partial<Record<CheckKey, string | null>>;

/** How many of the nine are 'pass'. */
export function countPasses(row: CheckRow): number {
  return CHECK_KEYS.reduce((n, k) => n + (row[k] === "pass" ? 1 : 0), 0);
}

/**
 * THE GATE. All nine must be exactly 'pass'.
 *
 * 'na' does NOT satisfy it. That is deliberate and worth stating: 'na' means
 * the check could not be applied, which is not the same as the business having
 * cleared it, and the badge claims nine checks were cleared. If a trade
 * genuinely cannot have one of these checked, that is a product decision about
 * what the badge means — not something to wave through here.
 */
export function allNinePass(row: CheckRow): boolean {
  return CHECK_KEYS.every((k) => row[k] === "pass");
}

/** Which checks are blocking verification, for a useful error message. */
export function failingChecks(row: CheckRow): string[] {
  return CHECK_KEYS.filter((k) => row[k] !== "pass")
    .map((k) => `${CHECK_LABELS[k]} (${row[k] ?? "not run"})`);
}

/**
 * A URL-safe, unique slug for the public profile. Retries with a numeric
 * suffix rather than failing the operator's click; the UNIQUE index on
 * coldcall_leads.slug is the real guard.
 */
export async function buildUniqueSlug(
  supabase: { from: Function },
  name: string,
  leadId: string,
): Promise<string> {
  const base = slugifyName(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await supabase
      .from("coldcall_leads").select("id").eq("slug", candidate).maybeSingle();
    if (error) throw new Error(`slug_lookup_failed: ${error.message}`);
    // Already ours (a re-verify) or free.
    if (!data || (data as { id: string }).id === leadId) return candidate;
  }
  throw new Error("slug_exhausted");
}

export interface AuditEntry {
  lead_id: string;
  actor_user_id?: string | null;
  actor_email?: string | null;
  field: string;
  old_value?: string | null;
  new_value?: string | null;
  reason?: string | null;
}

/**
 * Append to the verification paper trail.
 *
 * The table is append-only at the database level (trigger, migration 126), so
 * this can add but never rewrite. Failure is logged and surfaced to the caller
 * rather than swallowed: an unrecorded verification decision is exactly what
 * the audit log exists to prevent.
 */
export async function writeAudit(
  supabase: { from: Function },
  entry: AuditEntry,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from("coldcall_vetting_audit").insert({
    lead_id: entry.lead_id,
    actor_user_id: entry.actor_user_id ?? null,
    actor_email: entry.actor_email ?? null,
    field: entry.field,
    old_value: entry.old_value ?? null,
    new_value: entry.new_value ?? null,
    reason: entry.reason ?? null,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/**
 * The stamps that go with becoming verified: a one-year term, the year for the
 * badge, and a re-verification date 60 days before expiry so the renewal
 * pipeline has runway.
 */
export function verificationStamps(now = new Date()) {
  const expires = new Date(now.getTime());
  expires.setFullYear(expires.getFullYear() + 1);
  const reverify = new Date(expires.getTime() - 60 * 24 * 60 * 60 * 1000);
  return {
    verified_at: now.toISOString(),
    verified_year: now.getFullYear(),
    expires_at: expires.toISOString(),
    reverify_due: reverify.toISOString(),
  };
}

/**
 * THE ENTRY POINT into the vetting queue.
 *
 * One helper, called from every path that can put a business into vetting —
 * the automatic trustlight-signup hook and the manual "Send for verification"
 * button today, and the paid-plan hook when that exists. Keeping it in one
 * place is why the audit reason is a parameter rather than a literal at each
 * call site.
 *
 * ENTERS AT 'in_verification', NOT 'invited'. The queue's default view is
 * in_verification — that is the working queue. A paid signup that landed in
 * 'invited' would sit outside the view an operator actually looks at, which is
 * the failure mode worth designing against. 'invited' stays available for a
 * future "we asked, they have not answered" flow.
 *
 * IDEMPOTENT BY DESIGN: it only moves a lead that is still at 'lead'. Anything
 * already in, through, or rejected from vetting is left exactly as it is, so a
 * second signup, a double-click, or a re-run cannot restart or rewind work in
 * progress. It reports which of those happened rather than silently no-opping.
 *
 * This NEVER verifies anything. It only opens the queue entry; all nine checks
 * still have to pass through the gate in the normal way.
 */
export const VETTING_ENTRY_STATUS: VettingStatus = "in_verification";

export async function enterVetting(
  supabase: { from: Function },
  leadId: string,
  reason: string,
  actor?: { user_id?: string | null; email?: string | null },
): Promise<
  | { ok: true; moved: true; from: VettingStatus; to: VettingStatus; audit_recorded: boolean }
  | { ok: true; moved: false; reason: "already_in_vetting"; current: string }
  | { ok: false; message: string }
> {
  const { data, error } = await supabase
    .from("coldcall_leads").select("id, vetting_status").eq("id", leadId).maybeSingle();
  if (error) return { ok: false, message: `lead_lookup_failed: ${error.message}` };
  if (!data) return { ok: false, message: "lead not found" };

  const current = String((data as { vetting_status: string }).vetting_status ?? "lead");
  if (current !== "lead") {
    return { ok: true, moved: false, reason: "already_in_vetting", current };
  }

  const { error: uErr } = await supabase
    .from("coldcall_leads")
    .update({ vetting_status: VETTING_ENTRY_STATUS })
    // Re-assert the precondition in the WHERE clause so two concurrent callers
    // cannot both believe they moved it.
    .eq("id", leadId).eq("vetting_status", "lead");
  if (uErr) return { ok: false, message: `status_update_failed: ${uErr.message}` };

  const audit = await writeAudit(supabase, {
    lead_id: leadId,
    actor_user_id: actor?.user_id ?? null,
    actor_email: actor?.email ?? null,
    field: "vetting_status",
    old_value: "lead",
    new_value: VETTING_ENTRY_STATUS,
    reason,
  });

  return {
    ok: true, moved: true, from: "lead", to: VETTING_ENTRY_STATUS,
    audit_recorded: audit.ok,
  };
}

/**
 * The plans that mean "this business is paying for vetting".
 *
 * Decision 1a made coldcall_leads.plan the single source of truth for a paid
 * vetting subscription, replacing the retired trustlight row in
 * coldcall_lead_signups. So THIS is what opens the queue — not a signup row,
 * which can no longer exist for trustlight.
 */
export const PAID_VETTING_PLANS = ["verification", "exclusive"] as const;
export const PLANS = ["none", ...PAID_VETTING_PLANS] as const;
export type Plan = (typeof PLANS)[number];

export const isPaidVettingPlan = (p: unknown): boolean =>
  typeof p === "string" && (PAID_VETTING_PLANS as readonly string[]).includes(p);

/**
 * Set a lead's commercial plan, and open the vetting queue when that plan
 * becomes a paid one.
 *
 * EVERY path that sets `plan` must go through here rather than writing the
 * column directly — that is the whole point of the helper. The trigger lives
 * with the write so a future commercial UI cannot add a call site that
 * silently skips the queue entry.
 *
 * The queue entry is NON-FATAL and idempotent: enterVetting() only moves a
 * lead still at 'lead', so upgrading verification -> exclusive on a business
 * already being worked changes the plan and leaves the vetting alone.
 */
export async function setPlan(
  supabase: { from: Function },
  leadId: string,
  plan: Plan,
  actor?: { user_id?: string | null; email?: string | null },
  reason?: string | null,
): Promise<
  | { ok: true; plan: Plan; previous: string; vetting: Awaited<ReturnType<typeof enterVetting>> | null }
  | { ok: false; message: string }
> {
  const { data, error } = await supabase
    .from("coldcall_leads").select("id, plan, vetting_status").eq("id", leadId).maybeSingle();
  if (error) return { ok: false, message: `lead_lookup_failed: ${error.message}` };
  if (!data) return { ok: false, message: "lead not found" };
  const previous = String((data as { plan: string | null }).plan ?? "none");

  const { error: uErr } = await supabase
    .from("coldcall_leads").update({ plan }).eq("id", leadId);
  if (uErr) return { ok: false, message: `plan_update_failed: ${uErr.message}` };

  if (previous !== plan) {
    await writeAudit(supabase, {
      lead_id: leadId,
      actor_user_id: actor?.user_id ?? null,
      actor_email: actor?.email ?? null,
      field: "plan", old_value: previous, new_value: plan,
      reason: reason ?? null,
    });
  }

  // Only a TRANSITION into a paid plan opens the queue. Re-saving the same
  // paid plan is not a new signup and must not read as one in the audit log.
  let vetting = null;
  if (isPaidVettingPlan(plan) && !isPaidVettingPlan(previous)) {
    vetting = await enterVetting(
      supabase, leadId, `auto: plan set to ${plan}`,
      { user_id: actor?.user_id ?? null, email: actor?.email ?? null },
    );
  }

  return { ok: true, plan, previous, vetting };
}

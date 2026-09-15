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
  "plan", "is_comped", "comp_reason", "listing_consent", "notified_at",
  "exclusive_trade", "exclusive_county", "exclusive_state", "exclusive_until",
  "chk_last_run",
  ...CHECK_KEYS, ...CHECK_NOTE_KEYS,
].join(", ");

/** Columns the queue list renders. Deliberately narrow. */
export const VETTING_QUEUE_COLS = [
  "id", "name", "trade", "category", "city", "state", "parish",
  "vetting_status", "slug", "is_published", "verified_at", "expires_at", "updated_at",
  ...CHECK_KEYS,
].join(", ");

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

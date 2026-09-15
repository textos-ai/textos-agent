// =============================================================
// TrustLight — the PUBLIC shape, in one place.
//
// Extracted from routes/trustlight.ts so the admin profile editor's preview
// and the live public API are literally the same code. The brief asks for a
// preview "showing exactly what the public API will return ... so there is
// never a surprise about what got published" — a second implementation would
// drift from the first, and the drift would only show up as a business
// discovering its own listing says something unexpected.
//
// Everything a prospect can see is decided here. There is no select("*") and
// no spread of a database row into JSON: each public field is named twice, on
// the column whitelist and in the projection, so adding a column to
// coldcall_leads cannot silently widen a public response.
// =============================================================

/** The ONLY columns readable for a directory card. */
export const VERIFIED_COLS =
  "slug, legal_name, trading_name, name, trade, city, state, parish, " +
  "rating, review_count, dti_score, blurb, verified_year, plan, exclusive_until";

/** The ONLY columns readable for a full public profile. */
export const PROFILE_COLS =
  VERIFIED_COLS + ", services, years_in_business, license_state, verified_at, expires_at, " +
  "dti_findability, dti_answerability, dti_responsiveness, dti_completeness, dti_compliance, " +
  "chk_licensing_board, chk_license, chk_insurance, chk_business_filing, chk_court_records, " +
  "chk_address, chk_years_in_business, chk_contact, chk_reviews";

/**
 * Unvetted rows expose FOUR fields and nothing else. Note `category`, not
 * `trade`: an unvetted business has no curated trade, so the scraped Google
 * category is shown — a neutral descriptor, not a judgement.
 */
export const UNVETTED_COLS = "name, category, city, state";

export type VerifiedRow = {
  slug: string | null; legal_name: string | null; trading_name: string | null; name: string | null;
  trade: string | null; city: string | null; state: string | null; parish: string | null;
  rating: number | null; review_count: number | null; dti_score: number | null;
  blurb: string | null; verified_year: number | null;
  plan: string | null; exclusive_until: string | null;
};

/** Public display name: the curated names win; the scraped one is the last resort. */
export const displayName = (r: VerifiedRow) => r.trading_name || r.legal_name || r.name || "";

export const isExclusive = (r: VerifiedRow) =>
  r.plan === "exclusive" && !!r.exclusive_until && new Date(r.exclusive_until) > new Date();

/** Title-case a scraped category ("general contractor" -> "General Contractor"). */
export const titleCase = (s: string | null) =>
  (s ?? "").split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

/**
 * The 12-field directory card. EXPLICIT field by field — never a spread.
 * Identical on /featured and /search, so the site renders one card.
 */
export function shapeVerified(r: VerifiedRow) {
  return {
    slug: r.slug,
    name: displayName(r),
    trade: r.trade,
    city: r.city,
    state: r.state,
    county: r.parish,
    rating: r.rating,
    reviews: r.review_count,
    dti: r.dti_score,
    blurb: r.blurb,
    verified_year: r.verified_year,
    exclusive: isExclusive(r),
  };
}

/** The four neutral fields of an unvetted entry, built explicitly. */
export function shapeUnvetted(r: { name: string | null; category: string | null; city: string | null; state: string | null }) {
  return { name: r.name, trade: titleCase(r.category), city: r.city, state: r.state };
}

/**
 * The public-facing labels for the nine checks. Deliberately separate from the
 * admin's CHECK_LABELS in lib/trustlight-vetting.ts: these are claims shown to
 * the public and are worded as such, and changing an internal label must not
 * silently reword a public claim.
 */
export const PUBLIC_CHECK_LABELS: Record<string, string> = {
  chk_licensing_board: "State licensing board record",
  chk_license: "License verified",
  chk_insurance: "Insurance confirmed with carrier",
  chk_business_filing: "Business filing confirmed",
  chk_court_records: "Court records reviewed",
  chk_address: "Address confirmed",
  chk_years_in_business: "Years in business confirmed",
  chk_contact: "Contact details confirmed",
  chk_reviews: "Review audit completed",
};

export type ProfileRow = VerifiedRow & {
  services: string[] | null; years_in_business: number | null; license_state: string | null;
  verified_at: string | null; expires_at: string | null;
  dti_findability: number | null; dti_answerability: number | null;
  dti_responsiveness: number | null; dti_completeness: number | null; dti_compliance: number | null;
  [k: string]: unknown;
};

/**
 * The full public profile.
 *
 * `checks_passed` lists ONLY checks that passed, never the notes, and never
 * anything about a check that did not — a 'fail' or 'na' is simply absent, so
 * the response cannot be read as an accusation against the business.
 */
export function shapeProfile(r: ProfileRow) {
  const passed = Object.keys(PUBLIC_CHECK_LABELS)
    .filter((k) => r[k] === "pass")
    .map((k) => PUBLIC_CHECK_LABELS[k]);
  return {
    ...shapeVerified(r),
    services: Array.isArray(r.services) ? r.services : [],
    years_in_business: r.years_in_business,
    license_state: r.license_state,
    dti_pillars: {
      findability: r.dti_findability,
      answerability: r.dti_answerability,
      responsiveness: r.dti_responsiveness,
      completeness: r.dti_completeness,
      compliance: r.dti_compliance,
    },
    verification: {
      verified_at: r.verified_at,
      expires_at: r.expires_at,
      checks_passed: passed,
      checks_total: Object.keys(PUBLIC_CHECK_LABELS).length,
    },
  };
}

/**
 * The three conditions that make a row publishable, applied identically
 * everywhere. One function so a future endpoint cannot forget one.
 */
export function publishable<T extends { eq: Function; gt: Function }>(q: T, nowIso: string): T {
  return q.eq("vetting_status", "verified").eq("is_published", true).gt("expires_at", nowIso) as T;
}

/**
 * The same three conditions, evaluated against a row rather than a query — so
 * the admin preview can say WHY a record is not public instead of just showing
 * an empty result. Returns every blocker, not the first, because an operator
 * fixing one at a time is worse than being told all of them.
 */
export function visibilityOf(
  row: { vetting_status?: unknown; is_published?: unknown; expires_at?: unknown; slug?: unknown },
  now = new Date(),
): { visible: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (row.vetting_status !== "verified") {
    blockers.push(`Not verified — status is '${String(row.vetting_status ?? "lead")}'.`);
  }
  if (row.is_published !== true) blockers.push("Not published — the publish toggle is off.");
  if (!row.expires_at) {
    blockers.push("No expiry date — verification has not been stamped.");
  } else if (new Date(String(row.expires_at)) <= now) {
    blockers.push("Verification has expired.");
  }
  if (!row.slug) blockers.push("No slug — there is no public URL yet.");
  return { visible: blockers.length === 0, blockers };
}

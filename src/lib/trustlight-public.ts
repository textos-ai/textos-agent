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

/**
 * Contact columns, readable ONLY on the profile endpoint.
 *
 * Deliberately NOT part of VERIFIED_COLS. A directory card is a preview and
 * /search returns up to 75 of them per request across ~15,800 rows; putting a
 * phone number on a card would turn the directory into a bulk-harvestable
 * phone list behind a rate limit that fails open. The profile needs a slug you
 * already hold and returns one record, so contact details live here and only
 * here. See the note on shapeProfile().
 *
 * `phone` is the DISPLAY format. `phone_e164_digits` is the match key used to
 * dedupe applications against existing leads and is absent from every public
 * response, on purpose — it is not listed on any whitelist in this file.
 */
export const PROFILE_CONTACT_COLS = "phone, website_url, address, zip, google_profile_url";

/** The ONLY columns readable for a full public profile. */
export const PROFILE_COLS =
  VERIFIED_COLS + ", " + PROFILE_CONTACT_COLS +
  ", services, years_in_business, license_state, verified_at, expires_at, " +
  "dti_findability, dti_answerability, dti_responsiveness, dti_completeness, dti_compliance, " +
  "chk_licensing_board, chk_license, chk_insurance, chk_business_filing, chk_court_records, " +
  "chk_address, chk_years_in_business, chk_contact, chk_reviews";

/**
 * ── WHAT THIS DIRECTORY IS FOR ────────────────────────────────────────────
 *
 * coldcall_leads holds 15,822 scraped businesses across 54 Google categories,
 * and only 4,151 of them are home-repair trades. The rest are dentists,
 * barber shops, lawyers, restaurants, gyms and car washes — 1,242 auto repair
 * shops alone.
 *
 * Every one of those was appearing in the public directory under "Not yet
 * verified", on a page that tells storm survivors these are contractors. A
 * family looking for a roofer paged through nail salons. That is not a thin
 * directory, it is a wrong one, and it undermines the premise of the site.
 *
 * So the unvetted tier is restricted to these categories. Deliberately NOT
 * applied to the verified tier: `trade` there is a curated value an operator
 * typed ("Roofing", "Foundation Repair"), not a scraped one, and an exact
 * `in` match against this lowercase list would silently drop a business we
 * verified on purpose. Verification is the editorial decision; this list only
 * governs which unchecked businesses we surface.
 *
 * Values are the scraped `category` vocabulary exactly as stored — lowercase,
 * no variants. Confirmed against all 15,822 rows: 54 distinct categories,
 * zero differing only by case.
 */
export const HOME_TRADE_CATEGORIES = [
  "general contractor",
  "roofing contractor",
  "plumber",
  "electrician",
  "hvac contractor",
  "painter",
  "landscaper",
  "tree service",
  "gutter service",
  "fence contractor",
  "foundation repair",
  "garage door repair",
  "pest control",
  "pressure washing",
  "locksmith",
  "moving company",
] as const;

/**
 * What a family types, mapped to what we actually store.
 *
 * The filter is a case-insensitive EQUALS, not a contains, so `roofer`
 * matched nothing at all: the stored category is `roofing contractor`.
 * `electrician` and `plumber` happened to work by luck, and nothing else a
 * person types under stress did.
 *
 * Keys are lowercase. Values are members of HOME_TRADE_CATEGORIES. An input
 * that is not a key is passed through untouched, so typing the stored value
 * exactly still works and a new category needs no code change to be findable.
 *
 * KNOWN GAP, worth closing at the source: the curated `trade` column on a
 * verified record is free text an operator typed, so it can read "Plumbing"
 * where the scraped vocabulary says "plumber". The search route works around
 * that by matching a verified row against BOTH the canonical form and the raw
 * input. The real fix is to constrain the admin profile editor's `trade` field
 * to HOME_TRADE_CATEGORIES so the two vocabularies cannot drift apart.
 */
export const TRADE_SYNONYMS: Record<string, string> = {
  // Roofing
  "roofer": "roofing contractor",
  "roofers": "roofing contractor",
  "roofing": "roofing contractor",
  "roof": "roofing contractor",
  "roof repair": "roofing contractor",
  "roof replacement": "roofing contractor",
  // Plumbing
  "plumbing": "plumber",
  "plumbers": "plumber",
  "pipes": "plumber",
  // Electrical
  "electrical": "electrician",
  "electric": "electrician",
  "electricians": "electrician",
  // HVAC. "ac" is the single most likely thing typed in a Gulf Coast summer.
  "hvac": "hvac contractor",
  "ac": "hvac contractor",
  "a/c": "hvac contractor",
  "air conditioning": "hvac contractor",
  "air conditioner": "hvac contractor",
  "aircon": "hvac contractor",
  "heating": "hvac contractor",
  "heat": "hvac contractor",
  "furnace": "hvac contractor",
  "cooling": "hvac contractor",
  // General building
  "contractor": "general contractor",
  "general": "general contractor",
  "builder": "general contractor",
  "construction": "general contractor",
  "remodeling": "general contractor",
  "remodeler": "general contractor",
  "renovation": "general contractor",
  "handyman": "general contractor",
  // Painting
  "painting": "painter",
  "painters": "painter",
  // Yard
  "landscaping": "landscaper",
  "landscapers": "landscaper",
  "lawn": "landscaper",
  "lawn care": "landscaper",
  "yard": "landscaper",
  // Trees
  "tree": "tree service",
  "tree removal": "tree service",
  "tree trimming": "tree service",
  "arborist": "tree service",
  "stump removal": "tree service",
  // Gutters
  "gutter": "gutter service",
  "gutters": "gutter service",
  "gutter repair": "gutter service",
  // Fencing
  "fence": "fence contractor",
  "fencing": "fence contractor",
  "fences": "fence contractor",
  // Foundations
  "foundation": "foundation repair",
  "foundations": "foundation repair",
  "slab": "foundation repair",
  "house leveling": "foundation repair",
  "piers": "foundation repair",
  // Garage doors
  "garage": "garage door repair",
  "garage door": "garage door repair",
  "garage doors": "garage door repair",
  // Pest
  "pest": "pest control",
  "exterminator": "pest control",
  "termite": "pest control",
  "termites": "pest control",
  // Washing
  "power washing": "pressure washing",
  "pressure wash": "pressure washing",
  "power wash": "pressure washing",
  "soft wash": "pressure washing",
  // Locks
  "locks": "locksmith",
  "locksmiths": "locksmith",
  "lockout": "locksmith",
  // Moving
  "mover": "moving company",
  "movers": "moving company",
  "moving": "moving company",
  "removals": "moving company",
};

/**
 * Resolve what someone typed to what we store. Unknown input is returned
 * trimmed and unchanged rather than rejected — an unmapped word should still
 * be allowed to match a stored value exactly.
 */
export function canonicalTrade(input: string | null | undefined): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  return TRADE_SYNONYMS[s.toLowerCase()] ?? s;
}

/**
 * The columns a public name search looks at, in the same order the public
 * display name resolves (trading_name || legal_name || name).
 *
 * Searching only trading_name meant a verified business whose card shows a
 * name drawn from legal_name could not be found by searching the name it
 * displays. What is searchable now matches what is shown.
 *
 * `clean()` at the call site has already stripped %, comma, parens and star,
 * which are the characters that would otherwise break PostgREST's or()
 * grammar, so the term can be interpolated safely.
 */
export const NAME_SEARCH_COLUMNS = ["trading_name", "legal_name", "name"] as const;

export const nameSearchOr = (term: string) =>
  NAME_SEARCH_COLUMNS.map((c) => `${c}.ilike.*${term}*`).join(",");

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
  // Was "Court records reviewed". The check is unchanged - public records
  // including court filings - but the profile page is the one place a
  // contractor reads about themselves, and "court" is the exact word stripped
  // from every other page. The fact survives; the accusation in the phrasing
  // does not. Matches the wording in privacy.html.
  chk_court_records: "Public business records reviewed",
  chk_address: "Address confirmed",
  chk_years_in_business: "Years in business confirmed",
  chk_contact: "Contact details confirmed",
  // Was "Review audit completed". "Audit" is on the same stripped list and was
  // replaced everywhere else with plain language.
  chk_reviews: "Reviews checked",
};

/**
 * Fields a directory card cannot be published without.
 *
 * A verified record missing one of these used to reach the public response
 * with a null in it — the live /featured grid was returning a card whose
 * trade was `null`. A half-built card under a trust badge is worse than no
 * card: it makes the badge look automated rather than checked.
 *
 * DELIBERATELY NOT INCLUDED: rating, review_count, dti_score and blurb. A
 * genuinely unrated business has rating NULL, and migration 115 is explicit
 * that NULL means "no reviews yet" and must never be shown as 0. Excluding
 * those businesses would punish new ones for being new.
 *
 * `name` is absent because it is resolved (trading_name || legal_name ||
 * name) and is guarded separately by the verification gate, which refuses to
 * verify a business with no name at all.
 */
export const REQUIRED_PUBLIC_FIELDS = ["slug", "trade", "city", "state"] as const;

/**
 * Apply the required-field conditions to a query. Paired with
 * missingPublicFields() below, which answers the same question about a row
 * so the admin preview can explain the exclusion instead of just showing
 * nothing.
 */
export function withRequiredFields<T extends { not: Function }>(q: T): T {
  let x = q as T & Record<string, Function>;
  for (const f of REQUIRED_PUBLIC_FIELDS) x = x.not(f, "is", null);
  return x as T;
}

/** Which required fields this row is missing. */
export function missingPublicFields(row: Record<string, unknown>): string[] {
  return REQUIRED_PUBLIC_FIELDS.filter((f) => {
    const v = row[f];
    return v === null || v === undefined || String(v).trim() === "";
  });
}

export type ProfileRow = VerifiedRow & {
  phone: string | null; website_url: string | null; address: string | null;
  zip: string | null; google_profile_url: string | null;
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
 *
 * ── THE CONTACT BLOCK ───────────────────────────────────────────────────
 * A homeowner who has found a verified contractor has to be able to reach
 * them, so the profile carries the business's own public contact path: the
 * phone, the website, the street address and the Google listing. All of it is
 * business information the business already publishes itself.
 *
 * WHAT STAYS INTERNAL, ON EVERY ENDPOINT INCLUDING THIS ONE:
 *   contact_email, contact_name  — the owner's personal details, given to us
 *                                  for verification. Publishing them puts a
 *                                  private inbox on the open web to be scraped.
 *                                  The phone and website ARE the contact path.
 *   license_number, gl_carrier   — given to us to check, not to broadcast.
 *   application_note, chk_* notes— ours.
 *   phone_e164_digits            — the match key, never the published value.
 *
 * None of those appear on any whitelist in this file, which is what keeps them
 * out: there is no select("*") and no row spread anywhere, so a field cannot
 * reach a response without being named here on purpose.
 */
export function shapeProfile(r: ProfileRow) {
  const passed = Object.keys(PUBLIC_CHECK_LABELS)
    .filter((k) => r[k] === "pass")
    .map((k) => PUBLIC_CHECK_LABELS[k]);
  return {
    ...shapeVerified(r),
    contact: {
      phone: r.phone,
      website: r.website_url,
      google_profile: r.google_profile_url,
      address: {
        street: r.address,
        city: r.city,
        state: r.state,
        zip: r.zip,
      },
    },
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
export function publishable<T extends { eq: Function; gt: Function; not: Function }>(q: T, nowIso: string): T {
  // The required-field exclusion is folded in HERE rather than chained at each
  // call site. Every public read already goes through publishable(), so this
  // is the one place that makes it impossible for a read to forget — which is
  // how a card with trade:null reached the live /featured grid.
  return withRequiredFields(
    q.eq("vetting_status", "verified").eq("is_published", true).gt("expires_at", nowIso) as T,
  );
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
  // Required-field exclusion (slug included) — the same rule the public
  // queries enforce, so the preview can never say "visible" about a record
  // the API would filter out.
  const missing = missingPublicFields(row as Record<string, unknown>);
  for (const f of missing) {
    blockers.push(f === "slug"
      ? "No slug — there is no public URL yet."
      : `Missing ${f} — a required field, so this record is excluded from the public directory.`);
  }
  return { visible: blockers.length === 0, blockers };
}

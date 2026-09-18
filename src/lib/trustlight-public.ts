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
  "rating, review_count, dti_score, blurb, verified_year, plan, exclusive_until, " +
  // How long they have been verified. Time on the directory is a trust signal
  // in its own right - somebody checked 400 days ago and still listed has been
  // through a re-check the newcomer has not.
  "verified_at, " +
  // Read to EXPLAIN a score, never published raw. A 0 with no reason beside it
  // reads as a verdict on the business; these turn it into a statement about a
  // website. See dtiZero().
  "enrichment_status, website_url, domain, site_state, " +
  // The seven signals, read to build the three meter segments. Published as
  // GROUPS with their constituent names, never as raw columns.
  "has_https, has_viewport, phone_listed, has_business_hours, " +
  "reviews_linked, has_faq_or_blog, service_area_count, has_schema_org, " +
  "booking_tool, chat_widget, call_tracking";

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
export const PROFILE_CONTACT_COLS =
  "phone, website_url, address, zip, google_profile_url, place_id";

/**
 * The public Google Maps URL for a place_id.
 *
 * WHY THIS IS DERIVED RATHER THAN STORED. `google_profile_url` is the column
 * meant to hold this, and it is populated on 3 rows out of 15,825 — nothing
 * fills it. `place_id` is populated on 15,821, because the scrape collected it.
 * So the link a family actually wants is already on almost every record, one
 * string concatenation away, and waiting for the other column to be backfilled
 * would mean shipping nothing.
 *
 * `?q=place_id:<id>` is Google's own documented form for addressing a place by
 * id. Verified against a real record rather than assumed: a valid id returns a
 * page titled with the business name, and a malformed one returns a page
 * titled only "Google Maps", so the check can actually fail.
 *
 * Returns null for a missing id. The caller omits the link entirely rather
 * than rendering one that lands a homeowner on an empty map.
 */
export function googleMapsUrl(placeId: string | null | undefined): string | null {
  const id = String(placeId ?? "").trim();
  if (!id) return null;
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}`;
}

/**
 * Enrichment signals read for the profile's presence summary.
 *
 * These are NOT published as fields. They are reduced to a short list of
 * plain-language gaps by presenceGaps(), so the page can tell a business what
 * is missing from its own online presence. A homeowner sees the same text -
 * there is no login - so every phrase has to be a neutral statement of fact
 * about a website, never a judgement about the business.
 */
export const PROFILE_PRESENCE_COLS =
  "has_website, has_schema_org, booking_tool, chat_widget, call_tracking, analytics_pixels";

/** The ONLY columns readable for a full public profile. */
export const PROFILE_COLS =
  VERIFIED_COLS + ", " + PROFILE_CONTACT_COLS + ", " + PROFILE_PRESENCE_COLS +
  ", services, years_in_business, license_state, verified_at, expires_at, " +
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
// The unvetted card is the sales surface - 4,151 contractors who can find
// their own listing - so it carries the same score and the same explanation a
// verified card does. It still publishes no contact details and no checks.
export const UNVETTED_COLS =
  // `slug` makes the card clickable through to /b/<slug>, the business's own
  // page. Without it an unvetted card is a dead end: 4,105 contractors can find
  // their listing and then have nowhere to go. The slug is derived from the
  // name, which this same card already publishes, so it exposes nothing new.
  "slug, name, category, city, state, dti_score, enrichment_status, website_url, domain, site_state, " +
  "has_https, has_viewport, phone_listed, has_business_hours, " +
  "reviews_linked, has_faq_or_blog, service_area_count, has_schema_org, " +
  "booking_tool, chat_widget, call_tracking";

export type VerifiedRow = {
  slug: string | null; legal_name: string | null; trading_name: string | null; name: string | null;
  trade: string | null; city: string | null; state: string | null; parish: string | null;
  rating: number | null; review_count: number | null; dti_score: number | null;
  blurb: string | null; verified_year: number | null; verified_at?: string | null;
  plan: string | null; exclusive_until: string | null;
};

/** Public display name: the curated names win; the scraped one is the last resort. */
export const displayName = (r: VerifiedRow) => r.trading_name || r.legal_name || r.name || "";

/**
 * Whole days since a timestamp, or null.
 *
 * COMPUTED HERE, NOT IN THE BROWSER. A visitor's device clock can be wrong by
 * days, and this number is printed as a trust claim next to a verification
 * badge. One clock, ours, decides it.
 *
 * A future timestamp yields null rather than a negative number: that is bad
 * data, and "verified for -3 days" is worse than saying nothing.
 */
export function daysSince(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d >= 0 ? d : null;
}

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
    dti_zero: dtiZero(r),
    dti_signals: dtiSignals(r as Record<string, unknown>),
    blurb: r.blurb,
    verified_year: r.verified_year,
    // Both: the day count drives the trust line once it is meaningful, and the
    // timestamp is what the site prints as a month before then. Deriving the
    // month from the day count would be off by one around a month boundary.
    verified_at: r.verified_at ?? null,
    verified_days: daysSince(r.verified_at),
    exclusive: isExclusive(r),
  };
}

/** The four neutral fields of an unvetted entry, built explicitly. */
export function shapeUnvetted(r: {
  slug?: string | null;
  name: string | null; category: string | null; city: string | null; state: string | null;
  dti_score?: number | null; enrichment_status?: string | null;
  website_url?: string | null; domain?: string | null;
}) {
  return {
    slug: r.slug ?? null,
    name: r.name, trade: titleCase(r.category), city: r.city, state: r.state,
    dti: r.dti_score ?? null,
    dti_zero: dtiZero(r),
    dti_signals: dtiSignals(r as unknown as Record<string, unknown>),
  };
}

/**
 * The three meter segments, each with what is present and what is missing.
 *
 * The card shows three weighted bars; tapping one names the signals behind it.
 * That is the whole reason the score is grouped rather than flat — a
 * contractor has to be able to see WHICH thing to fix, and twelve segments on
 * a card is unreadable.
 *
 * `got` is null, not false, when a signal was not measured. A group with
 * nothing measured returns value:null and the bar renders unfilled-and-unknown
 * rather than empty-and-failed.
 */
export function dtiSignals(r: Record<string, unknown>): Array<{
  key: string; label: string; weight: number; value: number | null;
  present: string[]; missing: string[];
}> | null {
  const b = (v: unknown) => (v === true ? 1 : v === false ? 0 : null);
  const tools = [r.booking_tool, r.chat_widget, r.call_tracking];
  const toolsKnown = tools.some((t) => t === true || t === false);

  const GROUPS: Array<{ key: string; label: string; weight: number; parts: Array<[string, number | null]> }> = [
    { key: "findable", label: "Findable", weight: 40, parts: [
      ["live website", r.site_state == null ? null : r.site_state === "alive" ? 1 : 0],
      ["HTTPS", b(r.has_https)],
      ["mobile-ready", b(r.has_viewport)],
      ["structured data for search and AI", b(r.has_schema_org)],
    ] },
    { key: "reachable", label: "Reachable", weight: 35, parts: [
      ["phone on the page", b(r.phone_listed)],
      ["booking, chat or call handling", toolsKnown ? (tools.some((t) => t === true) ? 1 : 0) : null],
      ["business hours", b(r.has_business_hours)],
    ] },
    { key: "credible", label: "Credible", weight: 25, parts: [
      ["reviews linked", b(r.reviews_linked)],
      ["serves multiple areas", typeof r.service_area_count === "number"
        ? (r.service_area_count >= 3 ? 1 : 0) : null],
      ["FAQ or blog", b(r.has_faq_or_blog)],
    ] },
  ];

  const out = GROUPS.map((g) => {
    const known = g.parts.filter(([, v]) => v !== null);
    return {
      key: g.key, label: g.label, weight: g.weight,
      value: known.length ? known.reduce((a, [, v]) => a + (v as number), 0) / known.length : null,
      present: known.filter(([, v]) => (v as number) > 0).map(([n]) => n),
      missing: known.filter(([, v]) => (v as number) === 0).map(([n]) => n),
    };
  });
  // Nothing measured at all -> no meter. The card falls back to its label.
  return out.some((g) => g.value !== null) ? out : null;
}

/**
 * The shape behind /b/<slug> — a business's own share page.
 *
 * SEPARATE FROM THE DIRECTORY CARD ON PURPOSE. The unvetted card on /search
 * publishes name, trade, city and state and nothing else; widening that to add
 * a rating would change what 4,105 unchecked businesses expose on a public
 * index page. This shape is read one record at a time, by a slug somebody was
 * handed, and carries the extra fields that page needs.
 *
 * WHAT IS NEW HERE, stated plainly: `rating` and `reviews` become readable for
 * an UNVETTED business. Both are Google's public numbers, already visible on
 * the business's own Maps listing, and they are what makes the page
 * recognisable as theirs. No contact details, no checks, no internal columns.
 */
export const BUSINESS_PAGE_COLS =
  "slug, name, category, trade, city, state, parish, rating, review_count, place_id, " +
  "vetting_status, is_published, expires_at, " +
  "dti_score, enrichment_status, website_url, domain, site_state, " +
  "has_https, has_viewport, phone_listed, has_business_hours, " +
  "reviews_linked, has_faq_or_blog, service_area_count, has_schema_org, " +
  "booking_tool, chat_widget, call_tracking";

export function shapeBusinessPage(r: Record<string, unknown>) {
  const verified = r.vetting_status === "verified";
  return {
    slug: (r.slug as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    // A verified record's trade is the operator's curated value; an unvetted
    // one only has the scraped category. Same precedence the directory uses.
    trade: titleCase((verified ? (r.trade as string | null) : null) ?? (r.category as string | null)),
    city: (r.city as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    // The page names their parish back to them ("No electrician in Tangipahoa
    // Parish is verified"), so it has to travel with the record.
    parish: (r.parish as string | null) ?? null,
    rating: (r.rating as number | null) ?? null,
    reviews: (r.review_count as number | null) ?? null,
    // The same Google listing the rating above is taken from. Printing a score
    // with no way to read a single review asks the business to take our number
    // on faith, which is the one thing this site is built not to do - and on
    // this page the reader is the business itself.
    google_profile: googleMapsUrl(r.place_id as string | null),
    dti: (r.dti_score as number | null) ?? null,
    dti_zero: dtiZero(r as Parameters<typeof dtiZero>[0]),
    dti_signals: dtiSignals(r),
    // Lets the page send a visitor to the real profile instead of the pitch.
    verified,
  };
}

/**
 * Why a score is 0, in a form the card can label.
 *
 * A bare 0 on a trust page reads as a verdict on the BUSINESS. It is not: it
 * is a statement about a website, and it is only ever printed when we actually
 * checked. This returns the reason so the card can say which kind of nothing
 * it found, and returns null when the score is not 0 or when the reason is not
 * one we are willing to state.
 *
 *   "no_website"  Google Place Details was asked about this business by its
 *                 own place_id and returned no website.
 *   "social_only" their listed site is a social profile or a directory entry —
 *                 not a site they own or control. Site BUILDERS are excluded
 *                 on purpose; a Wix site is their own website.
 *
 * Anything we could not check has a NULL score and never reaches here.
 */
export function dtiZero(r: {
  dti_score?: number | null; enrichment_status?: string | null;
  website_url?: string | null; domain?: string | null; site_state?: string | null;
}): { reason: "no_website" | "social_only" | "site_unreachable" | "nothing_readable"; host: string | null } | null {
  if (r.dti_score !== 0) return null;
  const raw = String(r.website_url ?? r.domain ?? "").trim();
  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    let host: string | null = null;
    try { host = new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase(); } catch { host = null; }
    if (host && NOT_A_WEBSITE_HOSTS.some((d) => host === d || host!.endsWith("." + d))) {
      return { reason: "social_only", host };
    }
  }
  if (r.enrichment_status === "no_website_found") return { reason: "no_website", host: null };
  // A site we DID fetch that still scores nothing. Two different findings, and
  // conflating them would tell a business with a working site that they have
  // none.
  if (r.site_state === "dead_http_error" || r.site_state === "parked_or_lead_gen") {
    return { reason: "site_unreachable", host: null };
  }
  if (r.enrichment_status === "fully_enriched") return { reason: "nothing_readable", host: null };
  return null;
}

/** Mirrors NOT_A_WEBSITE in lib/trustlight-dti.ts. Duplicated deliberately:
 *  this file is the public shape and must not depend on the scorer. */
export const NOT_A_WEBSITE_HOSTS = [
  "facebook.com", "fb.com", "m.facebook.com", "instagram.com", "linkedin.com",
  "twitter.com", "x.com", "tiktok.com", "youtube.com", "youtu.be",
  "pinterest.com", "nextdoor.com", "threads.net",
  "yelp.com", "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com",
  "bbb.org", "houzz.com", "porch.com", "manta.com", "yellowpages.com",
  "superpages.com", "foursquare.com", "alignable.com", "buildzoom.com",
  "networx.com", "expertise.com", "chamberofcommerce.com", "mapquest.com",
  "linktr.ee", "linkin.bio", "beacons.ai", "bit.ly", "tinyurl.com",
  "campsite.bio", "carrd.co",
] as const;

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

/*
 * THE FIVE PILLARS ARE NOT PUBLISHED.
 *
 * dti_findability / answerability / responsiveness / completeness /
 * compliance were added for website copy and nothing ever populated them -
 * 0 of 15,822 rows carried a value. Three of the five cannot be computed
 * from any data we hold: nothing times how long a business takes to answer,
 * and nothing collects hours, photos or accessibility.
 *
 * Publishing three numbers with nothing behind them is the same failure as
 * the empty schema, only harder to notice. The columns stay in the table,
 * nullable and unused, and the public shape carries ONE score computed from
 * signals that were actually measured. See lib/trustlight-dti.ts.
 */
export type ProfileRow = VerifiedRow & {
  phone: string | null; website_url: string | null; address: string | null;
  zip: string | null; google_profile_url: string | null; place_id: string | null;
  has_website: boolean | null; has_schema_org: boolean | null;
  booking_tool: boolean | null; chat_widget: boolean | null;
  call_tracking: boolean | null; analytics_pixels: boolean | null;
  services: string[] | null; years_in_business: number | null; license_state: string | null;
  verified_at: string | null; expires_at: string | null;
  [k: string]: unknown;
};

/**
 * Plain-language gaps in a business's online presence.
 *
 * Duplicated deliberately rather than imported from lib/trustlight-enrich:
 * this file is the public shape and must not depend on the probe. If the two
 * ever disagree, THIS one is what the public sees.
 */
export function presenceGaps(row: {
  has_website?: boolean | null; has_schema_org?: boolean | null;
  booking_tool?: boolean | null; chat_widget?: boolean | null;
  call_tracking?: boolean | null; analytics_pixels?: boolean | null;
}): string[] {
  const gaps: string[] = [];
  if (row.has_website === false) gaps.push("no website");
  if (row.has_schema_org === false) gaps.push("no structured data for search engines and AI");

  // ── CONTACT TOOLING MUST AGREE WITH THE SCORE ────────────────────────────
  // The scorer treats chat, booking and call tracking as ONE signal satisfied
  // by ANY of the three: a business reachable by chat is reachable, and three
  // separate weights would count the same quality three times.
  //
  // This list used to report them separately, so a business with booking and
  // no call tracking was told "no call tracking" while the scorer had already
  // given it full marks for being reachable. Two businesses were sitting at
  // 100 with a gap printed underneath, which reads as either a broken score or
  // a broken list, and undermines both.
  //
  // So: if ANY contact tool is present, the business is reachable and nothing
  // here is missing. Only when none of the three is present do the specific
  // absences get named - and they stay specific, because "no online booking
  // and no chat" tells a contractor what to do and "no contact tooling" does
  // not.
  const tools = [row.booking_tool, row.chat_widget, row.call_tracking];
  const anyTool = tools.some((t) => t === true);
  if (!anyTool) {
    if (row.booking_tool === false && row.chat_widget === false) gaps.push("no online booking or chat");
    else if (row.booking_tool === false) gaps.push("no online booking");
    else if (row.chat_widget === false) gaps.push("no chat");
    if (row.call_tracking === false) gaps.push("no call tracking");
  }

  if (row.analytics_pixels === false) gaps.push("no analytics");
  return gaps;
}

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
      // The curated value wins when an operator has set one; otherwise the
      // link is built from place_id. place_id itself is NOT published — only
      // the URL derived from it.
      google_profile: r.google_profile_url ?? googleMapsUrl(r.place_id as string | null),
      address: {
        street: r.address,
        city: r.city,
        state: r.state,
        zip: r.zip,
      },
    },
    // What is missing from this business's online presence, in plain words.
    // Only signals we actually CHECKED appear - a null is silence, never a
    // claim. Empty means either a full presence or nothing measured, and the
    // page renders nothing in both cases.
    presence_gaps: presenceGaps(r),
    services: Array.isArray(r.services) ? r.services : [],
    years_in_business: r.years_in_business,
    license_state: r.license_state,
    verification: {
      verified_at: r.verified_at,
      verified_days: daysSince(r.verified_at),
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

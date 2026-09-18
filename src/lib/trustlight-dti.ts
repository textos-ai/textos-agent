// =============================================================
// TrustLight — the Digital Trust Index, computed from measured signals.
//
// WHAT THIS SCORE IS
//
// An ONLINE PRESENCE score: does this business have a live, modern,
// machine-readable website. That is what the LeadScout enrichment in
// migration 116 actually measured, and it is all this score claims.
//
// WHAT IT IS NOT
//
// The five pillar columns on coldcall_leads (dti_findability,
// dti_answerability, dti_responsiveness, dti_completeness, dti_compliance)
// were written for website copy and nothing ever populated them. Three of the
// five cannot be computed from any data we hold:
//
//   responsiveness — the copy claimed we time how long until a person
//                    answers. Nothing measures that. Enrichment detects
//                    whether a chat widget EXISTS, never whether anyone
//                    replies.
//   completeness   — no hours, services or photo data is collected.
//   compliance     — no privacy/terms/accessibility/AI-disclosure data.
//
// So the pillars are not published. Publishing three numbers with nothing
// behind them is the same failure as the empty schema, only harder to spot.
// The columns stay in the database, nullable and unused.
//
// ── THE TWO RULES THIS FILE EXISTS TO HONOUR ────────────────────────────────
//
// 1. NULL MEANS NOT CHECKED, NEVER FALSE, NEVER ZERO.
//    Migration 116 says it outright: collapsing NULL into false would turn
//    15,313 un-probed businesses into businesses we falsely claim to have
//    checked. A signal that is NULL is left OUT OF THE DENOMINATOR entirely
//    rather than scored as absent, so a business is never punished for a
//    probe we did not run. A business with too few signals scores NULL and
//    the card hides the block — it does not score 0.
//
// 2. NO HARDCODED WEIGHTS.
//    Every weight is read from coldcall_config at call time. The constants
//    below are seed values for the migration, not runtime behaviour; nothing
//    in this file falls back to them when config is present.
// =============================================================

/** Config keys. Weights live in coldcall_config, never in code. */
export const DTI_CONFIG_KEYS = {
  findable: "dti_weight_findable",
  reachable: "dti_weight_reachable",
  credible: "dti_weight_credible",
  minSignals: "dti_min_signals",
} as const;

/**
 * Seed values, for the migration that populates coldcall_config. NOT used at
 * runtime — scoreDti() takes the weights it is given and refuses to score
 * without them, so a missing config row is a loud failure rather than a
 * silent fallback to numbers nobody chose.
 */
export const DTI_SEED_WEIGHTS = {
  [DTI_CONFIG_KEYS.findable]: 40,
  [DTI_CONFIG_KEYS.reachable]: 35,
  [DTI_CONFIG_KEYS.credible]: 25,
  // One group is enough to score. Two of three would leave a business with a
  // live site but nothing else unscored, and "unscored" is what we are trying
  // to get rid of.
  [DTI_CONFIG_KEYS.minSignals]: 1,
} as const;

/**
 * Domain maturity threshold. NO LONGER USED BY THE PUBLIC SCORE - kept because
 * the hijack check reads it: a domain registered days before it is used is the
 * strongest storm-chaser tell we have.
 */
export const DTI_DOMAIN_MATURE_DAYS = 1095;

export type DtiWeights = Record<string, number>;

export type DtiRow = {
  enrichment_status?: string | null;
  site_state?: string | null;
  has_schema_org?: boolean | null;
  analytics_pixels?: boolean | null;
  chat_widget?: boolean | null;
  booking_tool?: boolean | null;
  call_tracking?: boolean | null;
  domain_age_days?: number | null;
  website_url?: string | null;
  domain?: string | null;
  has_https?: boolean | null;
  has_viewport?: boolean | null;
  phone_listed?: boolean | null;
  has_business_hours?: boolean | null;
  reviews_linked?: boolean | null;
  has_faq_or_blog?: boolean | null;
  service_area_count?: number | null;
};

export type DtiSignal = {
  key: string;
  label: string;
  weight: number;
  /** 0..1, or null when the signal was not checked. A GROUP scores the mean
   *  of the signals measured inside it. */
  value: number | null;
  detail: string;
  /** The individual signals behind the group, so the card can list what is
   *  present and what is missing when someone taps a segment. */
  parts?: Array<{ name: string; value: number | null }>;
};

export type DtiResult = {
  score: number | null;
  /** Why there is no score, when there isn't one. */
  reason: string | null;
  signals: DtiSignal[];
  counted: number;
  weightAvailable: number;
  /** Why the score is 0, when it is. Drives the label on the card. */
  zeroReason?: "no_website" | "social_only" | "site_unreachable" | "nothing_readable";
  /** For social_only: which host, so the card can name it. */
  zeroDetail?: string;
};

/**
 * Hosts that are NOT a website, for scoring purposes.
 *
 * A business whose only web presence is a Facebook page has no website: it
 * cannot be found the way a site can, it carries no structured data we can
 * read, and it belongs to the platform rather than to them.
 *
 * WHAT IS DELIBERATELY ABSENT: site builders. wixsite.com, godaddysites.com,
 * weebly.com, square.site, squarespace.com, wordpress.com, webflow.io,
 * business.site and sites.google.com are all REAL websites — the business's
 * own content, on their own page. Ten Louisiana home-trade businesses in this
 * table use one, including Christison Fence and Deck, Carboni Electric and
 * Affordable Plumbing, and zeroing them would be indefensible.
 *
 * Measured across the table: 29 home-trade businesses match this list, 25 of
 * them facebook.com.
 */
export const NOT_A_WEBSITE = [
  // Social profiles
  "facebook.com", "fb.com", "m.facebook.com", "instagram.com", "linkedin.com",
  "twitter.com", "x.com", "tiktok.com", "youtube.com", "youtu.be",
  "pinterest.com", "nextdoor.com", "threads.net",
  // Directory listings
  "yelp.com", "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com",
  "bbb.org", "houzz.com", "porch.com", "manta.com", "yellowpages.com",
  "superpages.com", "foursquare.com", "alignable.com", "buildzoom.com",
  "networx.com", "expertise.com", "chamberofcommerce.com", "mapquest.com",
  // Link aggregators and shorteners
  "linktr.ee", "linkin.bio", "beacons.ai", "bit.ly", "tinyurl.com",
  "campsite.bio", "carrd.co",
] as const;

function hostOf(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try { return new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return null; }
}

/** A weight from config, or a hard failure — never a quiet default. */
function weightOf(weights: DtiWeights, key: string): number {
  const v = weights[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`dti: missing or invalid weight '${key}' in coldcall_config`);
  }
  return v;
}

/**
 * Score one row.
 *
 * Three outcomes, and the difference between them is the whole design:
 *
 *   ZERO, because we checked and the answer is nothing:
 *     no_website_found  — Google Place Details was asked about this business
 *                         by its own place_id and returned no website. 2,027
 *                         home trades are in this state after the 2026-09-17
 *                         run. (This USED to score NULL, on the reasoning that
 *                         a 0 under a trust badge reads as a verdict. It is
 *                         labelled on the card instead — "No website found for
 *                         this business" — so the number is explained rather
 *                         than left to be misread.)
 *     social_only       — their listed site is a Facebook page or a directory
 *                         listing. See NOT_A_WEBSITE.
 *
 *   A REAL SCORE, from measured signals:
 *     fully_enriched    — the site was fetched and read.
 *
 *   NULL, because nobody could look:
 *     skipped_robots_txt — the site told us not to. Their right.
 *     probe_failed       — our problem, not theirs.
 *     not_enriched       — never attempted. A 0 here would be a claim built
 *                          out of our own missing record, which is the exact
 *                          mistake that had to be reverted across 14,820 rows.
 */
export function scoreDti(row: DtiRow, weights: DtiWeights): DtiResult {
  const empty = (reason: string): DtiResult =>
    ({ score: null, reason, signals: [], counted: 0, weightAvailable: 0 });

  // ── A CHECKED ABSENCE SCORES ZERO ───────────────────────────────────────
  // 'no_website_found' now means something it did not used to: Google Place
  // Details was asked about this specific business, by its own place_id, and
  // returned no website. That is a checked, sourced answer, so 0 is a true
  // statement about their online presence — not a punishment for a probe we
  // never ran.
  //
  // The distinction that makes this safe is the one that had to be enforced
  // the hard way: 'not_enriched' means NOBODY LOOKED and still scores NULL.
  // Writing 0 there would be a claim built out of our own missing data.
  if (row.enrichment_status === "no_website_found") {
    return {
      score: 0, reason: null, signals: [], counted: 0, weightAvailable: 0,
      zeroReason: "no_website",
    };
  }

  // ── A SOCIAL OR DIRECTORY PAGE IS NOT A WEBSITE ─────────────────────────
  // A Facebook page cannot be found the way a website can, and it is not the
  // business's to control. Site BUILDERS are deliberately excluded from this
  // list — a Wix site on a free subdomain is still their own site with their
  // own content, and zeroing 10 real Louisiana contractors for using one
  // would be exactly the kind of wrong call that loses an argument.
  const host = hostOf(row.website_url ?? row.domain ?? null);
  if (host && NOT_A_WEBSITE.some((d) => host === d || host.endsWith("." + d))) {
    return {
      score: 0, reason: null, signals: [], counted: 0, weightAvailable: 0,
      zeroReason: "social_only", zeroDetail: host,
    };
  }

  if (row.enrichment_status !== "fully_enriched") {
    return empty(`not scored: enrichment_status is '${row.enrichment_status ?? "null"}'`);
  }

  const bool = (v: boolean | null | undefined) =>
    v === true ? 1 : v === false ? 0 : null;

  // domain_age is deliberately absent from the score. It was 20 of 100 points
  // and it is the one thing TrustLight Growth cannot change - a business on a
  // new domain was capped at 80 whatever it bought. It is still collected and
  // still the strongest storm-chaser signal we have, but that is an internal
  // judgement about risk, not a measure of online presence.

  // Any one contact tool counts. A business with a booking tool and no chat
  // widget is as reachable as the reverse, so this is an OR rather than three
  // separate weights that would over-count the same quality.
  const tooling = [row.chat_widget, row.booking_tool, row.call_tracking];
  const toolingKnown = tooling.some((t) => t === true || t === false);
  const toolingValue = toolingKnown ? (tooling.some((t) => t === true) ? 1 : 0) : null;
  const toolingNames = [
    row.chat_widget === true ? "chat" : null,
    row.booking_tool === true ? "booking" : null,
    row.call_tracking === true ? "call tracking" : null,
  ].filter(Boolean);

  // ── THREE GROUPS, SEVEN SIGNALS ─────────────────────────────────────────
  // Twelve segments on a card meter is unreadable, so the signals are grouped
  // into three weighted bands. Each band scores as the MEAN of the signals we
  // actually measured inside it — a NULL signal drops out of its own group's
  // denominator exactly as a NULL group drops out of the score. The
  // blank-vs-false rule applies at both levels.
  //
  // Findable 40 / Reachable 35 / Credible 25. Every one of the seven is
  // something TrustLight Growth supplies, which is what makes "Growth takes
  // this to 100" a promise we can keep.
  const sub = (
    label: string,
    parts: Array<{ name: string; value: number | null }>,
  ): { value: number | null; detail: string; parts: typeof parts } => {
    const known = parts.filter((p) => p.value !== null);
    if (!known.length) return { value: null, detail: "not checked", parts };
    const got = known.filter((p) => (p.value as number) > 0).map((p) => p.name);
    const missing = known.filter((p) => (p.value as number) === 0).map((p) => p.name);
    return {
      value: known.reduce((a, p) => a + (p.value as number), 0) / known.length,
      detail: missing.length ? `missing: ${missing.join(", ")}` : `all present: ${got.join(", ")}`,
      parts,
    };
  };

  const findable = sub("Findable", [
    { name: "live website", value: row.site_state == null ? null : row.site_state === "alive" ? 1 : 0 },
    { name: "HTTPS", value: bool(row.has_https) },
    { name: "mobile-ready", value: bool(row.has_viewport) },
    { name: "structured data", value: bool(row.has_schema_org) },
  ]);

  const reachable = sub("Reachable", [
    { name: "phone on the page", value: bool(row.phone_listed) },
    // Any ONE contact tool counts. A business reachable by chat is reachable,
    // and three separate weights would count the same quality three times.
    { name: "booking, chat or call handling", value: toolingValue },
    { name: "business hours", value: bool(row.has_business_hours) },
  ]);

  const credible = sub("Credible", [
    { name: "reviews linked", value: bool(row.reviews_linked) },
    {
      name: "multiple service areas",
      value: typeof row.service_area_count === "number"
        ? (row.service_area_count >= 3 ? 1 : 0)
        : null,
    },
    { name: "FAQ or blog", value: bool(row.has_faq_or_blog) },
  ]);

  const signals: DtiSignal[] = [
    {
      key: "findable", label: "Findable",
      weight: weightOf(weights, DTI_CONFIG_KEYS.findable),
      value: findable.value, detail: findable.detail,
      parts: findable.parts,
    },
    {
      key: "reachable", label: "Reachable",
      weight: weightOf(weights, DTI_CONFIG_KEYS.reachable),
      value: reachable.value, detail: reachable.detail,
      parts: reachable.parts,
    },
    {
      key: "credible", label: "Credible",
      weight: weightOf(weights, DTI_CONFIG_KEYS.credible),
      value: credible.value, detail: credible.detail,
      parts: credible.parts,
    },
  ];

  // ai_voice_agent is deliberately absent: 0 of 509 enriched businesses have
  // one, so it is a constant and would only dilute the weights.

  // ── A WEIGHT OF 0 REMOVES A SIGNAL FROM THE PUBLIC SCORE ────────────────
  // Not "scores it as nothing" - removes it. A zero-weight signal left in the
  // list would still count toward min_signals, so a business could clear the
  // minimum on signals worth no points and be scored on almost nothing.
  //
  // This is what retires domain_age from the public DTI. It remains collected
  // and remains the strongest storm-chaser tell we have - a domain registered
  // three weeks ago - but that is an INTERNAL judgement about risk, not a
  // measure of online presence, and it was 20 of the 100 points while being
  // the one thing TrustLight Growth can never change. A score we sell against
  // has to be a score the product can move.
  //
  // Which signals count is therefore config, not code: set a weight to 0 in
  // coldcall_config and it leaves the score.
  const scored = signals.filter((s) => s.weight > 0);
  const counted = scored.filter((s) => s.value !== null);
  const minSignals = weightOf(weights, DTI_CONFIG_KEYS.minSignals);
  if (counted.length < minSignals) {
    return {
      score: null,
      reason: `not scored: ${counted.length} signal(s) checked, minimum is ${minSignals}`,
      signals: scored, counted: counted.length, weightAvailable: 0,
    };
  }

  // NULL signals are excluded from the denominator, not scored as zero. This
  // is the whole blank-vs-false rule expressed in one line.
  const weightAvailable = counted.reduce((a, s) => a + s.weight, 0);
  if (weightAvailable <= 0) {
    return { score: null, reason: "not scored: no weight available", signals: scored, counted: counted.length, weightAvailable: 0 };
  }
  const earned = counted.reduce((a, s) => a + s.weight * (s.value as number), 0);
  const score = Math.round((earned / weightAvailable) * 100);

  // ── A COMPUTED ZERO STILL NEEDS A REASON ────────────────────────────────
  // A site we fetched successfully can still score 0: it returns an HTTP
  // error, it is a parked holding page, or it loads and carries none of the
  // four signals. Those are real findings, but without a label the card shows
  // a bare 0 — and a bare 0 under a trust badge reads as a verdict on the
  // business. Fourteen rows were in this state before this branch existed.
  if (score === 0) {
    const dead = row.site_state === "dead_http_error" || row.site_state === "parked_or_lead_gen";
    return {
      score, reason: null, signals: scored, counted: counted.length, weightAvailable,
      zeroReason: dead ? "site_unreachable" : "nothing_readable",
    };
  }

  return { score, reason: null, signals: scored, counted: counted.length, weightAvailable };
}

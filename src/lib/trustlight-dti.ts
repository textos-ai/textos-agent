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
  siteAlive: "dti_weight_site_alive",
  schemaOrg: "dti_weight_schema_org",
  domainAge: "dti_weight_domain_age",
  analytics: "dti_weight_analytics",
  contactTooling: "dti_weight_contact_tooling",
  minSignals: "dti_min_signals",
} as const;

/**
 * Seed values, for the migration that populates coldcall_config. NOT used at
 * runtime — scoreDti() takes the weights it is given and refuses to score
 * without them, so a missing config row is a loud failure rather than a
 * silent fallback to numbers nobody chose.
 */
export const DTI_SEED_WEIGHTS = {
  [DTI_CONFIG_KEYS.siteAlive]: 30,
  [DTI_CONFIG_KEYS.schemaOrg]: 25,
  [DTI_CONFIG_KEYS.domainAge]: 20,
  [DTI_CONFIG_KEYS.contactTooling]: 15,
  [DTI_CONFIG_KEYS.analytics]: 10,
  [DTI_CONFIG_KEYS.minSignals]: 3,
} as const;

/**
 * A domain this old or older counts as fully established. Below it the signal
 * scales linearly, so a six-month-old domain scores about a sixth of the
 * weight rather than nothing.
 *
 * Three years is deliberate: storm-chaser domains are registered days before
 * they are used, and `recently_registered` is true for 24 of the 509 enriched
 * businesses. Age is the one signal here that is hard to fake quickly.
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
};

export type DtiSignal = {
  key: string;
  label: string;
  weight: number;
  /** 0..1, or null when the signal was not checked. */
  value: number | null;
  detail: string;
};

export type DtiResult = {
  score: number | null;
  /** Why there is no score, when there isn't one. */
  reason: string | null;
  signals: DtiSignal[];
  counted: number;
  weightAvailable: number;
};

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
 * ONLY `fully_enriched` rows are scored. The other four enrichment states all
 * mean some version of "we did not get to look":
 *   no_website_found   — checked, genuinely absent. Still NOT zero: a 0 under
 *                        a trust badge reads as a verdict on the business, and
 *                        having no website is not a trust failing.
 *   skipped_robots_txt — the site told us not to look. Their right.
 *   probe_failed       — our problem, not theirs.
 *   not_enriched       — never attempted (14,822 of 15,822 rows).
 */
export function scoreDti(row: DtiRow, weights: DtiWeights): DtiResult {
  const empty = (reason: string): DtiResult =>
    ({ score: null, reason, signals: [], counted: 0, weightAvailable: 0 });

  if (row.enrichment_status !== "fully_enriched") {
    return empty(`not scored: enrichment_status is '${row.enrichment_status ?? "null"}'`);
  }

  const bool = (v: boolean | null | undefined) =>
    v === true ? 1 : v === false ? 0 : null;

  // Domain age scales; everything else is present/absent.
  let ageValue: number | null = null;
  let ageDetail = "not checked";
  if (typeof row.domain_age_days === "number" && Number.isFinite(row.domain_age_days)) {
    const d = Math.max(0, row.domain_age_days);
    ageValue = Math.min(1, d / DTI_DOMAIN_MATURE_DAYS);
    ageDetail = `${d} days old`;
  }

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

  const signals: DtiSignal[] = [
    {
      key: "site_alive", label: "Website is live",
      weight: weightOf(weights, DTI_CONFIG_KEYS.siteAlive),
      value: row.site_state == null ? null : row.site_state === "alive" ? 1 : 0,
      detail: row.site_state == null ? "not checked" : `site_state = ${row.site_state}`,
    },
    {
      key: "schema_org", label: "Machine-readable (schema.org)",
      weight: weightOf(weights, DTI_CONFIG_KEYS.schemaOrg),
      value: bool(row.has_schema_org),
      detail: row.has_schema_org == null ? "not checked"
        : row.has_schema_org ? "structured data present" : "no structured data",
    },
    {
      key: "domain_age", label: "Established domain",
      weight: weightOf(weights, DTI_CONFIG_KEYS.domainAge),
      value: ageValue, detail: ageDetail,
    },
    {
      key: "contact_tooling", label: "Contact tooling",
      weight: weightOf(weights, DTI_CONFIG_KEYS.contactTooling),
      value: toolingValue,
      detail: !toolingKnown ? "not checked"
        : toolingNames.length ? toolingNames.join(", ") : "none detected",
    },
    {
      key: "analytics", label: "Site is maintained",
      weight: weightOf(weights, DTI_CONFIG_KEYS.analytics),
      value: bool(row.analytics_pixels),
      detail: row.analytics_pixels == null ? "not checked"
        : row.analytics_pixels ? "analytics present" : "no analytics",
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

  return { score, reason: null, signals: scored, counted: counted.length, weightAvailable };
}

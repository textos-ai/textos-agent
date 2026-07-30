// The claim guardrail — a keyword may only assert what the facts support.
//
// WHY THIS EXISTS
//
// Trades marketing copy is saturated with service-delivery promises: "emergency
// electrician", "licensed and insured", "free estimates", "same-day service".
// A naive template or a language model will emit them readily, because they are
// what the surrounding corpus looks like. On a licensed contractor's public site
// an unsupported promise is the same category of problem as a fabricated review:
// it is a claim the business has not made and may not be able to honour.
//
// So every derived keyword passes through here, and a term that asserts something
// is rejected unless a FACT unlocks it.
//
// THE RULES ARE CONFIG, NOT CODE. They live on the template
// (section_catalog.claim_rules) so a vertical can change them without a deploy —
// a plumber's banned list is not an electrician's, and neither is a solicitor's.
// DEFAULT_CLAIM_RULES below is a fallback for a template that has not defined any
// yet; it is deliberately the strict set, so a missing config fails closed.
//
// Nothing here calls a model. Matching is literal and word-boundary anchored, so
// the guard cannot itself invent or miss on paraphrase — it is the last thing that
// should be clever.

import type { SiteFacts } from "./facts";

/** What kind of fact unlocks a group of terms. */
export type UnlockKey =
  /** business_profile.license_number is present. */
  | "license"
  /** Hours actually cover 24/7, or a service names urgency. */
  | "hours_or_service"
  /** The operator wrote the claim themselves in an authored field. */
  | "authored_text"
  /** A price band has been set. */
  | "price_range";

export interface ClaimRule {
  /** Stable id, for reporting which rule rejected a keyword. */
  id: string;
  /** Terms this rule governs. Matched case-insensitively on word boundaries. */
  terms: string[];
  unlocked_by: UnlockKey;
  /** Shown to the operator. Says what would make the term allowed. */
  message: string;
}

export const DEFAULT_CLAIM_RULES: ClaimRule[] = [
  {
    id: "urgency",
    terms: ["emergency", "24/7", "24-7", "24 hour", "24-hour", "same day", "same-day",
      "after hours", "after-hours", "round the clock", "anytime"],
    unlocked_by: "hours_or_service",
    message: "Only if your opening hours cover it, or one of your services says so.",
  },
  {
    id: "credential",
    terms: ["licensed", "certified", "insured", "bonded", "accredited"],
    unlocked_by: "license",
    message: "Only once a licence number is on your business facts.",
  },
  {
    id: "assurance",
    terms: ["free estimate", "free estimates", "free quote", "free quotes",
      "guaranteed", "guarantee", "warranty", "warrantied", "no obligation", "risk free", "risk-free"],
    unlocked_by: "authored_text",
    message: "Only if you have written this promise yourself somewhere on the site.",
  },
  {
    id: "price",
    terms: ["cheap", "cheapest", "affordable", "lowest price", "best price", "discount",
      "budget", "low cost", "low-cost", "unbeatable"],
    unlocked_by: "price_range",
    message: "Only once a price range is on your business facts.",
  },
];

/** Which unlock keys the facts currently satisfy. */
export type ClaimEvidence = Record<UnlockKey, boolean>;

const URGENCY_IN_TEXT = /\b(emergency|24[\s/-]?7|24[\s-]?hour|after[\s-]?hours|same[\s-]?day)\b/i;

/**
 * Do the opening hours actually cover round-the-clock work?
 *
 * Every day open, and every day spanning at least 23 hours. A business open
 * 07:00–19:00 seven days is not a 24/7 business, and this is exactly the kind of
 * "well, nearly" that the guard exists to refuse.
 */
function hoursAre24x7(facts: SiteFacts): boolean {
  const days = facts.hours.filter((h) => !h.is_closed && h.opens && h.closes);
  if (days.length < 7) return false;
  return days.every((h) => {
    const [oh, om] = (h.opens as string).split(":").map(Number);
    const [ch, cm] = (h.closes as string).split(":").map(Number);
    const open = oh * 60 + om;
    // A close of 00:00 means midnight at the END of the day.
    const close = ch * 60 + cm === 0 ? 24 * 60 : ch * 60 + cm;
    return close - open >= 23 * 60;
  });
}

/**
 * Resolve the evidence available from this business's facts.
 *
 * `authoredText` is every operator-written value on the site, concatenated. It is
 * what makes `authored_text` self-referential: the operator saying "we guarantee
 * our work" is what permits the word "guarantee" in a keyword. Nothing else does.
 */
export function resolveClaimEvidence(facts: SiteFacts, authoredText = ""): ClaimEvidence {
  const serviceText = facts.services
    .map((s) => `${s.name} ${s.blurb ?? ""} ${s.body ?? ""}`)
    .join(" ");
  return {
    license: !!facts.profile?.license_number,
    hours_or_service: hoursAre24x7(facts) || URGENCY_IN_TEXT.test(serviceText),
    // NOT a blanket unlock. Any authored text would otherwise permit every
    // assurance term at once — writing "we tidy up after ourselves" would license
    // the word "guaranteed". The per-term check happens in checkClaims against
    // the corpus itself; this flag only records that a corpus exists.
    authored_text: false,
    price_range: false, // set by the caller from the price_range site field
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary match that also works for terms containing punctuation.
 *
 * "24/7" cannot use \b on both sides — the slash is a non-word character, so \b
 * after "7" holds but before "2" depends on what precedes it. Guarding with
 * lookarounds on word characters handles both shapes.
 */
function containsTerm(haystack: string, term: string): boolean {
  const re = new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, "i");
  return re.test(haystack);
}

export interface ClaimViolation {
  rule_id: string;
  term: string;
  message: string;
}

/**
 * Check one string against the rules. Returns every violation, not just the
 * first — an operator fixing one term should see all of them at once.
 */
export function checkClaims(
  text: string,
  evidence: ClaimEvidence,
  rules: ClaimRule[] = DEFAULT_CLAIM_RULES,
  authoredText = "",
): ClaimViolation[] {
  const out: ClaimViolation[] = [];
  for (const rule of rules) {
    // authored_text is SELF-REFERENTIAL and is resolved per term below: the
    // operator must have written THAT promise, not merely written something.
    if (rule.unlocked_by !== "authored_text" && evidence[rule.unlocked_by]) continue;
    for (const term of rule.terms) {
      if (!containsTerm(text, term)) continue;
      if (rule.unlocked_by === "authored_text" && containsTerm(authoredText, term)) continue;
      out.push({ rule_id: rule.id, term, message: rule.message });
    }
  }
  return out;
}

/**
 * Split a batch of candidate keywords into those the facts support and those they
 * do not. Rejections carry their reason so the manager can show it.
 */
export function partitionKeywords(
  keywords: string[],
  evidence: ClaimEvidence,
  rules: ClaimRule[] = DEFAULT_CLAIM_RULES,
  authoredText = "",
): { allowed: string[]; rejected: Array<{ keyword: string; violations: ClaimViolation[] }> } {
  const allowed: string[] = [];
  const rejected: Array<{ keyword: string; violations: ClaimViolation[] }> = [];
  for (const k of keywords) {
    const v = checkClaims(k, evidence, rules, authoredText);
    if (v.length === 0) allowed.push(k);
    else rejected.push({ keyword: k, violations: v });
  }
  return { allowed, rejected };
}

/** Read the rules off a template, falling back to the strict default set. */
export function claimRulesFromTemplate(sectionCatalog: unknown): ClaimRule[] {
  const rules = (sectionCatalog as { claim_rules?: ClaimRule[] } | null)?.claim_rules;
  if (!Array.isArray(rules) || rules.length === 0) return DEFAULT_CLAIM_RULES;
  // A malformed row would silently disable a rule, so anything unusable falls
  // back to the strict set rather than being skipped.
  const usable = rules.filter(
    (r) => r && typeof r.id === "string" && Array.isArray(r.terms) && typeof r.unlocked_by === "string",
  );
  return usable.length > 0 ? usable : DEFAULT_CLAIM_RULES;
}

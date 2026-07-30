// Keyword derivation — string composition, not generation.
//
// A trades business's search surface is mostly service × area. JK entered
// "Electrical Repair" as a service and "Chalmette" as an area, so
// "electrical repair chalmette la electrician" combines two things he told us
// plus the noun for his trade. Every token traces to a row he filled in.
//
// NO MODEL RUNS HERE, deliberately. Composition is cheaper, deterministic, and
// incapable of inventing a claim — a model asked for "keyword variants" will
// reach for "emergency electrician" and "licensed and insured" because that is
// what the surrounding corpus looks like, which is precisely the failure the
// claim guard exists to catch. Not generating them beats catching them.
//
// Everything produced here still passes through the guard before it is stored:
// composition can produce an unsupported claim if a SERVICE is named
// "Emergency Callout" and the business has no hours to back it.

import type { SiteFacts } from "./facts";
import {
  partitionKeywords,
  type ClaimEvidence,
  type ClaimRule,
  type ClaimViolation,
} from "./claim-guard";

/** Lowercase, strip punctuation, collapse whitespace to single hyphens. */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lowercase words, single-spaced. Keywords are phrases, not slugs. */
function phrase(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim() !== "")
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export class MissingTradeNounError extends Error {
  constructor() {
    super(
      "trade_noun is not set on business_profile. Area-page URLs and keywords need the "
      + "noun people search for (\"electrician\"), and `industry` is a descriptive string, "
      + "not a search term. Set it in Business Facts before provisioning area pages.",
    );
    this.name = "MissingTradeNounError";
  }
}

/**
 * The area-page slug: {city}-{region}-{trade_noun}, e.g. chalmette-la-electrician.
 *
 * HALTS rather than guessing when the trade noun is missing. A slug of
 * "chalmette-la-" would be a broken URL that looks deliberate.
 */
export function areaSlug(city: string, region: string | null, tradeNoun: string | null): string {
  if (!tradeNoun || tradeNoun.trim() === "") throw new MissingTradeNounError();
  return [slugify(city), region ? slugify(region) : null, slugify(tradeNoun)]
    .filter(Boolean)
    .join("-");
}

export interface DerivedPhrase {
  text: string;
  /** Which service this came from, when one was involved. */
  service_id: string | null;
  /** Which area this came from, when one was involved. */
  area_id: string | null;
  kind: "service_area" | "service" | "area" | "trade_area";
}

export interface KeywordDerivation {
  phrases: DerivedPhrase[];
  sources: {
    trade_noun: string;
    service_ids: string[];
    area_ids: string[];
    rule_set: string[];
  };
  rejected: Array<{ text: string; rule_id: string; term: string }>;
}

/**
 * Derive the keyword set from facts.
 *
 * Four shapes, each grounded in rows the operator entered:
 *   service × area   "electrical repair chalmette la electrician"  — the money phrase
 *   trade × area     "electrician chalmette la"                    — the generic local
 *   service          "electrical repair electrician"               — non-geographic
 *   area             "chalmette la electrician"                    — the area page itself
 *
 * Deduplicated on the phrase text, keeping the first (most specific) provenance.
 */
export function deriveKeywords(
  facts: SiteFacts,
  tradeNoun: string | null,
  evidence: ClaimEvidence,
  rules: ClaimRule[],
  authoredText = "",
): KeywordDerivation {
  if (!tradeNoun || tradeNoun.trim() === "") throw new MissingTradeNounError();
  const noun = tradeNoun.trim().toLowerCase();

  const candidates: DerivedPhrase[] = [];
  const seen = new Set<string>();
  const push = (text: string, p: Omit<DerivedPhrase, "text">) => {
    if (text === "" || seen.has(text)) return;
    seen.add(text);
    candidates.push({ text, ...p });
  };

  for (const s of facts.services) {
    for (const a of facts.areas) {
      push(phrase(s.name, a.city, a.region, noun), {
        service_id: s.service_key, area_id: a.area_slug, kind: "service_area",
      });
    }
    push(phrase(s.name, noun), { service_id: s.service_key, area_id: null, kind: "service" });
  }
  for (const a of facts.areas) {
    push(phrase(noun, a.city, a.region), {
      service_id: null, area_id: a.area_slug, kind: "trade_area",
    });
    push(phrase(a.city, a.region, noun), {
      service_id: null, area_id: a.area_slug, kind: "area",
    });
  }

  // The guard runs on everything, including phrases built purely from facts — a
  // service literally named "Emergency Callout" composes an urgency claim that
  // the hours may not support.
  const { allowed, rejected } = partitionKeywords(
    candidates.map((c) => c.text), evidence, rules, authoredText,
  );
  const allowedSet = new Set(allowed);

  return {
    phrases: candidates.filter((c) => allowedSet.has(c.text)),
    sources: {
      trade_noun: noun,
      service_ids: facts.services.map((s) => s.service_key),
      area_ids: facts.areas.map((a) => a.area_slug),
      rule_set: rules.map((r) => r.id),
    },
    rejected: rejected.flatMap((r) =>
      r.violations.map((v: ClaimViolation) => ({ text: r.keyword, rule_id: v.rule_id, term: v.term })),
    ),
  };
}

/**
 * Is a stored keyword set stale?
 *
 * Compares the services and areas it was built from against the ones that exist
 * now. A changed service or area does not silently keep old keywords alive — the
 * manager shows the set as out of date and offers to re-derive.
 */
export function isKeywordSetStale(
  sources: KeywordDerivation["sources"] | null | undefined,
  facts: SiteFacts,
  tradeNoun: string | null,
): { stale: boolean; reasons: string[] } {
  if (!sources) return { stale: true, reasons: ["never derived"] };
  const reasons: string[] = [];
  const now = {
    services: facts.services.map((s) => s.service_key).sort(),
    areas: facts.areas.map((a) => a.area_slug).sort(),
  };
  const was = {
    services: [...(sources.service_ids ?? [])].sort(),
    areas: [...(sources.area_ids ?? [])].sort(),
  };
  if (JSON.stringify(now.services) !== JSON.stringify(was.services)) reasons.push("services changed");
  if (JSON.stringify(now.areas) !== JSON.stringify(was.areas)) reasons.push("service areas changed");
  if ((tradeNoun ?? "").trim().toLowerCase() !== (sources.trade_noun ?? "")) reasons.push("trade noun changed");
  return { stale: reasons.length > 0, reasons };
}

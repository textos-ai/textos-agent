// The claim guardrail: a keyword may only assert what the facts support.
//
// These are the cases that matter on a licensed contractor's public site. An
// unsupported "licensed and insured" or "24/7 emergency" is the same category of
// problem as a fabricated review, and both a naive template and a language model
// will produce them readily because that is what trades marketing looks like.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLAIM_RULES,
  checkClaims,
  partitionKeywords,
  resolveClaimEvidence,
  claimRulesFromTemplate,
  type ClaimEvidence,
} from "../lib/site-render/claim-guard";
import type { SiteFacts } from "../lib/site-render/facts";

const NONE: ClaimEvidence = {
  license: false, hours_or_service: false, authored_text: false, price_range: false,
};
const ALL: ClaimEvidence = {
  license: true, hours_or_service: true, authored_text: true, price_range: true,
};

function facts(over: Partial<SiteFacts> = {}): SiteFacts {
  return {
    profile: null, hours: [], services: [], areas: [], faqs: [],
    projects: [], differentiators: [], media: {}, context: {},
    ...over,
  } as unknown as SiteFacts;
}
const svc = (name: string, blurb = "") => ({
  service_key: name.toLowerCase().replace(/\s+/g, "-"), name, blurb,
  body: null, bullets: [], display_order: 0,
});
const day = (d: number, opens: string | null, closes: string | null, is_closed = false) =>
  ({ day_of_week: d, opens, closes, is_closed });

describe("banned terms are rejected without evidence", () => {
  it("rejects the four rule families on a bare business", () => {
    for (const [kw, rule] of [
      ["emergency electrician chalmette", "urgency"],
      ["licensed electrician chalmette", "credential"],
      ["free estimates chalmette", "assurance"],
      ["affordable electrician chalmette", "price"],
    ] as const) {
      const v = checkClaims(kw, NONE);
      expect(v.length, kw).toBeGreaterThan(0);
      expect(v[0].rule_id, kw).toBe(rule);
      expect(v[0].message, kw).toBeTruthy();
    }
  });

  it("allows a plain service × area keyword — the whole point of the layer", () => {
    expect(checkClaims("electrical repair chalmette la electrician", NONE)).toEqual([]);
    expect(checkClaims("panel upgrade meraux la electrician", NONE)).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    const v = checkClaims("licensed insured emergency electrician", NONE);
    expect(v.map((x) => x.term).sort()).toEqual(["emergency", "insured", "licensed"]);
  });
});

describe("evidence unlocks the claim it earns, and only that", () => {
  it("a licence number unlocks credentials but not urgency", () => {
    const e = { ...NONE, license: true };
    expect(checkClaims("licensed electrician", e)).toEqual([]);
    expect(checkClaims("emergency electrician", e)).toHaveLength(1);
  });

  it("everything is allowed once every fact exists", () => {
    expect(checkClaims("licensed 24/7 emergency free estimates affordable", ALL, DEFAULT_CLAIM_RULES,
      "free estimates guarantee")).toEqual([]);
  });
});

describe("hours evidence is literal, not nearly", () => {
  it("07:00-19:00 seven days is NOT 24/7", () => {
    const f = facts({ hours: Array.from({ length: 7 }, (_, d) => day(d, "07:00", "19:00")) as never });
    expect(resolveClaimEvidence(f).hours_or_service).toBe(false);
  });

  it("00:00-00:00 seven days IS round the clock", () => {
    const f = facts({ hours: Array.from({ length: 7 }, (_, d) => day(d, "00:00", "00:00")) as never });
    expect(resolveClaimEvidence(f).hours_or_service).toBe(true);
  });

  it("six open days is not enough", () => {
    const h = Array.from({ length: 7 }, (_, d) => day(d, "00:00", "00:00", d === 0));
    expect(resolveClaimEvidence(facts({ hours: h as never })).hours_or_service).toBe(false);
  });

  it("a service that names urgency unlocks it without 24/7 hours", () => {
    const f = facts({ services: [svc("Emergency Callout")] as never });
    expect(resolveClaimEvidence(f).hours_or_service).toBe(true);
  });
});

describe("authored_text is per-term, not a blanket unlock", () => {
  const AUTHORED = "We guarantee our workmanship on every job.";

  it("permits the promise the operator actually wrote", () => {
    expect(checkClaims("guarantee electrician", NONE, DEFAULT_CLAIM_RULES, AUTHORED)).toEqual([]);
  });

  it("does NOT permit a different promise from the same corpus", () => {
    // Writing one assurance must not license all of them.
    const v = checkClaims("free estimates electrician", NONE, DEFAULT_CLAIM_RULES, AUTHORED);
    expect(v).toHaveLength(1);
    expect(v[0].term).toBe("free estimates");
  });
});

describe("matching is anchored, so it neither over- nor under-fires", () => {
  it("does not fire inside a longer word", () => {
    // "budget" is banned; "budgetary" is not the claim, and "discounted" is a
    // different word from "discount".
    expect(checkClaims("budgetary planning", NONE)).toEqual([]);
  });

  it("handles a term containing punctuation", () => {
    expect(checkClaims("24/7 electrician", NONE)).toHaveLength(1);
    expect(checkClaims("call 1234/7890", NONE)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(checkClaims("LICENSED Electrician", NONE)).toHaveLength(1);
  });
});

describe("partitionKeywords", () => {
  it("splits a batch and keeps the reason with each rejection", () => {
    const { allowed, rejected } = partitionKeywords(
      ["electrical repair chalmette", "emergency electrician", "licensed electrician"],
      NONE,
    );
    expect(allowed).toEqual(["electrical repair chalmette"]);
    expect(rejected.map((r) => r.keyword)).toEqual(["emergency electrician", "licensed electrician"]);
    expect(rejected[0].violations[0].message).toBeTruthy();
  });
});

describe("rules are config, and a missing or broken config fails closed", () => {
  it("falls back to the strict set when the template defines none", () => {
    expect(claimRulesFromTemplate(null)).toBe(DEFAULT_CLAIM_RULES);
    expect(claimRulesFromTemplate({})).toBe(DEFAULT_CLAIM_RULES);
    expect(claimRulesFromTemplate({ claim_rules: [] })).toBe(DEFAULT_CLAIM_RULES);
  });

  it("falls back rather than silently dropping a malformed rule", () => {
    expect(claimRulesFromTemplate({ claim_rules: [{ nonsense: true }] })).toBe(DEFAULT_CLAIM_RULES);
  });

  it("uses a template's own rules when they are well formed", () => {
    const custom = [{ id: "x", terms: ["zzz"], unlocked_by: "license" as const, message: "m" }];
    expect(claimRulesFromTemplate({ claim_rules: custom })).toEqual(custom);
    expect(checkClaims("zzz thing", NONE, custom)).toHaveLength(1);
    // A term banned by default but absent from the custom set is now allowed —
    // which is what "config, not code" means.
    expect(checkClaims("emergency thing", NONE, custom)).toEqual([]);
  });
});

// Keyword derivation: mechanical composition, guarded, with provenance.
import { describe, it, expect } from "vitest";
import {
  deriveKeywords, areaSlug, slugify, isKeywordSetStale, MissingTradeNounError,
} from "../lib/site-render/keyword-derive";
import { DEFAULT_CLAIM_RULES, type ClaimEvidence } from "../lib/site-render/claim-guard";
import type { SiteFacts } from "../lib/site-render/facts";

const NONE: ClaimEvidence = {
  license: false, hours_or_service: false, authored_text: false, price_range: false,
};

const svc = (name: string) => ({
  service_key: name.toLowerCase().replace(/\s+/g, "-"), name,
  blurb: null, body: null, bullets: [], display_order: 0,
});
const area = (city: string, region: string | null = "LA") => ({
  area_slug: city.toLowerCase().replace(/\s+/g, "-"), city, region,
  postal_code: null, geo_lat: null, geo_lng: null,
  local_blurb: "x", landmarks_blurb: "y",
});
function facts(services: string[], areas: Array<[string, string | null]>): SiteFacts {
  return {
    profile: null, hours: [], faqs: [], projects: [], differentiators: [], media: {}, context: {},
    services: services.map(svc), areas: areas.map(([c, r]) => area(c, r)),
  } as unknown as SiteFacts;
}

describe("slugs", () => {
  it("builds the area-page slug from city, region and trade noun", () => {
    expect(areaSlug("Chalmette", "LA", "electrician")).toBe("chalmette-la-electrician");
    expect(areaSlug("New Orleans", "LA", "electrician")).toBe("new-orleans-la-electrician");
  });
  it("handles a missing region without leaving a double hyphen", () => {
    expect(areaSlug("Chalmette", null, "electrician")).toBe("chalmette-electrician");
  });
  it("strips punctuation and accents", () => {
    expect(slugify("St. Bernard Parish")).toBe("st-bernard-parish");
    expect(slugify("Ménard & Co.")).toBe("menard-co");
  });
  it("HALTS rather than emitting a broken slug when the trade noun is missing", () => {
    // "chalmette-la-" would be a dead URL that looks deliberate.
    expect(() => areaSlug("Chalmette", "LA", null)).toThrow(MissingTradeNounError);
    expect(() => areaSlug("Chalmette", "LA", "  ")).toThrow(MissingTradeNounError);
  });
});

describe("derivation is service × area composition", () => {
  const f = facts(["Electrical Repair", "Panel Upgrade"], [["Chalmette", "LA"], ["Meraux", "LA"]]);

  it("produces the money phrase for every service × area pair", () => {
    const d = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES);
    const texts = d.phrases.map((p) => p.text);
    expect(texts).toContain("electrical repair chalmette la electrician");
    expect(texts).toContain("panel upgrade meraux la electrician");
  });

  it("carries provenance on every phrase", () => {
    const d = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES);
    const p = d.phrases.find((x) => x.text === "electrical repair chalmette la electrician")!;
    expect(p.service_id).toBe("electrical-repair");
    expect(p.area_id).toBe("chalmette");
    expect(p.kind).toBe("service_area");
  });

  it("records what it read, so staleness is detectable", () => {
    const d = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES);
    expect(d.sources.trade_noun).toBe("electrician");
    expect(d.sources.service_ids.sort()).toEqual(["electrical-repair", "panel-upgrade"]);
    expect(d.sources.area_ids.sort()).toEqual(["chalmette", "meraux"]);
  });

  it("deduplicates", () => {
    const d = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES);
    expect(new Set(d.phrases.map((p) => p.text)).size).toBe(d.phrases.length);
  });

  it("works with a single area", () => {
    const one = facts(["Electrical Repair"], [["Chalmette", "LA"]]);
    const d = deriveKeywords(one, "electrician", NONE, DEFAULT_CLAIM_RULES);
    expect(d.phrases.length).toBeGreaterThan(0);
  });

  it("halts without a trade noun rather than guessing from industry", () => {
    expect(() => deriveKeywords(f, null, NONE, DEFAULT_CLAIM_RULES)).toThrow(MissingTradeNounError);
  });
});

describe("the guard runs on composed phrases too", () => {
  it("rejects a phrase whose SERVICE NAME makes an unsupported claim", () => {
    // Composition alone can produce a banned claim: a service literally named
    // "Emergency Callout" yields "emergency callout chalmette la electrician"
    // on a business with no 24/7 hours.
    const f = facts(["Emergency Callout"], [["Chalmette", "LA"]]);
    const d = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES);
    expect(d.phrases.every((p) => !/emergency/i.test(p.text))).toBe(true);
    expect(d.rejected.some((r) => r.term === "emergency" && r.rule_id === "urgency")).toBe(true);
  });

  it("keeps the same phrase once the fact exists", () => {
    const f = facts(["Emergency Callout"], [["Chalmette", "LA"]]);
    const d = deriveKeywords(f, "electrician", { ...NONE, hours_or_service: true }, DEFAULT_CLAIM_RULES);
    expect(d.phrases.some((p) => /emergency/i.test(p.text))).toBe(true);
    expect(d.rejected).toEqual([]);
  });
});

describe("staleness", () => {
  const f = facts(["Electrical Repair"], [["Chalmette", "LA"]]);
  const fresh = deriveKeywords(f, "electrician", NONE, DEFAULT_CLAIM_RULES).sources;

  it("is not stale against the facts it was built from", () => {
    expect(isKeywordSetStale(fresh, f, "electrician").stale).toBe(false);
  });
  it("is stale when an area is added", () => {
    const f2 = facts(["Electrical Repair"], [["Chalmette", "LA"], ["Meraux", "LA"]]);
    const r = isKeywordSetStale(fresh, f2, "electrician");
    expect(r.stale).toBe(true);
    expect(r.reasons).toContain("service areas changed");
  });
  it("is stale when the trade noun changes — the URLs no longer match", () => {
    expect(isKeywordSetStale(fresh, f, "electrical contractor").reasons).toContain("trade noun changed");
  });
  it("treats never-derived as stale", () => {
    expect(isKeywordSetStale(null, f, "electrician").stale).toBe(true);
  });
});

import { tidy, renderFormula, metaLengthWarnings } from "../lib/site-render/meta-formula";

describe("meta formula tidying", () => {
  it("keeps the em-dash separator's spacing", () => {
    // Stripping it produced "JK Quality Electric— electrician" on the live site.
    expect(tidy("JK Quality Electric — electrician in St Bernard, LA"))
      .toBe("JK Quality Electric — electrician in St Bernard, LA");
    expect(tidy("Services — JK Quality Electric")).toBe("Services — JK Quality Electric");
  });

  it("tightens commas against the preceding word", () => {
    expect(tidy("Chalmette , LA")).toBe("Chalmette, LA");
  });

  it("cleans up after a token that resolved to nothing", () => {
    expect(tidy("Electrician in , LA")).toBe("Electrician in LA");
    expect(tidy("Acme —")).toBe("Acme");
    expect(tidy("— Acme")).toBe("Acme");
  });

  it("leaves an unknown token visible rather than blanking it", () => {
    expect(renderFormula("{buiness_name} home", { business_name: "X" })).toBe("{buiness_name} home");
  });

  it("reports length problems instead of truncating", () => {
    const long = "x".repeat(75);
    expect(metaLengthWarnings(long, null)[0]).toMatch(/75 characters/);
    expect(metaLengthWarnings(null, "short")[0]).toMatch(/aim for/);
    expect(metaLengthWarnings("ok", "y".repeat(150))).toEqual([]);
  });
});

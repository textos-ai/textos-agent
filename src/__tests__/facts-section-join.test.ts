// The join between a site section and the Business Facts band it draws on.
//
// The manager's Content tab tells an operator where a section's content actually
// comes from ("4 services from Business Facts → What you do", with an Edit link).
// A wrong entry in that join sends them to the wrong band, which is exactly the
// confusion the feature exists to remove — and it is invisible in a screenshot, so
// it is pinned here.
//
// The other thing under test is that NO caller writes its own words. Every visible
// string must come out of FACTS_SECTIONS / FIELD_NAMES, so a band renamed in the
// registry moves the manager's link text with it and the two pages cannot drift.
import { describe, it, expect } from "vitest";
import {
  FACTS_SECTIONS,
  SECTION_FACT_COLLECTION,
  resolveCollection,
  factsAnchor,
  countedNoun,
} from "../lib/site-render/facts-sections";

describe("section → Facts band join", () => {
  it("maps every fact-backed section to the band that owns its collection", () => {
    const expected: Record<string, string> = {
      services_grid: "What you do",
      service_detail: "What you do",
      featured_work: "Work you've completed",
      faq_teaser: "Questions you get asked",
      faq_accordion: "Questions you get asked",
      differentiator_band: "Why customers pick you",
      differentiator_list: "Why customers pick you",
      service_area_chips: "Where you work",
      reviews: "Where your proof lives",
    };
    // Same key set — a section added to the map without a test entry fails here
    // rather than shipping an unverified destination.
    expect(Object.keys(SECTION_FACT_COLLECTION).sort()).toEqual(Object.keys(expected).sort());

    for (const [sectionKey, heading] of Object.entries(expected)) {
      const src = resolveCollection(SECTION_FACT_COLLECTION[sectionKey]);
      expect(src.label, sectionKey).toBe(`Business Facts → ${heading}`);
      expect(src.where, sectionKey).toBe("facts");
      expect(src.anchor, sectionKey).not.toBeNull();
    }
  });

  it("resolves each anchor to a band that exists in the registry", () => {
    const valid = new Set(FACTS_SECTIONS.map((s) => factsAnchor(s.key)));
    for (const collection of Object.values(SECTION_FACT_COLLECTION)) {
      expect(valid.has(resolveCollection(collection).anchor as string), collection).toBe(true);
    }
  });

  it("takes every visible word from the registry, so a rename cannot drift", () => {
    for (const collection of Object.values(SECTION_FACT_COLLECTION)) {
      const src = resolveCollection(collection);
      const heading = src.label.replace("Business Facts → ", "");
      // The heading is a registry heading verbatim — not a variant, not title-cased.
      expect(FACTS_SECTIONS.some((s) => s.heading === heading), heading).toBe(true);
      // And the noun the manager prints is the registry's noun.
      expect(src.field_name, collection).toBeTruthy();
    }
  });

  it("gives two sections sharing a collection the identical destination", () => {
    // Same content framed twice must not read as two different sources.
    for (const [a, b] of [["faq_teaser", "faq_accordion"], ["services_grid", "service_detail"],
                          ["differentiator_band", "differentiator_list"]]) {
      const x = resolveCollection(SECTION_FACT_COLLECTION[a]);
      const y = resolveCollection(SECTION_FACT_COLLECTION[b]);
      expect(x).toEqual(y);
    }
  });

  it("agrees in number — '1 service area', not '1 service areas'", () => {
    // Every collection noun the registry can hand back must singularise cleanly,
    // because the manager prints it inside a sentence.
    for (const collection of Object.values(SECTION_FACT_COLLECTION)) {
      const noun = resolveCollection(collection).field_name as string;
      expect(countedNoun(4, noun)).toBe(`4 ${noun}`);
      expect(countedNoun(0, noun)).toBe(`0 ${noun}`);
      // A noun that is already singular ("Google Place ID") is left alone; only a
      // plural one has to change. The reviews block prints no count at all, but
      // the rule still has to be right for anything that does.
      if (noun.endsWith("s")) {
        expect(countedNoun(1, noun), noun).toBe(`1 ${noun.slice(0, -1)}`);
      } else {
        expect(countedNoun(1, noun), noun).toBe(`1 ${noun}`);
      }
    }
    expect(countedNoun(1, "service areas")).toBe("1 service area");
    expect(countedNoun(1, "FAQs")).toBe("1 FAQ");
    expect(countedNoun(2, "services")).toBe("2 services");
  });

  it("returns a safe, honest fallback for a collection no band owns", () => {
    const src = resolveCollection("not_a_real_collection");
    expect(src.label).toBe("Business Facts");
    expect(src.anchor).toBeNull();
  });
});

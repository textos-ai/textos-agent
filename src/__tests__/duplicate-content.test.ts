// The duplicate-content gate: does each area page say something true about that
// place, or is it the same paragraph with the city swapped?
import { describe, it, expect } from "vitest";
import {
  scoreAreas, tokenise, similarity, thresholdFromTemplate, DEFAULT_UNIQUE_THRESHOLD,
  type AreaText,
} from "../lib/site-render/duplicate-content";

const mk = (slug: string, city: string, local: string, land: string): AreaText => ({
  area_slug: slug, city, region: "LA", postal_code: null,
  local_blurb: local, landmarks_blurb: land,
});

describe("masking", () => {
  it("removes the place name so it cannot count as uniqueness", () => {
    const t = tokenise("Chalmette homes near Chalmette park", { city: "Chalmette", region: null, postal_code: null });
    expect(t).not.toContain("chalmette");
    expect(t).toContain("homes");
  });
  it("masks each word of a multi-word city", () => {
    const t = tokenise("New Orleans wiring", { city: "New Orleans", region: null, postal_code: null });
    expect(t).not.toContain("orleans");
    expect(t).toContain("wiring");
  });
});

describe("scoring", () => {
  it("flags the doorway case: same paragraph, city swapped", () => {
    // This is the reference's failure mode, at ~5% unique.
    const body = "We provide fast reliable electrical work for homeowners and businesses";
    const areas = [
      mk("a", "Chalmette", `${body} in Chalmette.`, "Close to the main road."),
      mk("b", "Meraux", `${body} in Meraux.`, "Close to the main road."),
      mk("c", "Arabi", `${body} in Arabi.`, "Close to the main road."),
    ];
    const scores = scoreAreas(areas);
    expect(scores.every((s) => s.below_threshold)).toBe(true);
    expect(scores[0].max_similarity).toBeGreaterThan(0.9);
    expect(scores[0].message).toMatch(/unique to Chalmette/);
  });

  it("passes genuinely local writing", () => {
    const areas = [
      mk("a", "Chalmette", "Older brick ranches along Judge Perez need panel upgrades.",
        "We work near the Chalmette Battlefield and the ferry landing."),
      mk("b", "Meraux", "Post-storm rewiring dominates around the refinery fenceline.",
        "Most jobs sit between Paris Road and the drainage canal."),
    ];
    const scores = scoreAreas(areas);
    expect(scores.every((s) => !s.below_threshold)).toBe(true);
  });

  it("reports which blurb is doing the work", () => {
    const areas = [
      mk("a", "Chalmette", "Generic shared sentence about electrical work here.",
        "Judge Perez Drive ferry landing battlefield levee crossing."),
      mk("b", "Meraux", "Generic shared sentence about electrical work here.",
        "Refinery fenceline Paris Road canal pumping station."),
    ];
    expect(scoreAreas(areas)[0].carried_by).toBe("landmarks_blurb");
  });

  it("handles a single area without pretending it is duplicated", () => {
    // C1: must work with one.
    const s = scoreAreas([mk("a", "New Orleans", "Local writing.", "Landmarks.")]);
    expect(s).toHaveLength(1);
    expect(s[0].below_threshold).toBe(false);
    expect(s[0].unique_ratio).toBe(1);
    expect(s[0].message).toMatch(/nothing for this page to duplicate/);
  });

  it("identical pages score at the floor", () => {
    const areas = [
      mk("a", "Chalmette", "Same words entirely.", "Same landmarks entirely."),
      mk("b", "Meraux", "Same words entirely.", "Same landmarks entirely."),
    ];
    const s = scoreAreas(areas);
    expect(s[0].unique_ratio).toBe(0);
    expect(s[0].max_similarity).toBe(1);
  });
});

describe("threshold is template config", () => {
  it("falls back when absent or nonsense", () => {
    expect(thresholdFromTemplate(null)).toBe(DEFAULT_UNIQUE_THRESHOLD);
    expect(thresholdFromTemplate({ duplicate_content: { unique_token_threshold: 0 } }))
      .toBe(DEFAULT_UNIQUE_THRESHOLD);
    expect(thresholdFromTemplate({ duplicate_content: { unique_token_threshold: 5 } }))
      .toBe(DEFAULT_UNIQUE_THRESHOLD);
  });
  it("uses a template value", () => {
    expect(thresholdFromTemplate({ duplicate_content: { unique_token_threshold: 0.5 } })).toBe(0.5);
  });
  it("a stricter threshold fails a page a looser one passes", () => {
    // Partial overlap: some shared boilerplate, some genuinely local writing, so
    // the ratio lands between the two thresholds. Fully-unique pages score 1.0
    // and no threshold below 1 can flag them, which is correct.
    const shared = "reliable electrical work for homeowners";
    const areas = [
      mk("a", "Chalmette", `${shared} plus Judge Perez ranches.`, "Battlefield ferry landing."),
      mk("b", "Meraux", `${shared} plus refinery fenceline rewiring.`, "Paris Road canal."),
    ];
    const ratio = scoreAreas(areas)[0].unique_ratio;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    expect(scoreAreas(areas, ratio - 0.01).every((s) => !s.below_threshold)).toBe(true);
    expect(scoreAreas(areas, ratio + 0.01)[0].below_threshold).toBe(true);
  });
});

describe("similarity", () => {
  it("is 1 for identical and 0 for disjoint", () => {
    expect(similarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(similarity(["a"], ["b"])).toBe(0);
  });
});

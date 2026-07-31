// The area map component and the two blurbs' placement.
//
// Runs against the renderers directly — no database. The area_map SECTION cannot
// appear on a real page until migration 111 is applied and the area pages are
// re-provisioned, so an end-to-end test would be asserting the migration, not the
// renderer. What matters here is what the renderer does with a coordinate.
import { describe, it, expect } from "vitest";
import { SECTION_RENDERERS, type RenderCtx } from "../lib/site-render/sections";

const AREA = (over: Record<string, unknown> = {}) => ({
  area_slug: "chalmette-la", city: "Chalmette", region: "LA", postal_code: "70043",
  geo_lat: 29.9427, geo_lng: -89.9631,
  local_blurb: "We have worked St Bernard Parish for a decade.",
  landmarks_blurb: "From Paris Road to the Chalmette Battlefield.",
  display_order: 0, ...over,
});

function ctxFor(area: Record<string, unknown> | null): RenderCtx {
  return {
    facts: {
      areas: area ? [area] : [], services: [], faqs: [], projects: [],
      differentiators: [], media: {}, hours: [],
      profile: { trade_noun: "electrician" },
    },
    instanceKey: area ? (area.area_slug as string) : null,
    pageInstance: null,
    currentPath: "/areas/chalmette-la-electrician",
    basePath: "/sites/x",
    pages: [{
      page_type: "area_detail", route_path: "/areas/chalmette-la-electrician",
      title: "Chalmette, LA", noindex: false, instance_key: "chalmette-la",
    }],
    pageSectionKeys: new Set<string>(), renderedAnchors: new Set<string>(),
    sectionsByPath: new Map(), faqs: [], businessName: "Probe", canonicalUrl: "https://x/y",
    navDef: null, f: { get: () => undefined } as unknown as RenderCtx["f"],
  } as unknown as RenderCtx;
}

describe("area_map", () => {
  it("centres a bounding box on the area's own coordinates", () => {
    const html = SECTION_RENDERERS.area_map(ctxFor(AREA()));
    expect(html).toContain("openstreetmap.org/export/embed.html");

    const bbox = /bbox=([^&"]+)/.exec(html)?.[1];
    expect(bbox, "the embed needs a bbox").toBeTruthy();
    const [w, s, e, n] = bbox!.split(",").map(Number);
    // The area's point sits inside its own box, and the box is the right way up.
    expect(w).toBeLessThan(-89.9631);
    expect(e).toBeGreaterThan(-89.9631);
    expect(s).toBeLessThan(29.9427);
    expect(n).toBeGreaterThan(29.9427);
    // A city-sized view, not a street and not a continent.
    expect(n - s).toBeGreaterThan(0.02);
    expect(n - s).toBeLessThan(0.2);
    // Longitude is widened by 1/cos(lat) so the box is not letterboxed away from
    // the equator; at 30°N that is a visible ~15%.
    expect(e - w).toBeGreaterThan(n - s);
  });

  it("marks the point and titles the frame with the place", () => {
    const html = SECTION_RENDERERS.area_map(ctxFor(AREA()));
    expect(html).toContain("marker=29.94270,-89.96310");
    expect(html).toContain('title="Map of Chalmette, LA"');
    expect(html).toContain('loading="lazy"');
    // No API key can ever appear in this markup — that is the whole reason the
    // component is OSM rather than Google.
    expect(html).not.toMatch(/[?&]key=/);
  });

  it("renders NOTHING when the area has no coordinates", () => {
    // A map of the wrong place is a false claim about where a licensed
    // contractor works. Absent beats approximate.
    expect(SECTION_RENDERERS.area_map(ctxFor(AREA({ geo_lat: null, geo_lng: null })))).toBe("");
    expect(SECTION_RENDERERS.area_map(ctxFor(AREA({ geo_lat: 29.9, geo_lng: null })))).toBe("");
    // And nothing at all on an unpublished page, whose fact row is gone.
    expect(SECTION_RENDERERS.area_map(ctxFor(null))).toBe("");
  });
});

describe("service_area_chips", () => {
  const AREAS = [
    AREA(), // Chalmette
    AREA({ area_slug: "arabi-la", city: "Arabi", landmarks_blurb: "Along St Claude to the levee." }),
    AREA({ area_slug: "meraux-la", city: "Meraux", landmarks_blurb: "Between Judge Perez and the river." }),
  ];
  const chipsCtx = () => {
    const c = ctxFor(AREAS[0]) as Record<string, unknown>;
    (c.facts as Record<string, unknown>).areas = AREAS;
    (c.facts as Record<string, unknown>).profile = { trade_noun: "electrician", locality: "St Bernard", region: "LA" };
    c.currentPath = "/";
    c.pages = AREAS.map((a) => ({
      page_type: "area_detail", route_path: `/areas/${a.area_slug}-electrician`,
      title: `${a.city}, LA`, noindex: false, instance_key: a.area_slug,
    }));
    return c as unknown as RenderCtx;
  };

  it("gives every chip its own area's landmarks line", () => {
    const html = SECTION_RENDERERS.service_area_chips(chipsCtx());
    // One carrier per area, not one blurb for the section.
    expect((html.match(/data-area-blurb="/g) ?? []).length).toBe(3);
    expect(html).toContain("Along St Claude to the levee.");
    expect(html).toContain("Between Judge Perez and the river.");
    // And each sits on the chip it belongs to.
    expect(html).toMatch(/arabi-la-electrician"[^>]*data-area-blurb="Along St Claude/);
  });

  it("renders a real line server-side, so the section reads with no JavaScript", () => {
    const html = SECTION_RENDERERS.service_area_chips(chipsCtx());
    const shown = /<p class="trades-area-blurb"[^>]*>([^<]+)</.exec(html)?.[1];
    expect(shown, "the paragraph must have text before any script runs")
      .toBe("From Paris Road to the Chalmette Battlefield.");
    // And the default is recorded, so leaving a chip can restore it.
    expect(html).toContain('data-area-blurb-default="From Paris Road to the Chalmette Battlefield."');
    expect(html).toContain("data-area-blurb-target");
  });

  it("still carries the blurb on an area that has no page yet", () => {
    const c = chipsCtx() as Record<string, unknown>;
    c.pages = []; // nothing provisioned yet
    const html = SECTION_RENDERERS.service_area_chips(c as unknown as RenderCtx);
    // No links — a chip must never promise a page that is not there — but the
    // hover behaviour does not depend on navigation.
    expect(html).not.toContain("trades-chip-link");
    expect((html.match(/data-area-blurb="/g) ?? []).length).toBe(3);
    expect(html).toContain("trades-chip-static");
  });

  it("quotes in a blurb cannot break out of the attribute", () => {
    const c = chipsCtx() as Record<string, unknown>;
    (c.facts as Record<string, unknown>).areas = [
      AREA({ landmarks_blurb: 'Near the "old" mill & the bridge' }),
    ];
    const html = SECTION_RENDERERS.service_area_chips(c as unknown as RenderCtx);
    expect(html).toContain("&quot;old&quot;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain('"old"');
  });
});

describe("the two area blurbs", () => {
  it("puts landmarks in the hero and the local blurb in the body", () => {
    const ctx = ctxFor(AREA());
    const hero = SECTION_RENDERERS.area_hero(ctx);
    const body = SECTION_RENDERERS.area_positioning(ctx);

    // 092 declares area_hero's fields as [headline, area_landmarks_blurb, ...] and
    // area_positioning's as [..., area_local_blurb]. The renderer had them
    // swapped, which buried the only writing that distinguishes one area page
    // from another — the scorer measured landmarks_blurb carrying the uniqueness
    // on 14 of 14 real areas.
    expect(hero).toContain("From Paris Road to the Chalmette Battlefield.");
    expect(hero).not.toContain("We have worked St Bernard Parish");

    expect(body).toContain("We have worked St Bernard Parish for a decade.");
    expect(body).not.toContain("From Paris Road");

    // Neither blurb is orphaned — both still render somewhere.
    expect(hero + body).toContain("From Paris Road");
    expect(hero + body).toContain("St Bernard Parish");
  });
});

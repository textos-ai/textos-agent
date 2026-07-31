// The area page hero: its map background, its chips, and the two blurbs.
//
// Runs against the renderers directly — no database. The standalone area_map
// section that 111 added is retired (112): the map is the hero BACKGROUND now, so
// what these pin is what area_hero does with a coordinate, not a separate band.
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

describe("area_hero map background", () => {
  it("puts the map behind the hero text, not in a band below", () => {
    const html = SECTION_RENDERERS.area_hero(ctxFor(AREA()));
    expect(html).toContain("is-map");
    expect(html).toContain("page-hero__bg--map");
    expect(html).toContain("openstreetmap.org/export/embed.html");
    // Same hero, same text treatment — the headline and subhead are still the
    // page-hero ones, so this is a background variant and not a second hero.
    expect(html).toContain("page-hero__headline");
    expect(html).toContain("page-hero__subhead");
    expect(html).toContain("page-hero__scrim");
  });

  it("makes the map decorative: no pointer target, no tab stop, not announced", () => {
    const html = SECTION_RENDERERS.area_hero(ctxFor(AREA()));
    // pointer-events is CSS, but these are the markup half of the same decision.
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('loading="lazy"');
  });

  it("carries a LIVE attribution link, because the embed's own is now unclickable", () => {
    const html = SECTION_RENDERERS.area_hero(ctxFor(AREA()));
    expect(html).toContain("openstreetmap.org/copyright");
    expect(html).toContain("© OpenStreetMap contributors");
    // And it sits outside the aria-hidden wrapper, or it would be announced to
    // nobody and hidden from assistive tech.
    const wrapper = /<div class="page-hero__bg page-hero__bg--map"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(wrapper).not.toContain("openstreetmap.org/copyright");
    // The way into an interactive map survives the loss of panning.
    expect(html).toContain("View Chalmette, LA on a larger map");
  });

  it("falls back to the solid hero when the area has no coordinates", () => {
    const html = SECTION_RENDERERS.area_hero(ctxFor(AREA({ geo_lat: null, geo_lng: null })));
    expect(html).not.toContain("is-map");
    expect(html).not.toContain("openstreetmap");
    expect(html).not.toContain("<iframe");
    // Still a complete hero — the headline and the landmarks line are the point.
    expect(html).toContain("page-hero__headline");
    expect(html).toContain("From Paris Road to the Chalmette Battlefield.");
  });

  it("centres on this area, not on a default", () => {
    const a = SECTION_RENDERERS.area_hero(ctxFor(AREA()));
    const b = SECTION_RENDERERS.area_hero(ctxFor(AREA({
      city: "Slidell", area_slug: "slidell-la", geo_lat: 30.2752, geo_lng: -89.7812,
    })));
    const src = (h: string) => /src="([^"]*embed\.html[^"]*)"/.exec(h)?.[1] ?? "";
    expect(src(a)).not.toBe(src(b));
    expect(src(a)).toContain("marker=29.94270,-89.96310");
    expect(src(b)).toContain("marker=30.27520,-89.78120");
  });
});

describe("service_area_chips", () => {
  const AREAS = [
    AREA(), // Chalmette
    AREA({ area_slug: "arabi-la", city: "Arabi", landmarks_blurb: "Along St Claude to the levee." }),
    AREA({ area_slug: "meraux-la", city: "Meraux", landmarks_blurb: "Between Judge Perez and the river." }),
  ];
  const chipsCtx = () => {
    const c = ctxFor(AREAS[0]) as unknown as Record<string, unknown>;
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
    const c = chipsCtx() as unknown as Record<string, unknown>;
    c.pages = []; // nothing provisioned yet
    const html = SECTION_RENDERERS.service_area_chips(c as unknown as RenderCtx);
    // No links — a chip must never promise a page that is not there — but the
    // hover behaviour does not depend on navigation.
    expect(html).not.toContain("trades-chip-link");
    expect((html.match(/data-area-blurb="/g) ?? []).length).toBe(3);
    expect(html).toContain("trades-chip-static");
  });

  it("quotes in a blurb cannot break out of the attribute", () => {
    const c = chipsCtx() as unknown as Record<string, unknown>;
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

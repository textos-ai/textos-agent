// Grouped nav: resolution, dead-link filtering and group collapse.
//
// The dropdown is on all eight pages, so its failure modes are pinned here rather
// than left to a visual check: a child whose section renders nowhere must drop, a
// group whose children all drop must stop being a dropdown, and the parent must
// read active when a child page is current.
import { describe, it, expect } from "vitest";
import { buildNavForTest, type NavItemDef } from "../lib/site-render/sections";

const PAGES = [
  { page_type: "home", route_path: "/", title: null, noindex: false },
  { page_type: "projects", route_path: "/projects", title: null, noindex: false },
  { page_type: "why_us", route_path: "/why-us", title: null, noindex: false },
  { page_type: "faq", route_path: "/faq", title: null, noindex: false },
];
const DEF: NavItemDef[] = [
  { label: "About Us", children: [
    { label: "Our Work", page_type: "projects", section_key: "featured_work" },
    { label: "Why Us", page_type: "why_us" },
    { label: "FAQ", page_type: "faq", section_key: "faq_teaser" },
    { label: "Reviews", section_key: "reviews" },
  ]},
];

describe("grouped nav", () => {
  it("keeps a child whose section renders somewhere, drops one that renders nowhere", () => {
    const withReviews = buildNavForTest(DEF, PAGES, "/faq", { reviews: "/" });
    expect(withReviews[0].children!.map((c) => c.label)).toEqual(["Our Work", "Why Us", "FAQ", "Reviews"]);

    const noReviews = buildNavForTest(DEF, PAGES, "/faq", {});
    expect(noReviews[0].children!.map((c) => c.label)).toEqual(["Our Work", "Why Us", "FAQ"]);
  });

  it("drops the group entirely when every child drops", () => {
    expect(buildNavForTest(DEF, [], "/", {})).toEqual([]);
  });

  it("marks the parent active when a child page is current", () => {
    expect(buildNavForTest(DEF, PAGES, "/faq", {})[0].active).toBe(true);
    expect(buildNavForTest(DEF, PAGES, "/", {})[0].active).toBe(false);
  });

  it("is a group only when it has children", () => {
    const flat = buildNavForTest([{ label: "Why Us", page_type: "why_us" }], PAGES, "/", {});
    expect(flat[0].is_group).toBeUndefined();
    expect(flat[0].href).toBe("/sites/x/why-us");
  });
});

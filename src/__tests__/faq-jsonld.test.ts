// FAQPage JSON-LD emit path.
//
// This cannot be verified by effect on the live test site: business_faqs is empty
// for the only provisioned business, and inventing FAQ content for a real
// client's site to make a check pass is not an option. So the contract is pinned
// here instead — that faq_accordion feeds the SAME array the graph is built from,
// which is the property that makes the schema unable to disagree with the page.
import { describe, it, expect } from "vitest";
import { SECTION_RENDERERS } from "../lib/site-render/sections";
import { buildGraph, type FaqEntry } from "../lib/site-render/jsonld";
import type { SiteFacts } from "../lib/site-render/facts";

/** Minimal facts: only the fields the FAQ renderer reads. */
function factsWithFaqs(faqs: Array<{ question: string; answer: string; scope: string }>): SiteFacts {
  return {
    profile: null,
    hours: [],
    services: [],
    areas: [],
    faqs: faqs.map((f, i) => ({ id: `f${i}`, display_order: i, ...f })),
    projects: [],
    differentiators: [],
    media: [],
    context: {},
  } as unknown as SiteFacts;
}

function ctxWith(facts: SiteFacts, collected: FaqEntry[]) {
  return {
    facts,
    f: { get: () => null, label: (_k: string, d: string) => d, require: () => "" },
    businessName: "Test Co",
    canonicalUrl: "https://example.com/sites/test/faq",
    faqs: collected,
    renderedAnchors: new Set<string>(),
    pages: [{ page_type: "faq", route_path: "/faq", title: null, noindex: false }],
    currentPath: "/faq",
    basePath: "/sites/test",
    pageSectionKeys: new Set(["faq_accordion"]),
  } as never;
}

const OPTS = {
  canonicalUrl: "https://example.com/sites/test/faq",
  siteHomeUrl: "https://example.com/sites/test",
  origin: "https://example.com",
  businessName: "Test Co",
  description: null,
  logoUrl: null,
  imageUrl: null,
};

describe("FAQPage JSON-LD", () => {
  it("emits one Question per rendered answer, from the array the renderer filled", () => {
    const collected: FaqEntry[] = [];
    const facts = factsWithFaqs([
      { question: "Do you offer free estimates?", answer: "Yes, on residential work.", scope: "global" },
      { question: "Are you licensed?", answer: "Yes, and insured.", scope: "global" },
    ]);
    const html = SECTION_RENDERERS.faq_accordion(ctxWith(facts, collected));

    expect(html).not.toBe("");
    expect(collected).toHaveLength(2);

    const graph = buildGraph(facts, OPTS, collected, "faq") as { "@graph": Array<Record<string, unknown>> };
    const faqNode = graph["@graph"].find((n) => n["@type"] === "FAQPage");
    expect(faqNode).toBeDefined();
    const entities = faqNode!.mainEntity as Array<Record<string, unknown>>;
    // The count must match what rendered. The source mockup shipped 8 questions in
    // its schema against 9 on the page; that is what this asserts cannot happen.
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("Do you offer free estimates?");
    expect((entities[0].acceptedAnswer as Record<string, unknown>).text).toBe("Yes, on residential work.");
  });

  it("deduplicates a question that appears in both the teaser and the global set", () => {
    const collected: FaqEntry[] = [];
    const facts = factsWithFaqs([
      { question: "Are you licensed?", answer: "Yes.", scope: "home_teaser" },
      { question: "are you licensed?", answer: "Yes, and insured.", scope: "global" },
    ]);
    SECTION_RENDERERS.faq_accordion(ctxWith(facts, collected));
    expect(collected).toHaveLength(1);
  });

  it("renders nothing and emits no FAQPage node when there are no questions", () => {
    const collected: FaqEntry[] = [];
    const facts = factsWithFaqs([]);
    // Empty sections must not render: an operator-facing "add these in Business
    // Facts" line was reaching real visitors on JK's FAQ page before this.
    expect(SECTION_RENDERERS.faq_accordion(ctxWith(facts, collected))).toBe("");
    expect(collected).toHaveLength(0);

    const graph = buildGraph(facts, OPTS, collected, "faq") as { "@graph": Array<Record<string, unknown>> };
    expect(graph["@graph"].some((n) => n["@type"] === "FAQPage")).toBe(false);
  });

  it("emits no Service node on a page type that is not the services page", () => {
    const facts = factsWithFaqs([]);
    const graph = buildGraph(facts, OPTS, [], "faq") as { "@graph": Array<Record<string, unknown>> };
    expect(graph["@graph"].some((n) => n["@type"] === "Service")).toBe(false);
  });
});

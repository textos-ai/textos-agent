// Structured data, generated from the structured facts.
//
// Correct by construction — never authored by a model. Every value here traces
// to a business_profile / business_hours / business_services /
// business_service_areas row.
//
// THREE DEFECTS IN THE SOURCE TEMPLATE, DELIBERATELY NOT INHERITED:
//
// 1. It emitted ONE @id (https://…/#business) across all 11 pages while varying
//    geo and areaServed per page — the same entity claiming ten different
//    coordinate pairs. Here the LocalBusiness @id is the page's own canonical
//    URL + '#business', and geo/areaServed describe that page only. One page,
//    one non-conflicting entity.
//
// 2. It shipped no aggregateRating/Review node despite a visible reviews
//    section. We add none either — there are no real reviews. Emitting a rating
//    without reviews would be a fabricated claim, and AI-generated review
//    content is prohibited outright (textos-agent/CLAUDE.md, FTC grounds).
//
// 3. Its area pages used relative image paths (/jk-quality-electric/mockup/…)
//    that resolve to nothing at a production origin. Every URL here is absolute.

import {
  type SiteFacts,
  type ProfileRow,
  SCHEMA_DAYS,
  telHref,
} from "./facts";

export interface JsonLdOptions {
  canonicalUrl: string;   // absolute, e.g. https://app.textos.ai/sites/jkqualityelectric
  /** The site's HOME url. The business entity is anchored here, not to the page
   *  being rendered — see the @id note below. */
  siteHomeUrl: string;
  origin: string;         // absolute origin for image URLs
  businessName: string;
  description: string | null;
  logoUrl: string | null;
  imageUrl: string | null;
}

/** Group per-day rows into openingHoursSpecification entries. */
function openingHours(facts: SiteFacts) {
  const open = facts.hours.filter((h) => !h.is_closed && h.opens && h.closes);
  if (open.length === 0) return undefined;

  const bySlot = new Map<string, string[]>();
  for (const h of open) {
    const slot = `${(h.opens as string).slice(0, 5)}|${(h.closes as string).slice(0, 5)}`;
    const list = bySlot.get(slot) ?? [];
    list.push(SCHEMA_DAYS[h.day_of_week]);
    bySlot.set(slot, list);
  }
  return [...bySlot.entries()].map(([slot, days]) => {
    const [opens, closes] = slot.split("|");
    return {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: days,
      opens,
      closes,
    };
  });
}

function postalAddress(p: ProfileRow) {
  const addr: Record<string, unknown> = { "@type": "PostalAddress" };
  if (p.street_address) addr.streetAddress = p.street_address;
  if (p.locality) addr.addressLocality = p.locality;
  if (p.region) addr.addressRegion = p.region;
  if (p.postal_code) addr.postalCode = p.postal_code;
  if (p.country) addr.addressCountry = p.country;
  // Only "@type" means we know nothing — omit the node entirely rather than
  // emit an empty address.
  return Object.keys(addr).length > 1 ? addr : undefined;
}

export function buildLocalBusiness(facts: SiteFacts, opts: JsonLdOptions): Record<string, unknown> | null {
  const p = facts.profile;
  if (!p) return null;

  const node: Record<string, unknown> = {
    "@type": "LocalBusiness",
    // ONE ENTITY FOR THE WHOLE SITE, anchored to the home URL.
    //
    // This previously used the page's own canonical, which produced eight
    // different @ids for one electrician — .../services#business,
    // .../privacy-policy#business and so on — and a search engine reads those as
    // eight separate businesses. Over-correcting the source template's mirror
    // defect (one @id across pages with conflicting geo) landed us on the
    // opposite fault. The entity is the same on every page because it IS the same
    // business; only the page-level nodes vary.
    "@id": `${opts.siteHomeUrl}#business`,
    name: p.legal_name || opts.businessName,
    url: opts.siteHomeUrl,
    // One business, two roles: the legal entity and the place. Linked rather
    // than left as two unrelated nodes.
    parentOrganization: { "@id": `${opts.siteHomeUrl}#organization` },
  };

  if (p.alternate_name) node.alternateName = p.alternate_name;
  if (opts.description) node.description = opts.description;
  if (p.phone) node.telephone = telHref(p.phone);
  if (p.email) node.email = p.email;

  // Defect #3 fix: absolute URLs only.
  if (opts.imageUrl) node.image = opts.imageUrl;
  if (opts.logoUrl) node.logo = opts.logoUrl;

  const address = postalAddress(p);
  if (address) node.address = address;

  if (p.geo_lat !== null && p.geo_lng !== null) {
    node.geo = { "@type": "GeoCoordinates", latitude: p.geo_lat, longitude: p.geo_lng };
  }

  const hours = openingHours(facts);
  if (hours) node.openingHoursSpecification = hours;

  if (facts.areas.length > 0) {
    node.areaServed = facts.areas.map((a) => ({
      "@type": "City",
      name: a.city,
      ...(a.region ? { containedInPlace: { "@type": "AdministrativeArea", name: a.region } } : {}),
    }));
  }

  if (p.license_number) {
    node.hasCredential = p.license_authority
      ? `${p.license_authority} License #${p.license_number}`
      : `License #${p.license_number}`;
  }

  if (facts.services.length > 0) {
    node.makesOffer = facts.services.map((s) => ({
      "@type": "Offer",
      itemOffered: {
        "@type": "Service",
        name: s.name,
        ...(s.blurb ? { description: s.blurb } : {}),
      },
    }));
  }

  // Defect #2: no aggregateRating, no review[]. There are no real reviews.
  return node;
}

export interface FaqEntry { question: string; answer: string }

export function buildFaqPage(faqs: FaqEntry[]): Record<string, unknown> | null {
  if (faqs.length === 0) return null;
  return {
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

/**
 * Service node for the services page — provider, areaServed from
 * business_service_areas, and serviceType from business_services.
 */
export function buildService(facts: SiteFacts, opts: JsonLdOptions): Record<string, unknown> | null {
  if (facts.services.length === 0) return null;
  const p = facts.profile;
  const provider: Record<string, unknown> = {
    "@type": "LocalBusiness",
    "@id": `${opts.siteHomeUrl}#business`,
    name: p?.legal_name || opts.businessName,
  };
  if (p?.phone) provider.telephone = telHref(p.phone);
  if (p?.license_number) {
    provider.hasCredential = p.license_authority
      ? `${p.license_authority} License #${p.license_number}`
      : `License #${p.license_number}`;
  }
  const node: Record<string, unknown> = {
    "@type": "Service",
    provider,
    serviceType: facts.services.map((s) => s.name),
  };
  if (facts.areas.length > 0) node.areaServed = facts.areas.map((a) => a.city);
  return node;
}

/**
 * ContactPage for the contact page (2B).
 *
 * Deliberately thin: the contact details themselves already live on the
 * LocalBusiness node in the same graph, and repeating telephone/address here
 * would describe one business twice with two ids. This node says "this URL is the
 * contact page for that entity" and points at it.
 */
export function buildContactPage(opts: JsonLdOptions): Record<string, unknown> {
  return {
    "@type": "ContactPage",
    "@id": `${opts.canonicalUrl}#contact`,
    url: opts.canonicalUrl,
    name: `Contact ${opts.businessName}`,
    about: { "@id": `${opts.siteHomeUrl}#business` },
  };
}

/**
 * Organization and WebSite — the two site-level entities (B4).
 *
 * Both are anchored to the site home, like the LocalBusiness, so all three ids are
 * stable across every page. Organization is the legal entity; LocalBusiness is the
 * same body as a place customers visit, and `parentOrganization` ties them rather
 * than leaving two unrelated nodes describing one business.
 *
 * No SearchAction on WebSite: the site has no search endpoint, and claiming one
 * that 404s is a fabricated capability.
 */
export function buildOrganization(facts: SiteFacts, opts: JsonLdOptions): Record<string, unknown> {
  const p = facts.profile;
  const node: Record<string, unknown> = {
    "@type": "Organization",
    "@id": `${opts.siteHomeUrl}#organization`,
    name: p?.legal_name || opts.businessName,
    url: opts.siteHomeUrl,
  };
  if (opts.logoUrl) node.logo = opts.logoUrl;
  if (p?.phone) node.telephone = telHref(p.phone);
  const sameAs = [p?.google_business_url, p?.facebook_url, p?.instagram_url].filter(Boolean);
  if (sameAs.length > 0) node.sameAs = sameAs;
  return node;
}

export function buildWebSite(opts: JsonLdOptions): Record<string, unknown> {
  return {
    "@type": "WebSite",
    "@id": `${opts.siteHomeUrl}#website`,
    url: opts.siteHomeUrl,
    name: opts.businessName,
    publisher: { "@id": `${opts.siteHomeUrl}#organization` },
  };
}

export interface Crumb { name: string; url: string }

/**
 * BreadcrumbList for any page below the top level. The reference emits one on its
 * area pages; matching it means an answer engine can place a page in the site
 * rather than treating every URL as a root.
 *
 * Omitted on home — a single-item trail states nothing.
 */
export function buildBreadcrumbs(crumbs: Crumb[]): Record<string, unknown> | null {
  if (crumbs.length < 2) return null;
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

/**
 * Assemble the @graph for a page. Nodes that cannot be built honestly are
 * simply absent — no empty rating, no invented entity.
 *
 * `faqs` is the array the FAQ renderer populated while rendering, so the schema
 * is generated from EXACTLY what appeared. The source template shipped 8
 * questions in its JSON-LD against 9 rendered; that mismatch is structurally
 * impossible here.
 */
export function buildGraph(
  facts: SiteFacts,
  opts: JsonLdOptions,
  faqs: FaqEntry[],
  pageType = "home",
  breadcrumbs: Crumb[] = [],
): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [];
  const lb = buildLocalBusiness(facts, opts);
  if (lb) graph.push(lb);
  // Site-level entities, identical on every page (B4).
  graph.push(buildOrganization(facts, opts));
  graph.push(buildWebSite(opts));
  const crumbs = buildBreadcrumbs(breadcrumbs);
  if (crumbs) graph.push(crumbs);
  if (pageType === "services") {
    const svc = buildService(facts, opts);
    if (svc) graph.push(svc);
  }
  if (pageType === "contact") graph.push(buildContactPage(opts));
  const faq = buildFaqPage(faqs);
  if (faq) graph.push(faq);
  return { "@context": "https://schema.org", "@graph": graph };
}

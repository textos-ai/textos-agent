// Section renderers for the trades-v1 home page.
//
// Each renderer COMPOSES catalog components via renderTemplate() — it does not
// hand-write structural markup. Section wrappers carry trades-* class names that
// textos-web/public/sites/trades-v1.css styles; the inner markup is whatever the
// catalog entry emits (Bootstrap/Homer class names), styled by the same sheet.
//
// The slug→renderer map at the bottom is execution logic, not data — the same
// acceptable-constant pattern as FREE_BUILD_TASK_HANDLERS. WHICH sections render
// and in WHAT ORDER comes from site_sections in the database, seeded from the
// template's section_catalog. Adding a section to the template requires no code
// change here unless it is a genuinely new KIND of section, exactly as adding a
// task requires a handler.
//
// CSS NOTE: nothing here emits a <style> tag. All styling ships from the web
// origin as a linked stylesheet. Agent-rendered markup cannot carry Astro's
// data-astro-cid attribute, so a scoped <style> would never match it.

import { getComponent } from "../component-catalog";
import { renderTemplate } from "../assembler/template";
import {
  MissingFactError,
  type SiteFacts,
  addressLine,
  summarizeHours,
  telHref,
} from "./facts";
import type { FieldResolver } from "./resolver";
import type { FaqEntry } from "./jsonld";

/** A named document produced from a page type — see migration 102. */
export interface PageInstanceDef {
  instance_key: string;
  route: string;
  title?: string | null;
}

/** One nav entry. A group has children and no page_type. */
export interface NavItemDef {
  label: string;
  page_type?: string;
  section_key?: string;
  children?: NavItemDef[];
  /** Expand children from a live source rather than the template (C5). */
  children_from?: string;
}

export interface RenderCtx {
  facts: SiteFacts;
  f: FieldResolver;
  businessName: string;
  canonicalUrl: string;
  /** Collected by faq_teaser so the JSON-LD builder emits exactly what rendered. */
  faqs: FaqEntry[];
  /**
   * Anchors of the sections that actually produced output. site_nav and
   * site_footer render in a SECOND pass so their links can be filtered against
   * this — otherwise the nav offers "Our Work" and "FAQ" on a site with no
   * projects and no questions, and the link goes nowhere. A menu item that
   * scrolls to nothing is the same "where does this go" failure this pass is
   * about, seen from the visitor's side.
   */
  renderedAnchors: Set<string>;
  /** Every page on this site, from site_pages. Drives cross-page nav.
   *
   *  instance_key is the JOIN KEY back to the fact that generated the page — the
   *  area_slug on an area page. Optional only because the nav resolution genuinely
   *  does not need it and the test seam does not supply it; compose always sets it.
   *  Matching on `title` instead (what area_card_grid did) breaks the moment an
   *  operator renames a page, and silently: the card keeps rendering, minus its
   *  blurb. */
  pages: Array<{
    page_type: string; route_path: string; title: string | null; noindex: boolean;
    instance_key?: string | null;
  }>;
  /**
   * Every section key DECLARED on this page, known before any renderer runs.
   * renderedAnchors is only complete in the second pass, so a first-pass section
   * that needs to link to a sibling (the service cards' "Book this service")
   * cannot use it. This set can be consulted from either pass.
   */
  pageSectionKeys: Set<string>;
  /**
   * route_path → section keys declared on that page, for the WHOLE site. Lets an
   * anchor link resolve to the page that hosts its section, which is what makes
   * the nav identical everywhere instead of shrinking on pages that happen not to
   * contain the target.
   */
  sectionsByPath: Map<string, Set<string>>;
  /**
   * The template's definition of THIS page instance, when the page type has any.
   * legal uses it: terms-of-service and privacy-policy share a section list and
   * differ in route, title and meta, so the renderers do not need a per-document
   * variant. Kept after 103 removed the clause structure because the instance is
   * still what distinguishes the two documents.
   */
  pageInstance: PageInstanceDef | null;
  /** site_pages.instance_key for this page — the area slug on an area page. */
  instanceKey: string | null;
  /** The template's nav definition (migration 104). Null falls back to the
   *  pre-104 hardcoded order, so this deploys safely before the migration. */
  navDef: NavItemDef[] | null;
  /** route_path of the page being rendered, for the active state. */
  currentPath: string;
  /** URL prefix the site is served under, e.g. "/sites/jkqualityelectric". */
  basePath: string;
}

/** Sections deferred to the second pass, because they link to the others. */
/**
 * Sections whose AUTHORED copy is site-wide, not per page.
 *
 * site_fields rows hang off a section_id, and every page has its own row for the
 * shared chrome — so an authored cta_headline on home did nothing on
 * /services, /why-us or /faq, which fell back to the template default and showed a
 * different CTA band on every page. Same latent fault for the nav tagline, the
 * footer tagline and the sticky-bar labels.
 *
 * For these keys the HOME page's value wins everywhere, which is what the section
 * descriptions written in 101 and 102 already promise the operator ("Edit it once
 * under Home and it changes everywhere") — a promise the code did not keep. The
 * manager offers them only under Home, so nobody edits a copy that is then
 * ignored.
 *
 * page_hero, story_prose and the rest are deliberately absent: those SHOULD differ
 * per page.
 */
export const SHARED_AUTHORED_SECTIONS = new Set([
  "site_nav",
  "site_footer",
  "cta_band",
  "mobile_sticky_bar",
]);

export const SECOND_PASS_SECTIONS = new Set(["site_nav", "site_footer"]);

export type SectionRenderer = (ctx: RenderCtx) => string;

/** Compose a catalog component by id. Halts if the id is not in the catalog. */
function comp(id: string, view: Record<string, unknown>): string {
  const entry = getComponent(id);
  if (!entry) {
    throw new Error(
      `Catalog component '${id}' not found. Add it to the catalog under the 'site' archetype — never hand-write a replacement (src/lib/CLAUDE.md).`,
    );
  }
  return renderTemplate(entry.html_template, view);
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Anchor id for a section, DERIVED from its section_key.
 *
 * Every section gets one so the manager's "View on site" link can always point
 * at the right place. Derived rather than hand-picked because hand-picked
 * anchors drift: before this, six of fourteen sections had no id at all, and the
 * nav linked to #work and #faq-home, neither of which existed on the rendered
 * page. business-site.ts imports this same function, so the link and the target
 * cannot disagree.
 */
export function anchorFor(sectionKey: string): string {
  return sectionKey.replace(/_/g, "-");
}

/** Section shell. `id` becomes the anchor the nav and the manager link to. */
function section(key: string, id: string | null, inner: string, extraClass = ""): string {
  return `<section class="trades-section trades-${esc(key)}${extraClass ? " " + esc(extraClass) : ""}"${id ? ` id="${esc(id)}"` : ""}>${inner}</section>`;
}

function head(eyebrow: string | undefined, headline: string | undefined, sub?: string): string {
  if (!eyebrow && !headline && !sub) return "";
  return `<header class="trades-head">${
    eyebrow ? `<div class="trades-eyebrow">${esc(eyebrow)}</div>` : ""
  }${headline ? `<h2 class="trades-title">${esc(headline)}</h2>` : ""}${
    sub ? `<p class="trades-sub">${esc(sub)}</p>` : ""
  }</header>`;
}

/** Logo media row → URL, or null. Nav/footer fall back to the wordmark. */
function logoUrl(ctx: RenderCtx): string | null {
  const m = ctx.f.get<{ url?: string }>("logo_image");
  return m && typeof m === "object" && typeof m.url === "string" ? m.url : null;
}
function logoAlt(ctx: RenderCtx): string {
  const m = ctx.f.get<{ alt_text?: string | null }>("logo_image");
  return (m && typeof m === "object" && m.alt_text) || `${ctx.businessName} logo`;
}

/** Absolute href for a page's route_path under this site's base path. */
export function pageHref(ctx: RenderCtx, routePath: string): string {
  if (routePath === "/") return ctx.basePath || "/";
  return `${ctx.basePath}${routePath}`;
}

/**
 * Does this section have content to render?
 *
 * Every emptiness test in this file is a pure function of `facts` — none of them
 * read a per-page field — so the answer is the SAME on every page. That is what
 * lets the nav decide whether a section renders on a page it is not currently
 * rendering, without having to render it.
 *
 * The renderers below call this for their own early return, so there is exactly
 * one definition of "empty" per section and the nav cannot disagree with the page.
 * A key that is absent here always renders (reviews, for one, has a real empty
 * state and is never dropped).
 */
export function sectionHasContent(key: string, facts: SiteFacts): boolean {
  switch (key) {
    case "services_grid":
    case "service_detail":
      return facts.services.length > 0;
    case "featured_work":
      return facts.projects.some((pr) => !!pr.media_id && !!facts.media[pr.media_id]);
    case "service_area_chips":
      return facts.areas.length > 0;
    // The teaser falls back from home_teaser to global, so an 'area'-scoped
    // question alone is not enough to fill either block.
    case "faq_teaser":
    case "faq_accordion":
      return facts.faqs.some((f) => f.scope === "home_teaser" || f.scope === "global");
    // differentiator_band is DELIBERATELY ABSENT. It also renders on a band_body
    // field alone, so its emptiness is not a pure function of facts and it would
    // break the invariant this function is built on. It is not an anchor target,
    // so nothing needs it here — and a wrong answer would be worse than none.
    case "differentiator_list":
      return facts.differentiators.length > 0;
    case "cta_band":
      return !!(facts.profile?.phone || facts.profile?.email);
    case "license_callout":
      return !!facts.profile?.license_number;
    default:
      return true;
  }
}

/**
 * The route_path of the page that hosts a section AND renders it, or null.
 *
 * Current page first, using renderedAnchors — that is ground truth, not a model,
 * and it is complete by the time nav and footer render in the second pass. For any
 * other page we fall back to the facts predicate above, preferring home so the
 * same section always resolves to the same URL across the site.
 */
function hostPathFor(ctx: RenderCtx, sectionKey: string): string | null {
  if (ctx.pageSectionKeys.has(sectionKey)) {
    return ctx.renderedAnchors.has(anchorFor(sectionKey)) ? ctx.currentPath : null;
  }
  if (!sectionHasContent(sectionKey, ctx.facts)) return null;

  const hosts = [...ctx.sectionsByPath.entries()]
    .filter(([, keys]) => keys.has(sectionKey))
    .map(([routePath]) => routePath);
  if (hosts.length === 0) return null;
  return hosts.includes("/") ? "/" : hosts[0];
}

/**
 * Href to a section anywhere on the site — "#anchor" when it is on this page,
 * "/sites/{slug}/path#anchor" when it lives on another one. Null when the section
 * renders NOWHERE, which is the one case where a link is still dropped.
 *
 * THE SINGLE RESOLUTION. navLinks (and therefore the footer's quick links, which
 * call it) and bookHref all go through here, so a cross-page target is computed
 * one way only.
 */
export function anchorHref(ctx: RenderCtx, sectionKey: string): string | null {
  const path = hostPathFor(ctx, sectionKey);
  if (path === null) return null;
  const frag = `#${anchorFor(sectionKey)}`;
  return path === ctx.currentPath ? frag : `${pageHref(ctx, path)}${frag}`;
}

/**
 * Nav/footer links — PAGES first, then anchors on the current page.
 *
 * Page links come from site_pages, so a page that does not exist cannot be
 * linked. That is how the mockup's "Service Areas" dropdown disappears on its
 * own: area_index ships in 2C, there is no row for it yet, and the filter drops
 * it with no special case.
 *
 * IDENTICAL ON EVERY PAGE. This list is the same items in the same order on every
 * page of the site; only `active` differs. One template serves every client, and
 * chrome that changes shape as a visitor moves around reads as a broken site.
 *
 * The filter did not go away — what it resolves to changed. An anchor link now
 * resolves to the page that HOSTS its section: "#reviews" while you are on home,
 * "/sites/{slug}#reviews" once you are not. Before this, /services and /faq showed
 * fewer items than home because an anchor whose target was absent from the current
 * page was dropped outright.
 *
 * The dead-link guarantee is unchanged and comes from the same place: a section
 * that renders NOWHERE on the site still drops out entirely (see anchorHref). An
 * anchor is still only offered when no page covers the same ground.
 */
export interface NavLink {
  label: string; href: string; active: boolean;
  is_group?: boolean; children?: NavLink[];
}

/**
 * Nav/footer links, STRUCTURED BY THE TEMPLATE (migration 104).
 *
 * Resolution per item is unchanged from the hardcoded version: prefer a real page
 * of page_type, fall back to an anchor on section_key resolved through
 * anchorHref, drop out when neither resolves. anchorHref returns null when a
 * section renders NOWHERE on the site, so the dead-link guarantee is identical for
 * a child and for a top-level item.
 *
 * A group is a button parent with no destination of its own. If every child drops
 * the group drops with them, so a dropdown can never open onto nothing. The parent
 * shows active when any child is the current page.
 *
 * IDENTICAL ON EVERY PAGE: the item set depends only on which pages and sections
 * exist site-wide, never on which page is being rendered — only `active` and the
 * same-page-vs-cross-page href form differ.
 */
function resolveNavItem(ctx: RenderCtx, def: NavItemDef): NavLink | null {
  // C5: children the template cannot list, because they are one per service area
  // per business. The item names its SOURCE and the children are expanded here —
  // second instance of the same dropdown component, no new pattern.
  if (def.children_from === "area_pages") {
    const parent = def.page_type
      ? ctx.pages.find((x) => x.page_type === def.page_type && !x.noindex)
      : undefined;
    const children: NavLink[] = ctx.pages
      .filter((p) => p.page_type === "area_detail" && !p.noindex)
      .map((p) => ({
        label: p.title ?? "",
        href: pageHref(ctx, p.route_path),
        active: p.route_path === ctx.currentPath,
      }));
    // No areas yet: fall through to the plain page/anchor resolution below, so
    // the item is a normal link rather than a dropdown onto nothing.
    if (children.length > 0) {
      return {
        label: def.label,
        // Unlike About Us, this parent IS a page — the area index.
        href: parent ? pageHref(ctx, parent.route_path) : "",
        is_group: true,
        children,
        active: (parent ? parent.route_path === ctx.currentPath : false)
          || children.some((c) => c.active),
      };
    }
  }
  if (def.children?.length) {
    const children = def.children
      .map((c) => resolveNavItem(ctx, c))
      .filter((c): c is NavLink => c !== null);
    if (children.length === 0) return null;
    return {
      label: def.label, href: "", is_group: true, children,
      active: children.some((c) => c.active),
    };
  }
  if (def.page_type) {
    const page = ctx.pages.find((x) => x.page_type === def.page_type && !x.noindex);
    if (page) {
      return {
        label: def.label,
        href: pageHref(ctx, page.route_path),
        active: page.route_path === ctx.currentPath,
      };
    }
  }
  if (def.section_key) {
    const href = anchorHref(ctx, def.section_key);
    if (href) return { label: def.label, href, active: false };
  }
  return null;
}

/** Pre-104 fallback, so the renderer works before the migration is applied. */
const DEFAULT_NAV: NavItemDef[] = [
  { label: "Services", page_type: "services", section_key: "services_grid" },
  { label: "Our Work", page_type: "projects", section_key: "featured_work" },
  { label: "Service Areas", page_type: "area_index", section_key: "service_area_chips" },
  { label: "Why Us", page_type: "why_us" },
  { label: "FAQ", page_type: "faq", section_key: "faq_teaser" },
  { label: "Contact", page_type: "contact", section_key: "cta_band" },
];

/** Month names spelled out: a legal document should not read "7/30/2026", and a
 *  Worker has no reliable locale to defer to. */
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * Render a last-updated date as "July 30, 2026".
 *
 * Passes the operator's text through UNCHANGED when it is not a date we can read,
 * because they may have written "Revised at launch" and inventing a date for a
 * legal document is not something to do quietly.
 */
export function formatLegalDate(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const us = /^(\d{1,2})[/](\d{1,2})[/](\d{4})$/.exec(t);
  let y: number, m: number, d: number;
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
  else return t;
  if (m < 1 || m > 12 || d < 1 || d > 31) return t;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Footer link list: groups are replaced by their children.
 *
 * A group parent has no page of its own, so the nav renders it as a button. The
 * footer emitted the same list as plain links and produced `<a href="">About Us</a>`
 * — a dead link that reloads the page. A footer is a flat index, so the children
 * stand in for the parent and an empty href can no longer be constructed.
 */
function flattenNav(links: NavLink[]): NavLink[] {
  return links.flatMap((l) => (l.is_group && l.children?.length ? l.children : l.href ? [l] : []));
}

function navLinks(ctx: RenderCtx): NavLink[] {
  return (ctx.navDef ?? DEFAULT_NAV)
    .map((d) => resolveNavItem(ctx, d))
    .filter((x): x is NavLink => x !== null);
}


/**
 * Links to the site's legal documents, for the footer.
 *
 * Generated from the page list, so a template with no legal pages shows none and
 * a template with different documents gets its own labels.
 */
function legalLinks(ctx: RenderCtx): Array<{ href: string; label: string }> {
  return ctx.pages
    .filter((p) => p.page_type === "legal" && p.title)
    .map((p) => ({ href: pageHref(ctx, p.route_path), label: p.title as string }));
}

/**
 * The booking target for the page being rendered.
 *
 * This used to be the module constant bookHref(ctx) = "#cta-band", which is wrong
 * on any page without a cta_band: the FAQ page has faq_footer_cta instead, so its
 * primary "Book Online" button pointed at an id that did not exist on the page
 * and did nothing when clicked. Verified on test before the fix.
 *
 * Resolution order, first match wins:
 *   1. a dedicated contact page, when the template has one (2B)
 *   2. a booking section ON THIS PAGE — scrolling beats navigating away
 *   3. cta_band wherever it lives, via the same anchorHref the nav uses
 *
 * Step 2 checks pageSectionKeys directly because it is a LOCALITY preference, not
 * a resolution: anchorHref would happily hand back another page's cta_band, and on
 * the FAQ page the local faq_footer_cta is the better target. Steps 2 and 3 both
 * resolve through anchorHref, so there is one cross-page mechanism, not two.
 */
const BOOKING_SECTIONS = ["cta_band", "faq_footer_cta"];

function bookHref(ctx: RenderCtx): string {
  const contact = ctx.pages.find((x) => x.page_type === "contact");
  if (contact) return pageHref(ctx, contact.route_path);

  for (const k of BOOKING_SECTIONS) {
    if (!ctx.pageSectionKeys.has(k)) continue;
    const local = anchorHref(ctx, k);
    if (local) return local;
  }

  // Nothing local — point at cta_band wherever it renders. The final fallback is
  // only reached on a site whose every page lacks a booking section.
  return anchorHref(ctx, "cta_band") ?? `#${anchorFor("cta_band")}`;
}

// ── 1. site_nav ────────────────────────────────────────────────────────────
const site_nav: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  return comp("site-nav", {
    // The client's OWN home, not "/". A hardcoded "/" is this deployment's
    // marketing homepage, so clicking the client's logo left their site entirely.
    home_href: pageHref(ctx, "/"),
    business_name: ctx.businessName,
    tagline: ctx.f.get<string>("tagline") ?? null,
    logo_url: logoUrl(ctx),
    logo_alt: logoAlt(ctx),
    links: navLinks(ctx),
    phone_display: p?.phone ?? null,
    phone_href: p?.phone ? telHref(p.phone) : null,
    cta_label: ctx.f.label("nav_cta_label", "Book Online"),
    cta_href: bookHref(ctx),
  });
};

/** Derived trust items — license, tenure, hours, guarantee. Shared by the hero. */
function trustItems(ctx: RenderCtx): Array<{ label: string }> {
  const p = ctx.facts.profile;
  const items: Array<{ label: string }> = [];
  if (p?.license_number) items.push({ label: `Licensed #${p.license_number}` });
  const years = ctx.f.get<string>("years_in_business");
  if (years) items.push({ label: `${years} Years Local` });
  const open = summarizeHours(ctx.facts.hours).filter((h) => h.value !== "Closed");
  if (open.length > 0) items.push({ label: `${open[0].day} ${open[0].value}` });
  if (ctx.facts.areas.length > 0) items.push({ label: `Serving ${ctx.facts.areas[0].city}` });
  return items;
}

// ── 2. hero_home ───────────────────────────────────────────────────────────
// Composes `hero-media`, NOT Homer's `section-hero`. section-hero is a centred
// light text block from landing.html — the wrong layout for a trades site, and
// media does not fix it. Trust items are folded IN here per the mockup rather
// than rendering as a separate band below (see trust_bar).
const hero_home: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  // Hero copy is SITE-AUTHORED. Everything else on the hero is DERIVED.
  const headline = ctx.f.require<string>("hero_headline");

  const media = ctx.f.get<{
    url: string; alt_text: string | null; kind: string; mime_type: string | null;
    width: number | null; height: number | null; poster_url: string | null;
  }>("hero_image");

  // Two CTAs: primary books, secondary calls. The secondary only appears when
  // there is a real phone number to call — never a dead button.
  const primaryLabel = ctx.f.label("hero_cta_label", "Book Online");
  const secondaryLabel = p?.phone ? ctx.f.label("hero_cta_secondary_label", `Call ${p.phone}`) : null;
  const items = trustItems(ctx);

  return comp("hero-media", {
    anchor: anchorFor("hero_home"),
    has_media: !!media,
    is_video: media?.kind === "video",
    media_url: media?.url ?? null,
    media_mime: media?.mime_type ?? null,
    media_alt: media?.alt_text ?? "",
    media_width: media?.width ?? null,
    media_height: media?.height ?? null,
    poster_url: media?.poster_url ?? null,
    eyebrow: ctx.f.get<string>("hero_eyebrow") ?? null,
    headline,
    subhead: ctx.f.get<string>("hero_subhead") ?? null,
    has_ctas: true,
    cta_primary_label: primaryLabel,
    cta_primary_href: bookHref(ctx),
    cta_secondary_label: secondaryLabel,
    cta_secondary_href: p?.phone ? `tel:${telHref(p.phone)}` : null,
    has_trust: items.length > 0,
    trust_items: items,
  });
};

// ── 3. trust_bar ───────────────────────────────────────────────────────────
// RESTORED (1D part A). Migration 094 dropped this on a misreading of mine: the
// mockup has trust items in the hero AND this separate icon band below it. Its
// CSS confirms a real section — .trust-bar { background: surface; border-bottom;
// padding: 1rem 0 } with .trust-bar__item uppercase .8rem/600 muted and 16px
// accent icons.
//
// Content is entirely DERIVED — license, tenure, guarantee, hours, booking — so
// it needs no authored fields and cannot be "empty" while the facts exist.
const trust_bar: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  const items: Array<{ icon: string; label: string }> = [];

  if (p?.license_number) items.push({ icon: "\u2726", label: `Licensed #${p.license_number}` });
  const years = ctx.f.get<string>("years_in_business");
  const homeBase = ctx.f.get<string>("home_base_area");
  if (years && homeBase) items.push({ icon: "\u25C6", label: `${years} Years in ${homeBase}` });
  else if (years) items.push({ icon: "\u25C6", label: `${years} Years Local` });
  else if (homeBase) items.push({ icon: "\u25C6", label: `Local to ${homeBase}` });
  items.push({ icon: "\u2713", label: "Satisfaction Guaranteed" });
  const open = summarizeHours(ctx.facts.hours).filter((h) => h.value !== "Closed");
  if (open.length > 0) items.push({ icon: "\u25D4", label: `${open[0].day} ${open[0].value}` });
  const booking = ctx.f.get<string>("booking_url");
  if (booking) items.push({ icon: "\u2192", label: "Online Booking" });

  if (items.length === 0) return "";
  const inner = items.map((i) =>
    `<div class="trust-bar__item"><span class="trust-bar__icon" aria-hidden="true">${esc(i.icon)}</span>${esc(i.label)}</div>`,
  ).join("");
  return section("trustbar", anchorFor("trust_bar"), `<div class="trust-bar__inner">${inner}</div>`);
};

// ── 4. services_grid ───────────────────────────────────────────────────────
const services_grid: SectionRenderer = (ctx) => {
  const services = ctx.facts.services;
  if (services.length === 0) {
      // Renders NOTHING when empty. This used to emit an operator-facing line
      // ("… once they are added in Business Facts"), which named an internal admin
      // page to the client's own public visitors — seen live on JK's FAQ page. The
      // 1C rule is that empty sections do not render publicly; the site manager's
      // Sections pane is where the operator is told what to fill.
      return "";
  }
  // Mockup treatment: accent icon, condensed uppercase title (from the card
  // CSS), short blurb, bullet list, then a "Learn more" link in accent caps.
  const ICONS = ["\u26A1", "\u{1F50C}", "\u{1F50D}", "\u{1F6E0}", "\u{1F4A1}", "\u{1F50B}"];
  const cols = services.map((s, i) => ({
    size: 12, md: 6, lg: services.length >= 3 ? 4 : 6,
    content: `<div class="fade-up">${comp("card-basic", {
      // Under the section h2, so h3. The shared component still defaults to h5
      // for the app assembler, which has no section heading above it.
      heading_level: 3,
      title: s.name,
      content: `<div class="trades-card-icon" aria-hidden="true">${ICONS[i % ICONS.length]}</div>`
        + `${s.blurb ? `<p class="trades-card-blurb">${esc(s.blurb)}</p>` : ""}`
        + `${s.bullets.length
            ? comp("list-group", { items: s.bullets.slice(0, 6).map((b) => ({ label: b })) })
            : ""}`
        + `<a class="trades-card-link" href="${bookHref(ctx)}">Learn more \u2192</a>`,
    })}</div>`,
  }));
  return section("services", anchorFor("services_grid"),
    head(ctx.f.get("section_eyebrow") ?? "What We Do", ctx.f.get("section_headline") ?? "Electrical services, done right.") +
    comp("container", { content: comp("row-col", { gap: 4, cols }) }));
};

// ── 5. positioning_band ────────────────────────────────────────────────────
const positioning_band: SectionRenderer = (ctx) => {
  const quote = ctx.f.get<string>("positioning_quote")
    ?? (ctx.facts.context?.positioning_statement as string | undefined);
  // Operator-authored differentiators win over business_context's LLM-written
  // key_differentiators — the operator typed these about their own trade.
  const diffs = ctx.facts.differentiators.length > 0
    ? ctx.facts.differentiators.map((d) => d.headline)
    : ((ctx.facts.context?.key_differentiators as string[] | undefined) ?? []);
  if (!quote && diffs.length === 0) return "";
  // Pillar cards: accent display headline over muted body, centered. The
  // operator-authored differentiators carry a headline+body; context's
  // key_differentiators are flat strings and fall back to body-only.
  const rows = ctx.facts.differentiators.length > 0
    ? ctx.facts.differentiators.slice(0, 3).map((d) => ({ title: d.headline, body: d.body, icon: d.icon }))
    : diffs.slice(0, 3).map((d) => ({ title: null as string | null, body: d, icon: null as string | null }));

  const cols = rows.map((d) => ({
    size: 12, md: 4, lg: 4,
    content: `<div class="fade-up">${comp("card-basic", {
      content: `<div class="trades-pillar-card">`
        + `${d.icon ? `<div class="trades-pillar-icon" aria-hidden="true">${esc(d.icon)}</div>` : ""}`
        + `${d.title ? `<div class="trades-pillar-title">${esc(d.title)}</div>` : ""}`
        + `<p class="trades-pillar">${esc(d.body)}</p></div>`,
    })}</div>`,
  }));
  return section("positioning", anchorFor("positioning_band"),
    head(ctx.f.get("section_eyebrow") ?? `Why ${ctx.businessName}`, undefined) +
    comp("container", {
      content: `${quote ? comp("blockquote", { quote, cite: ctx.businessName }) : ""}${
        cols.length ? comp("row-col", { gap: 4, cols }) : ""
      }`,
    }));
};

// ── 6. featured_work ───────────────────────────────────────────────────────
// No project media exists yet (site_media is empty). Renders an honest empty
// state rather than the source template's six "[Replace with real photo]"
// placeholder tiles.
/**
 * Gallery tiles from business_projects. ONE builder for two sections.
 *
 * The reference runs the identical .gallery component on both pages — index.html
 * shows 6 items, projects.html shows 8 — so home is a CAPPED VIEW of the same
 * collection, not a different treatment. Checked against both files. Sharing the
 * builder means the tile, the caption and the hover behaviour cannot drift apart.
 *
 * The caption is `caption — city`, matching the reference's
 * "200A panel upgrade — Chalmette, LA". The city is the local-signal payload and
 * is the reason the caption is not just the caption.
 *
 * CSS `columns` masonry: varied natural heights, caption revealed on hover. Not a
 * 12-col grid, which would force uniform tiles and lose the rhythm.
 */
function galleryTiles(ctx: RenderCtx, limit?: number): string {
  const projects = ctx.facts.projects
    // Only projects that actually have an image render — a caption with no photo
    // is a half-entered row, not a gallery tile.
    .map((pr) => ({ pr, media: pr.media_id ? ctx.facts.media[pr.media_id] : undefined }))
    .filter((x) => !!x.media);
  const shown = limit === undefined ? projects : projects.slice(0, limit);
  return shown.map(({ pr, media }) =>
    `<figure class="trades-figure fade-up">${comp("lightbox", {
      full_url: media!.url, thumb_url: media!.url, alt: media!.alt_text ?? pr.caption,
    })}<figcaption>${esc(pr.caption)}${pr.city ? ` — ${esc(pr.city)}` : ""}</figcaption></figure>`,
  ).join("");
}

/** Home's teaser: SIX, matching index.html against projects.html's eight. */
const HOME_GALLERY_LIMIT = 6;

const featured_work: SectionRenderer = (ctx) => {
  if (!sectionHasContent("featured_work", ctx.facts)) return "";
  return section("work", anchorFor("featured_work"),
    head(ctx.f.get("section_eyebrow") ?? "Featured Work", ctx.f.get("section_headline") ?? "Real jobs. Real results.") +
    comp("container", { content: `<div class="trades-gallery">${galleryTiles(ctx, HOME_GALLERY_LIMIT)}</div>` }));
};

// ── 7. reviews ─────────────────────────────────────────────────────────────
// EMPTY STATE IS THE CORRECT OUTPUT. AI-generated testimonials are prohibited
// (textos-agent/CLAUDE.md, FTC consumer-protection grounds). No place_id is
// connected, so there is nothing real to show — and nothing may be invented.
// star-rating-static exists in the catalog for when real reviews arrive.
const reviews: SectionRenderer = (ctx) => {
  const placeId = ctx.facts.profile?.google_place_id;
  const businessUrl = ctx.facts.profile?.google_business_url;
  const reviewUrl = businessUrl
    ?? (placeId ? `https://search.google.com/local/reviews?placeid=${placeId}` : null);

  // STILL THE EMPTY STATE. The mockup's aggregate block (large accent score,
  // stars, source label, three review cards, "Leave us a review") is styled and
  // ready, but nothing populates it: there is no place_id, Google Reviews
  // fetching is out of scope, and generating review text is prohibited
  // (textos-agent/CLAUDE.md, FTC). Rendering a score we do not have would be a
  // fabricated claim, so the section shows what is true — nothing yet — with a
  // real link out when one exists.
  const head1 = head("What Customers Say", ctx.f.get("section_headline") ?? "Reviews");
  return section("reviews", anchorFor("reviews"),
    head1 +
    `<div class="trades-empty-card fade-up">`
    + `<p class="trades-empty">Verified customer reviews appear here once this business connects its Google Business Profile. `
    + `We never write reviews.</p>`
    + (reviewUrl
        ? `<p style="margin:0"><a class="trades-reviews-cta" href="${esc(reviewUrl)}" rel="noopener">Leave us a review \u2192</a></p>`
        : "")
    + `</div>`);
};

// ── 8. service_area_chips ──────────────────────────────────────────────────
const service_area_chips: SectionRenderer = (ctx) => {
  const areas = ctx.facts.areas;
  if (areas.length === 0) return "";
  // EVERY CHIP THAT CAN LINK, LINKS. These named fourteen places and went
  // nowhere — the whole point of area pages is that "Kenner" on the home page
  // takes you to the Kenner page, and a dead chip beside a live area page is the
  // site failing to use its own content.
  //
  // The badge template is verbatim Homer recon and stays a <span>; the anchor
  // wraps it, which is what area_card_grid already does for its cards. Nothing
  // structural is hand-written here that the catalog could have supplied.
  //
  // An area with NO page renders as a bare chip rather than a link to a 404.
  // Provisioning now follows the facts, so that is a transient state, but a chip
  // must never promise a page that is not there.
  const pageBySlug = new Map(
    ctx.pages
      .filter((p) => p.page_type === "area_detail" && !p.noindex && p.instance_key)
      .map((p) => [p.instance_key as string, p.route_path]),
  );
  // Each chip CARRIES ITS OWN AREA'S landmarks line, and the paragraph beneath
  // shows whichever chip the visitor is pointing at.
  //
  // This block used to print areas[0].landmarks_blurb flat — one city's writing
  // standing in as copy about the whole business, so JK's home page described
  // fourteen parishes in New Orleans' words. Every area's line is reachable here
  // instead, which is also the only version where none of them is privileged.
  //
  // The first area's line is what renders server-side, so the section reads
  // correctly with no JavaScript, on a touch device with no hover, and to a
  // crawler. The swap is an enhancement on top of a complete page, never the
  // thing that makes it complete.
  //
  // data-* rather than a JSON blob: the text is already in the markup for the
  // chip it belongs to, so nothing has to be kept in step with anything.
  const chips = areas
    .map((a) => {
      const badge = comp("badge", { label: a.city, pill: true });
      const route = pageBySlug.get(a.area_slug);
      const blurb = a.landmarks_blurb ? ` data-area-blurb="${esc(a.landmarks_blurb)}"` : "";
      // An area with no page still swaps the blurb — it just does not navigate.
      return route
        ? `<a class="trades-chip-link" href="${esc(pageHref(ctx, route))}"${blurb}>${badge}</a>`
        : `<span class="trades-chip-static"${blurb}>${badge}</span>`;
    })
    .join("");
  const p = ctx.facts.profile;
  const sub = p?.locality ? `Based in ${p.locality}${p.region ? `, ${p.region}` : ""}.` : undefined;
  const first = areas.find((a) => !!a.landmarks_blurb)?.landmarks_blurb ?? "";
  return section("areas", anchorFor("service_area_chips"),
    head(ctx.f.get("section_eyebrow") ?? "Where We Work", ctx.f.get("section_headline") ?? "Areas we serve", sub) +
    `<div class="trades-chips">${chips}</div>` +
    (first
      ? `<p class="trades-area-blurb" data-area-blurb-target`
        + ` data-area-blurb-default="${esc(first)}">${esc(first)}</p>`
      : ""));
};

// ── 9. differentiator_band ─────────────────────────────────────────────────
const differentiator_band: SectionRenderer = (ctx) => {
  const diffs = ctx.facts.differentiators;
  const body = ctx.f.get<string>("band_body");
  if (diffs.length === 0 && !body) return "";
  // Mockup: centered band with a glow, copy, then display-face pill tags. The
  // tags are the differentiator headlines — short, uppercase, condensed.
  const tags = diffs.map((d) => `<span class="trades-tag">${esc(d.headline)}</span>`).join("");
  return section("diffband", anchorFor("differentiator_band"),
    head(ctx.f.get("section_eyebrow"), ctx.f.get("section_headline")) +
    (body ? `<p class="trades-band-body">${esc(body)}</p>` : "") +
    (tags ? `<div class="trades-tags">${tags}</div>` : ""));
};

// ── 10. faq_teaser ─────────────────────────────────────────────────────────
// FAQs are site-authored. Whatever renders here is exactly what the FAQPage
// JSON-LD emits — the source template's 8-vs-9 mismatch cannot happen.
const faq_teaser: SectionRenderer = (ctx) => {
  // home_teaser first; fall back to global so a business that only entered
  // general FAQs still gets a home accordion.
  const scoped = ctx.facts.faqs.filter((f) => f.scope === "home_teaser");
  const pool = scoped.length > 0 ? scoped : ctx.facts.faqs.filter((f) => f.scope === "global");
  const faqs: FaqEntry[] = pool.slice(0, 6).map((f) => ({ question: f.question, answer: f.answer }));
  if (faqs.length === 0) return "";
  ctx.faqs.push(...faqs);
  const items = faqs.map((q, i) => ({
    itemId: `faq-${i}`,
    title: q.question,
    content: esc(q.answer),
    open: i === 0,
  }));
  return section("faq", anchorFor("faq_teaser"),
    head(ctx.f.get("section_eyebrow") ?? "Common Questions", ctx.f.get("section_headline") ?? "Questions, answered") +
    comp("container", { content: `<div class="fade-up">${comp("accordion", { id: "faq-home-acc", items })}</div>` }));
};

// ── 11. cta_band ───────────────────────────────────────────────────────────
const cta_band: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  const href = p?.phone ? `tel:${telHref(p.phone)}` : (p?.email ? `mailto:${p.email}` : null);
  if (!href) return "";
  // Mockup: full-bleed accent field with a diagonal stripe, on-accent ink
  // headline, and TWO contrasting actions. card-cta supplies the primary; the
  // secondary is appended so both sit in the same action row.
  const booking = ctx.f.get<string>("booking_url");
  const secondary = booking
    ? `<a class="btn-site btn-site--outline btn-site--lg" href="${esc(booking)}" rel="noopener">Book Online</a>`
    : (p?.email ? `<a class="btn-site btn-site--outline btn-site--lg" href="mailto:${esc(p.email)}">Email Us</a>` : "");
  return section("cta", anchorFor("cta_band"),
    comp("card-cta", {
        heading_level: 2,
      headline: ctx.f.label("cta_headline", "Ready for electrical work done right?"),
      supporting_text: p?.phone ? `Call ${p.phone}` : `Email ${p?.email}`,
      cta_url: href,
      cta_label: ctx.f.label("cta_primary_label", p?.phone ? "Call Now" : "Email Us"),
    })
    + (secondary ? `<div class="hero-media__ctas" style="justify-content:center;margin:0">${secondary}</div>` : ""));
};

// ── 12. site_footer ────────────────────────────────────────────────────────
const site_footer: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  const hours = summarizeHours(ctx.facts.hours);
  const licenseLine = p?.license_number
    ? (p.license_authority ? `${p.license_authority} License #${p.license_number}` : `License #${p.license_number}`)
    : null;
  const links = flattenNav(navLinks(ctx));
  const legal = legalLinks(ctx);
  const hasAddress = !!(p && (p.street_address || p.locality));
  const social: Array<{ label: string; href: string; glyph: string }> = [];
  if (p?.facebook_url) social.push({ label: "Facebook", href: p.facebook_url, glyph: "f" });
  if (p?.instagram_url) social.push({ label: "Instagram", href: p.instagram_url, glyph: "\u25EF" });
  if (p?.google_business_url) social.push({ label: "Google", href: p.google_business_url, glyph: "G" });

  return comp("site-footer", {
    anchor: anchorFor("site_footer"),
    social, has_social: social.length > 0,
    business_name: ctx.businessName,
    tagline: ctx.f.get<string>("footer_tagline") ?? null,
    logo_url: logoUrl(ctx),
    logo_alt: logoAlt(ctx),
    phone_display: p?.phone ?? null,
    phone_href: p?.phone ? telHref(p.phone) : null,
    email: p?.email ?? null,
    license_line: licenseLine,
    links, has_links: links.length > 0,
    hours, has_hours: hours.length > 0,
      // Legal documents, from site_pages. The reference footer links both and ours
      // linked neither — these pages are noindex and out of the sitemap, so the
      // footer is the ONLY way a visitor reaches them. Labels come from
      // site_pages.title (seeded per instance in 102), never a hardcoded pair.
      legal_links: legal,
      has_legal: legal.length > 0,
    street_address: p?.street_address ?? null,
    address_line: p ? addressLine(p) : "",
    has_address: hasAddress,
    copyright_line: `© ${new Date().getUTCFullYear()} ${ctx.businessName}.${licenseLine ? ` ${licenseLine}.` : ""}`,
  });
};

// ── 13. chat_widget ────────────────────────────────────────────────────────
// Mount point only. No widget is wired in this phase; an empty mount is honest,
// a fake chat bubble is not.
const chat_widget: SectionRenderer = () => `<div id="trades-chat-mount" data-chat-mount hidden></div>`;

// ── 14. mobile_sticky_bar ──────────────────────────────────────────────────
const mobile_sticky_bar: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  if (!p?.phone) return "";
  return comp("mobile-sticky-bar", {
    anchor: anchorFor("mobile_sticky_bar"),
    phone_href: telHref(p.phone),
    call_label: ctx.f.label("sticky_call_label", "Call Now"),
    book_href: bookHref(ctx),
    book_label: ctx.f.label("sticky_book_label", "Book Online"),
  });
};


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2A — inner-page sections
// ═══════════════════════════════════════════════════════════════════════════

// ── page_hero ──────────────────────────────────────────────────────────────
// Used by seven of eight page types. Copy is SITE-AUTHORED per page; the
// fallback headline is the page title so a freshly provisioned page is readable
// before anyone edits it.
const page_hero: SectionRenderer = (ctx) => {
  const pageTitle = ctx.pages.find((x) => x.route_path === ctx.currentPath)?.title;
  const headline = ctx.f.get<string>("page_hero_headline")
    ?? pageTitle
    ?? ctx.businessName;
  const media = ctx.f.get<{ url: string; alt_text: string | null }>("page_hero_image");
  return comp("page-hero", {
    anchor: anchorFor("page_hero"),
    label: ctx.f.get<string>("page_hero_label") ?? null,
    headline,
    subhead: ctx.f.get<string>("page_hero_subhead") ?? null,
    has_media: !!media,
    media_url: media?.url ?? null,
    media_alt: media?.alt_text ?? "",
  });
};

// ── service_detail ─────────────────────────────────────────────────────────
// One block per service, each with its own anchor so a home-page card can deep
// link into it. Derives entirely from business_services.
//
// SCHEMA GAP, DECLARED: the mockup nests a six-card sub-grid under its
// installation service (panel upgrades, EV charger, fixtures, smart-home,
// circuits, storm-resilience). There is no storage for per-service sub-items —
// business_services has name/blurb/body/bullets and nothing hierarchical. Adding
// a collection for it was explicitly out of scope this phase, so the nesting is
// absent and this comment is the record of why.
//
// A service with no BODY renders what it has. A missing name or blurb is a hard
// failure — a service card with no name is not a degraded state, it is broken.
const service_detail: SectionRenderer = (ctx) => {
  const services = ctx.facts.services;
  if (services.length === 0) {
      // Renders NOTHING when empty. This used to emit an operator-facing line
      // ("… once they are added in Business Facts"), which named an internal admin
      // page to the client's own public visitors — seen live on JK's FAQ page. The
      // 1C rule is that empty sections do not render publicly; the site manager's
      // Sections pane is where the operator is told what to fill.
      return "";
  }

  const blocks = services.map((svc, i) => {
    if (!svc.name || svc.name.trim() === "") {
      throw new MissingFactError(`services[${svc.service_key}].name`, `services[${svc.service_key}].name`);
    }
    if (!svc.blurb || svc.blurb.trim() === "") {
      throw new MissingFactError(`services[${svc.service_key}].blurb`, `services[${svc.service_key}].blurb`);
    }
    const bullets = svc.bullets.length
      ? comp("list-group", { items: svc.bullets.map((b) => ({ label: b })) })
      : "";
    // Alternating surface, matching the mockup's section--dark / --darker rhythm.
    const alt = i % 2 === 1 ? " is-alt" : "";
    return `<section class="trades-section trades-svcdetail${alt}" id="${esc(svc.service_key)}">`
      + comp("container", {
          content: `<div class="svc-detail fade-up">`
            + `<span class="trades-eyebrow">${esc(svc.name)}</span>`
            + `<h2 class="trades-title svc-detail__title">${esc(svc.blurb)}</h2>`
            + (svc.body ? `<p class="svc-detail__body">${esc(svc.body)}</p>` : "")
            + bullets
            + `<a class="trades-card-link" href="${bookHref(ctx)}">Book this service \u2192</a>`
            + `</div>`,
        })
      + `</section>`;
  });
  // B3: every service page links out to every area page, and back. Generated
  // from site_pages, so the links appear the moment area pages exist and there
  // is never a hardcoded list to fall out of date.
  const areaPages = ctx.pages.filter((p) => p.page_type === "area_detail" && !p.noindex);
  const areaLinks = areaPages.length === 0 ? "" : section("svcareas", null,
    comp("container", {
      content: `<div class="svc-areas"><h2 class="svc-areas__title">Where we work</h2>`
        + `<ul class="svc-areas__list">`
        + areaPages.map((p) => `<li><a href="${esc(pageHref(ctx, p.route_path))}">${esc(p.title ?? "")}</a></li>`).join("")
        + `</ul></div>`,
    }));
  return blocks.join("") + areaLinks;
};

// ── story_prose ────────────────────────────────────────────────────────────
// SITE-AUTHORED, three paragraphs, edited in the site manager. The mockup styles
// this with .prose (max-width 720px, 0.95rem, line-height 1.8).
const story_prose: SectionRenderer = (ctx) => {
  const paras = [1, 2, 3]
    .map((n) => ctx.f.get<string>(`story_para_${n}`))
    .filter((x): x is string => !!x && x.trim() !== "");
  if (paras.length === 0) return "";
  return section("story", anchorFor("story_prose"),
    head(ctx.f.get("section_eyebrow"), ctx.f.get("section_headline")) +
    comp("container", {
      content: `<div class="prose fade-up">${paras.map((t) => `<p>${esc(t)}</p>`).join("")}</div>`,
    }));
};

// ── differentiator_list ────────────────────────────────────────────────────
// Fuller treatment than the home band: headline + body per item, stacked, not
// compressed into pill tags.
const differentiator_list: SectionRenderer = (ctx) => {
  const diffs = ctx.facts.differentiators;
  if (!sectionHasContent("differentiator_list", ctx.facts)) return "";
  const items = diffs.map((d) =>
    `<div class="diff-item fade-up">`
    + (d.icon ? `<div class="diff-item__icon" aria-hidden="true">${esc(d.icon)}</div>` : "")
    + `<h3 class="diff-item__title">${esc(d.headline)}</h3>`
    + `<p class="diff-item__body">${esc(d.body)}</p>`
    + `</div>`,
  ).join("");
  return section("difflist", anchorFor("differentiator_list"),
    head(ctx.f.get("section_eyebrow") ?? "Why homeowners choose us",
         ctx.f.get("section_headline") ?? undefined) +
    comp("container", { content: `<div class="diff-list">${items}</div>` }));
};

// ── license_callout ────────────────────────────────────────────────────────
// DERIVED from license_number + license_authority. Renders nothing without a
// licence — an empty credential block is worse than no block.
const license_callout: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  if (!p?.license_number) return "";
  const title = p.license_authority
    ? `${p.license_authority} License #${p.license_number}`
    : `License #${p.license_number}`;
  return section("license", anchorFor("license_callout"),
    comp("container", {
      content: `<div class="license-callout fade-up">`
        + `<h2 class="license-callout__title">${esc(title)}</h2>`
        + `<p class="license-callout__body">Licensed and insured. Every job is permitted and code-compliant, and you can verify us with the issuing board at any time.</p>`
        + `</div>`,
    }));
};

// ── faq_accordion ──────────────────────────────────────────────────────────
// The FULL question list for the FAQ page.
//
// Checked against the mockup: its faq.html renders 9 questions and its home
// teaser renders 4, and the teaser's four all reappear on the FAQ page — it
// EXTENDS rather than excludes. So both scopes are included here, teaser items
// first, deduplicated on the question text.
//
// The FAQPage JSON-LD is built from ctx.faqs, which this renderer populates —
// the same array, so the schema cannot disagree with what rendered. The mockup
// shipped 8 in its JSON-LD against 9 rendered; that is impossible here.
const faq_accordion: SectionRenderer = (ctx) => {
  const teaser = ctx.facts.faqs.filter((f) => f.scope === "home_teaser");
  const global = ctx.facts.faqs.filter((f) => f.scope === "global");
  const seen = new Set<string>();
  const all: FaqEntry[] = [];
  for (const f of [...teaser, ...global]) {
    const k = f.question.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    all.push({ question: f.question, answer: f.answer });
  }
  if (all.length === 0) {
      // Renders NOTHING when empty. This used to emit an operator-facing line
      // ("… once they are added in Business Facts"), which named an internal admin
      // page to the client's own public visitors — seen live on JK's FAQ page. The
      // 1C rule is that empty sections do not render publicly; the site manager's
      // Sections pane is where the operator is told what to fill.
      return "";
  }
  ctx.faqs.push(...all);
  const items = all.map((q, i) => ({
    itemId: `faq-q-${i}`,
    title: q.question,
    content: esc(q.answer),
    open: i === 0,
  }));
  return section("faqpage", anchorFor("faq_accordion"),
    comp("container", { content: `<div class="fade-up">${comp("accordion", { id: "faq-page-acc", items })}</div>` }));
};

// ── faq_footer_cta ─────────────────────────────────────────────────────────
const faq_footer_cta: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  const line = ctx.f.label("faq_cta_line", "Still have a question? We're happy to help.");
  const href = p?.phone ? `tel:${telHref(p.phone)}` : (p?.email ? `mailto:${p.email}` : null);
  if (!href) return "";
  // Rendered as "cta" so it carries .trades-cta and inherits the accent band
  // verbatim — every closing CTA on the site is the same shape and colour. The
  // id stays its own (anchorFor), so anchorHref and the nav filter are unaffected.
  return section("cta", anchorFor("faq_footer_cta"),
    `<div class="container"><div class="faq-cta fade-up">`
    + `<p class="faq-cta__line">${esc(line)}</p>`
    + `<a class="btn-site btn-site--primary btn-site--lg" href="${esc(href)}">`
    + `${esc(p?.phone ? `Call ${p.phone}` : "Email us")}</a>`
    + `</div></div>`);
};

/**
 * section_key → renderer. Execution logic, not data (cf. FREE_BUILD_TASK_HANDLERS).
 * The rendered set and its order come from site_sections in the DB.
 */
// ── project_gallery (2B) ───────────────────────────────────────────────────
// The whole collection, uncapped — home shows the first six of the same tiles.
const project_gallery: SectionRenderer = (ctx) => {
  if (!sectionHasContent("featured_work", ctx.facts)) return "";
  return section("gallery", anchorFor("project_gallery"),
    head(ctx.f.get("section_eyebrow"), ctx.f.get("section_headline")) +
    comp("container", { content: `<div class="trades-gallery">${galleryTiles(ctx)}</div>` }));
};

// ── gallery_cta (2B) ───────────────────────────────────────────────────────
// A short invitation under the photo wall, for someone who has just finished
// looking through the work. Renders with or without a headline, but never
// without a destination — bookHref always resolves to something real.
const gallery_cta: SectionRenderer = (ctx) => {
  const headline = ctx.f.get<string>("section_headline");
  // Rendered as "cta" so it carries .trades-cta and inherits the accent band
  // verbatim — every closing CTA on the site is the same shape and colour. The
  // id stays its own (anchorFor), so anchorHref and the nav filter are unaffected.
  return section("cta", anchorFor("gallery_cta"),
    comp("container", {
      content: `<div class="gallery-cta fade-up">`
        + (headline ? `<h2 class="gallery-cta__title">${esc(headline)}</h2>` : "")
        + `<a class="btn btn-primary" href="${bookHref(ctx)}">${esc(ctx.f.label("cta_primary_label", "Book Online"))}</a>`
        + `</div>`,
    }));
};

// ── contact_direct (2B) ────────────────────────────────────────────────────
// Phone, email, address, hours and a directions link. ENTIRELY DERIVED from
// business_profile and business_hours — there is nothing authored here but the
// heading, which is why the manager says so.
//
// DIRECTIONS LINK, NOT AN EMBEDDED MAP. The reference embeds a Google Maps
// iframe whose `pb=` blob hardcodes JK's coordinates, so it cannot be generated
// for another client without a new per-client field — and it loads Google on
// every client visitor's browser. A directions link is built from the address we
// already hold, works for every client with no configuration, and puts no
// third-party script on a contractor's page.
const contact_direct: SectionRenderer = (ctx) => {
  const p = ctx.facts.profile;
  if (!p) return "";
  const hours = summarizeHours(ctx.facts.hours);
  const addr = addressLine(p);
  const mapsQuery = [p.street_address, p.locality, p.region, p.postal_code]
    .filter(Boolean).join(", ");

  const rows: string[] = [];
  if (p.phone) {
    rows.push(`<a class="contact-direct__phone" href="tel:${esc(telHref(p.phone))}">${esc(p.phone)}</a>`);
  }
  if (p.email) {
    rows.push(`<a class="contact-direct__email" href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
  }
  if (addr) {
    rows.push(`<address class="contact-direct__address">${esc(addr)}</address>`);
  }
  if (mapsQuery) {
    rows.push(
      `<a class="contact-direct__directions" target="_blank" rel="noopener"`
      + ` href="https://www.google.com/maps/dir/?api=1&amp;destination=${encodeURIComponent(mapsQuery)}">Get directions</a>`,
    );
  }
  const hoursTable = hours.length > 0
    ? `<table class="contact-direct__hours"><caption>Opening hours</caption><tbody>`
      + hours.map((h) => `<tr><th scope="row">${esc(h.day)}</th><td>${esc(h.value)}</td></tr>`).join("")
      + `</tbody></table>`
    : "";

  if (rows.length === 0 && hoursTable === "") return "";

  return section("contact", anchorFor("contact_direct"),
    head(ctx.f.get("section_eyebrow"), ctx.f.get("section_headline")) +
    comp("container", {
      content: `<div class="contact-direct fade-up">`
        + `<div class="contact-direct__lines">${rows.join("")}`
        + `<a class="btn btn-primary contact-direct__book" href="${bookHref(ctx)}">`
        + `${esc(ctx.f.label("cta_primary_label", "Book Online"))}</a></div>`
        + hoursTable
        + `</div>`,
    }));
};

// ── legal_notice (2B) ──────────────────────────────────────────────────────
// The "Last updated" line, and nothing else.
//
// The reference's notice block is an "Attorney Review Required" banner addressed
// to whoever is building the site. That is a note to the builder, not to the
// client's visitors, and it is deliberately not reproduced. The last-updated date
// is the only public notice-like element on that page.
//
// No default: an unset date renders nothing rather than a plausible-looking one.
const legal_notice: SectionRenderer = () => {
  // RETIRED in 106. The date now sits under the H1 inside page_hero, which is
  // where the reference puts it — a whole trades-section for one line inherited
  // full section padding and left a large gap below the heading. Kept as a no-op
  // so a page still carrying the section row renders nothing rather than the date
  // twice.
  return "";
};

// ── legal_body (2B, revised in 103) ───────────────────────────────────────
// ONE pasted document, not twelve labelled boxes.
//
// 102 modelled this as 12 clause fields per instance. That was wrong about how the
// text arrives: a legal document comes finished, from a lawyer or an existing site,
// and gets pasted in one go. Nobody retypes one into numbered boxes, and "Clause 5"
// told an operator nothing about where their text had gone.
//
// PLAIN TEXT, PARAGRAPHS PRESERVED. Nothing in this stack renders markdown for user
// content — the only related dependency is sanitize-html in textos-web, which
// cleans HTML rather than producing it, and the agent has none. So the body is
// escaped and split: a blank line starts a new paragraph, a single newline becomes
// a line break. That covers pasted prose and pasted lists without adding an editor
// or a markdown dependency.
//
// Headings inside the pasted text are the author's problem, not the schema's.
//
// 102's principle is unchanged: no default, and an empty body renders nothing.
/**
 * Format pasted document text. ESCAPE FIRST, THEN FORMAT — every character the
 * operator supplied is inert before any markup of ours is added, so pasted HTML
 * is shown as text and never rendered.
 *
 * A deliberately small, well-defined subset. No markdown dependency, no editor:
 *
 *   "1. Services Provided"   numbered line        -> heading
 *   "PAYMENT TERMS"          short ALL-CAPS line  -> heading
 *   "- item" / "* item" / "• item"           -> list item
 *   blank line                                    -> new paragraph
 *   anything else                                 -> paragraph text
 *
 * A single newline inside a paragraph becomes a line break, so text pasted
 * without blank lines still keeps its shape instead of collapsing into one block.
 */
export function formatPastedText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(`<p>${para.map(esc).join("<br />")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul class="legal-list">${list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flush = () => { flushPara(); flushList(); };

  // "1." / "1.2" / "10)" at the start of a reasonably short line.
  const NUMBERED = /^\s*\d+(?:\.\d+)*[.)]\s+\S/;
  // A short line with no lower-case letters, e.g. "PAYMENT TERMS". The length cap
  // keeps a shouted sentence inside a paragraph from becoming a heading.
  const ALLCAPS = /^[^a-z]{3,60}$/;
  const BULLET = /^\s*[-*\u2022]\s+(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") { flush(); continue; }

    const bullet = BULLET.exec(line);
    if (bullet) { flushPara(); list.push(bullet[1].trim()); continue; }

    const isHeading = (NUMBERED.test(line) && line.length <= 120)
      || (ALLCAPS.test(line) && /[A-Z]/.test(line));
    if (isHeading) {
      flush();
      out.push(`<h2 class="legal-heading">${esc(line)}</h2>`);
      continue;
    }

    flushList();
    para.push(line);
  }
  flush();
  return out.join("");
}

// ── legal_body (2B, revised in 103) ──────────────────────────────────
// ONE pasted document, and the template never supplies a word of it.
const legal_body: SectionRenderer = (ctx) => {
  const body = ctx.f.get<string>("legal_body_text");
  if (!body || body.trim() === "") return "";
  const html = formatPastedText(body);
  if (html === "") return "";
  return section("legalbody", anchorFor("legal_body"),
    comp("container", { content: `<div class="legal-body">${html}</div>` }));
};

// ══ AREA PAGES (2C Part C) ═════════════════════════════════════════════════
//
// Every one of these reads the area from ctx.pageInstance — the site_pages row
// carries instance_key = area_slug, so a page knows which place it is about
// without recomputing anything.

/** The business_service_areas row this page is about, or null. */
function currentArea(ctx: RenderCtx) {
  // instanceKey comes off the site_pages ROW, not the template's instance list.
  // area_detail has no instance list — the 092 seed uses `instances` as a COUNT
  // there — so reading pageInstance left every area section empty.
  const key = ctx.instanceKey ?? ctx.pageInstance?.instance_key;
  if (!key) return null;
  return ctx.facts.areas.find((a) => a.area_slug === key) ?? null;
}

/** "Chalmette, LA" — the place, written the way it is spoken. */
function areaLabel(a: { city: string; region: string | null }): string {
  return a.region ? `${a.city}, ${a.region}` : a.city;
}

/**
 * The OpenStreetMap embed for an area, or null when it has no point.
 *
 * ONE COMPUTATION, used by the hero background and by the standalone area_map
 * section while both exist. Two copies of a bounding-box calculation would drift
 * the moment one was tuned, and the drift would show as two maps of the same
 * place at different zooms.
 *
 * Null, never a fallback centre: a map of the wrong place is a false claim about
 * where a licensed contractor works, and 0,0 is in the Gulf of Guinea.
 */
function areaMapEmbed(a: {
  city: string; region: string | null; geo_lat: number | null; geo_lng: number | null;
}): { src: string; title: string; largerHref: string; largerLabel: string } | null {
  if (a.geo_lat === null || a.geo_lng === null) return null;
  const lat = Number(a.geo_lat), lng = Number(a.geo_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // ~5km across at these latitudes — a city, not a street and not a state. The
  // longitude span is widened by 1/cos(lat) so the box stays visually square as
  // you move away from the equator; without it a New Orleans map is noticeably
  // letterboxed.
  const dLat = 0.045;
  const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const r = (n: number) => n.toFixed(5);
  const bbox = [r(lng - dLng), r(lat - dLat), r(lng + dLng), r(lat + dLat)].join(",");
  const label = areaLabel(a);
  return {
    src: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${r(lat)},${r(lng)}`,
    title: `Map of ${label}`,
    largerHref: `https://www.openstreetmap.org/?mlat=${r(lat)}&mlon=${r(lng)}#map=13/${r(lat)}/${r(lng)}`,
    largerLabel: `View ${label} on a larger map`,
  };
}

/** Where the embed's own (now unclickable) attribution points. */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

// ── area_card_grid — the index (C3) ───────────────────────────────────────
const area_card_grid: SectionRenderer = (ctx) => {
  const pages = ctx.pages.filter((p) => p.page_type === "area_detail" && !p.noindex);
  if (pages.length === 0) return "";
  const cards = pages.map((p) => {
    // Joined on instance_key, not on the rendered title. Title matching lost the
    // blurb the moment a page was renamed, and lost it silently.
    const a = ctx.facts.areas.find((x) => x.area_slug === p.instance_key)
      ?? ctx.facts.areas.find((x) => areaLabel(x) === p.title);
    return `<a class="area-card fade-up" href="${esc(pageHref(ctx, p.route_path))}">`
      + `<h2 class="area-card__title">${esc(p.title ?? "")}</h2>`
      + (a?.local_blurb ? `<p class="area-card__blurb">${esc(a.local_blurb)}</p>` : "")
      + `</a>`;
  }).join("");
  return section("areagrid", anchorFor("area_card_grid"),
    head(ctx.f.get("section_eyebrow"), ctx.f.get("section_headline")) +
    comp("container", { content: `<div class="area-grid">${cards}</div>` }));
};

// ── breadcrumb_nav — matches the reference's area pages (B4) ──────────────
const breadcrumb_nav: SectionRenderer = (ctx) => {
  const index = ctx.pages.find((p) => p.page_type === "area_index");
  const here = ctx.pages.find((p) => p.route_path === ctx.currentPath);
  if (!here) return "";
  const trail: Array<{ label: string; href: string | null }> = [
    { label: "Home", href: pageHref(ctx, "/") },
  ];
  if (index) trail.push({ label: "Service Areas", href: pageHref(ctx, index.route_path) });
  trail.push({ label: here.title ?? "", href: null });
  const items = trail.map((t, i) =>
    `<li>${t.href ? `<a href="${esc(t.href)}">${esc(t.label)}</a>` : `<span aria-current="page">${esc(t.label)}</span>`}`
    + (i < trail.length - 1 ? `<span class="crumb-sep" aria-hidden="true">/</span>` : "")
    + `</li>`).join("");
  return `<nav class="crumbs" aria-label="Breadcrumb" id="${anchorFor("breadcrumb_nav")}">`
    + `<div class="container"><ol class="crumbs__list">${items}</ol></div></nav>`;
};

// ── area_hero ─────────────────────────────────────────────────────────────
const area_hero: SectionRenderer = (ctx) => {
  const a = currentArea(ctx);
  // UNPUBLISHED: the page exists, its service area does not any more. The row is
  // kept and flagged noindex rather than deleted, so a visitor arriving from an
  // old link or a stale search result still lands on the client's site — and must
  // land on something that reads as a page, not on a blank document with a nav.
  //
  // It says only what is true: this business no longer lists this place. It does
  // NOT name the place as though it were still served, and it does not invent a
  // reason. The way onward is the areas index, which lists what IS served.
  if (!a) {
    const here = ctx.pages.find((p) => p.route_path === ctx.currentPath);
    const index = ctx.pages.find((p) => p.page_type === "area_index");
    const name = here?.title ?? "";
    return comp("page-hero", {
      anchor: anchorFor("area_hero"),
      label: "Service area",
      headline: name ? `We no longer cover ${name}` : "This service area is no longer covered",
      subhead: index
        ? "Have a look at the areas we do cover, or get in touch and we will tell you who can help."
        : "Get in touch and we will tell you who can help.",
      meta_line: null,
      has_media: false, media_url: null, media_alt: "",
    });
  }
  const noun = ctx.facts.profile?.trade_noun ?? "";
  const map = areaMapEmbed(a);
  return comp("page-hero", {
    anchor: anchorFor("area_hero"),
    label: "Service area",
    // The H1 states the subject in the words someone would search (B2).
    headline: noun ? `${noun} in ${areaLabel(a)}` : areaLabel(a),
    // LANDMARKS, not the local blurb. Two reasons, and they agree:
    //
    // 1. The template says so. 092 declares area_hero's fields as
    //    ["area_hero_headline", "area_landmarks_blurb", ...] and area_positioning's
    //    as [..., "area_local_blurb"]. The renderer had them the other way round,
    //    so this restores the spec rather than changing it.
    // 2. The duplicate-content scorer measured it: landmarks_blurb carries the
    //    unique writing on 14 of 14 of JK's areas. Putting the one element that
    //    distinguishes this page from its thirteen siblings last, under the fold,
    //    was backwards for a page whose whole purpose is local specificity.
    subhead: a.landmarks_blurb,
    meta_line: null,
    // THE MAP IS THE BACKGROUND, not a band below. An area page's subject is a
    // place, so the place is what sits behind its headline — the same slot a
    // photo occupies on every other inner page, with the same scrim and the same
    // text treatment. An area with no coordinates falls back to the solid
    // surface, exactly as a page with no photo does.
    has_media: false, media_url: null, media_alt: "",
    ...(map
      ? {
          has_map: true,
          map_src: map.src,
          map_title: map.title,
          map_link_href: map.largerHref,
          map_link_label: map.largerLabel,
          // The embed's own attribution link cannot be clicked once the frame is
          // pointer-events:none, so this is the live one OSM's terms require.
          map_attrib_href: OSM_COPYRIGHT_URL,
          map_attrib_label: "© OpenStreetMap contributors",
        }
      : { has_map: false }),
  });
};

// ── area_map — where this place actually is, under the hero ───────────────
//
// Skipped in 2B because the reference's embed hardcoded one set of coordinates
// and could not generalise. business_service_areas now stores geo_lat/geo_lng per
// area, so the objection is gone: every area centres on its own point.
//
// ITS OWN SECTION, not folded into area_map_nearby. That section is named "map"
// and is a list of links to sibling areas — it belongs at the FOOT of the page,
// and a map belongs directly under the hero. Merging them would drag the nearby
// list up with it. (092 bundled `map_embed_or_placeholder` into area_map_nearby;
// this deliberately supersedes that placement, which put the map last.)
//
// NO COORDINATES, NO SECTION. An area saved without lat/lng renders nothing here
// rather than a map of the wrong place or of the middle of the ocean — a map is a
// factual claim about where a licensed contractor works.
// area_map — RETIRED. The map is the hero BACKGROUND now (see area_hero), so a
// standalone band under it was a second copy of the same map. Migration 112 drops
// the section from the template and deletes its rows.
//
// The renderer goes first, deliberately. Between this deploy and that migration,
// compose finds a provisioned section with no handler, logs
// no_renderer_for_section and skips it — which is exactly the intended end state,
// reached a little early. The reverse order would have shown two maps until the
// migration landed. The map-embed-osm catalog entry stays: it is a working,
// keyless component and the only thing that changed is that nothing composes it
// today.

// ── area_services_grid — services, linked back to the services page (B3) ──
const area_services_grid: SectionRenderer = (ctx) => {
  const a = currentArea(ctx);
  if (!a || !sectionHasContent("services_grid", ctx.facts)) return "";
  const servicesPage = ctx.pages.find((p) => p.page_type === "services");
  const items = ctx.facts.services.map((s) =>
    `<li class="area-svc"><span class="area-svc__name">${esc(s.name)}</span>`
    + (s.blurb ? `<span class="area-svc__blurb">${esc(s.blurb)}</span>` : "")
    + `</li>`).join("");
  const back = servicesPage
    ? `<p class="area-svc__more"><a href="${esc(pageHref(ctx, servicesPage.route_path))}">`
      + `All services in detail</a></p>`
    : "";
  return section("areasvc", anchorFor("area_services_grid"),
    head(undefined, `What we do in ${areaLabel(a)}`) +
    comp("container", { content: `<ul class="area-svc-list">${items}</ul>${back}` }));
};

// ── area_positioning — the landmarks blurb, the local-signal payload ──────
// The local blurb, which moved DOWN here as the landmarks blurb moved up to the
// hero. Both stay used and neither is orphaned: 092 declares area_local_blurb as
// this section's field, so this is the template's own mapping restored.
const area_positioning: SectionRenderer = (ctx) => {
  const a = currentArea(ctx);
  if (!a?.local_blurb) return "";
  return section("areapos", anchorFor("area_positioning"),
    comp("container", {
      content: `<div class="prose fade-up"><p>${esc(a.local_blurb)}</p></div>`,
    }));
};

// ── area_faq — area-scoped questions, falling back to the global set ──────
const area_faq: SectionRenderer = (ctx) => {
  const a = currentArea(ctx);
  if (!a) return "";
  const scoped = ctx.facts.faqs.filter((f) => f.scope === `area:${a.area_slug}`);
  const pool = scoped.length > 0 ? scoped : ctx.facts.faqs.filter((f) => f.scope === "global");
  const all: FaqEntry[] = pool.slice(0, 6).map((f) => ({ question: f.question, answer: f.answer }));
  if (all.length === 0) return "";
  // Same array the FAQPage schema is built from, so the two cannot disagree.
  ctx.faqs.push(...all);
  return section("areafaq", anchorFor("area_faq"),
    head(undefined, `Questions from ${areaLabel(a)}`) +
    comp("container", {
      content: `<div class="fade-up">${comp("accordion", {
        id: "area-faq-acc",
        items: all.map((q, i) => ({ itemId: `area-faq-${i}`, title: q.question, content: esc(q.answer), open: i === 0 })),
      })}</div>`,
    }));
};

// ── area_map_nearby — the other areas, so no area page is an orphan (B3) ──
const area_map_nearby: SectionRenderer = (ctx) => {
  // NO currentArea GUARD. This is the one section an unpublished page needs most:
  // it is the visitor's route back into the areas that ARE covered. Gating it on
  // the missing fact row left that page a dead end.
  const others = ctx.pages.filter(
    (p) => p.page_type === "area_detail" && p.route_path !== ctx.currentPath && !p.noindex);
  if (others.length === 0) return "";
  const links = others.map((p) =>
    `<li><a href="${esc(pageHref(ctx, p.route_path))}">${esc(p.title ?? "")}</a></li>`).join("");
  return section("areanear", anchorFor("area_map_nearby"),
    head(undefined, "Other areas we cover") +
    comp("container", { content: `<ul class="area-nearby">${links}</ul>` }));
};

export const SECTION_RENDERERS: Record<string, SectionRenderer> = {
  area_card_grid,
  breadcrumb_nav,
  area_hero,
  area_services_grid,
  area_positioning,
  area_faq,
  area_map_nearby,
  project_gallery,
  gallery_cta,
  contact_direct,
  legal_notice,
  legal_body,
  site_nav,
  // Phase 2A — inner pages
  page_hero,
  service_detail,
  story_prose,
  differentiator_list,
  license_callout,
  faq_accordion,
  faq_footer_cta,
  hero_home,
  trust_bar,
  services_grid,
  positioning_band,
  featured_work,
  reviews,
  service_area_chips,
  differentiator_band,
  faq_teaser,
  cta_band,
  site_footer,
  chat_widget,
  mobile_sticky_bar,
};

/**
 * Test seam for the nav resolver. Builds the minimal RenderCtx the resolution
 * actually reads, so the group rules can be pinned without a database.
 * `hosts` maps a section_key to the route_path that renders it; a key absent from
 * it renders nowhere and its item must drop.
 */
export function buildNavForTest(
  def: NavItemDef[],
  pages: RenderCtx["pages"],
  currentPath: string,
  hosts: Record<string, string>,
): NavLink[] {
  const sectionsByPath = new Map<string, Set<string>>();
  for (const [key, path] of Object.entries(hosts)) {
    const set = sectionsByPath.get(path) ?? new Set<string>();
    set.add(key); sectionsByPath.set(path, set);
  }
  const ctx = {
    pages, currentPath, basePath: "/sites/x", navDef: def,
    sectionsByPath, pageSectionKeys: new Set<string>(), renderedAnchors: new Set<string>(),
    facts: { services: [], areas: [], faqs: [], projects: [], differentiators: [], media: {}, profile: null, hours: [] },
  } as unknown as RenderCtx;
  return navLinks(ctx);
}

// Compose a managed site page.
//
// Reads the page's sections FROM THE DATABASE (site_sections, ordered), resolves
// each section's fields, and renders them in order. There is no hardcoded
// section list here — adding a section to the template is a DB write.
//
// Returns HTML fragments + JSON-LD + theme tokens. It does NOT emit a document
// shell, <head>, or <style>: textos-web owns those. Agent renders sections, web
// wraps and serves.

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger";
import { loadSiteFacts, MissingFactError, unwrap, type SiteFacts } from "./facts";
import { FieldResolver, type DerivationMap, type StoredField } from "./resolver";
import {
  applyMetaFormula, metaTokens, metaLengthWarnings, type MetaFormula,
} from "./meta-formula";
import {
  SECTION_RENDERERS, SECOND_PASS_SECTIONS, anchorFor,
  type RenderCtx, type PageInstanceDef, type NavItemDef, SHARED_AUTHORED_SECTIONS,
} from "./sections";
import { buildGraph, type FaqEntry, type JsonLdOptions } from "./jsonld";

export interface ComposedPage {
  template_key: string;
  page_type: string;
  route_path: string;
  page_id: string;
  /** Head meta for THIS page, from site_pages.meta. */
  page_meta: { title?: string; description?: string; og_image?: string };
  /** Advisory length warnings for the formula-derived meta (B1). */
  meta_warnings: string[];
  noindex: boolean;
  /** Every page on the site, for cross-page nav, the sitemap and llms.txt. */
  pages: Array<{ page_type: string; route_path: string; title: string | null; noindex: boolean }>;
  /** Ordered HTML fragments. Web joins and injects them. */
  sections: Array<{ section_key: string; html: string }>;
  jsonld: Record<string, unknown>;
  /** SITE-AUTHORED theme tokens. Resolved from site_fields, NOT from the
   *  businesses row — businesses.accent_color/hero_font are
   *  business-landing-page's output for its own rendering and are not this
   *  site's brand. A null means "not set"; the stylesheet's own :root fallback
   *  applies rather than another feature's colour leaking in. */
  theme: {
    accent: string | null;
    font: string | null;
    ink_on_dark: string | null;
    ink_on_accent: string | null;
    display_font: string | null;
    body_font: string | null;
    ink_on_light: string | null;
    surface_color: string | null;
    scrim_opacity: string | null;
    radius_scale: string | null;
  };
  meta: {
    title: string | null;
    description: string | null;
    canonical: string;
  };
  /** Diagnostics — which fields were derived vs authored. Not rendered. */
  field_report: Array<{ section_key: string; rendered: boolean }>;
}

export interface ComposeOptions {
  canonicalUrl: string;
  origin: string;
  /**
   * Which page to render, by site_pages.route_path. Defaults to the home page.
   * There is NO hardcoded page list anywhere — the set of pages is whatever rows
   * exist for the site, so adding a page type to a template needs no code change.
   */
  routePath?: string;
  /** URL prefix the site is served under, e.g. "/sites/jkqualityelectric". */
  basePath: string;
}

export async function composeManagedPage(
  supabase: SupabaseClient,
  business: Record<string, unknown>,
  opts: ComposeOptions,
): Promise<ComposedPage | null> {
  const businessId = business.id as string;

  // 1. Is there a managed site for this business?
  const siteRes = await supabase
    .from("sites")
    .select("id, slug, status, template_id")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const siteRow = unwrap<unknown>(siteRes, "sites", null);
  if (!siteRow) return null;

  const site = siteRow as { id: string; slug: string; status: string; template_id: string };

  // 2. Template (section catalog + derivation map).
  const tplRes = await supabase
    .from("site_templates")
    .select("template_key, section_catalog, field_derivation_map")
    .eq("id", site.template_id)
    .maybeSingle();
  const tplRow = unwrap<unknown>(tplRes, "site_templates", null);
  if (!tplRow) {
    log.error("[site-render] template_missing", { site_id: site.id, template_id: site.template_id });
    throw new Error(`site ${site.id} references template ${site.template_id}, which does not exist`);
  }
  const tpl = tplRow as {
    template_key: string;
    section_catalog: Record<string, unknown>;
    field_derivation_map: DerivationMap;
  };

  // 3. The home page and its ordered sections — from the DB, not from code.
  // Every page on the site. Needed for the requested-page lookup, cross-page
  // nav, the sitemap and llms.txt — one read serves all four.
  const pagesRes = await supabase
    .from("site_pages")
    .select("id, page_type, instance_key, route_path, title, noindex, meta, display_order")
    .eq("site_id", site.id)
    .order("display_order", { ascending: true });
  const allPages = unwrap<Array<{
    id: string; page_type: string; instance_key: string | null; route_path: string; title: string | null;
    noindex: boolean; meta: Record<string, string> | null; display_order: number;
  }>>(pagesRes, "site_pages", []);

  // Only published-worthy pages appear in nav. noindex pages (the legal docs)
  // are reachable but not advertised, matching the mockup's robots.txt.
  const navPages = allPages.map((x) => ({
    page_type: x.page_type, route_path: x.route_path, title: x.title, noindex: !!x.noindex,
    // The fact this page was generated from — area_slug on an area page. Carried
    // so a section can link a FACT to its PAGE without matching on display text.
    instance_key: x.instance_key,
  }));

  const wantPath = opts.routePath ?? "/";
  const page = allPages.find((x) => x.route_path === wantPath);
  // null means "no such page on this site" — the caller turns that into a real
  // 404. It must NOT fall through to anything else: a missing sub-page used to
  // serve the marketing homepage under a 200.
  if (!page) return null;

  // EVERY page's sections in one read, not just this page's.
  //
  // The nav has to be identical on every page, which means an anchor link must be
  // able to resolve to the page that HOSTS its section — and that requires knowing
  // what sections the other pages declare. One query with `.in()` costs the same
  // round trip as the single-page query it replaces.
  const sectionRes = await supabase
    .from("site_sections")
    .select("id, page_id, section_key, display_order, is_enabled")
    .in("page_id", allPages.map((x) => x.id))
    .eq("is_enabled", true)
    .order("display_order", { ascending: true });
  const allSections = unwrap<Array<{ id: string; page_id: string; section_key: string; display_order: number }>>(
    sectionRes, "site_sections", []);

  // route_path → the section keys declared on that page. Keyed by path because
  // that is what the nav needs to build an href.
  const sectionsByPath = new Map<string, Set<string>>();
  for (const x of allSections) {
    const rp = allPages.find((pg) => pg.id === x.page_id)?.route_path;
    if (!rp) continue;
    let set = sectionsByPath.get(rp);
    if (!set) { set = new Set(); sectionsByPath.set(rp, set); }
    set.add(x.section_key);
  }

  const sections = allSections.filter((x) => x.page_id === page.id);
  if (sections.length === 0) return null;

  // 4. Stored field values for those sections (site-authored + overrides).
  const fieldRes = await supabase
    .from("site_fields")
    .select("section_id, field_key, value_text, value_json, source_path")
    // ALL pages' sections, not just this page's — the shared chrome resolves from
    // the home page's rows (see SHARED_AUTHORED_SECTIONS). Same round trip.
    .in("section_id", allSections.map((s) => s.id));
  const fieldRows = unwrap<Array<StoredField & { section_id: string }>>(fieldRes, "site_fields", []);
  const bySection = new Map<string, StoredField[]>();
  for (const r of fieldRows) {
    const list = bySection.get(r.section_id) ?? [];
    list.push(r);
    bySection.set(r.section_id, list);
  }

  // 5. Business facts — the derivation source.
  const facts: SiteFacts = await loadSiteFacts(supabase, businessId, business);

  // 6. Render each section in order.
  const businessName = (business.name as string) || facts.profile?.legal_name || "";
  const faqs: FaqEntry[] = [];
  const out: ComposedPage["sections"] = [];
  const report: ComposedPage["field_report"] = [];

  // TWO PASSES. site_nav and site_footer link to the other sections, so they
  // cannot be rendered until we know which ones produced output — otherwise the
  // menu offers "Our Work" on a site with no project photos and the link scrolls
  // nowhere. First pass renders everything else and collects the anchors of what
  // actually appeared; second pass renders the linkers, then the results are
  // re-sorted back into catalog order.
  const renderedAnchors = new Set<string>();
  const rendered = new Map<string, string>();
  // Declared up front so a first-pass renderer can ask what else is on its page.
  // The template's definition of this instance, when the page type declares any.
  // legal_body reads its clause headings from it; every other section ignores it.
  const catalogPageTypes = (tpl.section_catalog.page_types ?? []) as Array<{
    page_type: string; instances?: PageInstanceDef[];
  }>;
  const catalogPage = catalogPageTypes.find((pt) => pt.page_type === page.page_type);
  const pageInstance = page.instance_key
    // Array.isArray, NOT `?? []`. The 092 seed uses `instances` inconsistently:
    // legal carried ["tos","privacy"] (strings) and area_detail carries the NUMBER
    // 10, meaning "expect ten of these". `10 ?? []` passes the number straight
    // through and (10).find throws. Provisioning already guards this shape; this
    // path did not, and every area page 500'd.
    ? (Array.isArray(catalogPage?.instances) ? catalogPage.instances : [])
        .find((i) => i.instance_key === page.instance_key) ?? null
    : null;

  // section_key -> the HOME page's authored rows for it, for the shared chrome.
  const homePageId = allPages.find((x) => x.page_type === "home")?.id ?? null;
  const homeSectionIds = new Map(
    allSections.filter((x) => x.page_id === homePageId).map((x) => [x.section_key, x.id]),
  );
  const homeRowsByKey = new Map<string, StoredField[]>();
  for (const [key, id] of homeSectionIds) {
    const rows = bySection.get(id);
    if (rows?.length) homeRowsByKey.set(key, rows);
  }

  // Nav structure from the template (104). Null until that migration lands, which
  // makes the renderer fall back to its previous hardcoded order rather than
  // rendering an empty menu — this deploys safely ahead of the migration.
  const navDef = ((tpl.section_catalog as { nav?: { items?: NavItemDef[] } }).nav?.items) ?? null;

  const currentAreaRow = page.instance_key
    ? facts.areas.find((a) => a.area_slug === page.instance_key) ?? null
    : null;

  // B1: title/description from the template's formula for this page type.
  const metaFormula = (catalogPage as { meta_formula?: MetaFormula } | undefined)?.meta_formula;
  const metaFromFormula = applyMetaFormula(
    metaFormula,
    metaTokens(facts, businessName, {
      page_title: page.title ?? "",
      // Area pages: the place this page is about. Resolved from the same
      // instance_key the renderers use, so the title names the same city the
      // body does. Blank on every other page type, where {city} is not in play.
      city: currentAreaRow?.city ?? "",
      region_code: currentAreaRow?.region ?? "",
    }),
  );
  const metaWarnings = metaLengthWarnings(metaFromFormula.title, metaFromFormula.description);

  // Breadcrumbs for any page below the top level (B4). Home gets none — a
  // one-item trail says nothing. Built from site_pages, so it never names a page
  // that does not exist.
  const siteHome = `${opts.origin}${opts.basePath || ""}`;
  const breadcrumbTrail = page.page_type === "home" ? [] : [
    { name: "Home", url: siteHome },
    { name: page.title || page.page_type.replace(/_/g, " "), url: opts.canonicalUrl },
  ];

  const pageSectionKeys = new Set(sections.map((x) => x.section_key));
  const ordered = [
    ...sections.filter((x) => !SECOND_PASS_SECTIONS.has(x.section_key)),
    ...sections.filter((x) => SECOND_PASS_SECTIONS.has(x.section_key)),
  ];

  for (const s of ordered) {
    const renderer = SECTION_RENDERERS[s.section_key];
    if (!renderer) {
      // The template lists a section this Worker cannot render. Skip loudly
      // rather than crash the page — same posture as the orchestrator's
      // no_handler_for_default_task path.
      log.warn("[site-render] no_renderer_for_section", { site_id: site.id, section_key: s.section_key });
      report.push({ section_key: s.section_key, rendered: false });
      continue;
    }
    // Shared chrome takes its authored copy from HOME, so the nav, footer, CTA
    // band and sticky bar read identically on every page. Home's rows go LAST
    // because the resolver's Map lets later entries win.
    //
    // A stale per-page row for one of these keys is therefore inert. That is
    // deliberate: the manager no longer offers those fields per page, so there is
    // nothing an operator can type here and then watch fail to appear.
    const ownRows = bySection.get(s.id) ?? [];
    const rows = SHARED_AUTHORED_SECTIONS.has(s.section_key)
      ? [...ownRows, ...(homeRowsByKey.get(s.section_key) ?? [])]
      : ownRows;
    const f = new FieldResolver(rows, tpl.field_derivation_map, facts);
    const ctx: RenderCtx = {
      facts, f, businessName, canonicalUrl: opts.canonicalUrl, faqs, renderedAnchors,
      pages: navPages, currentPath: page.route_path, basePath: opts.basePath,
      pageSectionKeys, sectionsByPath, pageInstance, navDef,
      instanceKey: page.instance_key ?? null,
    };
    try {
      const html = renderer(ctx);
      if (html && html.trim() !== "") {
        rendered.set(s.section_key, html);
        renderedAnchors.add(anchorFor(s.section_key));
        report.push({ section_key: s.section_key, rendered: true });
      } else {
        report.push({ section_key: s.section_key, rendered: false });
      }
    } catch (err) {
      // A missing REQUIRED fact is fatal for the page — never render a
      // placeholder for a licensed contractor's public site.
      if (err instanceof MissingFactError) throw err;
      log.error("[site-render] section_failed", {
        site_id: site.id, section_key: s.section_key, err: String(err),
      });
      throw err;
    }
  }

  // Back into catalog order — the second pass rendered site_nav/site_footer last,
  // but they belong where site_sections.display_order puts them.
  for (const s of sections) {
    const html = rendered.get(s.section_key);
    if (html) out.push({ section_key: s.section_key, html });
  }

  // 7. Structured data — from the facts, matching exactly what rendered.
  const logoUrl = facts.profile?.logo_media_id ? facts.media[facts.profile.logo_media_id]?.url ?? null : null;
  const heroUrl = facts.profile?.hero_media_id ? facts.media[facts.profile.hero_media_id]?.url ?? null : null;
  const abs = (u: string | null) => (u ? (u.startsWith("http") ? u : `${opts.origin}${u}`) : null);

  const jsonldOpts: JsonLdOptions = {
    // Anchored to the site home, so one business is one entity across all pages.
    siteHomeUrl: `${opts.origin}${opts.basePath || ""}`,
    canonicalUrl: opts.canonicalUrl,
    origin: opts.origin,
    businessName,
    description: facts.profile?.description ?? (business.seo_description as string | null) ?? null,
    logoUrl: abs(logoUrl),
    imageUrl: abs(heroUrl),
  };

  // Theme is read from the page's own site_fields via a resolver over the whole
  // page (the tokens are site-level, not owned by one section).
  const allStored: StoredField[] = [];
  for (const list of bySection.values()) allStored.push(...list);
  const siteResolver = new FieldResolver(allStored, tpl.field_derivation_map, facts);

  return {
    template_key: tpl.template_key,
    page_type: page.page_type,
    page_id: page.id,
    page_meta: (page.meta ?? {}) as ComposedPage["page_meta"],
    noindex: !!page.noindex,
    pages: allPages.map((x) => ({
      page_type: x.page_type, route_path: x.route_path, title: x.title, noindex: !!x.noindex,
    })),
    theme: {
      accent:        siteResolver.get<string>("theme_color") ?? null,
      font:          siteResolver.get<string>("font_family") ?? null,
      ink_on_dark:   siteResolver.get<string>("ink_on_dark") ?? null,
      ink_on_accent: siteResolver.get<string>("ink_on_accent") ?? null,
      // display_font/body_font supersede font_family (migration 098); fall back
      // to it so a site configured before the split keeps its heading face.
      display_font:  siteResolver.get<string>("display_font") ?? siteResolver.get<string>("font_family") ?? null,
      body_font:     siteResolver.get<string>("body_font") ?? null,
      ink_on_light:  siteResolver.get<string>("ink_on_light") ?? null,
      surface_color: siteResolver.get<string>("surface_color") ?? null,
      scrim_opacity: siteResolver.get<string>("scrim_opacity") ?? null,
      radius_scale:  siteResolver.get<string>("radius_scale") ?? null,
    },
    route_path: page.route_path,
    sections: out,
    jsonld: buildGraph(facts, jsonldOpts, faqs, page.page_type, breadcrumbTrail),
    meta: {
      // FORMULA FIRST (B1). The template's meta_formula is evaluated against live
      // facts on every request, so a title cannot drift from what the page
      // contains. site_pages.meta below it is a snapshot taken once at provision
      // time by migration 100 and never refreshed — correct on the day, stale
      // after the next service area is added.
      title: metaFromFormula.title
        || page.meta?.title || page.title || (business.seo_title as string | null) || businessName,
      description: metaFromFormula.description
        || page.meta?.description
        || facts.profile?.description
        || (business.seo_description as string | null)
        || null,
      canonical: opts.canonicalUrl,
    },
    meta_warnings: metaWarnings,
    field_report: report,
  };
}

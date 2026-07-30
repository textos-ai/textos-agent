// Provision a managed site from a template.
//
// Creates the sites row, one site_pages row per page type being provisioned,
// and one site_sections row per section — READ FROM THE TEMPLATE'S
// section_catalog IN THE DATABASE. There is no section list in this file.
// Adding a section to trades-v1 is a DB write; re-provisioning picks it up.
//
// Phase 1B provisions the HOME page only. The other eight page types are out of
// scope; `pageTypes` exists so the same function covers them later without a
// rewrite.
//
// Idempotent: re-provisioning an existing site refreshes its section rows
// (insert missing, re-order existing) and never touches site_fields, so
// site-authored copy survives.

import type { SupabaseClient } from "@supabase/supabase-js";
import { areaSlug } from "./keyword-derive";
import { log } from "../logger";
import { unwrap } from "./facts";

/**
 * Page paths that are already claimed by the DEPLOYED ROUTING TABLE, so a
 * template may never mint a page at one of them.
 *
 * This is not arbitrary caution and it is not cruft — each entry was verified by
 * request on 2026-07-29 to already resolve to something else. Removing an entry
 * silently breaks a live serving path, and the breakage looks like "the page is
 * wrong" rather than "the route collided", which is expensive to diagnose.
 *
 *   app       /sites/:biz/app        -> /business/app/  200   (_redirects:120-121)
 *                                     the legacy singleton generated mini-app shell.
 *   apps      /sites/:biz/apps/:app  -> /business/apps-shell/ 200 (_redirects:118-119)
 *                                     the multi-app shell. 27 app rows depend on it.
 *   llms.txt  /sites/[slug]/llms.txt.ts — an existing Astro route file, the
 *                                     machine-readable site summary.
 *
 * _redirects is evaluated BEFORE the SSR route, so a colliding page would not
 * merely be shadowed — it would serve the app shell under a 200.
 */
export const RESERVED_PAGE_SLUGS = new Set(['app', 'apps', 'llms.txt']);

/** First path segment of a route, e.g. "/areas/{x}" -> "areas". */
function firstSegment(route: string): string {
  return route.replace(/^\/+/, '').split('/')[0] ?? '';
}

export interface ProvisionResult {
  site_id: string;
  site_slug: string;
  created: boolean;
  pages: Array<{ page_type: string; instance_key: string | null; route_path: string; sections: string[] }>;
}

interface CatalogSection {
  order: number;
  section_key: string;
  anchor?: string;
  shared?: boolean;
}
interface CatalogPageType {
  page_type: string;
  route: string;
  repeatable?: boolean;
  robots?: string;
  meta_defaults?: { title?: string; description?: string };
  sections: CatalogSection[];
}

/**
 * One-time import mapping for SITE-AUTHORED copy: section_key → { field_key →
 * businesses column }. This is a migration aid, not a section list — it says
 * "where did this business's existing copy live before the Website Manager",
 * and is only consulted when a site_fields row is absent.
 */
const AUTHORED_SEED: Record<string, Record<string, string>> = {
  hero_home: {
    hero_eyebrow:   "hero_eyebrow",
    hero_headline:  "hero_headline",
    hero_subhead:   "hero_subhead",
    hero_cta_label: "hero_cta_label",
  },
  cta_band: {
    cta_headline: "hero_cta_label",
  },
};

async function seedAuthoredFields(
  supabase: SupabaseClient,
  pageId: string,
  sectionKeys: string[],
  business: Record<string, unknown>,
): Promise<void> {
  const secRes = await supabase
    .from("site_sections")
    .select("id, section_key")
    .eq("page_id", pageId);
  const sections = unwrap<Array<{ id: string; section_key: string }>>(secRes, "site_sections", []);
  if (sections.length === 0) return;

  const existingRes = await supabase
    .from("site_fields")
    .select("section_id, field_key")
    .in("section_id", sections.map((s) => s.id));
  const existing = new Set(
    unwrap<Array<{ section_id: string; field_key: string }>>(existingRes, "site_fields", [])
      .map((r) => `${r.section_id}::${r.field_key}`),
  );

  const toInsert: Array<Record<string, unknown>> = [];
  for (const sec of sections) {
    if (!sectionKeys.includes(sec.section_key)) continue;
    const seed = AUTHORED_SEED[sec.section_key];
    if (!seed) continue;
    for (const [fieldKey, column] of Object.entries(seed)) {
      if (existing.has(`${sec.id}::${fieldKey}`)) continue;
      const v = business[column];
      if (typeof v !== "string" || v.trim() === "") continue;
      toInsert.push({
        section_id: sec.id,
        field_key: fieldKey,
        value_text: v,
        source: "imported",
        source_path: null,
        alignment_status: "unchecked",
      });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("site_fields").insert(toInsert);
    if (error) throw new Error(`authored_seed_failed: ${error.message}`);
    log.info("[site-render] seeded_authored_fields", { page_id: pageId, count: toInsert.length });
  }
}

export async function provisionSite(
  supabase: SupabaseClient,
  businessId: string,
  businessSlug: string,
  templateKey: string,
  pageTypes: string[] = ["home"],
  /** Force a NEW site row instead of reusing the business's latest. A business
   *  may have more than one site; find-or-create is the default because
   *  re-provisioning must be idempotent. */
  forceNew = false,
  /**
   * Restrict a repeatable page type to these instance keys.
   *
   * Provisioning walks instances sequentially — a page upsert, a sections upsert
   * and a field seed each, several round trips per page. Re-expanding all
   * fourteen areas on a save that added ONE took about seven seconds, all of it
   * re-confirming pages that already existed.
   *
   * Undefined means "every instance", which is what a full provision or a
   * re-provision wants. The caller that is merely keeping pages in step with the
   * facts passes just the missing keys and pays for those.
   */
  onlyInstanceKeys?: string[],
): Promise<ProvisionResult> {
  const onlyKeys = onlyInstanceKeys ? new Set(onlyInstanceKeys) : null;
  // 0. The businesses row — source for the one-time authored-copy import.
  const { data: bizRow } = await supabase
    .from("businesses")
    .select("name, hero_eyebrow, hero_headline, hero_subhead, hero_cta_label")
    .eq("id", businessId)
    .maybeSingle();
  const business = (bizRow as Record<string, unknown> | null) ?? {};

  // 1. Template
  const { data: tplRow, error: tplErr } = await supabase
    .from("site_templates")
    .select("id, template_key, section_catalog")
    .eq("template_key", templateKey)
    .maybeSingle();
  if (tplErr) throw new Error(`template_lookup_failed: ${tplErr.message}`);
  if (!tplRow) throw new Error(`template '${templateKey}' not found — apply migration 092 first`);
  const tpl = tplRow as { id: string; template_key: string; section_catalog: { page_types?: CatalogPageType[] } };

  const allPageTypes = tpl.section_catalog.page_types ?? [];
  if (allPageTypes.length === 0) {
    throw new Error(`template '${templateKey}' has an empty section_catalog.page_types`);
  }

  // 2. Site row (find-or-create)
  const { data: existing } = forceNew ? { data: null } : await supabase
    .from("sites")
    .select("id, slug")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let siteId: string;
  let siteSlug: string;
  let created = false;

  if (existing) {
    siteId = (existing as { id: string }).id;
    siteSlug = (existing as { slug: string }).slug;
  } else {
    const { data: ins, error: insErr } = await supabase
      .from("sites")
      .insert({
        business_id: businessId,
        template_id: tpl.id,
        slug: businessSlug,
        status: "draft",
      })
      .select("id, slug")
      .single();
    if (insErr) throw new Error(`site_insert_failed: ${insErr.message}`);
    siteId = (ins as { id: string }).id;
    siteSlug = (ins as { slug: string }).slug;
    created = true;
  }

  // Area pages need the service-area rows and the trade noun. areaSlug throws
  // MissingTradeNounError when the noun is absent, which halts provisioning
  // loudly rather than minting /areas/chalmette-la- with an empty segment.
  const areaRes = await supabase
    .from("business_service_areas")
    .select("area_slug, city, region")
    .eq("business_id", businessId)
    .order("display_order", { ascending: true });
  const areas = unwrap<Array<{ area_slug: string; city: string; region: string | null }>>(
    areaRes, "business_service_areas", []);
  const profRes = await supabase
    .from("business_profile").select("trade_noun").eq("business_id", businessId).maybeSingle();
  const tradeNoun = (profRes.data as { trade_noun: string | null } | null)?.trade_noun ?? null;

  // 3. Pages + sections, straight from the catalog
  const pages: ProvisionResult["pages"] = [];
  // A page type may declare INSTANCES — several documents from one set of
  // sections. legal does: terms-of-service and privacy-policy share the section
  // list and differ only in route, title, meta and clause headings. Each instance
  // becomes its own site_pages row with instance_key set, which is what the
  // COALESCE(instance_key,'') unique index is for.
  //
  // A type with no instances yields exactly one page with instance_key null, so
  // every pre-2B page type behaves as before.
  interface PageInstance {
    instance_key: string; route: string; title?: string;
    meta_defaults?: { title?: string; description?: string };
  }
  const expand = (def: (typeof allPageTypes)[number]): Array<{ instanceKey: string | null; route: string; title: string | null; md?: { title?: string; description?: string } }> => {
    const raw = (def as { instances?: unknown }).instances;
    // Only an ARRAY is an instance list. The 092 seed also uses this key for a
    // COUNT (area_detail: 10), and `raw?.length` is undefined on a number but
    // truthy on a string, so the shape has to be checked rather than probed.
    const instances = Array.isArray(raw) ? raw : undefined;
    if (instances?.length) {
      // The original 092 seed carried `instances: ["tos","privacy"]` — bare
      // strings, no route. Mapping over those would mint pages with route_path
      // undefined, so an instance that is not a full object halts here instead.
      const bad = instances.filter(
        (i) => !i || typeof i !== "object"
          || typeof (i as PageInstance).instance_key !== "string"
          || typeof (i as PageInstance).route !== "string",
      );
      if (bad.length > 0) {
        throw new Error(
          `page_type '${def.page_type}' has ${bad.length} instance(s) missing instance_key/route: `
          + `${JSON.stringify(bad).slice(0, 200)}. The template predates the instance format — `
          + `apply the outstanding migrations in textos-agent/migrations/.`,
        );
      }
      return (instances as PageInstance[]).map((i) => ({
        instanceKey: i.instance_key,
        route: i.route,
        title: i.title ?? null,
        md: i.meta_defaults,
      }));
    }
    // AREA PAGES: one instance per business_service_areas row (C1). Not a fixed
    // number — three areas means three pages, twenty means twenty, one means one.
    //
    // The slug is COMPUTED HERE AND STORED on the row. It is never recomputed at
    // render, so editing trade_noun later cannot silently rewrite live URLs and
    // break inbound links; the manager surfaces those pages as stale instead and
    // regenerating is a deliberate action (Rob's decision).
    if ((def as { instance_source?: string }).instance_source === "service_areas") {
      return areas.map((a) => ({
        instanceKey: a.area_slug,
        route: `/areas/${areaSlug(a.city, a.region, tradeNoun)}`,
        title: `${a.city}${a.region ? `, ${a.region}` : ""}`,
        md: (def as { meta_defaults?: { title?: string; description?: string } }).meta_defaults,
      }));
    }
    return [{ instanceKey: null, route: def.route, title: null, md: (def as { meta_defaults?: { title?: string; description?: string } }).meta_defaults }];
  };

  for (const wanted of pageTypes) {
    const def = allPageTypes.find((p) => p.page_type === wanted);
    if (!def) throw new Error(`template '${templateKey}' has no page_type '${wanted}'`);
    // Filtered AFTER expansion, and only for instanced types: a non-instanced
    // page (home, /areas) has instanceKey null and must never be filtered out by
    // an area-key list, or the index would vanish from a targeted top-up.
    const expanded = expand(def);
    const instanceList = onlyKeys
      ? expanded.filter((i) => i.instanceKey === null || onlyKeys.has(i.instanceKey))
      : expanded;
    if (def.repeatable && expanded.length === 1 && expanded[0].instanceKey === null) {
      throw new Error(
        `page_type '${wanted}' is repeatable but declares no instances — nothing to provision. ` +
        `Add an 'instances' array to the template's page_type.`,
      );
    }

  for (const inst of instanceList) {
    // Clean URLs: no trailing slash. The template carries area_index as "/areas/"
    // and a stored "/areas/" never matches the "/areas" a visitor types, so the
    // page 404s while existing. Normalised here rather than in the template so
    // any vertical gets it.
    const routePath = inst.route === "/" ? "/" : inst.route.replace(/\/+$/, "");

    // Reserved-route guard. Halts loudly rather than creating a page that would
    // silently serve the generated-app shell.
    const seg = firstSegment(routePath);
    if (seg && RESERVED_PAGE_SLUGS.has(seg)) {
      throw new Error(
        `page_type '${def.page_type}' resolves to '${routePath}', whose first segment ` +
        `'${seg}' is reserved by the deployed routing table (see RESERVED_PAGE_SLUGS). ` +
        `Change the template's route — this path already serves something else.`,
      );
    }

    // Per-page head meta, seeded from the template's defaults. {business_name}
    // is the only placeholder, so substitution stays predictable.
    const md = inst.md;
    const bizName = (business.name as string) ?? "";
    const meta = md
      ? {
          ...(md.title ? { title: md.title.replace(/\{business_name\}/g, bizName) } : {}),
          ...(md.description ? { description: md.description.replace(/\{business_name\}/g, bizName) } : {}),
        }
      : {};

    const { data: pageRow, error: pageErr } = await supabase
      .from("site_pages")
      .upsert(
        {
          site_id: siteId,
          page_type: def.page_type,
          instance_key: inst.instanceKey,
          title: inst.title,
          route_path: routePath,
          display_order: 0,
          status: "draft",
          noindex: def.robots === "Disallow",
          meta,
        },
        { onConflict: "site_id,page_type,instance_key" },
      )
      .select("id")
      .single();

    // The unique index uses COALESCE(instance_key,''), which PostgREST cannot
    // name as a conflict target. Fall back to select-then-insert.
    let pageId: string;
    if (pageErr) {
      const { data: found } = await supabase
        .from("site_pages")
        .select("id")
        .eq("site_id", siteId)
        .eq("page_type", def.page_type)
        // Scoped to THIS instance. Matching `instance_key IS NULL` would make the
        // two legal documents collide on one row and provision only the second.
        .filter("instance_key", inst.instanceKey === null ? "is" : "eq", inst.instanceKey === null ? "null" : inst.instanceKey)
        .maybeSingle();
      if (found) {
        pageId = (found as { id: string }).id;
        // BACKFILL, not overwrite. A page row created before migration 100 has
        // meta='{}' and would keep falling back to the computed title forever —
        // JK's home page did exactly this. Only an EMPTY meta is filled, so an
        // operator's authored title is never clobbered by a re-provision, which
        // is the same insert-if-absent rule the seeded fields follow. route_path
        // rides along so 100's .html→clean rewrite reaches existing rows too.
        const { data: cur } = await supabase
          .from("site_pages").select("meta, route_path").eq("id", pageId).maybeSingle();
        const curMeta = (cur as { meta?: Record<string, unknown> } | null)?.meta ?? {};
        const curRoute = (cur as { route_path?: string } | null)?.route_path;
        const patch: Record<string, unknown> = {};
        if (Object.keys(curMeta).length === 0 && Object.keys(meta).length > 0) patch.meta = meta;
        if (curRoute !== routePath) patch.route_path = routePath;
        if (Object.keys(patch).length > 0) {
          const { error: patchErr } = await supabase.from("site_pages").update(patch).eq("id", pageId);
          if (patchErr) throw new Error(`page_backfill_failed(${def.page_type}): ${patchErr.message}`);
        }
      } else {
        const { data: ins2, error: insErr2 } = await supabase
          .from("site_pages")
          .insert({
            site_id: siteId,
            page_type: def.page_type,
            instance_key: inst.instanceKey,
            title: inst.title,
            route_path: routePath,
            display_order: 0,
            status: "draft",
            noindex: def.robots === "Disallow",
            meta,
          })
          .select("id")
          .single();
        if (insErr2) throw new Error(`page_insert_failed(${def.page_type}): ${insErr2.message}`);
        pageId = (ins2 as { id: string }).id;
      }
    } else {
      pageId = (pageRow as { id: string }).id;
    }

    // Sections — order and membership from the catalog.
    const wantedSections = [...def.sections].sort((a, b) => a.order - b.order);
    const rows = wantedSections.map((s) => ({
      page_id: pageId,
      section_key: s.section_key,
      display_order: s.order,
      is_enabled: true,
    }));
    if (rows.length > 0) {
      const { error: secErr } = await supabase
        .from("site_sections")
        .upsert(rows, { onConflict: "page_id,section_key" });
      if (secErr) throw new Error(`sections_upsert_failed(${def.page_type}): ${secErr.message}`);
    }

    // Seed SITE-AUTHORED copy. These fields have no business fact behind them
    // (they are voice, not fact), so they must be stored — but this business
    // already has generated hero copy on `businesses` from business-landing-page.
    // Import it as the starting point rather than making the operator retype it.
    //
    // source='imported', source_path=null: it is site-authored from here on and
    // is never drift-checked. INSERT-IF-ABSENT only — an existing row is an
    // operator edit and is never overwritten by a re-provision.
    await seedAuthoredFields(supabase, pageId, wantedSections.map((s) => s.section_key), business);

    pages.push({
      page_type: def.page_type,
      instance_key: inst.instanceKey,
      route_path: routePath,
      sections: wantedSections.map((s) => s.section_key),
    });
  }
  }

  log.info("[site-render] provisioned", {
    business_id: businessId, site_id: siteId, template: templateKey,
    pages: pages.map((p) => p.page_type), created,
  });

  return { site_id: siteId, site_slug: siteSlug, created, pages };
}

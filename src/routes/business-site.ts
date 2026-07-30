// Site manager API — the editing surface for a managed site.
//
// Three kinds of field, three behaviours (migration 091 + the 1B resolver):
//   SITE_AUTHORED  stored here, editable here. Hero copy, positioning prose,
//                  theme tokens. No business fact behind them.
//   DERIVED        NOT stored. Resolved at render from business facts through
//                  source_path. Returned READ-ONLY with its source so the UI can
//                  say "from Business Facts → phone" and link to the real editor.
//                  Editing it here would break the property that makes it always
//                  current.
//   OVERRIDDEN     a stored row that ALSO carries source_path. The stored value
//                  wins; context_snapshot records what the derived value was at
//                  override time, so a later alignment pass can say "was X".
//
// Section visibility toggles are deliberately absent (Phase 1C amendment): the
// template structure is the same for every client. Sections auto-hide when they
// have no content — that is the renderer's job, not an operator switch.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { requireAuth } from "../lib/jwt";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { loadSiteFacts, resolveSourcePath, unwrap } from "../lib/site-render/facts";
import type { DerivationMap } from "../lib/site-render/resolver";
import { provisionSite } from "../lib/site-render/provision";
import { anchorFor, SHARED_AUTHORED_SECTIONS } from "../lib/site-render/sections";
import {
  FACTS_SECTIONS, resolveSource, resolveCollection, SECTION_FACT_COLLECTION, countedNoun,
} from "../lib/site-render/facts-sections";
import { scoreAreas, thresholdFromTemplate } from "../lib/site-render/duplicate-content";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

/** Which authored fields belong to which section, and how to render the input.
 *  Derived from the template's section_catalog at request time — this map only
 *  supplies the LABEL and INPUT TYPE, never the field list itself. */
interface FieldUi {
  label: string;
  input: "text" | "textarea" | "color" | "select" | "range";
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** range only */
  min?: number; max?: number; step?: number;
  /** Shown in the UI as the value used when the field is left blank. Every
   *  theme token has one, so an unset site still renders correctly. */
  placeholder?: string;
}

/** Faces /sites/[slug] can actually render. Free text would let an operator
 *  name a font the page has no @font-face for; a closed list cannot. Split into
 *  DISPLAY (headings, eyebrows — condensed, uppercase, doing the visual work)
 *  and BODY (reading copy), because the mockup uses two faces for two jobs and
 *  one token cannot express that: Bebas as body copy would be unreadable. */
const DISPLAY_FONT_OPTIONS = [
  { value: "'Bebas Neue', 'Anton', Impact, sans-serif", label: "Bebas Neue (default)" },
  { value: "'Anton', Impact, sans-serif",               label: "Anton" },
  { value: "'Oswald', 'Anton', sans-serif",             label: "Oswald" },
  { value: "'Archivo Black', Impact, sans-serif",       label: "Archivo Black" },
  { value: "'Playfair Display', Georgia, serif",        label: "Playfair Display" },
  { value: "'Space Grotesk', sans-serif",               label: "Space Grotesk" },
];
const BODY_FONT_OPTIONS = [
  { value: "'Inter', 'DM Sans', system-ui, sans-serif", label: "Inter (default)" },
  { value: "'DM Sans', system-ui, sans-serif",          label: "DM Sans" },
  { value: "'Manrope', system-ui, sans-serif",          label: "Manrope" },
  { value: "'Source Sans 3', system-ui, sans-serif",    label: "Source Sans 3" },
  { value: "'Space Grotesk', sans-serif",               label: "Space Grotesk" },
];

const FIELD_UI: Record<string, FieldUi> = {
  // site-level
  tagline:            { label: "Tagline", input: "text", hint: "Small line under the business name in the nav." },
  theme_color:        { label: "Brand colour", input: "color", placeholder: "#1F3556",
                        hint: "Buttons, accents and links use it." },
  // ── Theme tokens (migration 096) ──
  // hero-media is deliberately dark, so its text needs an on-dark colour. The
  // sheet previously had only a light-surface ink and the headline inherited it.
  ink_on_dark:        { label: "Text on dark", input: "color", placeholder: "#F7F8FA",
                        hint: "Headline and body over hero media or any dark band." },
  ink_on_light:       { label: "Text on light", input: "color", placeholder: "#16181D",
                        hint: "Headline and body over normal light sections." },
  surface_color:      { label: "Section background", input: "color", placeholder: "#FFFFFF",
                        hint: "Background behind content sections." },
  scrim_opacity:      { label: "Photo darkening", input: "range", min: 0, max: 1, step: 0.05,
                        placeholder: "0.55",
                        hint: "How much the hero image is darkened so text stays readable. Higher is darker." },
  radius_scale:       { label: "Corner style", input: "select", placeholder: "soft",
                        options: [{ value: "sharp", label: "Sharp" }, { value: "soft", label: "Soft" }],
                        hint: "Applies to cards, buttons and inputs." },
  // Superseded by display_font/body_font (migration 098). Kept so an existing
  // stored value still shows rather than silently vanishing from the UI.
  font_family:        { label: "Heading font (legacy)", input: "select", options: DISPLAY_FONT_OPTIONS,
                        hint: "Superseded by Display font. Clear this and use the two fields below." },
  display_font:       { label: "Display font", input: "select", options: DISPLAY_FONT_OPTIONS,
                        placeholder: "Bebas Neue",
                        hint: "Headings and eyebrows. Condensed faces carry the template's look." },
  body_font:          { label: "Body font", input: "select", options: BODY_FONT_OPTIONS,
                        placeholder: "Inter",
                        hint: "Reading copy. Keep this a normal-weight sans." },
  ink_on_accent:      { label: "Text on accent", input: "color", placeholder: "auto (derived)",
                        hint: "Optional. Left blank, this is computed from your brand colour's luminance so contrast always clears 4.5:1." },
  canonical_origin:   { label: "Canonical origin", input: "text", hint: "Set when the site gets its own domain." },
  booking_url:        { label: "Booking link", input: "text",
                        hint: "Where your buttons send people to book. Also adds an Online Booking item to the trust strip." },
  price_range:        { label: "Price range", input: "text", hint: "$, $$, $$$ — shown in structured data." },
  years_in_business:  { label: "Years in business", input: "text", hint: "Appears as a trust item in the hero." },
  home_base_area:     { label: "Home base", input: "text", hint: 'e.g. "Saint Bernard Parish".' },
  // ── Per-section copy ──
  // NO DESIGNER VOCABULARY. "eyebrow", "hero" and "band" mean nothing to a
  // client; they read as jargon and make the form feel like someone else's tool.
  // Every label says what the thing IS, every hint says where it appears.
  //
  // These are the UNIVERSAL fallbacks. Where the template has something more
  // specific (migration 099's field_help — "the heading above your service
  // cards" rather than "a section heading"), that wins.
  hero_eyebrow:       { label: "Small label above the headline", input: "text",
                        hint: "A few words above the main headline, shown in your brand colour." },
  hero_headline:      { label: "Main headline", input: "text",
                        hint: "The largest text on your page. Required — the page will not build without it." },
  hero_subhead:       { label: "Opening sentence", input: "textarea",
                        hint: "One sentence under the headline saying what you do and where." },
  hero_cta_label:     { label: "Main button wording", input: "text",
                        hint: 'The first button in the opening panel, e.g. "Book Online".' },
  hero_cta_secondary_label: { label: "Second button wording", input: "text",
                        hint: "Leave blank to show Call plus your phone number." },
  page_hero_label: {
    label: "Small line above the page title", input: "text",
    hint: "A short line that sits above the big title on this page — two or three words, like \"Our services\". Leave it empty to hide it.",
    placeholder: "What we do",
  },
  page_hero_headline: {
    label: "Page title", input: "text",
    hint: "The big heading at the top of this page. If you leave it empty, the page name is used.",
  },
  page_hero_subhead: {
    label: "Line under the page title", input: "textarea",
    hint: "One or two sentences under the title explaining what this page covers.",
  },
  story_para_1: {
    label: "Your story — first paragraph", input: "textarea",
    hint: "How the business started, in your own words. Write it the way you would say it to a customer.",
  },
  story_para_2: {
    label: "Your story — second paragraph", input: "textarea",
    hint: "What you do differently, or what you have learned doing this work.",
  },
  story_para_3: {
    label: "Your story — third paragraph", input: "textarea",
    hint: "Optional. Leave it empty if two paragraphs say everything.",
  },
  faq_cta_line: {
    label: "Line above the contact box", input: "text",
    hint: "Shown at the bottom of the questions page, above the phone number and booking button.",
    placeholder: "Still have a question? We're happy to help.",
  },
  legal_body_text: {
    label: "Document text", input: "textarea",
    hint: "Paste the complete text of this document. Formatting that is understood: a line starting with a number (\"1. Services Provided\") becomes a heading; so does a short line in CAPITALS. A line starting with - or a bullet becomes a list item. A blank line starts a new paragraph. Everything else is kept as written. Nothing is added for you.",
  },
  legal_last_updated: {
    label: "Date last updated", input: "text",
    hint: "The date you last revised this document, written how you want it to read. Leave it empty and no date is shown.",
    placeholder: "12 March 2026",
  },
  nav_cta_label:      { label: "Top bar button wording", input: "text",
                        hint: "The button at the top right of every page." },
  section_eyebrow:    { label: "Small label above the heading", input: "text",
                        hint: "A few words above this section's heading, in your brand colour." },
  section_headline:   { label: "Section heading", input: "text",
                        hint: "The large heading at the top of this section." },
  positioning_quote:  { label: "Quote about who you serve", input: "textarea",
                        hint: "One or two sentences, shown in large italic type." },
  band_body:          { label: "Highlights introduction", input: "textarea",
                        hint: "A sentence or two introducing what makes you different." },
  cta_headline:       { label: "Coloured band heading", input: "text",
                        hint: "The large heading inside the coloured band near the bottom of the page." },
  cta_primary_label:  { label: "Coloured band button wording", input: "text",
                        hint: "The button inside the coloured band." },
  footer_tagline:     { label: "Footer tagline", input: "text",
                        hint: "A short line under your business name at the bottom of the page." },
  sticky_call_label:  { label: "Phone call button wording", input: "text",
                        hint: "Shown only on phones, fixed to the bottom of the screen." },
  sticky_book_label:  { label: "Phone book button wording", input: "text",
                        hint: "Shown only on phones, fixed to the bottom of the screen." },
};

// Section display names come from the catalog's `label` (migration 099), NOT
// from title-casing the key — that produced "Faq Teaser" and "Cta Band", since
// no key-derived rule can know FAQ and CTA are acronyms. This fallback only
// runs for a template that predates 099, and still handles the acronyms.
const ACRONYMS: Record<string, string> = { faq: "FAQ", cta: "CTA", seo: "SEO", nap: "NAP" };
function fallbackLabel(sectionKey: string): string {
  return sectionKey.split("_")
    .map((w) => ACRONYMS[w] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── GET /:slug/site/manage ────────────────────────────────────────────────
app.get("/:slug/site/manage", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const sitesRes = await supabase
    .from("sites")
    .select("id, slug, name, status, template_id, created_at")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });
  const sites = unwrap<Array<Record<string, unknown>>>(sitesRes, "sites", []) as Array<{ id: string; slug: string; name: string | null; status: string; template_id: string; created_at: string }>;

  if (sites.length === 0) {
    return c.json({ business: { slug: business.slug, name: business.name }, sites: [], site: null });
  }

  const wanted = c.req.query("site_id");
  const site = sites.find((s) => s.id === wanted) ?? sites[0];

  const { data: tplRow } = await supabase
    .from("site_templates")
    .select("template_key, name, section_catalog, field_derivation_map")
    .eq("id", site.template_id)
    .maybeSingle();
  if (!tplRow) return c.json(errBody("internal", "template row missing"), 500);
  const tpl = tplRow as {
    template_key: string; name: string;
    section_catalog: {
      page_types?: Array<{
        page_type: string;
        sections: Array<{
          order: number; section_key: string;
          label?: string; description?: string;
          field_help?: Record<string, string>;
        }>;
      }>;
    };
    field_derivation_map: DerivationMap;
  };

  // EVERY page, not just home (2A). The manager groups its editable fields BY
  // PAGE, so a client editing the services page is not scrolling past the home
  // page's fields to reach them. Ordered by the template's own page order so the
  // manager's page order matches the nav's.
  const pagesRes = await supabase
    .from("site_pages").select("id, page_type, route_path, title")
    .eq("site_id", site.id);
  const allPages = unwrap<Array<Record<string, unknown>>>(pagesRes, "site_pages", []) as unknown as
    Array<{ id: string; page_type: string; route_path: string; title: string | null }>;

  const home = allPages.find((p) => p.page_type === "home");
  if (!home) return c.json(errBody("internal", "home page row missing — re-provision the site"), 500);

  // Page order comes from the template's page_types list; anything the template
  // no longer declares sorts last rather than disappearing from the manager.
  const pageOrder = (tpl.section_catalog.page_types ?? []).map((pt) => pt.page_type);
  const pageRank = (t: string) => {
    const i = pageOrder.indexOf(t);
    return i === -1 ? pageOrder.length : i;
  };
  allPages.sort((a, b) => pageRank(a.page_type) - pageRank(b.page_type));

  const page = home;

  const secRes = await supabase
    .from("site_sections").select("id, page_id, section_key, display_order, is_enabled")
    .in("page_id", allPages.map((p) => p.id)).order("display_order", { ascending: true });
  const allSections = unwrap<Array<Record<string, unknown>>>(secRes, "site_sections", []) as unknown as
    Array<{ id: string; page_id: string; section_key: string; display_order: number; is_enabled: boolean }>;

  // Site-level fields still anchor to the HOME page's first section — that is
  // where they already live, and moving them would orphan every existing row.
  const sections = allSections.filter((x) => x.page_id === home.id);

  const fieldRes = await supabase
    .from("site_fields")
    .select("id, section_id, field_key, value_text, value_json, source, source_path, context_snapshot, alignment_status, updated_at")
    .in("section_id", allSections.map((s) => s.id));
  const stored = unwrap<Array<Record<string, unknown>>>(fieldRes, "site_fields", []) as unknown as Array<{
    id: string; section_id: string; field_key: string; value_text: string | null;
    value_json: unknown; source: string; source_path: string | null;
    context_snapshot: string | null; alignment_status: string; updated_at: string;
  }>;

  const facts = await loadSiteFacts(supabase, business.id, business as unknown as Record<string, unknown>);

  // ── Derived-field inventory. Read-only, with the live value and its source. ──
  const derivation = tpl.field_derivation_map.site_fields ?? {};
  const derived = Object.entries(derivation)
    .filter(([, v]) => !!v.derives_from)
    .map(([field_key, v]) => {
      const path = v.derives_from as string;
      const live = resolveSourcePath(path, facts);
      const override = stored.find((s) => s.field_key === field_key && s.source_path);
      const src = resolveSource(path);
      return {
        field_key,
        // PLAIN NAME, not the key humanised. `human(field_key)` in the UI produced
        // "Address Locality", "Geo Lng", "Phone E164" and "Hero Image" — developer
        // and designer vocabulary in front of a contractor. The registry already
        // holds the plain noun for the underlying fact, so use that; the humanised
        // key remains only for a path the registry does not know.
        label: src.field_name
          ? src.field_name.charAt(0).toUpperCase() + src.field_name.slice(1)
          : fallbackLabel(field_key),
        source_path: path,
        // "Business Facts → Where your proof lives" — the heading VERBATIM from
        // the Facts registry, so a client searching that page for these words
        // finds the block. The field name rides alongside as a parenthetical.
        source_label: src.label,
        source_field: src.field_name,
        source_where: src.where,
        source_anchor: src.anchor,
        source_highlight: src.highlight,
        // Media rows resolve to an object; show the URL for display purposes.
        live_value: live && typeof live === "object" && "url" in (live as object)
          ? (live as { url: string }).url
          : (typeof live === "object" ? null : (live ?? null)),
        is_present: live !== undefined && live !== null,
        overridden: !!override,
        override_value: override?.value_text ?? null,
        context_snapshot: override?.context_snapshot ?? null,
      };
    })
    .sort((a, b) => a.field_key.localeCompare(b.field_key));

  // ── Authored fields, grouped by section, from the template's own catalog. ──
  //
  // SITE-LEVEL fields (tagline, theme_color, price_range, …) belong to the site,
  // not to any one section, so they get their own group rather than being
  // scattered. The list comes from the template's field_derivation_map — the
  // authoritative record of what is site-authored — NOT from a constant here.
  // Before this, six of the seven had no input anywhere in the manager.
  const authoredKeys = Object.entries(derivation)
    .filter(([, v]) => v.site_authored)
    .map(([k]) => k);

  // font_family is read by /sites/[slug] (the 1C D2 theme fix) but is not yet in
  // the derivation map, so nothing could ever write it and it stayed null
  // forever. Migration 095 adds it to the map; unioning it here means the input
  // exists both before and after that migration lands.
  /**
   * Keys that are authored but belong to a PAGE, not to the site.
   *
   * `site_authored: true` in the derivation map means "not derived from business
   * facts". It does NOT mean "one value for the whole site" — but this list
   * conflated the two, so every key 102/103 added to the map landed in Site
   * Settings. The legal Document text and Last updated fields appeared there
   * instead of on the Terms of Service and Privacy Policy groups, which rendered
   * with no fields at all.
   *
   * Worse than misplaced: a site-level field is stored against the HOME page's
   * first section, and legal_body renders from its own section's rows — so text
   * typed into that box would have saved and then never appeared anywhere.
   *
   * These two are per-instance by definition: each legal document has its own
   * legal_body section row, which is exactly how the two documents hold different
   * text under one field key.
   */
  const PAGE_SCOPED_KEYS = new Set(["legal_body_text", "legal_last_updated"]);

  const siteLevelKeys = [...new Set([...authoredKeys, "font_family"])]
    .filter((k) => FIELD_UI[k] && !PAGE_SCOPED_KEYS.has(k));
  // Catalog metadata (label / description / field_help, migration 099), keyed by
  // section. Declared HERE, above the first consumer: bySectionAuthored is an
  // immediately-executing .map(), so leaving these below it was a temporal dead
  // zone — tsc cannot see it because the access is inside a callback, but it
  // throws ReferenceError at runtime.
  const catalogHome = (tpl.section_catalog.page_types ?? []).find((pt) => pt.page_type === "home");
  // Keyed by "page_type/section_key", not section_key alone: page_hero appears on
  // three pages with three different descriptions, and a flat key would give all
  // three whichever page happened to be read last.
  type CatalogSection = NonNullable<typeof catalogHome>["sections"][number];
  const catalogByKey: Record<string, CatalogSection | undefined> = {};
  for (const pt of tpl.section_catalog.page_types ?? []) {
    for (const cs of pt.sections ?? []) catalogByKey[`${pt.page_type}/${cs.section_key}`] = cs;
  }
  const pageTypeById: Record<string, string> = {};
  const pageById: Record<string, typeof allPages[number]> = {};
  for (const pg of allPages) { pageTypeById[pg.id] = pg.page_type; pageById[pg.id] = pg; }

  // DECLARED ABOVE ITS CALLER, NOT BELOW IT.
  //
  // bySectionAuthored runs an immediately-executing .map() that calls
  // factContents, and FACT_COLLECTIONS is a const — leaving it further down the
  // handler put it in the temporal dead zone and every authenticated request threw
  // ReferenceError: Cannot access 'FACT_COLLECTIONS' before initialization. tsc
  // cannot see it because the access is inside a callback, and it survived a deploy
  // because the only check run against the manager was a GET of the /business page,
  // which is a STATIC shell that never calls this API.
  //
  // Second occurrence of this exact shape in this file (catalogByKey was the
  // first). __tests__/manager-endpoint.test.ts now executes the handler, which is
  // the only thing that catches it.
  // ── Section slots: every template section, with whether it has content. ──
  // Each entry carries a COMPLETE sentence rather than a noun spliced into
  // `No ${source} yet`. That template produced "No a Google Place ID yet" — an
  // article cannot survive being concatenated into a fixed frame, and the same
  // fault would hit any source phrase needing an article or a verb.
  // Keyed by COLLECTION rather than by section: faq_teaser and faq_accordion draw
  // on the same questions, services_grid and service_detail on the same services.
  // One definition each means the count and the empty sentence cannot drift between
  // two sections that show the same facts.
  //
  // `count` is separate from items.length because the reviews block has no list to
  // show — it is connected or it is not.
  const FACT_COLLECTIONS: Record<string, { count: number; items: string[]; empty: string }> = {
    services:        { count: facts.services.length,
                       items: facts.services.map((x) => x.name),
                       empty: "You have not added any services yet" },
    areas:           { count: facts.areas.length,
                       items: facts.areas.map((x) => x.city),
                       empty: "You have not added any service areas yet" },
    faqs:            { count: facts.faqs.length,
                       items: facts.faqs.map((x) => x.question),
                       empty: "You have not added any questions yet" },
    projects:        { count: facts.projects.filter((p) => p.media_id).length,
                       items: facts.projects.filter((p) => p.media_id).map((x) => x.caption),
                       empty: "No projects have a photo yet" },
    differentiators: { count: facts.differentiators.length,
                       items: facts.differentiators.map((x) => x.headline),
                       empty: "You have not added any differentiators yet" },
    // No item list: there is nothing to enumerate, and inventing a phrase like
    // "listing connected" would be a new string competing with the registry's.
    google_place_id: { count: facts.profile?.google_place_id ? 1 : 0,
                       items: [],
                       empty: "Your Google listing is not connected yet" },
  };

  /**
   * The read-only half of a section group: what arrives from Business Facts.
   *
   * Facts holds the CONTENT (service names, blurbs, questions, answers); the
   * manager holds the FRAMING (small label, heading, authored intro). Neither page
   * used to mention the other, so an operator could not tell which was
   * authoritative. Every visible word here — the band name and the noun — comes
   * from the facts-sections registry, so it reads exactly as the Facts page does.
   */
  const MAX_SHOWN = 8;
  function factContents(sectionKey: string) {
    const collection = SECTION_FACT_COLLECTION[sectionKey];
    if (!collection) return null;
    const coll = FACT_COLLECTIONS[collection];
    if (!coll) return null;
    const src = resolveCollection(collection);
    const base = src.where === "context" ? "../context" : "../facts";
    return {
      collection,
      // The finished phrase — "4 services", "1 service area". Assembled in the
      // registry so the UI prints it and writes nothing of its own.
      //
      // Null when there is no list to enumerate: the reviews block is connected or
      // it is not, and its registry noun is already singular, so a count would have
      // read "1 Google Place ID from Business Facts → Where your proof lives".
      // Without a count the UI falls back to naming the band alone, which is the
      // honest statement — this is where it comes from.
      count_label: coll.items.length > 0 ? countedNoun(coll.count, src.field_name ?? "") : null,
      count: coll.count,
      items: coll.items.slice(0, MAX_SHOWN),
      more: Math.max(0, coll.items.length - MAX_SHOWN),
      // "Business Facts → What you do", verbatim from the registry.
      source_label: src.label,
      href: src.anchor ? `${base}#${src.anchor}` : base,
      empty_hint: coll.count === 0 ? coll.empty : null,
    };
  }

  // Shared chrome (nav, footer, CTA band, sticky bar) is offered ONCE, under Home.
  //
  // Its authored copy now resolves site-wide from the home page's rows, so a field
  // edited on the services page would save and then never appear — a silent no-op,
  // which is worse than the field being absent. The section descriptions already
  // tell the operator it is edited once under Home; this makes that true in the UI
  // as well as in the renderer.
  const bySectionAuthored = allSections
    .filter((sec) => !(SHARED_AUTHORED_SECTIONS.has(sec.section_key) && sec.page_id !== home.id))
    .map((sec) => {
    const pg = pageById[sec.page_id];
    const pageType = pg?.page_type ?? "home";
    const rows = stored.filter((s) => s.section_id === sec.id && !s.source_path
      // Site-level keys render in their own group above, never inside a section.
      && !siteLevelKeys.includes(s.field_key));
    // Keys the UI knows how to render for this section: whatever is already
    // stored, plus the site-level authored keys on the first section.
    const keys = new Set(rows.map((r) => r.field_key));
    for (const k of Object.keys(FIELD_UI)) {
      if (siteLevelKeys.includes(k)) continue;
      // page_hero is the shared top-of-page block on services / why-us / faq.
      if (sec.section_key === "page_hero" && k.startsWith("page_hero_")) keys.add(k);
      if (sec.section_key === "story_prose" && k.startsWith("story_para_")) keys.add(k);
      if (sec.section_key === "faq_footer_cta" && k === "faq_cta_line") keys.add(k);
      // 2B: the legal document sections.
      // 106: the date moved into the hero, so its field follows it there.
      if (sec.section_key === "page_hero" && k === "legal_last_updated") keys.add(k);
      if (sec.section_key === "legal_body" && k === "legal_body_text") keys.add(k);
      if (sec.section_key === "hero_home" && k.startsWith("hero_")) keys.add(k);
      if (sec.section_key === "site_nav" && (k === "tagline" || k === "nav_cta_label")) keys.add(k);
      if (sec.section_key === "site_footer" && k === "footer_tagline") keys.add(k);
      if (sec.section_key === "positioning_band" && k === "positioning_quote") keys.add(k);
      if (sec.section_key === "differentiator_band" && k === "band_body") keys.add(k);
      if (sec.section_key === "cta_band" && (k === "cta_headline" || k === "cta_primary_label")) keys.add(k);
      if (sec.section_key === "mobile_sticky_bar" && k.startsWith("sticky_")) keys.add(k);
      if (["services_grid", "featured_work", "service_area_chips", "faq_teaser", "differentiator_band", "reviews",
           "service_detail", "story_prose", "differentiator_list", "faq_accordion",
           "project_gallery", "gallery_cta", "contact_direct"].includes(sec.section_key)
          && (k === "section_eyebrow" || k === "section_headline")) keys.add(k);
    }
    const cat = catalogByKey[`${pageType}/${sec.section_key}`];
    return {
      section_id: sec.id,
      section_key: sec.section_key,
      display_order: sec.display_order,
      // Page identity, so the manager can group by page and point "View on site"
      // at the page the section is actually on rather than always at home.
      page_id: sec.page_id,
      page_type: pageType,
      page_label: pg ? (pg.title ?? fallbackLabel(pg.page_type)) : "Home",
      route_path: pg?.route_path ?? "/",
      // The other half of "complete contents" — read-only, from Business Facts.
      contents: factContents(sec.section_key),
      // From the template (migration 099), never derived from the key.
      label: cat?.label ?? fallbackLabel(sec.section_key),
      description: cat?.description ?? null,
      anchor: anchorFor(sec.section_key),
      fields: [...keys].map((k) => {
        const row = rows.find((r) => r.field_key === k);
        const ui = FIELD_UI[k] ?? { label: k.replace(/_/g, " "), input: "text" as const };
        // Template-specific help wins over the universal FIELD_UI hint: only the
        // template knows that "section_headline" here means the heading above the
        // service cards rather than above the FAQ list.
        const help = cat?.field_help?.[k] ?? ui.hint ?? null;
        return {
          field_key: k, label: ui.label, input: ui.input, hint: help,
          options: ui.options ?? null, placeholder: ui.placeholder ?? null,
          min: ui.min ?? null, max: ui.max ?? null, step: ui.step ?? null,
          value: row?.value_text ?? null,
          source: row?.source ?? null,
          // Copy imported from business-landing-page is a starting point, not a
          // decision — the UI flags it so an operator knows to review it.
          is_imported: row?.source === "imported",
        };
      }).sort((a, b) => a.field_key.localeCompare(b.field_key)),
    };
  });

  // Slots cover EVERY page (2A), each tagged with the page it belongs to. The
  // counts above are business-wide facts, so a section that is empty is empty on
  // every page it appears on — which is the honest answer.
  const slots = allPages.flatMap((pg) => {
    const cat = (tpl.section_catalog.page_types ?? []).find((pt) => pt.page_type === pg.page_type);
    return (cat?.sections ?? []).map((s) => {
      const cc = factContents(s.section_key);
      return {
        page_type: pg.page_type,
        page_label: pg.title ?? fallbackLabel(pg.page_type),
        route_path: pg.route_path,
        section_key: s.section_key,
        order: s.order,
        label: s.label ?? fallbackLabel(s.section_key),
        description: s.description ?? null,
        anchor: anchorFor(s.section_key),
        has_content: cc ? cc.count > 0 : true,
        content_count: cc?.count ?? null,
        empty_hint: cc?.empty_hint ?? null,
        fill_where: cc ? "facts" : null,
        contents: cc,
      };
    });
  });

  // ── Area page quality — the duplicate-content gate (2C Part D) ────────────
  //
  // ADVISORY, NOT A BLOCK. There is no publish flow to gate, and the operator is
  // the only one who can write something true about a place. The manager states
  // the score and names the fix; it does not stop anything.
  //
  // The threshold comes from the TEMPLATE, not from a constant here — a vertical
  // whose areas are legitimately similar can carry its own number.
  //
  // Every visible word about where to fix it comes from the facts-sections
  // registry, the same rule factContents follows: the blurbs live in Business
  // Facts, and this page never invents its own name for that band.
  const areaQuality = (() => {
    if (facts.areas.length === 0) return null;
    const threshold = thresholdFromTemplate(tpl.section_catalog);
    const src = resolveCollection("areas");
    const base = src.where === "context" ? "../context" : "../facts";
    // `?? ""` because the column is nullable even though AreaRow types it as a
    // string: an area added before the blurbs were required still has nulls, and
    // scoring must report "nothing unique here" rather than throw on .toLowerCase.
    const scores = scoreAreas(
      facts.areas.map((a) => ({
        area_slug: a.area_slug,
        city: a.city,
        region: a.region,
        postal_code: a.postal_code,
        local_blurb: a.local_blurb ?? "",
        landmarks_blurb: a.landmarks_blurb ?? "",
      })),
      threshold,
    );
    return {
      threshold,
      below_count: scores.filter((s) => s.below_threshold).length,
      source_label: src.label,
      edit_href: src.anchor ? `${base}#${src.anchor}` : base,
      areas: scores,
    };
  })();

  const mediaRes = await supabase
    .from("site_media")
    .select("id, url, alt_text, kind, mime_type, width, height, bytes, role, origin, poster_url")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });
  const mediaRows = unwrap<Array<Record<string, unknown>>>(mediaRes, "site_media", []);

  // Site-level fields attach to the first section's id: site_fields rows need a
  // section_id, the resolver in compose.ts reads across every section on the
  // page, and overrides already use this same anchor. Presented as its own
  // group so the operator sees "Site settings", not "site_nav".
  const anchorSectionId = sections[0]?.id ?? null;
  const siteGroup = anchorSectionId
    ? {
        section_id: anchorSectionId,
        section_key: "__site__",
        display_order: -1,
        // Site settings apply to every page. Tagged to home so the group sorts
        // first and "View on site" has somewhere sensible to point.
        page_id: home.id,
        page_type: "home",
        page_label: home.title ?? "Home",
        route_path: home.route_path,
        fields: siteLevelKeys.map((k) => {
          const row = stored.find((r) => r.field_key === k && !r.source_path);
          const ui = FIELD_UI[k];
          return {
            field_key: k, label: ui.label, input: ui.input, hint: ui.hint ?? null,
            options: ui.options ?? null, placeholder: ui.placeholder ?? null,
            min: ui.min ?? null, max: ui.max ?? null, step: ui.step ?? null,
            value: row?.value_text ?? null,
            source: row?.source ?? null,
            is_imported: row?.source === "imported",
          };
        }),
      }
    : null;

  return c.json({
    business: { slug: business.slug, name: business.name },
    sites,
    site: { ...site, template_key: tpl.template_key, template_name: tpl.name, page_id: page.id, route_path: page.route_path },
    // Page list in template order, so the manager renders its page groups in the
    // same order the site's nav does.
    pages: allPages.map((pg) => ({
      page_id: pg.id,
      page_type: pg.page_type,
      route_path: pg.route_path,
      label: pg.title ?? fallbackLabel(pg.page_type),
      href: pg.route_path === "/" ? `/sites/${site.slug}` : `/sites/${site.slug}${pg.route_path}`,
    })),
    sections: siteGroup ? [siteGroup, ...bySectionAuthored] : bySectionAuthored,
    derived,
    slots,
    area_quality: areaQuality,
    media: mediaRows ?? [],
    preview_url: `/sites/${site.slug}`,
  });
});

// ── PUT /:slug/site/manage ────────────────────────────────────────────────
const SaveBody = z.object({
  site_id: z.string().uuid(),
  // section_id → { field_key → value | null }
  authored: z.record(z.string().uuid(), z.record(z.string(), z.string().nullable())).default({}),
  // field_key → value | null  (null clears the override, reverting to derived)
  overrides: z.record(z.string(), z.string().nullable()).default({}),
});

app.put("/:slug/site/manage", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  let body: z.infer<typeof SaveBody>;
  try {
    body = SaveBody.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "invalid", err.issues.map((i) => ({ field: i.path.join("."), message: i.message }))), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  const { data: site } = await supabase
    .from("sites").select("id, template_id").eq("id", body.site_id).eq("business_id", business.id).maybeSingle();
  if (!site) return c.json(errBody("not_found", "site not found for this business"), 404);

  const { data: tplRow } = await supabase
    .from("site_templates").select("field_derivation_map").eq("id", (site as { template_id: string }).template_id).maybeSingle();
  const derivation = ((tplRow as { field_derivation_map: DerivationMap } | null)?.field_derivation_map.site_fields) ?? {};

  const now = new Date().toISOString();
  const stamp = { updated_by: auth.user_id, updated_at: now };

  // ── Authored fields ──
  // An operator edit ALWAYS sets source='operator'. That is what stops a
  // re-provision from overwriting it: the seeder only inserts when a row is
  // absent, and this row now says a human wrote it.
  for (const [sectionId, fields] of Object.entries(body.authored)) {
    for (const [fieldKey, raw] of Object.entries(fields)) {
      const value = raw === null ? null : String(raw).trim();
      if (value === null || value === "") {
        await supabase.from("site_fields").delete().eq("section_id", sectionId).eq("field_key", fieldKey).is("source_path", null);
        continue;
      }
      const { error } = await supabase.from("site_fields").upsert(
        {
          section_id: sectionId, field_key: fieldKey, value_text: value,
          source: "operator", source_path: null, alignment_status: "unchecked", ...stamp,
        },
        { onConflict: "section_id,field_key" },
      );
      if (error) {
        log.error("[site-manage] authored_write_failed", { site_id: body.site_id, field: fieldKey, err: error.message });
        return c.json(errBody("internal", `authored_write_failed(${fieldKey}): ${error.message}`), 500);
      }
    }
  }

  // ── Overrides ──
  // Storing an override captures context_snapshot: the derived value AS IT WAS
  // when the override was taken. That is what lets a later alignment pass say
  // "the fact changed since you overrode this".
  if (Object.keys(body.overrides).length > 0) {
    const facts = await loadSiteFacts(supabase, business.id, business as unknown as Record<string, unknown>);
    const { data: firstSec } = await supabase
      .from("site_sections").select("id")
      .eq("page_id", (await supabase.from("site_pages").select("id").eq("site_id", body.site_id).eq("page_type", "home").maybeSingle()).data?.id ?? "")
      .order("display_order", { ascending: true }).limit(1).maybeSingle();
    const sectionId = (firstSec as { id: string } | null)?.id;
    if (!sectionId) return c.json(errBody("internal", "no section to attach the override to"), 500);

    for (const [fieldKey, raw] of Object.entries(body.overrides)) {
      const path = derivation[fieldKey]?.derives_from;
      if (!path) {
        return c.json(errBody("bad_request", `'${fieldKey}' is not a derived field — nothing to override`), 400);
      }
      if (raw === null || String(raw).trim() === "") {
        await supabase.from("site_fields").delete().eq("section_id", sectionId).eq("field_key", fieldKey).not("source_path", "is", null);
        continue;
      }
      const live = resolveSourcePath(path, facts);
      const snapshot = live === undefined || live === null
        ? null
        : (typeof live === "object" ? JSON.stringify(live) : String(live));
      const { error } = await supabase.from("site_fields").upsert(
        {
          section_id: sectionId, field_key: fieldKey, value_text: String(raw).trim(),
          source: "operator", source_path: path, context_snapshot: snapshot,
          alignment_status: "overridden", alignment_checked_at: now, ...stamp,
        },
        { onConflict: "section_id,field_key" },
      );
      if (error) {
        log.error("[site-manage] override_write_failed", { site_id: body.site_id, field: fieldKey, err: error.message });
        return c.json(errBody("internal", `override_write_failed(${fieldKey}): ${error.message}`), 500);
      }
    }
  }

  log.info("[site-manage] saved", {
    business_id: business.id, site_id: body.site_id,
    sections: Object.keys(body.authored).length, overrides: Object.keys(body.overrides).length,
  });
  return c.json({ ok: true });
});

// ── POST /:slug/site/create ───────────────────────────────────────────────
// A business may have more than one site. Slug must be globally unique.
const CreateBody = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
  name: z.string().trim().min(1).optional(),
  template_key: z.string().trim().default("trades-v1"),
});

app.post("/:slug/site/create", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "invalid", err.issues.map((i) => ({ field: i.path.join("."), message: i.message }))), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  const { data: taken } = await supabase.from("sites").select("id").eq("slug", body.slug).maybeSingle();
  if (taken) return c.json(errBody("bad_request", `site slug '${body.slug}' is already taken`), 409);

  try {
    const result = await provisionSite(supabase, business.id, body.slug, body.template_key, ["home"], true);
    if (body.name) await supabase.from("sites").update({ name: body.name }).eq("id", result.site_id);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("[site-manage] create_failed", { business_id: business.id, err: String(err) });
    return c.json(errBody("internal", `create_failed: ${String(err)}`), 500);
  }
});

export default app;

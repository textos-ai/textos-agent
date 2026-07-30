import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { log } from "../lib/logger";
import { composeManagedPage } from "../lib/site-render/compose";
import { MissingFactError, SchemaError } from "../lib/site-render/facts";

const app = new Hono<{ Bindings: Env }>();

/**
 * Public business site data endpoint — no auth required.
 * Returns both businesses table visual identity columns and business_context data.
 * V1 note: slug is unique per user; collisions impossible at alpha scale.
 */
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: "not_found", message: "Invalid slug" }, 404);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: businessRaw, error: bizErr } = await supabase
    .from("businesses")
    .select(
      "id, name, slug, created_at, " +
      "accent_color, accent_color_override, hero_layout, hero_font, " +
      "hero_image_url, hero_image_credit, seo_title, seo_description, seo_keywords, " +
      "calendly_url, show_credentials_publicly, eyebrow_vocab, " +
      "hero_css_pattern, og_image_url, " +
      "hero_eyebrow, hero_headline, hero_headline_accent, hero_subhead, " +
      "hero_cta_label, hero_cta_type, " +
      "icp_headline, icp_description, icp_signals, " +
      "pain_points, metrics, palate_cleanser, why_us, nav_links, " +
      "what_we_do_eyebrow, what_we_do_headline, what_we_do_body, " +
      "founder_eyebrow, founder_headline, founder_body",
    )
    .eq("slug", slug)
    .eq("is_active", true) // public site is hidden when the business is deactivated
    .limit(1)
    .maybeSingle();

  const business = businessRaw as Record<string, unknown> | null;
  if (bizErr || !business) {
    log.info("site_not_found", { slug });
    return c.json({ error: "not_found", message: "Business not found" }, 404);
  }

  const { data: ctxRaw } = await supabase
    .from("business_context")
    .select(
      "business_summary, value_proposition, industry, business_model, " +
      "target_customer, positioning_statement, key_differentiators, brand_voice, agent_name",
    )
    .eq("business_id", business.id)
    .maybeSingle();

  const ctx = ctxRaw as Record<string, unknown> | null;

  // ── Phase 1 multi-app: list of generated apps for this business ────────
  // Public — same auth posture as the rest of this endpoint. Source:
  // business_assets WHERE asset_type='app' AND is_current=true. Newest
  // first. app_slug and app_icon come from the top-level columns added
  // in the Phase 1 migration; app_title/tagline/type live in asset_data
  // (where the HTML step also stores them on insert).
  const { data: appRowsRaw, error: appsErr } = await supabase
    .from("business_assets")
    .select("id, app_slug, app_icon, asset_data, created_at")
    .eq("business_id", business.id)
    .eq("asset_type", "app")
    .eq("is_current", true)
    .order("created_at", { ascending: false });
  if (appsErr) {
    log.warn("site_apps_lookup_failed", { slug, err: appsErr.message });
    // Non-fatal — render the site with an empty apps list rather than 500.
  }
  type AppRow = {
    id: string;
    app_slug: string | null;
    app_icon: string | null;
    asset_data: Record<string, unknown> | null;
    created_at: string;
  };
  const apps = ((appRowsRaw ?? []) as AppRow[])
    // Drop legacy rows that pre-date the slug migration — they'd render
    // without a routable URL. New rows always have app_slug; this is a
    // safety filter, not a frequent path.
    .filter((r) => typeof r.app_slug === "string" && r.app_slug.length > 0)
    .map((r) => ({
      id: r.id,
      app_slug: r.app_slug as string,
      app_title: (r.asset_data?.app_title as string) ?? "",
      app_tagline: (r.asset_data?.app_tagline as string) ?? "",
      app_icon: r.app_icon,
      app_type: (r.asset_data?.app_type as string) ?? "",
      created_at: r.created_at,
    }));

  // ── Website Manager: a managed site supersedes the generated landing page ──
  // When the business has a `sites` row, compose its page from the trades
  // template + business facts and return it alongside the legacy payload. The
  // frontend renders `managed_site` when present and falls back to the landing
  // page otherwise — matching the recorded "OPEN MY WEBSITE" decision.
  //
  // Derived fields resolve HERE, at request time, from the current business
  // facts. That is what makes "change the phone on the Facts page, reload the
  // site, it's changed" true with no regeneration step.
  let managedSite: unknown = null;
  let managedError: string | null = null;
  // Distinguishes "this deployment is broken" from "this business hasn't
  // filled something in". The frontend refuses to serve a page for the former.
  let managedErrorKind: "schema" | "missing_fact" | "other" | null = null;
  try {
    const origin = new URL(c.req.url).origin;
    const frontend = (c.env.FRONTEND_URL as string | undefined) ?? origin;
    const base = `/sites/${business.slug as string}`;
    // ?path= selects the page. Absent means the home page, which keeps every
    // existing consumer of this endpoint working unchanged.
    const wantPath = c.req.query("path") || "/";
    const canonicalPath = wantPath === "/" ? base : `${base}${wantPath}`;
    managedSite = await composeManagedPage(supabase, business, {
      canonicalUrl: `${frontend.replace(/\/$/, "")}${canonicalPath}`,
      origin: frontend.replace(/\/$/, ""),
      basePath: base,
      routePath: wantPath,
    });
  } catch (err) {
    // A missing REQUIRED fact must NOT silently fall back to the old landing
    // page — that would hide the problem behind a page that looks fine. Surface
    // it so the operator sees exactly which fact is absent.
    if (err instanceof SchemaError) {
      // A migration was never applied. This is NOT a content problem and must
      // not degrade to the legacy landing page — that would hide a dead
      // feature behind a page that looks fine.
      managedError = err.message;
      managedErrorKind = "schema";
      log.error("site_managed_schema_fault", { slug, table: err.table, code: err.code });
    } else if (err instanceof MissingFactError) {
      managedError = err.message;
      managedErrorKind = "missing_fact";
      log.warn("site_managed_missing_fact", { slug, field: err.fieldName, path: err.sourcePath });
    } else {
      managedError = String(err);
      managedErrorKind = "other";
      log.error("site_managed_compose_failed", { slug, err: String(err) });
    }
  }

  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    managed_site: managedSite,
    managed_error: managedError,
    managed_error_kind: managedErrorKind,
    // id is read by app.astro (`/sites/{slug}/app`) and the embedded
    // "Business App" teaser in /sites/[slug]/index.astro to resolve
    // slug → businessId before calling /api/generated-apps/{id}/app-html.
    // Already publicly derivable from generated-app HTML and Stripe metadata;
    // net new exposure is zero.
    id:                       business.id,
    name:                     business.name,
    slug:                     business.slug,
    created_at:               business.created_at,
    // Visual identity (agent-derived, may be null before first build)
    accent_color:             business.accent_color     ?? null,
    accent_color_override:    business.accent_color_override ?? null,
    hero_layout:              business.hero_layout      ?? "type",
    hero_font:                business.hero_font        ?? "space_grotesk",
    hero_image_url:           business.hero_image_url   ?? null,
    hero_image_credit:        business.hero_image_credit ?? null,
    eyebrow_vocab:            business.eyebrow_vocab    ?? "standard",
    hero_css_pattern:         business.hero_css_pattern ?? null,
    og_image_url:             business.og_image_url     ?? null,
    // SEO (agent-derived)
    seo_title:                business.seo_title        ?? null,
    seo_description:          business.seo_description  ?? null,
    seo_keywords:             business.seo_keywords     ?? [],
    // Hero content fields
    hero_eyebrow:             business.hero_eyebrow     ?? null,
    hero_headline:            business.hero_headline    ?? null,
    hero_headline_accent:     business.hero_headline_accent ?? null,
    hero_subhead:             business.hero_subhead     ?? null,
    hero_cta_label:           business.hero_cta_label   ?? null,
    hero_cta_type:            business.hero_cta_type    ?? null,
    // ICP fields
    icp_headline:             business.icp_headline     ?? null,
    icp_description:          business.icp_description  ?? null,
    icp_signals:              business.icp_signals      ?? [],
    // Structured content (JSONB)
    pain_points:              business.pain_points      ?? [],
    metrics:                  business.metrics          ?? [],
    palate_cleanser:          business.palate_cleanser  ?? {},
    why_us:                   business.why_us           ?? [],
    nav_links:                business.nav_links        ?? [],
    // What We Do fields
    what_we_do_eyebrow:       business.what_we_do_eyebrow ?? null,
    what_we_do_headline:      business.what_we_do_headline ?? null,
    what_we_do_body:          business.what_we_do_body  ?? null,
    // Founder fields
    founder_eyebrow:          business.founder_eyebrow  ?? null,
    founder_headline:         business.founder_headline ?? null,
    founder_body:             business.founder_body     ?? null,
    // User settings
    calendly_url:             business.calendly_url     ?? null,
    show_credentials_publicly: business.show_credentials_publicly ?? false,
    // Business context
    value_proposition:        ctx?.value_proposition    ?? null,
    business_summary:         ctx?.business_summary     ?? null,
    industry:                 ctx?.industry             ?? null,
    business_model:           ctx?.business_model       ?? null,
    target_customer:          ctx?.target_customer      ?? null,
    positioning_statement:    ctx?.positioning_statement ?? null,
    key_differentiators:      ctx?.key_differentiators  ?? [],
    agent_name:               ctx?.agent_name           ?? null,
    // Phase 1 multi-app: list of generated apps for this business.
    // Empty array when the biz has none or the lookup failed.
    apps,
  });
});

export default app;

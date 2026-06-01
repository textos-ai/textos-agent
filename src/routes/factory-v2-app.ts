import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { generateStrategyContentFromAnswers } from "../lib/factory-v2/strategy-live-generator";
import { SAMPLE_BUSINESS } from "../lib/factory-v2/strategy-live-prompt";
import { buildStrategyResultComposition } from "../lib/factory-v2/strategy-result-recipe";
import { assembleComposition } from "../lib/factory-v2/assemble";
import { wrapProofDocument } from "../lib/factory-v2/document-shell";
import { buildStrategyCollectPage } from "../lib/factory-v2/strategy-collect-recipe";
import { pickStableSkin, isFactoryV2Skin } from "../lib/factory-v2/strategy-skin";
import { getOrCreateSkin, readStoredSkin } from "../lib/factory-v2/strategy-skin-store";
import {
  loadRealBusiness,
  buildRealIdentity,
  requiredFieldReport,
  MissingContextError,
  BusinessNotFoundError,
} from "../lib/factory-v2/strategy-context";

// ─────────────────────────────────────────────────────────────────────────────
// TEMP DEV — factory-v2 Step-4 wizard app (retire at cutover, same as the
// factory-v2-proof endpoint). Browser-callable, NOT secret-gated.
//
//   GET  /            → sample (Phase B) wizard page — SAMPLE_BUSINESS.
//   POST /            → sample generate.
//   GET  /:slug       → Phase-1 wizard page for a REAL business by slug.
//                       ?debug=context → JSON introspection (no render).
//   POST /:slug       → REAL-context generate: visitor answers + the business's
//                       real DB context → proven chain → result inner HTML.
//
// No-fallbacks: a real business missing required context HALTS with a clear
// error (MissingContextError) — never falls back to SAMPLE_BUSINESS.
//
// Assets: served from the Worker origin (no /homer/* of its own), so the Homer
// bundle loads from the textos-web TEST origin.
// ─────────────────────────────────────────────────────────────────────────────

const HOMER_ASSET_BASE = "https://textos-web-test.pages.dev";

const app = new Hono<{ Bindings: Env }>();

function renderWizard(skin: string): Response {
  const { innerHtml, inlineScript } = buildStrategyCollectPage();
  const doc = wrapProofDocument(innerHtml, {
    skin,
    assetBase: HOMER_ASSET_BASE,
    extraScripts: ["/homer/js/pages/form-wizard.js"],
    inlineScript,
  });
  return new Response(doc, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-fv2-skin": skin } });
}

async function generate(
  c: { env: Env },
  business: { name: string; summary: string },
  answers: { question: string; answer: string }[],
): Promise<Response> {
  const { content, meta } = await generateStrategyContentFromAnswers(c.env.ANTHROPIC_API_KEY, business, answers);
  const composition = buildStrategyResultComposition(content);
  const { html: inner, rendered_ids } = assembleComposition(composition); // throws on unknown id

  const hay = JSON.stringify(content).toLowerCase();
  return new Response(inner, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-fv2-composed-ids": rendered_ids.join(","),
      "x-fv2-sections": String(content.sections.length),
      "x-fv2-stop-reason": String(meta.stop_reason),
      "x-fv2-output-tokens": String(meta.output_tokens),
      "x-fv2-headline": encodeURIComponent(content.headline).slice(0, 200),
    },
  });
}

// ── Sample (Phase B) — unchanged behavior ──────────────────────────────────
app.get("/", (c) => {
  const override = c.req.query("skin");
  const skin = isFactoryV2Skin(override) ? override : pickStableSkin(SAMPLE_BUSINESS.name);
  return renderWizard(skin);
});

app.post("/", async (c) => {
  let body: { answers?: { question: string; answer: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const answers = body?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return c.json({ error: "no_answers" }, 400);
  try {
    return await generate(c, SAMPLE_BUSINESS, answers);
  } catch (err) {
    return c.json({ error: "generation_failed", message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ── Phase 1 — REAL business by slug ────────────────────────────────────────
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const client = createSupabaseClient(c.env);

  // Introspection mode — verify the live DB without rendering/generating.
  if (c.req.query("debug") === "context") {
    try {
      const { business, ctx } = await loadRealBusiness(client, slug);
      const report = requiredFieldReport(business, ctx);

      // Skin-storage probe: does any home for a persisted skin exist today?
      const acSkin = await client.from("app_configs").select("skin").limit(1);
      const assets = await client
        .from("business_assets")
        .select("id, asset_type, asset_subtype, metadata")
        .eq("business_id", business.id);
      const assetRows = (assets.data ?? []) as { asset_type: string; asset_subtype: string | null; metadata: Record<string, unknown> }[];

      return c.json({
        slug,
        business_found: true,
        business_id: business.id,
        business_name: business.name,
        context_present: ctx !== null,
        required: report,
        // small real-value samples to confirm this is gaudet's data (truncated)
        sample_values: ctx
          ? {
              industry: (ctx.industry ?? "").slice(0, 80),
              value_proposition: (ctx.value_proposition ?? "").slice(0, 120),
              brand_voice: (ctx.brand_voice ?? "").slice(0, 80),
              business_summary: (ctx.business_summary ?? "").slice(0, 120),
            }
          : null,
        skin_storage: {
          stored_skin: await readStoredSkin(client, business.id), // factory_v2_app_skin
          app_configs_has_skin_column: acSkin.error == null,
          app_configs_probe_error: acSkin.error?.message ?? null,
          business_assets_count: assetRows.length,
          business_assets_types: assetRows.map((a) => a.asset_type),
          business_assets_with_skin_meta: assetRows.filter((a) => a.metadata && "skin" in a.metadata).length,
        },
      });
    } catch (err) {
      if (err instanceof BusinessNotFoundError) {
        return c.json({ slug, business_found: false, error: err.message }, 404);
      }
      return c.json({ slug, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // Normal render — validate real context (no-fallbacks) then theme + render.
  try {
    const { business, ctx } = await loadRealBusiness(client, slug);
    buildRealIdentity(slug, business, ctx); // throws MissingContextError if incomplete

    // Persisted skin: picked ONCE on first render, read back every time after.
    // ?skin= is a non-persisting preview override (curation only).
    const override = c.req.query("skin");
    const skin = isFactoryV2Skin(override) ? override : (await getOrCreateSkin(client, business.id)).skin;
    return renderWizard(skin);
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json({ error: "business_not_found", slug, message: err.message }, 404);
    if (err instanceof MissingContextError) {
      return c.json({ error: "missing_required_context", slug, missing: err.missing, message: err.message }, 422);
    }
    return c.json({ error: "load_failed", slug, message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/:slug", async (c) => {
  const slug = c.req.param("slug");
  let body: { answers?: { question: string; answer: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const answers = body?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return c.json({ error: "no_answers" }, 400);

  const client = createSupabaseClient(c.env);
  try {
    const { business, ctx } = await loadRealBusiness(client, slug);
    const identity = buildRealIdentity(slug, business, ctx); // no-fallbacks: throws if incomplete
    return await generate(c, identity, answers); // REAL gaudet context, not SAMPLE_BUSINESS
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json({ error: "business_not_found", slug, message: err.message }, 404);
    if (err instanceof MissingContextError) {
      return c.json({ error: "missing_required_context", slug, missing: err.missing, message: err.message }, 422);
    }
    return c.json({ error: "generation_failed", slug, message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

export default app;

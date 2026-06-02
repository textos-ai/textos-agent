import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { wrapProofDocument } from "../lib/factory-v2/document-shell";
import { isFactoryV2Skin } from "../lib/factory-v2/strategy-skin";
import { getOrCreateSkin } from "../lib/factory-v2/strategy-skin-store";
import {
  loadRealBusiness,
  buildRealIdentity,
  MissingContextError,
  BusinessNotFoundError,
} from "../lib/factory-v2/strategy-context";
import { generateCalculatorSpec } from "../lib/factory-v2/calculator-generator";
import { buildCalculatorPage } from "../lib/factory-v2/calculator-recipe";
import {
  sanitizeExpression,
  DisallowedExpressionTokenError,
  type CalculatorBuildSpec,
} from "../lib/factory-v2/calculator-spec-schema";
import { isFontPairing, DEFAULT_FONT_PAIRING } from "../lib/factory-v2/textos-style-layer";

// ─────────────────────────────────────────────────────────────────────────────
// TEMP DEV — factory-v2 Calculator app (the Compute archetype /dev/ proof).
//
//   GET /:slug                → themed Calculator page for a REAL business (real
//                               context + no-fallbacks, stored skin). The FORMULA
//                               spec is LLM-generated ONCE at build, cached in KV.
//                               Compute is CLIENT-SIDE: tx-bind live headline +
//                               an inline snapshot on submit. NO result endpoint.
//   GET /:slug?debug=spec     → the generated/cached formula spec as JSON.
//   GET /:slug?debug=sanitize → PROVE the expression security gate THROWS on a
//                               set of malicious test expressions.
//   GET /:slug?regen=1        → force-regenerate the spec.
//
// Assets load absolute from the textos-web origin (the Worker has no /homer/*).
// ─────────────────────────────────────────────────────────────────────────────

const HOMER_ASSET_BASE = "https://textos-web-test.pages.dev";

const app = new Hono<{ Bindings: Env }>();

function specKey(businessId: string): string {
  return `fv2:calc-spec:${businessId}`;
}

async function getOrGenSpec(
  c: { env: Env },
  businessId: string,
  identity: { name: string; summary: string },
  forceRegen: boolean,
): Promise<CalculatorBuildSpec> {
  const kv = c.env.SNAPSHOT_KV;
  const key = specKey(businessId);
  if (kv && !forceRegen) {
    const cached = await kv.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as CalculatorBuildSpec; // validated before it was stored
      } catch {
        /* fall through to regenerate */
      }
    }
  }
  const { spec } = await generateCalculatorSpec(c.env.ANTHROPIC_API_KEY, identity);
  if (kv) await kv.put(key, JSON.stringify(spec), { expirationTtl: 86_400 });
  return spec;
}

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  // Security-gate proof — does NOT need the business/spec. A battery of malicious
  // expressions must ALL throw DisallowedExpressionTokenError.
  if (c.req.query("debug") === "sanitize") {
    const allowed = new Set(["revenue", "cost", "rate"]);
    const attacks = [
      "revenue - cost",                               // legit control (should PASS)
      "fetch('https://evil')",                        // network exfil
      "window.location",                              // global access
      "constructor.constructor('return process')()",  // sandbox escape attempt
      "revenue.toString()",                            // property access
      "globalThis",                                    // global identifier
      "`${revenue}`",                                  // template literal
      "revenue = 0",                                   // assignment
      "Math.sqrt(revenue)",                            // non-whitelisted Math fn
      "[].map",                                        // brackets
      "revenue ? 1 : 0",                               // ternary
    ];
    const results = attacks.map((expr) => {
      try {
        sanitizeExpression(expr, allowed);
        return { expr, threw: false, ok: expr === "revenue - cost" };
      } catch (err) {
        return {
          expr,
          threw: true,
          error_name: (err as Error).name,
          is_security_error: err instanceof DisallowedExpressionTokenError,
        };
      }
    });
    const malicious = results.filter((r) => r.expr !== "revenue - cost");
    return c.json({
      gate: "sanitizeExpression",
      legit_control_passed: results[0].threw === false,
      all_malicious_blocked: malicious.every((r) => r.threw === true),
      results,
    });
  }

  const client = createSupabaseClient(c.env);
  try {
    const { business, ctx } = await loadRealBusiness(client, slug);
    const identity = buildRealIdentity(slug, business, ctx); // no-fallbacks: throws if incomplete

    const forceRegen = c.req.query("regen") === "1";
    const spec = await getOrGenSpec(c, business.id, identity, forceRegen);

    if (c.req.query("debug") === "spec") {
      return c.json({
        slug,
        business: business.name,
        hero: spec.hero,
        font_pairing: spec.font_pairing,
        inputs: spec.inputs.map((i) => ({ id: i.id, label: i.label, type: i.type, default_value: i.default_value, min: i.min, max: i.max, unit_prefix: i.unit_prefix, unit_suffix: i.unit_suffix })),
        computations: spec.computations.map((cm) => ({ id: cm.id, label: cm.label, expression: cm.expression, format: cm.format })),
        headline: spec.headline,
        chart: spec.chart,
        bands: spec.result.bands?.map((b) => ({ min: b.min, max: b.max ?? "+inf", label: b.label })) ?? "(none — pure number)",
        recommendations: spec.result.recommendations.length,
        style: spec.style,
      });
    }

    const { skin } = await getOrCreateSkin(client, business.id);
    const override = c.req.query("skin");
    const usedSkin = isFactoryV2Skin(override) ? override : skin;
    const pairing = isFontPairing(spec.font_pairing) ? spec.font_pairing : DEFAULT_FONT_PAIRING;

    const { innerHtml, inlineScript, scripts } = buildCalculatorPage(spec);
    const doc = wrapProofDocument(innerHtml, {
      skin: usedSkin,
      assetBase: HOMER_ASSET_BASE,
      extraScripts: scripts, // assembler-DERIVED (tx-bind add-on; charts ride the base bundle)
      inlineScript,
      fontPairing: pairing,
    });
    return c.html(doc, 200, { "x-fv2-skin": usedSkin, "x-fv2-font-pairing": pairing });
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json({ error: "business_not_found", slug, message: err.message }, 404);
    if (err instanceof MissingContextError) {
      return c.json({ error: "missing_required_context", slug, missing: err.missing, message: err.message }, 422);
    }
    return c.json({ error: "calculator_failed", slug, message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ── POST /:slug/publish — build the self-contained Calculator app + upsert the
// business_assets row the existing /api/generated-apps by-slug endpoint serves.
// Test-only. CLIENT-SIDE like Assessment: tx-bind live headline + inline submit
// snapshot run entirely in the sandboxed iframe — NO result endpoint, NO postUrl.
app.post("/:slug/publish", async (c) => {
  if (c.env.ENVIRONMENT !== "test") {
    return c.json({ error: "forbidden", message: "publish is test-only in this build" }, 403);
  }
  const slug = c.req.param("slug");
  let body: { app_slug?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const appSlug = body.app_slug && /^[a-z0-9-]+$/.test(body.app_slug) ? body.app_slug : "charcuterie-board-planner";

  const client = createSupabaseClient(c.env);
  try {
    const { business, ctx } = await loadRealBusiness(client, slug);
    const identity = buildRealIdentity(slug, business, ctx); // no-fallbacks

    const { skin } = await getOrCreateSkin(client, business.id);
    const spec = await getOrGenSpec(c, business.id, identity, false); // cached, verified /dev/ input
    const pairing = isFontPairing(spec.font_pairing) ? spec.font_pairing : DEFAULT_FONT_PAIRING;

    // Self-contained HTML — identical to /dev/: full app.js base + the derived
    // tx-bind add-on. Compute runs client-side in the iframe; no result endpoint.
    const { innerHtml, inlineScript, scripts } = buildCalculatorPage(spec);
    const html = wrapProofDocument(innerHtml, {
      skin,
      assetBase: HOMER_ASSET_BASE,
      extraScripts: scripts,
      inlineScript,
      fontPairing: pairing,
    });

    const asset_data = { html, app_title: spec.hero.title, app_tagline: spec.hero.subtitle, app_type: "calculator" };

    // Supersede the slug: update-in-place if a row exists (unique (business_id,
    // app_slug) index), else insert.
    const existing = await client
      .from("business_assets")
      .select("id")
      .eq("business_id", business.id)
      .eq("asset_type", "app")
      .eq("app_slug", appSlug)
      .maybeSingle();
    if (existing.error) throw existing.error;

    let assetId: string;
    let mode: "updated" | "inserted";
    if (existing.data?.id) {
      const upd = await client
        .from("business_assets")
        .update({ asset_data, is_current: true, updated_at: new Date().toISOString() })
        .eq("id", existing.data.id)
        .select("id")
        .single();
      if (upd.error) throw upd.error;
      assetId = upd.data.id as string;
      mode = "updated";
    } else {
      const ins = await client
        .from("business_assets")
        .insert({ business_id: business.id, asset_type: "app", app_slug: appSlug, is_current: true, asset_data })
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      assetId = ins.data.id as string;
      mode = "inserted";
    }

    return c.json({
      published: true,
      mode,
      asset_id: assetId,
      business_slug: business.slug,
      app_slug: appSlug,
      app_type: "calculator",
      skin,
      font_pairing: pairing,
      derived_scripts: scripts,
      site_url: `${HOMER_ASSET_BASE}/sites/${business.slug}/apps/${appSlug}/`,
    });
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json({ error: "business_not_found", slug, message: err.message }, 404);
    if (err instanceof MissingContextError) {
      return c.json({ error: "missing_required_context", slug, missing: err.missing, message: err.message }, 422);
    }
    return c.json({ error: "publish_failed", slug, message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;

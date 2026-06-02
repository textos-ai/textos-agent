import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { generateStrategyContentFromAnswers } from "../lib/factory-v2/strategy-live-generator";
import { buildStrategyResultHtml } from "../lib/factory-v2/strategy-result-recipe";
import { wrapProofDocument } from "../lib/factory-v2/document-shell";
import { buildStrategyCollectPage } from "../lib/factory-v2/strategy-collect-recipe";
import { getOrCreateSkin } from "../lib/factory-v2/strategy-skin-store";
import { getOrGenStrategyStyle } from "../lib/factory-v2/strategy-style";
import {
  loadRealBusinessById,
  buildRealIdentity,
  MissingContextError,
  BusinessNotFoundError,
} from "../lib/factory-v2/strategy-context";

// ─────────────────────────────────────────────────────────────────────────────
// /api/factory-v2/* — STABLE (non-/dev/) runtime for the clean factory-v2
// Strategy app once it is PUBLISHED to a real /sites/{slug}/apps/{appSlug}/ URL.
//
//   POST /:businessId/by-slug/:appSlug/result   public  — the published app's
//        wizard (running inside the apps-shell iframe) POSTs the visitor's
//        answers here; runs the PROVEN generate chain on the business's REAL
//        context (no-fallbacks) and returns the composed RESULT inner HTML.
//   POST /:businessId/publish                    test-only — builds the
//        self-contained wizard HTML (skin baked, absolute result URL, absolute
//        Homer assets) and UPSERTS the business_assets app row that the
//        existing /api/generated-apps by-slug endpoint serves. No new
//        generation logic; reuses the proven chain.
//
// The delivery path (_redirects → apps-shell → /api/sites → /api/generated-apps
// by-slug → iframe srcdoc) is UNCHANGED — this only produces + stores the row
// that path already reads. Pipeline B is untouched.
// ─────────────────────────────────────────────────────────────────────────────

const HOMER_ASSET_BASE = "https://textos-web-test.pages.dev";
const DEFAULT_APP_SLUG = "charcuterie-strategy";
const APP_TITLE = "Charcuterie Event Planner";
const APP_TAGLINE = "Build your custom grazing-table game plan.";

const app = new Hono<{ Bindings: Env }>();

// Per-IP / per-app KV rate limit (mirrors generated-apps.ts result guard).
async function rateLimitOk(env: Env, scopeKey: string, max: number, windowSec: number): Promise<boolean> {
  const kv = env.SNAPSHOT_KV;
  if (!kv) return true;
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:fv2result:${scopeKey}:${bucket}`;
  const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (cur >= max) return false;
  await kv.put(key, String(cur + 1), { expirationTtl: windowSec * 2 });
  return true;
}

// ── POST /:businessId/by-slug/:appSlug/result — the published app's backend ──
app.post("/:businessId/by-slug/:appSlug/result", async (c) => {
  const businessId = c.req.param("businessId");
  const appSlug = c.req.param("appSlug");
  const ip = c.req.header("cf-connecting-ip") || "unknown";

  const perIpOk = await rateLimitOk(c.env, `${businessId}:${appSlug}:${ip}`, 8, 60);
  const perAppOk = await rateLimitOk(c.env, `${businessId}:${appSlug}:_all`, 60, 60);
  if (!perIpOk || !perAppOk) {
    return c.json(errBody("rate_limited", "Too many requests — please wait a moment."), 429);
  }

  let body: { answers?: { question: string; answer: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "invalid JSON"), 400);
  }
  const answers = body?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    return c.json(errBody("bad_request", "answers array required"), 400);
  }

  const client = createSupabaseClient(c.env);
  try {
    const { business, ctx } = await loadRealBusinessById(client, businessId);
    const identity = buildRealIdentity(business.slug, business, ctx); // no-fallbacks
    const { content } = await generateStrategyContentFromAnswers(c.env.ANTHROPIC_API_KEY, identity, answers);
    // Same build-time style the collect page was published with (KV-cached) —
    // so the per-visitor result is framed + token-styled to match.
    const style = await getOrGenStrategyStyle(c.env, businessId, identity);
    const inner = buildStrategyResultHtml(content, style.style); // throws on unknown id
    return c.html(inner, 200);
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json(errBody("not_found", err.message), 404);
    if (err instanceof MissingContextError) {
      return c.json(errBody("bad_request", err.message, { missing: err.missing }), 422);
    }
    log.error("factory_v2.result.failed", { businessId, appSlug, err: err instanceof Error ? err.message : String(err) });
    return c.json(errBody("internal", "result generation failed — please retry"), 502);
  }
});

// ── POST /:businessId/publish — build + upsert the published app row ─────────
app.post("/:businessId/publish", async (c) => {
  // Test-only gate: this writes a business_assets row. On test, gaudet's apps
  // are disposable; a prod path would need proper owner auth.
  if (c.env.ENVIRONMENT !== "test") {
    return c.json(errBody("forbidden", "publish is test-only in this build"), 403);
  }

  const businessId = c.req.param("businessId");
  let body: { app_slug?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const appSlug = (body.app_slug && /^[a-z0-9-]+$/.test(body.app_slug)) ? body.app_slug : DEFAULT_APP_SLUG;

  const client = createSupabaseClient(c.env);
  try {
    // Real context (no-fallbacks: throws if gaudet is missing required fields).
    const { business, ctx } = await loadRealBusinessById(client, businessId);
    const identity = buildRealIdentity(business.slug, business, ctx);

    // Stored skin (picked once, read back every time).
    const { skin } = await getOrCreateSkin(client, businessId);

    // Build-time style (font pairing + per-component tokens), LLM-picked once,
    // KV-cached, shared with the result endpoint so collect + result match.
    const style = await getOrGenStrategyStyle(c.env, businessId, identity);

    // Self-contained wizard HTML: absolute result URL (the iframe is
    // about:srcdoc, so a relative POST would fail), skin baked, absolute assets.
    const origin = new URL(c.req.url).origin; // this Worker's own origin
    const postUrl = `${origin}/api/factory-v2/${businessId}/by-slug/${appSlug}/result`;
    const { innerHtml, inlineScript } = buildStrategyCollectPage({ postUrl, style: style.style });
    const html = wrapProofDocument(innerHtml, {
      skin,
      assetBase: HOMER_ASSET_BASE,
      extraScripts: ["/homer/js/pages/form-wizard.js"],
      inlineScript,
      fontPairing: style.font_pairing,
    });

    const asset_data = { html, app_title: APP_TITLE, app_tagline: APP_TAGLINE, app_type: "strategy" };

    // Supersede: the unique partial index (business_id, app_slug) WHERE
    // asset_type='app' allows ONE row per slug — so update in place if it
    // exists (overwriting whatever Pipeline B app was there — disposable),
    // else insert. Avoids the unique-index conflict and any cascade delete.
    const existing = await client
      .from("business_assets")
      .select("id")
      .eq("business_id", businessId)
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
        .insert({
          business_id: businessId,
          asset_type: "app",
          app_slug: appSlug,
          is_current: true,
          asset_data,
        })
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      assetId = ins.data.id as string;
      mode = "inserted";
    }

    log.info("factory_v2.publish.ok", { businessId, appSlug, skin, mode, asset_id: assetId });
    return c.json({
      published: true,
      mode,
      asset_id: assetId,
      business_slug: business.slug,
      app_slug: appSlug,
      skin,
      font_pairing: style.font_pairing,
      style: style.style,
      site_url: `https://${HOMER_ASSET_BASE.replace("https://", "")}/sites/${business.slug}/apps/${appSlug}/`,
      result_endpoint: postUrl,
    });
  } catch (err) {
    if (err instanceof BusinessNotFoundError) return c.json(errBody("not_found", err.message), 404);
    if (err instanceof MissingContextError) {
      return c.json(errBody("bad_request", err.message, { missing: err.missing }), 422);
    }
    log.error("factory_v2.publish.failed", { businessId, appSlug, err: err instanceof Error ? err.message : String(err) });
    return c.json(errBody("internal", err instanceof Error ? err.message : String(err)), 500);
  }
});

export default app;

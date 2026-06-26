/**
 * Publish a content asset immediately to a connected social account via Zernio.
 *
 * POST /api/businesses/:slug/marketing/content-assets/:id/publish
 *   Reads the stored accountId from business_integrations (never hardcoded),
 *   calls publishPost() in the Zernio service module, and records the result
 *   on the content_assets row. No LLM calls — content is already generated.
 *
 * Guards:
 *   - Already published → 409 (Zernio posts can't be deleted via API)
 *   - Dismissed content → 409
 *   - No Zernio integration / no Bluesky account → 503
 *   - Zernio 429 → 429 rate-limit message
 *   - Zernio 403 → 403 plan-limit message
 *   - Zernio 401 → 503 reconnect message (Bluesky tokens expire ~2h)
 *   - Other Zernio error → 502 structured error, never 500
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { publishPost, getPost } from "../services/zernio";
import {
  friendlyPublishError,
  friendlyValidationError,
} from "../lib/friendly-errors";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

interface ZernioAccount {
  accountId: string;
  platform: string;
  handle?: string;
}

interface ZernioConfig {
  profileId?: string;
  accounts?: ZernioAccount[];
}

// ── POST /:slug/marketing/content-assets/:id/publish ─────────────────────────

app.post("/:slug/marketing/content-assets/:id/publish", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  // ── Load and verify the content asset ────────────────────────────────────

  const { data: asset, error: assetErr } = await supabase
    .from("content_assets")
    .select("id, generated_body, status, zernio_post_id, target_platform")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (assetErr) {
    log.error("[social-publish] asset_load_failed", { id, err: assetErr.message });
    return c.json({ error: "Failed to load content asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  // Guard: already published — Zernio posts can't be deleted via API, no double-post
  if ((asset as any).status === "published") {
    return c.json(
      { error: "Already published", zernio_post_id: (asset as any).zernio_post_id },
      409,
    );
  }

  // Guard: don't publish dismissed content
  if ((asset as any).status === "dismissed") {
    return c.json({ error: "Cannot publish dismissed content" }, 409);
  }

  // ── Load Zernio integration — get the stored Bluesky accountId ───────────

  const { data: integration, error: integErr } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .eq("is_active", true)
    .maybeSingle();

  if (integErr) {
    log.error("[social-publish] integration_load_failed", {
      business_id: business.id,
      err: integErr.message,
    });
    return c.json({ error: "Failed to load social integration" }, 500);
  }

  if (!integration) {
    return c.json(
      { error: "No Zernio integration configured — connect a social account first" },
      503,
    );
  }

  const cfg = ((integration as any).config ?? {}) as ZernioConfig;

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Social publishing not configured" }, 503);
  }

  // ── Pre-flight: validate content length for the target platform ───────────
  // Char limit is read from the platforms table — no hardcoded maps.

  const content        = String((asset as any).generated_body ?? "");
  const targetPlatform = String((asset as any).target_platform ?? "bluesky").toLowerCase();

  const platformAccount = (cfg.accounts ?? []).find((a) => a.platform === targetPlatform);
  if (!platformAccount) {
    const displayName = targetPlatform.charAt(0).toUpperCase() + targetPlatform.slice(1);
    return c.json(
      { error: `${displayName} isn't connected yet — go to Platforms in the sidebar to connect it.` },
      503,
    );
  }

  const { data: platformRow } = await supabase
    .from("platforms")
    .select("char_limit")
    .eq("slug", targetPlatform)
    .maybeSingle();
  const charLimit = typeof (platformRow as any)?.char_limit === "number"
    ? (platformRow as any).char_limit
    : 300;

  if (content.length > charLimit) {
    return c.json(
      { error: friendlyValidationError(targetPlatform, charLimit, content.length) },
      422,
    );
  }

  // ── Submit to Zernio — note: Zernio publishes async ──────────────────────

  const result = await publishPost(apiKey, {
    content,
    platform: targetPlatform,
    accountId: platformAccount.accountId,
  });

  if (!result.ok) {
    log.error("[social-publish] publish_failed", {
      business_id: business.id,
      asset_id: id,
      err: result.error,
      zernio_status: result.status,
    });

    // Map HTTP status to friendly message. Reconnect flag lets UI show a reconnect CTA.
    const friendly = friendlyPublishError({
      httpStatus: result.status,
      errorMessage: result.error,
      platform: targetPlatform,
    });
    const reconnect = result.status === 401;
    const httpStatus = result.status === 429 ? 429 : result.status === 403 ? 403 : 502;
    return c.json({ error: friendly, ...(reconnect ? { reconnect: true } : {}) }, httpStatus);
  }

  // ── Poll for confirmed final status (Zernio is async) ────────────────────
  // POST /posts returns a postId immediately with status "pending"/"processing".
  // We must GET /posts/:id and wait for "published" or "failed" before marking
  // the asset published. Never trust the immediate response as the final state.

  const TERMINAL = new Set(["published", "failed", "error"]);
  const POLL_MAX = 6;
  const POLL_DELAY_MS = 1500;

  let finalStatus    = result.status;
  let finalErrorMsg  = result.errorMessage;
  let finalErrorCat  = result.errorCategory;

  if (!TERMINAL.has(finalStatus)) {
    for (let attempt = 0; attempt < POLL_MAX; attempt++) {
      await new Promise<void>((r) => setTimeout(r, POLL_DELAY_MS));

      const poll = await getPost(apiKey, result.postId);
      if (!poll.ok) {
        log.warn("[social-publish] poll_failed", { attempt: attempt + 1, err: poll.error });
        continue;
      }

      log.info("[social-publish] poll_status", {
        attempt: attempt + 1,
        status: poll.status,
        postId: result.postId,
      });

      finalStatus   = poll.status;
      finalErrorMsg = poll.errorMessage;
      finalErrorCat = poll.errorCategory;

      if (TERMINAL.has(finalStatus)) break;
    }
  }

  if (finalStatus !== "published") {
    const isFailure = finalStatus === "failed" || finalStatus === "error";
    const friendly  = isFailure
      ? friendlyPublishError({
          errorMessage:   finalErrorMsg,
          errorCategory:  finalErrorCat,
          platform:       targetPlatform,
          charLimit:      charLimit,
          contentLength:  content.length,
        })
      : "Victora is waiting on a response from the publishing service — try again in a moment.";

    log.error("[social-publish] publish_not_confirmed", {
      business_id:    business.id,
      asset_id:       id,
      zernio_post_id: result.postId,
      final_status:   finalStatus,
      error_message:  finalErrorMsg,
      error_category: finalErrorCat,
    });

    return c.json({ error: friendly }, 502);
  }

  // ── Confirmed published — record in DB ────────────────────────────────────

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update({
      status: "published",
      zernio_post_id: result.postId,
      published_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateErr) {
    // Post is live on the platform — don't mask it, but warn about DB lag
    log.error("[social-publish] db_update_failed", {
      business_id: business.id,
      asset_id: id,
      zernio_post_id: result.postId,
      err: updateErr.message,
    });
    return c.json({
      ok: true,
      zernio_post_id: result.postId,
      status: "published",
      warning: "Published but status record may be delayed",
    });
  }

  log.info("[social-publish] published_ok", {
    business_id: business.id,
    asset_id: id,
    zernio_post_id: result.postId,
    platform: targetPlatform,
    handle: platformAccount.handle,
  });

  return c.json({ ok: true, zernio_post_id: result.postId, status: "published" });
});

export default app;

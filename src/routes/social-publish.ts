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
import { publishPost, getPost, cancelScheduledPost, reschedulePost } from "../services/zernio";
import { computeNextOptimalSlot } from "../lib/scheduling/next-optimal";
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
    .select("char_limit, publish_supported, display_name")
    .eq("slug", targetPlatform)
    .maybeSingle();
  const charLimit = typeof (platformRow as any)?.char_limit === "number"
    ? (platformRow as any).char_limit
    : 300;

  // Publish support gate — checked before any Zernio call.
  // publish_supported is admin-editable in the platforms table; FALSE = coming soon.
  if (platformRow && (platformRow as any).publish_supported === false) {
    const displayName = String((platformRow as any).display_name
      ?? (targetPlatform.charAt(0).toUpperCase() + targetPlatform.slice(1)));
    log.warn("[social-publish] publish_blocked_unsupported", {
      business_id: business.id,
      asset_id:    id,
      platform:    targetPlatform,
    });
    return c.json(
      { error: `${displayName} publishing isn't available yet — it's coming soon.` },
      422,
    );
  }

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

// ── POST /:slug/marketing/content-assets/:id/schedule ────────────────────────
// Schedule at the next optimal time. Computes the slot, hands Zernio a future
// scheduledFor (firing is delegated to Zernio), and records the schedule on the
// asset. Additive — immediate publish is untouched.
app.post("/:slug/marketing/content-assets/:id/schedule", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: assetErr } = await supabase
    .from("content_assets")
    .select("id, generated_body, status, target_platform, content_type")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (assetErr) return c.json({ error: "Failed to load content asset" }, 500);
  if (!asset) return c.json({ error: "Content asset not found" }, 404);
  if ((asset as any).status === "published") return c.json({ error: "Already published" }, 409);
  if ((asset as any).status === "dismissed") return c.json({ error: "Cannot schedule dismissed content" }, 409);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) return c.json({ error: "Social publishing not configured" }, 503);

  const targetPlatform = String((asset as any).target_platform ?? "bluesky").toLowerCase();
  const content        = String((asset as any).generated_body ?? "");

  // Connected account for this platform.
  const { data: integration, error: integErr } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .eq("is_active", true)
    .maybeSingle();
  if (integErr) return c.json({ error: "Failed to load social integration" }, 500);
  if (!integration) {
    return c.json({ error: "No Zernio integration configured — connect a social account first" }, 503);
  }
  const cfg = ((integration as any).config ?? {}) as ZernioConfig;
  const platformAccount = (cfg.accounts ?? []).find((a) => a.platform === targetPlatform);
  if (!platformAccount) {
    const dn = targetPlatform.charAt(0).toUpperCase() + targetPlatform.slice(1);
    return c.json({ error: `${dn} isn't connected yet — go to Platforms to connect it.` }, 503);
  }

  // publish_supported gate + char limit (same rules as immediate publish).
  const { data: platformRow } = await supabase
    .from("platforms")
    .select("char_limit, publish_supported, display_name")
    .eq("slug", targetPlatform)
    .maybeSingle();
  if (platformRow && (platformRow as any).publish_supported === false) {
    const dn = String((platformRow as any).display_name ?? targetPlatform);
    return c.json({ error: `${dn} publishing isn't available yet — it's coming soon.` }, 422);
  }
  const charLimit = typeof (platformRow as any)?.char_limit === "number" ? (platformRow as any).char_limit : 300;
  if (content.length > charLimit) {
    return c.json({ error: friendlyValidationError(targetPlatform, charLimit, content.length) }, 422);
  }

  // Next optimal slot (consistency-first + jitter), Central tz.
  const slot = await computeNextOptimalSlot(
    supabase, targetPlatform, String((asset as any).content_type ?? "social_post"), Date.now(),
  );
  if (!slot) {
    return c.json({ error: `No posting schedule configured for ${targetPlatform} yet.` }, 422);
  }

  // Hand Zernio the future time — it fires it.
  const result = await publishPost(apiKey, {
    content,
    platform: targetPlatform,
    accountId: platformAccount.accountId,
    scheduledFor: slot.scheduledForLocal,
    timezone: slot.timezone,
  });
  if (!result.ok) {
    log.error("[social-publish] schedule_failed", { business_id: business.id, asset_id: id, err: result.error });
    const friendly = friendlyPublishError({
      httpStatus: result.status, errorMessage: result.error, platform: targetPlatform,
    });
    const httpStatus = result.status === 429 ? 429 : result.status === 403 ? 403 : 502;
    return c.json({ error: friendly }, httpStatus);
  }

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update({
      status: "scheduled",
      scheduled_for: slot.scheduledForUTC,
      scheduled_timezone: slot.timezone,
      zernio_scheduled_id: result.postId,
    })
    .eq("id", id);
  if (updateErr) {
    log.error("[social-publish] schedule_db_update_failed", { asset_id: id, err: updateErr.message });
    return c.json({ error: "Scheduled with Zernio but failed to record it — please refresh." }, 500);
  }

  log.info("[social-publish] scheduled_ok", {
    business_id: business.id, asset_id: id, platform: targetPlatform,
    scheduled_for: slot.scheduledForUTC, zernio_scheduled_id: result.postId,
  });
  return c.json({
    ok: true,
    status: "scheduled",
    scheduled_for: slot.scheduledForUTC,
    scheduled_timezone: slot.timezone,
    label: slot.label,
    zernio_scheduled_id: result.postId,
  });
});

// ── POST /:slug/marketing/content-assets/:id/unschedule ──────────────────────
// Cancel a scheduled post on Zernio (DELETE /posts/{id}) and revert to draft.
app.post("/:slug/marketing/content-assets/:id/unschedule", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: assetErr } = await supabase
    .from("content_assets")
    .select("id, status, zernio_scheduled_id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (assetErr) return c.json({ error: "Failed to load content asset" }, 500);
  if (!asset) return c.json({ error: "Content asset not found" }, 404);
  if ((asset as any).status !== "scheduled") {
    return c.json({ error: "This post isn't scheduled." }, 409);
  }

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) return c.json({ error: "Social publishing not configured" }, 503);

  const zid = (asset as any).zernio_scheduled_id as string | null;
  if (zid) {
    const cancel = await cancelScheduledPost(apiKey, zid);
    if (!cancel.ok) {
      log.error("[social-publish] unschedule_zernio_failed", { asset_id: id, zid, err: cancel.error });
      return c.json({ error: "Couldn't cancel the scheduled post — please try again." }, 502);
    }
  }

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update({ status: "draft", scheduled_for: null, scheduled_timezone: null, zernio_scheduled_id: null })
    .eq("id", id);
  if (updateErr) {
    return c.json({ error: "Cancelled on Zernio but failed to update — please refresh." }, 500);
  }

  log.info("[social-publish] unscheduled_ok", { business_id: business.id, asset_id: id });
  return c.json({ ok: true, status: "draft" });
});

// ── POST /:slug/marketing/content-assets/:id/reschedule ──────────────────────
// Move a scheduled post to a user-chosen time. Zernio PUT /posts/{id} (live-
// tested) updates the fire time; we store the new UTC instant Zernio returns.
app.post("/:slug/marketing/content-assets/:id/reschedule", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { scheduled_for_local?: string; timezone?: string };
  const localWhen = typeof body.scheduled_for_local === "string" ? body.scheduled_for_local.trim() : "";
  const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : "America/Chicago";
  if (!localWhen) return c.json({ error: "Pick a new time to reschedule to." }, 400);

  const { data: asset, error: assetErr } = await supabase
    .from("content_assets")
    .select("id, status, zernio_scheduled_id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (assetErr) return c.json({ error: "Failed to load content asset" }, 500);
  if (!asset) return c.json({ error: "Content asset not found" }, 404);
  if ((asset as any).status !== "scheduled") return c.json({ error: "This post isn't scheduled." }, 409);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) return c.json({ error: "Social publishing not configured" }, 503);

  const zid = (asset as any).zernio_scheduled_id as string | null;
  if (!zid) return c.json({ error: "Missing the scheduled post reference — unschedule and reschedule." }, 409);

  const res = await reschedulePost(apiKey, zid, localWhen, timezone);
  if (!res.ok) {
    log.error("[social-publish] reschedule_failed", { asset_id: id, zid, err: res.error });
    return c.json({ error: "Couldn't move the scheduled post — please try again." }, 502);
  }

  // Zernio returns the new fire time in UTC; store that.
  const newUtc = res.scheduledFor;
  const { error: updateErr } = await supabase
    .from("content_assets")
    .update({ scheduled_for: newUtc, scheduled_timezone: timezone })
    .eq("id", id);
  if (updateErr) return c.json({ error: "Rescheduled on Zernio but failed to record it — please refresh." }, 500);

  log.info("[social-publish] rescheduled_ok", { business_id: business.id, asset_id: id, scheduled_for: newUtc });
  return c.json({ ok: true, status: "scheduled", scheduled_for: newUtc, scheduled_timezone: timezone });
});

export default app;

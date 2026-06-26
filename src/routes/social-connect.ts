/**
 * Social account connect routes for Zernio integration.
 *
 * GET  /api/businesses/:slug/social/connect/status
 *   Returns the current Zernio integration state for this business.
 *
 * POST /api/businesses/:slug/social/connect/init
 *   Creates/reuses a Zernio profile for this business, then returns the
 *   Zernio-hosted connect URL for the requested platform. The caller
 *   redirects the user's browser to that URL.
 *
 * POST /api/businesses/:slug/social/connect/callback
 *   Called by the frontend after the user returns from Zernio's OAuth flow.
 *   STUB: endpoint shape finalized after Rob's live test of
 *   GET /api/v1/connect/bluesky?profileId=test.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import {
  createProfile,
  disconnectAccount,
  getConnectUrl,
  getProfileAccounts,
  resolvePendingConnection,
} from "../services/zernio";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── Integration config shape stored in business_integrations.config ───────────

interface ZernioAccount {
  accountId: string;
  platform: string;
  handle?: string;
  connectedAt: string;
}

interface ZernioConfig {
  profileId?: string;
  accounts?: ZernioAccount[];
}

// ── GET /:slug/social/connect/status ─────────────────────────────────────────

app.get("/:slug/social/connect/status", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data, error } = await supabase
    .from("business_integrations")
    .select("config, is_active, updated_at")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .maybeSingle();

  if (error) {
    log.error("[social-connect] status_query_failed", {
      business_id: business.id,
      err: error.message,
    });
    return c.json({ error: "Failed to load integration status" }, 500);
  }

  if (!data) {
    return c.json({ connected: false, accounts: [] });
  }

  const cfg = (data.config ?? {}) as ZernioConfig;
  return c.json({
    connected: (cfg.accounts?.length ?? 0) > 0,
    profileId: cfg.profileId ?? null,
    accounts: cfg.accounts ?? [],
    isActive: data.is_active,
    updatedAt: data.updated_at,
  });
});

// ── POST /:slug/social/connect/init ──────────────────────────────────────────

app.post("/:slug/social/connect/init", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let body: { platform?: string; return_path?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const platform = body.platform?.trim().toLowerCase();
  if (!platform) return c.json({ error: "platform is required" }, 400);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) {
    log.error("[social-connect] missing_api_key", { business_id: business.id });
    return c.json({ error: "Social publishing not configured" }, 503);
  }

  // ── 1. Get or create Zernio profile for this business ────────────────────

  const { data: existing } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .maybeSingle();

  let cfg: ZernioConfig = (existing?.config ?? {}) as ZernioConfig;
  let profileId = cfg.profileId;

  if (!profileId) {
    const profileResult = await createProfile(apiKey, business.name ?? slug);
    if (!profileResult.ok) {
      log.error("[social-connect] create_profile_failed", {
        business_id: business.id,
        err: profileResult.error,
      });
      return c.json({ error: `Failed to create Zernio profile: ${profileResult.error}` }, 502);
    }

    profileId = profileResult.profileId;
    cfg = { ...cfg, profileId };

    // Upsert the integration row with the new profileId
    const { error: upsertErr } = await supabase
      .from("business_integrations")
      .upsert(
        {
          business_id: business.id,
          provider: "zernio",
          config: cfg,
          is_active: true,
        },
        { onConflict: "business_id,provider" },
      );

    if (upsertErr) {
      log.error("[social-connect] profile_upsert_failed", {
        business_id: business.id,
        err: upsertErr.message,
      });
      return c.json({ error: "Failed to save Zernio profile" }, 500);
    }
  }

  // ── 2. Get Zernio-hosted connect URL ─────────────────────────────────────

  // redirect_url: the page Zernio sends the user back to after connect.
  // We use the review page with ?zernio_done=1 so the JS can detect return.
  // Pending-connection callback params are handled in the /callback endpoint
  // once the Bluesky connect shape is confirmed.
  const frontendUrl = c.env.FRONTEND_URL ?? "https://app.victora.ai";
  const returnPath  = typeof body.return_path === "string" && body.return_path.startsWith("/")
    ? body.return_path
    : `/business/${slug}/marketing/review`;
  const redirectUrl = `${frontendUrl}${returnPath}${returnPath.includes("?") ? "&" : "?"}zernio_done=1`;

  const { data: platformRow } = await supabase
    .from("platforms")
    .select("connect_mode")
    .eq("slug", platform)
    .maybeSingle();
  const headless = (platformRow?.connect_mode ?? "interactive") === "headless";

  const connectResult = await getConnectUrl(apiKey, platform, profileId, redirectUrl, headless);
  if (!connectResult.ok) {
    log.error("[social-connect] get_connect_url_failed", {
      business_id: business.id,
      platform,
      err: connectResult.error,
    });
    return c.json(
      { error: `Failed to get connect URL: ${connectResult.error}` },
      502,
    );
  }

  log.info?.("[social-connect] connect_init_ok", {
    business_id: business.id,
    platform,
    profileId,
  });

  return c.json({ ok: true, connectUrl: connectResult.connectUrl, profileId });
});

// ── POST /:slug/social/connect/sync ──────────────────────────────────────────
// Pulls the current accounts list from Zernio for this business's stored
// profileId and writes them to business_integrations.config.accounts.
// Called automatically after the user returns from Zernio's connect flow
// (replacing the stub "connection pending" message) and on manual refresh.

app.post("/:slug/social/connect/sync", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) return c.json({ error: "Social publishing not configured" }, 503);

  const { data: existing, error: fetchErr } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .maybeSingle();

  if (fetchErr) {
    log.error("[social-connect] sync_fetch_failed", { business_id: business.id, err: fetchErr.message });
    return c.json({ error: "Failed to load integration" }, 500);
  }
  if (!existing) {
    return c.json({ error: "No Zernio profile on record — run Connect first" }, 409);
  }

  const cfg = (existing.config ?? {}) as ZernioConfig;
  if (!cfg.profileId) {
    return c.json({ error: "No profileId on record — run Connect first" }, 409);
  }

  const result = await getProfileAccounts(apiKey, cfg.profileId);
  if (!result.ok) {
    log.error("[social-connect] sync_accounts_failed", {
      business_id: business.id,
      profileId: cfg.profileId,
      err: result.error,
    });
    return c.json({ error: `Failed to fetch accounts from Zernio: ${result.error}` }, 502);
  }

  const newAccounts: ZernioAccount[] = result.accounts.map((a) => ({
    accountId:   a.accountId,
    platform:    a.platform,
    handle:      a.handle,
    connectedAt: new Date().toISOString(),
  }));

  const { error: updateErr } = await supabase
    .from("business_integrations")
    .update({ config: { ...cfg, accounts: newAccounts } })
    .eq("business_id", business.id)
    .eq("provider", "zernio");

  if (updateErr) {
    log.error("[social-connect] sync_update_failed", {
      business_id: business.id,
      err: updateErr.message,
    });
    return c.json({ error: "Failed to update accounts" }, 500);
  }

  log.info("[social-connect] sync_ok", {
    business_id: business.id,
    profileId: cfg.profileId,
    accounts_count: newAccounts.length,
    platforms: newAccounts.map((a) => a.platform),
  });

  return c.json({ ok: true, accounts: newAccounts });
});

// ── DELETE /:slug/social/connect/accounts/:platform ──────────────────────────
// Strict ordering: disconnect on Zernio FIRST, then remove locally.
// If Zernio fails → halt, return friendly error, leave local config intact.
// Never clear locally while the account is still live upstream.

app.delete("/:slug/social/connect/accounts/:platform", async (c) => {
  const auth     = c.get("auth") as { user_id: string };
  const slug     = c.req.param("slug");
  const platform = c.req.param("platform").toLowerCase();
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) {
    log.error("[social-connect] disconnect_missing_api_key", { business_id: business.id });
    return c.json({ error: "Social publishing not configured" }, 503);
  }

  const { data: existing, error: fetchErr } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .maybeSingle();

  if (fetchErr) {
    log.error("[social-connect] disconnect_fetch_failed", { business_id: business.id, err: fetchErr.message });
    return c.json({ error: "Failed to load integration" }, 500);
  }
  if (!existing) return c.json({ error: "No integration on record" }, 404);

  const cfg     = (existing.config ?? {}) as ZernioConfig;
  const account = (cfg.accounts ?? []).find((a) => a.platform === platform);
  if (!account) return c.json({ error: "Platform not connected" }, 404);

  const displayName = platform.charAt(0).toUpperCase() + platform.slice(1);

  // ── Step 1: Disconnect on Zernio FIRST ───────────────────────────────────
  log.info("[social-connect] disconnect_zernio_attempt", {
    business_id: business.id,
    platform,
    accountId: account.accountId,
  });

  const zernioResult = await disconnectAccount(apiKey, account.accountId);

  if (!zernioResult.ok) {
    // 404 = account is already gone upstream — safe to clean up locally.
    // Any other error = Zernio is live but unreachable; halt to avoid phantom.
    if (zernioResult.status !== 404) {
      log.error("[social-connect] disconnect_zernio_failed", {
        business_id: business.id,
        platform,
        accountId: account.accountId,
        err: zernioResult.error,
      });
      return c.json(
        { error: `Couldn't disconnect ${displayName} right now — please try again in a moment.` },
        502,
      );
    }
    // 404 path — already gone on Zernio, fall through to local cleanup
    log.warn("[social-connect] disconnect_zernio_already_gone", {
      business_id: business.id,
      platform,
      accountId: account.accountId,
    });
  } else {
    log.info("[social-connect] disconnect_zernio_ok", {
      business_id: business.id,
      platform,
      accountId: account.accountId,
      message: zernioResult.message,
    });
  }

  // ── Step 2: Zernio confirmed (or was already gone) — remove locally ───────
  const accounts = (cfg.accounts ?? []).filter((a) => a.platform !== platform);

  const { error: updateErr } = await supabase
    .from("business_integrations")
    .update({ config: { ...cfg, accounts } })
    .eq("business_id", business.id)
    .eq("provider", "zernio");

  if (updateErr) {
    // Zernio is already disconnected here — log the desync prominently.
    log.error("[social-connect] disconnect_local_write_failed", {
      business_id: business.id,
      platform,
      accountId: account.accountId,
      detail: "Zernio disconnected but local config update failed — state desync",
      err: updateErr.message,
    });
    return c.json({ error: "Failed to update local connection state" }, 500);
  }

  log.info("[social-connect] disconnected", { business_id: business.id, platform });
  return c.json({ ok: true, platform });
});

// ── POST /:slug/social/connect/callback ──────────────────────────────────────
// STUB — finalize once Rob confirms the Bluesky connect response shape.
// After Rob tests GET https://zernio.com/api/v1/connect/bluesky?profileId=test:
//   1. Update resolvePendingConnection() in src/services/zernio.ts
//      with the correct endpoint + param names.
//   2. Replace the stub body below with real accountId extraction + DB write.

app.post("/:slug/social/connect/callback", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let body: { connectToken?: string; platform?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { connectToken, platform } = body;
  if (!connectToken) return c.json({ error: "connectToken is required" }, 400);
  if (!platform) return c.json({ error: "platform is required" }, 400);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const apiKey = c.env.ZERNIO_API_KEY;
  if (!apiKey) return c.json({ error: "Social publishing not configured" }, 503);

  // STUB: resolve the accountId from the connect token via Zernio.
  const resolveResult = await resolvePendingConnection(apiKey, connectToken);
  if (!resolveResult.ok) {
    return c.json({ error: resolveResult.error }, 502);
  }

  // Store the new account in business_integrations.config.accounts
  const { data: existing } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .maybeSingle();

  if (!existing) {
    return c.json({ error: "No Zernio profile found — run /init first" }, 409);
  }

  const cfg = (existing.config ?? {}) as ZernioConfig;
  const accounts: ZernioAccount[] = cfg.accounts ?? [];

  // Replace any existing account for this platform
  const filtered = accounts.filter((a) => a.platform !== platform);
  const newAccount: ZernioAccount = {
    accountId: resolveResult.accountId,
    platform: resolveResult.platform,
    handle: resolveResult.handle,
    connectedAt: new Date().toISOString(),
  };
  const updatedAccounts = [...filtered, newAccount];

  const { error: updateErr } = await supabase
    .from("business_integrations")
    .update({ config: { ...cfg, accounts: updatedAccounts } })
    .eq("business_id", business.id)
    .eq("provider", "zernio");

  if (updateErr) {
    log.error("[social-connect] callback_update_failed", {
      business_id: business.id,
      err: updateErr.message,
    });
    return c.json({ error: "Failed to save connected account" }, 500);
  }

  return c.json({ ok: true, accountId: resolveResult.accountId, platform });
});

export default app;

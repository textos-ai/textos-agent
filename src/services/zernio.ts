/**
 * Zernio social publishing interface.
 * ALL Zernio API calls go through this module — if we replace Zernio,
 * this is the only file that changes. Routes and task handlers import
 * from here, never from fetch() directly.
 *
 * No LLM calls in this module. Content is already generated.
 */

const ZERNIO_BASE = "https://zernio.com/api/v1";

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function zernioFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  // Strip leading BOM (﻿) and surrounding whitespace — Cloudflare secret
  // storage can carry a BOM when the value was pasted from a BOM-encoded source.
  const cleanKey = apiKey.replace(/^﻿/, "").trim();
  return fetch(`${ZERNIO_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cleanKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

// ── Result types ──────────────────────────────────────────────────────────────

export type ZernioOk<T> = { ok: true } & T;
export type ZernioErr = { ok: false; error: string; status?: number };
export type ZernioResult<T> = ZernioOk<T> | ZernioErr;

function zernioErr(label: string, status: number, body: string): ZernioErr {
  return { ok: false, error: `Zernio ${label} ${status}: ${body}`, status };
}

// ── Profile management ────────────────────────────────────────────────────────

/**
 * Create a Zernio profile for a business. Returns the profileId.
 * A profile is the tenant namespace — connected social accounts are
 * attached to a profile, and the API key grants access to all profiles
 * in the workspace.
 */
export async function createProfile(
  apiKey: string,
  name: string,
): Promise<ZernioResult<{ profileId: string }>> {
  let res: Response;
  try {
    res = await zernioFetch(apiKey, "/profiles", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    return { ok: false, error: `Zernio createProfile network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("createProfile", res.status, body);
  }

  const data = (await res.json()) as Record<string, unknown>;
  // Zernio may nest under .profile or return flat
  const profile = (data.profile ?? data) as Record<string, unknown>;
  const profileId = String(profile._id ?? profile.id ?? "");
  if (!profileId) {
    return { ok: false, error: "Zernio createProfile: no id in response" };
  }
  return { ok: true, profileId };
}

// ── Account connection ────────────────────────────────────────────────────────

/**
 * Get a Zernio-hosted connect URL for a social platform.
 * The returned URL redirects the user through Zernio's OAuth / credential
 * flow (headless=true suppresses Zernio branding). After completion Zernio
 * redirects to redirectUrl with platform-specific callback params.
 *
 * NOTE (Bluesky): Bluesky uses App Password, not OAuth. The Zernio connect
 * endpoint may return a hosted credential-entry page rather than a standard
 * OAuth consent screen. The shape of the callback params is confirmed per
 * Rob's live test — see social-connect.ts for callback handling.
 */
export async function getConnectUrl(
  apiKey: string,
  platform: string,
  profileId: string,
  redirectUrl: string,
  headless = true,
): Promise<ZernioResult<{ connectUrl: string }>> {
  const params = new URLSearchParams({
    profileId,
    redirect_url: redirectUrl,
    headless: String(headless),
  });

  let res: Response;
  try {
    res = await zernioFetch(apiKey, `/connect/${platform}?${params.toString()}`);
  } catch (e) {
    return { ok: false, error: `Zernio getConnectUrl network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("getConnectUrl", res.status, body);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const connectUrl = String(data.authUrl ?? data.url ?? data.connectUrl ?? data.redirect_url ?? "");
  if (!connectUrl) {
    return {
      ok: false,
      error: `Zernio getConnectUrl: no URL in response — ${JSON.stringify(data)}`,
    };
  }
  return { ok: true, connectUrl };
}

/**
 * Complete a pending Bluesky connection after the user returns from Zernio.
 * Zernio returns callback params (connect_token / tempToken) in the redirect URL.
 * We call Zernio's pending-data endpoint to resolve the accountId.
 *
 * STUB — endpoint shape confirmed after Rob's live test of
 * GET /api/v1/connect/bluesky?profileId=test. Finalize before shipping.
 */
export async function resolvePendingConnection(
  apiKey: string,
  _connectToken: string,
): Promise<ZernioResult<{ accountId: string; platform: string; handle?: string }>> {
  // TODO: confirm Zernio's pending-connection endpoint and callback param shape.
  // Likely: GET /api/v1/connect/pending?tempToken=xxx
  //      or POST /api/v1/connect/pending { connectToken }
  // Update this implementation once Rob tests GET /connect/bluesky?profileId=test.
  return { ok: false, error: "resolvePendingConnection: not yet finalized — awaiting Bluesky connect shape" };
}

// ── Profile account listing ───────────────────────────────────────────────────

/**
 * Fetch the connected accounts for a Zernio profile.
 * Tries GET /profiles/{profileId} first; accounts may be nested under
 * .profile.accounts or top-level .accounts. Logs the raw shape for
 * debugging since the exact field names are API-version-dependent.
 */
export async function getProfileAccounts(
  apiKey: string,
  profileId: string,
): Promise<ZernioResult<{ accounts: { accountId: string; platform: string; handle?: string }[] }>> {
  let res: Response;
  try {
    res = await zernioFetch(apiKey, `/accounts?profileId=${encodeURIComponent(profileId)}`);
  } catch (e) {
    return { ok: false, error: `Zernio getProfileAccounts network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("getProfileAccounts", res.status, body);
  }

  const data = (await res.json()) as Record<string, unknown>;
  // GET /accounts returns an array directly or wrapped in { accounts: [...] }
  const rawAccounts = (
    Array.isArray(data) ? data :
    Array.isArray((data as any).accounts) ? (data as any).accounts :
    Array.isArray((data as any).data) ? (data as any).data :
    []
  ) as Record<string, unknown>[];

  const accounts = rawAccounts
    .map((a) => ({
      accountId: String(a._id ?? a.id ?? a.accountId ?? ""),
      platform:  String(a.platform ?? ""),
      handle:    a.handle != null ? String(a.handle) : (a.displayName != null ? String(a.displayName) : undefined),
    }))
    .filter((a) => a.accountId && a.platform);

  return { ok: true, accounts };
}

// ── Account disconnection ─────────────────────────────────────────────────────

/**
 * Disconnect (delete) a connected social account from Zernio.
 * Confirmed endpoint: DELETE /accounts/{accountId}
 * No request body; no profileId required — accountId is the sole identifier.
 * Success 200: { message: "Account disconnected successfully" }
 * Error 404: account not found on Zernio (already disconnected upstream).
 */
export async function disconnectAccount(
  apiKey: string,
  accountId: string,
): Promise<ZernioResult<{ message: string }>> {
  let res: Response;
  try {
    res = await zernioFetch(apiKey, `/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
  } catch (e) {
    return { ok: false, error: `Zernio disconnectAccount network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("disconnectAccount", res.status, body);
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = String(data.message ?? "Account disconnected successfully");
  return { ok: true, message };
}

// ── Publishing ────────────────────────────────────────────────────────────────

export type PublishInput = {
  content: string;
  platform: string;    // e.g. "bluesky"
  accountId: string;   // Zernio account ID for this platform
};

export type PublishOutput = {
  postId: string;         // Zernio _id — used for analytics lookups
  status: string;         // "published" | "pending" | "failed" | etc. (initial response — may not be final)
  errorMessage?: string;  // present when status is "failed"
  errorCategory?: string; // Zernio error category for friendly-error mapping
};

export type PostDetails = {
  postId: string;
  status: string;         // final status from GET /posts/:id
  errorMessage?: string;
  errorCategory?: string;
};

/**
 * Publish content immediately to a connected social account via Zernio.
 * Returns the Zernio post ID for later analytics retrieval.
 * On any failure returns a structured error — never throws.
 */
export async function publishPost(
  apiKey: string,
  input: PublishInput,
): Promise<ZernioResult<PublishOutput>> {
  let res: Response;
  try {
    res = await zernioFetch(apiKey, "/posts", {
      method: "POST",
      body: JSON.stringify({
        content: input.content,
        platforms: [{ platform: input.platform, accountId: input.accountId }],
        publishNow: true,
      }),
    });
  } catch (e) {
    return { ok: false, error: `Zernio publishPost network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("publishPost", res.status, body);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const post = ((data.post ?? data) as Record<string, unknown>);
  const postId = String(post._id ?? post.id ?? "");
  if (!postId) {
    return { ok: false, error: "Zernio publishPost: no post id in response" };
  }
  const status        = String(post.status ?? "pending");
  const errorMessage  = post.errorMessage  != null ? String(post.errorMessage)  : undefined;
  const errorCategory = post.errorCategory != null ? String(post.errorCategory) : undefined;
  return { ok: true, postId, status, errorMessage, errorCategory };
}

/**
 * Fetch the current status of a Zernio post by ID.
 * Zernio publishes asynchronously — use this to poll for the final
 * "published" or "failed" status after POST /posts returns a postId.
 */
export async function getPost(
  apiKey: string,
  postId: string,
): Promise<ZernioResult<PostDetails>> {
  let res: Response;
  try {
    res = await zernioFetch(apiKey, `/posts/${postId}`);
  } catch (e) {
    return { ok: false, error: `Zernio getPost network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return zernioErr("getPost", res.status, body);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const post = ((data.post ?? data) as Record<string, unknown>);
  const status        = String(post.status ?? "unknown");
  const errorMessage  = post.errorMessage  != null ? String(post.errorMessage)  : undefined;
  const errorCategory = post.errorCategory != null ? String(post.errorCategory) : undefined;
  return { ok: true, postId, status, errorMessage, errorCategory };
}

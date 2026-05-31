import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient, persistStreamEvent } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createAnthropicClient } from "../services/anthropic";
import { APP_RESULT_MODEL } from "../lib/app-models";
import { buildStrategyResultPrompt } from "../lib/prompts/app-content-prompts";
import { StrategyResultSchema } from "../lib/assembler/validation/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// /api/generated-apps/* — runtime for AI-generated per-business mini-apps.
//
// Separate URL space from /api/apps/* (which is the existing pre-built app
// catalog) — see "apps-catalog.ts" / "apps-businesses.ts" / "apps-instances.ts".
//
// Routes (registered under /api/generated-apps):
//   GET    /:businessId/app-html       public        fetch the saved HTML (singleton — kept for backward compat; deprecated)
//   GET    /:businessId/by-slug/:slug  public        fetch a specific app by its slug (Phase 1 multi-app)
//   GET    /:businessId/list           owner-only    list all apps for a business (Phase 1 multi-app)
//   DELETE /:businessId/:appId         owner-only    hard delete + cascade (Brief 2)
//   POST   /:businessId/purchase       public        create Stripe Checkout
//   POST   /webhook/stripe             public, sig'd handle checkout completed
//   POST   /:businessId/verify-token   public, hdr   decrement a visitor token
//   PATCH  /:businessId/config         owner-only    update app_configs row
//
// Visitor-token flow:
//   1. Visitor clicks Unlock → POST /purchase, gets Stripe Checkout URL
//      (also creates an app_visitor_tokens row with tokens_remaining=0).
//   2. Stripe collects payment, fires checkout.session.completed → /webhook/stripe
//      sets tokens_remaining and redirects to /sites/{slug}/app?vt=<token>.
//   3. App page stores ?vt= in localStorage; subsequent calls send it via
//      x-visitor-token header.
//   4. /verify-token decrements tokens_remaining by 1, logs to app_usage_log,
//      returns 200 if valid. Errors land in app_bug_log.
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// ── Stripe helpers (mirrors checkout.ts pattern) ─────────────────────────────
async function stripePost(
  path: string,
  params: Record<string, string>,
  secretKey: string,
): Promise<Response> {
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const chunk of header.split(",")) {
    const eq = chunk.indexOf("=");
    if (eq > -1) parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === parts.v1;
}

interface StripeCheckoutSession {
  id: string;
  mode: string;
  payment_status: string;
  payment_intent: string | null;
  customer_details?: { email?: string | null } | null;
  metadata: Record<string, string | undefined> | null;
}

interface StripeCharge {
  id: string;
  payment_intent: string | null;
  amount_refunded: number;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /:businessId/app-html — public read of the most-recent app HTML.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/:businessId/app-html", async (c) => {
  const businessId = c.req.param("businessId");
  const sb = createSupabaseClient(c.env);

  const { data: asset, error } = await sb
    .from("business_assets")
    .select("id, asset_data")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error("generated_apps.fetch_failed", { businessId, err: error.message });
    return c.json(errBody("internal", "fetch_failed"), 500);
  }
  if (!asset) {
    return c.json(errBody("not_found", "no app for this business"), 404);
  }

  const data = asset.asset_data as Record<string, unknown> | null;
  return c.json({
    asset_id: asset.id,
    html: (data?.html as string) ?? "",
    app_title: (data?.app_title as string) ?? "",
    app_tagline: (data?.app_tagline as string) ?? "",
    app_type: (data?.app_type as string) ?? "",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:businessId/purchase — create a Stripe Checkout for app tokens.
// Body: { tokens?: number }  (default 10)
// Returns: { checkout_url }
// ─────────────────────────────────────────────────────────────────────────────
const PurchaseBody = z.object({ tokens: z.number().int().positive().max(1000).optional() });

app.post("/:businessId/purchase", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(errBody("not_configured", "Stripe not configured"), 503);
  }
  const businessId = c.req.param("businessId");

  let body: z.infer<typeof PurchaseBody> = {};
  try {
    const raw = await c.req.json().catch(() => ({}));
    body = PurchaseBody.parse(raw);
  } catch {
    body = {};
  }
  const tokensRequested = body.tokens ?? 10;

  const sb = createSupabaseClient(c.env);

  // Fetch app_config to learn price/asset, plus business slug for return URLs.
  const { data: cfg } = await sb
    .from("app_configs")
    .select("paid_tier_price_cents, asset_id")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!cfg) return c.json(errBody("not_found", "app not configured for this business"), 404);

  const { data: biz } = await sb
    .from("businesses")
    .select("slug, name")
    .eq("id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (!biz) return c.json(errBody("not_found", "business not found"), 404);

  const unitAmount = (cfg.paid_tier_price_cents as number) * tokensRequested;
  const frontendUrl = c.env.FRONTEND_URL ?? "https://app.textos.ai";

  // Pre-create app_visitor_tokens row with 0 remaining — webhook fills in remaining
  // once payment is confirmed. visitor_token is set by DB DEFAULT.
  const { data: vt, error: vtErr } = await sb
    .from("app_visitor_tokens")
    .insert({
      business_id: businessId,
      tokens_purchased: tokensRequested,
      tokens_remaining: 0,
      amount_cents: unitAmount,
    })
    .select("visitor_token")
    .single();
  if (vtErr || !vt) {
    return c.json(errBody("internal", `visitor_token_insert_failed: ${vtErr?.message ?? ""}`), 500);
  }

  const successUrl = `${frontendUrl}/sites/${biz.slug}/app?vt=${vt.visitor_token}`;
  const cancelUrl = `${frontendUrl}/sites/${biz.slug}/app`;

  const res = await stripePost(
    "/checkout/sessions",
    {
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(unitAmount),
      "line_items[0][price_data][product_data][name]": `${tokensRequested} App Tokens — ${biz.name ?? "App"}`,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[business_id]": businessId,
      "metadata[tokens_purchased]": String(tokensRequested),
      "metadata[visitor_token]": vt.visitor_token as string,
      "metadata[textos_kind]": "generated_app_tokens",
    },
    c.env.STRIPE_SECRET_KEY,
  );

  if (!res.ok) {
    const errText = await res.text();
    log.error("generated_apps.checkout_failed", { businessId, err: errText });
    return c.json(errBody("upstream_error", "stripe_checkout_failed"), 502);
  }

  const session = (await res.json()) as { id: string; url: string };

  // Store the session id alongside the visitor_token so the webhook can match.
  await sb
    .from("app_visitor_tokens")
    .update({ stripe_session_id: session.id })
    .eq("visitor_token", vt.visitor_token);

  return c.json({ checkout_url: session.url });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/stripe — handle checkout.session.completed for app token buys.
// Signature-verified via STRIPE_WEBHOOK_SECRET. Idempotent on session id.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook/stripe", async (c) => {
  const sig = c.req.header("stripe-signature") ?? "";
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json(errBody("not_configured", "STRIPE_WEBHOOK_SECRET unset"), 503);
  }

  const payload = await c.req.text();
  const ok = await verifyStripeSignature(payload, sig, c.env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return c.json(errBody("unauthorized", "bad_signature"), 401);

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.json(errBody("bad_request", "invalid_json"), 400);
  }

  const sb = createSupabaseClient(c.env);

  // ── checkout.session.completed ───────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as StripeCheckoutSession;
    const meta = session.metadata ?? {};
    if (meta.textos_kind !== "generated_app_tokens") {
      return c.json({ ok: true, ignored: "not_our_event" });
    }

    const tokensPurchased = parseInt(meta.tokens_purchased ?? "0", 10);
    const businessId = meta.business_id ?? "";
    const visitorToken = meta.visitor_token ?? "";

    if (!businessId || !visitorToken || tokensPurchased <= 0) {
      log.error("generated_apps.webhook_bad_metadata", { session_id: session.id, meta });
      return c.json(errBody("bad_request", "missing metadata"), 400);
    }

    // Capture visitor email + payment_intent for receipts and refund linkage.
    // visitor_email and stripe_payment_intent_id are added by the GROUP 3 SQL.
    const visitorEmail = session.customer_details?.email ?? null;
    const paymentIntent = session.payment_intent ?? null;

    // Idempotent: only update if tokens_remaining is still 0. If a duplicate
    // event fires, we won't double-credit.
    const { data: updated, error: updErr } = await sb
      .from("app_visitor_tokens")
      .update({
        tokens_remaining: tokensPurchased,
        visitor_email: visitorEmail,
        stripe_payment_intent_id: paymentIntent,
      })
      .eq("visitor_token", visitorToken)
      .eq("tokens_remaining", 0)
      .select("id")
      .maybeSingle();

    if (updErr) {
      log.error("generated_apps.webhook_update_failed", { err: updErr.message, session_id: session.id });
      return c.json(errBody("internal", "update_failed"), 500);
    }

    log.info("generated_apps.tokens_credited", {
      session_id: session.id,
      business_id: businessId,
      visitor_token: visitorToken,
      tokens: tokensPurchased,
      has_email: visitorEmail !== null,
      has_payment_intent: paymentIntent !== null,
      new_row: updated ? "yes" : "no (already credited or expired)",
    });

    return c.json({ ok: true });
  }

  // ── charge.refunded ──────────────────────────────────────────────────────
  // Stripe refund → zero the visitor's remaining tokens. Matched by
  // stripe_payment_intent_id (stored on app_visitor_tokens at
  // checkout.session.completed time).
  if (event.type === "charge.refunded") {
    const charge = event.data.object as StripeCharge;
    if (!charge.payment_intent) {
      return c.json({ ok: true, ignored: "no_payment_intent_on_charge" });
    }

    const { data: vt, error: lookupErr } = await sb
      .from("app_visitor_tokens")
      .select("id, business_id, visitor_token, tokens_remaining")
      .eq("stripe_payment_intent_id", charge.payment_intent)
      .maybeSingle();

    if (lookupErr) {
      log.error("generated_apps.refund_lookup_failed", {
        err: lookupErr.message,
        payment_intent: charge.payment_intent,
      });
      return c.json(errBody("internal", "refund_lookup_failed"), 500);
    }
    if (!vt) {
      // Not one of ours — silently ignore. The platform stripe webhook
      // handles subscription / topup refunds via its own path.
      return c.json({ ok: true, ignored: "not_our_refund" });
    }

    const { error: zeroErr } = await sb
      .from("app_visitor_tokens")
      .update({ tokens_remaining: 0 })
      .eq("id", vt.id);

    if (zeroErr) {
      log.error("generated_apps.refund_update_failed", {
        err: zeroErr.message,
        payment_intent: charge.payment_intent,
      });
      return c.json(errBody("internal", "refund_update_failed"), 500);
    }

    log.info("generated_apps.tokens_refunded", {
      charge_id: charge.id,
      payment_intent: charge.payment_intent,
      business_id: vt.business_id,
      previous_remaining: vt.tokens_remaining,
    });
    return c.json({ ok: true });
  }

  return c.json({ ok: true, ignored: event.type });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:businessId/verify-token — deduct 1 token, log usage. Header: x-visitor-token
// ─────────────────────────────────────────────────────────────────────────────
app.post("/:businessId/verify-token", async (c) => {
  const businessId = c.req.param("businessId");
  const token = c.req.header("x-visitor-token") ?? "";
  if (!token) return c.json(errBody("unauthorized", "missing visitor token"), 401);

  const sb = createSupabaseClient(c.env);

  const { data: row, error } = await sb
    .from("app_visitor_tokens")
    .select("id, tokens_remaining, business_id, expires_at")
    .eq("visitor_token", token)
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    await sb.from("app_bug_log").insert({
      business_id: businessId,
      asset_id: businessId, // best-effort; updated below if we resolve real asset
      error_type: "verify_token_select_failed",
      error_message: error.message,
    });
    return c.json(errBody("internal", "verify_failed"), 500);
  }
  if (!row) return c.json(errBody("unauthorized", "invalid token"), 401);
  if (row.tokens_remaining <= 0) {
    return c.json(errBody("forbidden", "no tokens remaining"), 401);
  }
  if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) {
    return c.json(errBody("forbidden", "token expired"), 401);
  }

  // Find current asset for this business for the usage log
  const { data: asset } = await sb
    .from("business_assets")
    .select("id")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const newRemaining = (row.tokens_remaining as number) - 1;
  const { error: deductErr } = await sb
    .from("app_visitor_tokens")
    .update({ tokens_remaining: newRemaining })
    .eq("id", row.id);

  if (deductErr) {
    await sb.from("app_bug_log").insert({
      business_id: businessId,
      asset_id: asset?.id ?? row.id,
      error_type: "deduct_failed",
      error_message: deductErr.message,
    });
    return c.json(errBody("internal", "deduct_failed"), 500);
  }

  await sb.from("app_usage_log").insert({
    business_id: businessId,
    asset_id: asset?.id ?? row.id,
    visitor_token: token,
    interaction_type: "query",
    tokens_used: 1,
  });

  return c.json({ ok: true, tokens_remaining: newRemaining });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:businessId/config — owner-only update of app_configs.
// ─────────────────────────────────────────────────────────────────────────────
const ConfigBody = z.object({
  llm_tier: z.enum(["haiku", "sonnet", "opus"]).optional(),
  paid_tier_price_cents: z.number().int().min(0).max(100000).optional(),
  free_tier_enabled: z.boolean().optional(),
  is_published: z.boolean().optional(),
  // Floor at 1 — visitor must spend at least one token per use, otherwise
  // app interactions are effectively free even after a paid purchase.
  token_cost_per_use: z.number().int().min(1).max(100).optional(),
});

app.patch("/:businessId/config", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const businessId = c.req.param("businessId");

  let body: z.infer<typeof ConfigBody>;
  try {
    body = ConfigBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const sb = createSupabaseClient(c.env);
  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .eq("user_id", user_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!biz) return c.json(errBody("not_found", "business not found"), 404);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of Object.keys(body) as Array<keyof typeof body>) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { error } = await sb.from("app_configs").update(update).eq("business_id", businessId);
  if (error) {
    return c.json(errBody("internal", `update_failed: ${error.message}`), 500);
  }

  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:businessId/list — owner-only listing of generated apps for a business.
//
// Returns one entry per app row (asset_type='app') plus the in-progress draft
// (asset_type='app_draft') and any recent failed task_runs that didn't yield
// a row. Stats (views/completions/lead_captures) are placeholders — once a
// view/completion/lead tracking surface exists we'll populate them from there;
// for now return 0 so the frontend list rendering is stable.
//
// Default filter: is_current=true only. Pass ?include_history=true to also
// surface superseded rows (operator history). The is_current=true filter
// applies only to the asset_type='app' query — drafts and failed task_runs
// have their own implicit "active right now" semantics already.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/:businessId/list", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const businessId = c.req.param("businessId");
  const includeHistory = c.req.query("include_history") === "true";
  const sb = createSupabaseClient(c.env);

  // Ownership check — mirrors the pattern from PATCH /:businessId/config.
  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .eq("user_id", user_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!biz) return c.json(errBody("not_found", "business not found"), 404);

  // ── Active apps (asset_type='app') ────────────────────────────────────
  let appsQuery = sb
    .from("business_assets")
    .select(
      "id, app_slug, app_icon, asset_data, asset_subtype, is_current, created_at, task_run_id",
    )
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .order("created_at", { ascending: false });
  if (!includeHistory) appsQuery = appsQuery.eq("is_current", true);
  const { data: appRows, error: appErr } = await appsQuery;
  if (appErr) {
    log.error("generated_apps.list.apps_failed", {
      business_id: businessId,
      err: appErr.message,
    });
    return c.json(errBody("internal", "apps_lookup_failed"), 500);
  }

  // ── In-progress draft (asset_type='app_draft', is_current=true) ───────
  const { data: draftRows, error: draftErr } = await sb
    .from("business_assets")
    .select("id, asset_data, created_at, task_run_id")
    .eq("business_id", businessId)
    .eq("asset_type", "app_draft")
    .eq("is_current", true)
    .order("created_at", { ascending: false });
  if (draftErr) {
    log.error("generated_apps.list.drafts_failed", {
      business_id: businessId,
      err: draftErr.message,
    });
    return c.json(errBody("internal", "drafts_lookup_failed"), 500);
  }

  // ── Failed gen-app task_runs without an asset row ─────────────────────
  // "failed without a row" = status='failed' on a gen-app task slug AND
  // we did NOT find an asset row tied to that task_run_id above. The
  // join is done client-side because PostgREST doesn't do anti-joins
  // cleanly through .from() chains.
  const { data: failedTasksRaw, error: failedErr } = await sb
    .from("task_runs")
    .select("id, error, created_at, tasks!inner(slug)")
    .eq("business_id", businessId)
    .eq("status", "failed")
    .like("tasks.slug", "generate-business-app%")
    .order("created_at", { ascending: false })
    .limit(20);
  if (failedErr) {
    log.error("generated_apps.list.failed_runs_failed", {
      business_id: businessId,
      err: failedErr.message,
    });
    // Non-fatal — show what we have.
  }
  type FailedRun = {
    id: string;
    error: string | null;
    created_at: string;
    tasks: { slug: string };
  };
  const failedTasks = (failedTasksRaw ?? []) as unknown as FailedRun[];
  const taskRunIdsWithRow = new Set<string>(
    [
      ...((appRows ?? []) as Array<{ task_run_id: string | null }>),
      ...((draftRows ?? []) as Array<{ task_run_id: string | null }>),
    ]
      .map((r) => r.task_run_id)
      .filter((v): v is string => typeof v === "string"),
  );
  const orphanFailed = failedTasks.filter((r) => !taskRunIdsWithRow.has(r.id));

  // ── Shape the response ────────────────────────────────────────────────
  // Stats placeholders. When per-app tracking exists (app_usage_log
  // already records visits but isn't aggregated; views/lead_capture
  // tracking doesn't exist yet) we'll fill these in from a separate
  // count query. Returning 0 keeps the frontend rendering stable today.
  type AppEntry = {
    id: string;
    app_slug: string | null;
    app_title: string;
    app_tagline: string;
    app_icon: string | null;
    app_type: string;
    status: "active" | "building" | "failed";
    created_at: string;
    is_current?: boolean;
    error?: string | null;
    views: number;
    completions: number;
    lead_captures: number;
  };

  const activeEntries: AppEntry[] = ((appRows ?? []) as Array<{
    id: string;
    app_slug: string | null;
    app_icon: string | null;
    asset_data: Record<string, unknown> | null;
    asset_subtype: string | null;
    is_current: boolean;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    app_slug: r.app_slug,
    app_title: (r.asset_data?.app_title as string) ?? "",
    app_tagline: (r.asset_data?.app_tagline as string) ?? "",
    app_icon: r.app_icon,
    app_type: (r.asset_data?.app_type as string) ?? "",
    status: "active" as const,
    created_at: r.created_at,
    is_current: r.is_current,
    views: 0,
    completions: 0,
    lead_captures: 0,
  }));

  const buildingEntries: AppEntry[] = ((draftRows ?? []) as Array<{
    id: string;
    asset_data: Record<string, unknown> | null;
    created_at: string;
  }>).map((r) => {
    const design = (r.asset_data?.design as Record<string, unknown> | undefined) ?? {};
    return {
      id: r.id,
      app_slug: null,
      app_title: (design.app_title as string) ?? (r.asset_data?.app_title as string) ?? "",
      app_tagline: (design.app_tagline as string) ?? (r.asset_data?.app_tagline as string) ?? "",
      app_icon: (design.app_icon as string) ?? null,
      app_type: (design.app_type as string) ?? (r.asset_data?.app_type as string) ?? "",
      status: "building" as const,
      created_at: r.created_at,
      views: 0,
      completions: 0,
      lead_captures: 0,
    };
  });

  const failedEntries: AppEntry[] = orphanFailed.map((r) => ({
    id: r.id, // task_run id, not asset id — no asset row exists for failed runs
    app_slug: null,
    app_title: "",
    app_tagline: "",
    app_icon: null,
    app_type: "",
    status: "failed" as const,
    created_at: r.created_at,
    error: r.error,
    views: 0,
    completions: 0,
    lead_captures: 0,
  }));

  // Active first (already created_at DESC), then building, then failed.
  return c.json({
    apps: [...activeEntries, ...buildingEntries, ...failedEntries],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:businessId/by-slug/:slug — PUBLIC. Visitor iframe reads the specific
// app identified by its app_slug. Mirrors the response shape of the existing
// /:businessId/app-html endpoint (id, html, app_title, app_tagline, app_type)
// plus the new top-level app_icon field.
//
// is_current=true gates the read so superseded versions of the same slug
// don't leak to visitors.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/:businessId/by-slug/:slug", async (c) => {
  const businessId = c.req.param("businessId");
  const slug = c.req.param("slug");
  const sb = createSupabaseClient(c.env);

  const { data: asset, error } = await sb
    .from("business_assets")
    .select("id, asset_data, app_icon")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .eq("app_slug", slug)
    .eq("is_current", true)
    .maybeSingle();

  if (error) {
    log.error("generated_apps.by_slug.fetch_failed", {
      businessId,
      slug,
      err: error.message,
    });
    return c.json(errBody("internal", "fetch_failed"), 500);
  }
  if (!asset) {
    return c.json(errBody("not_found", "no app for this business/slug"), 404);
  }

  const data = asset.asset_data as Record<string, unknown> | null;
  return c.json({
    id: asset.id,
    html: (data?.html as string) ?? "",
    app_title: (data?.app_title as string) ?? "",
    app_tagline: (data?.app_tagline as string) ?? "",
    app_type: (data?.app_type as string) ?? "",
    app_icon: asset.app_icon ?? null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:businessId/by-slug/:slug/result — PUBLIC. Runtime strategy result.
//
// The visitor completes the wizard; the client POSTs { responses } (a map of
// question id → answer). We generate the result FROM those answers with
// APP_RESULT_MODEL — a single call, AbortController-bounded, capped max_tokens
// (NO Promise.race) — validate against StrategyResultSchema (no-fallbacks), and
// return { headline, summary, sections[], cta }. Per-IP and per-app KV rate
// limits guard cost/abuse from day one.
// ─────────────────────────────────────────────────────────────────────────────
async function rateLimitOk(
  env: Env,
  scopeKey: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const kv = env.SNAPSHOT_KV;
  if (!kv) return true; // binding absent → don't hard-block the feature
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:appresult:${scopeKey}:${bucket}`;
  const cur = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (cur >= max) return false;
  await kv.put(key, String(cur + 1), { expirationTtl: windowSec * 2 });
  return true;
}

app.post("/:businessId/by-slug/:slug/result", async (c) => {
  const businessId = c.req.param("businessId");
  const slug = c.req.param("slug");
  const ip = c.req.header("cf-connecting-ip") || "unknown";

  // Rate limit: per-IP-per-app (abuse) AND per-app (cost cap). Both windowed.
  const perIpOk = await rateLimitOk(c.env, `${businessId}:${slug}:${ip}`, 8, 60);
  const perAppOk = await rateLimitOk(c.env, `${businessId}:${slug}:_all`, 60, 60);
  if (!perIpOk || !perAppOk) {
    return c.json(errBody("rate_limited", "Too many requests — please wait a moment."), 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "invalid JSON"), 400);
  }
  const responsesRaw = (body as { responses?: unknown } | null)?.responses;
  if (!responsesRaw || typeof responsesRaw !== "object") {
    return c.json(errBody("bad_request", "responses object required"), 400);
  }
  const responses: Record<string, string> = {};
  for (const [k, v] of Object.entries(responsesRaw as Record<string, unknown>)) {
    responses[k] = typeof v === "string" ? v : String(v ?? "");
  }

  const sb = createSupabaseClient(c.env);
  const { data: asset, error } = await sb
    .from("business_assets")
    .select("id, asset_data")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .eq("app_slug", slug)
    .eq("is_current", true)
    .maybeSingle();
  if (error) return c.json(errBody("internal", "fetch_failed"), 500);
  if (!asset) return c.json(errBody("not_found", "no app for this business/slug"), 404);

  const ad = (asset.asset_data as Record<string, any> | null) || {};
  if (ad.archetype_id !== "strategy") {
    return c.json(errBody("bad_request", "result generation is only for strategy apps"), 400);
  }
  const content = ad.content as any;
  const bc = ad.build_context as any;
  const sectionPlan = content?.result?.section_plan;
  const questions = content?.questions;
  if (!Array.isArray(sectionPlan) || !Array.isArray(questions) || !bc) {
    return c.json(errBody("internal", "app is missing build content/context"), 500);
  }

  const { system, user } = buildStrategyResultPrompt({
    bc,
    appTitle: (ad.app_title as string) || content.app_title,
    sectionPlan: sectionPlan.map((s: any) => ({ heading: s.heading, directive: s.directive })),
    questions: questions.map((q: any) => ({ id: q.id, text: q.text })),
    responses,
  });

  // Single call, AbortController-bounded, capped max_tokens. No Promise.race.
  const anthropic = createAnthropicClient(c.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let parsed: unknown;
  try {
    const msg = await anthropic.messages.create(
      {
        model: APP_RESULT_MODEL,
        max_tokens: 1500,
        stream: false,
        system,
        messages: [{ role: "user", content: user }],
      },
      { signal: controller.signal },
    );
    const block = msg.content[0];
    const text = block && block.type === "text" ? (block as { text: string }).text : "";
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
  } catch (err) {
    clearTimeout(timer);
    log.error("generated_apps.result.generation_failed", {
      businessId,
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(errBody("internal", "result generation failed — please retry"), 502);
  }
  clearTimeout(timer);

  let result: ReturnType<typeof StrategyResultSchema.parse>;
  try {
    result = StrategyResultSchema.parse(parsed);
  } catch (zerr) {
    log.error("generated_apps.result.validation_failed", {
      businessId,
      slug,
      err: zerr instanceof Error ? zerr.message : String(zerr),
    });
    return c.json(errBody("internal", "result validation failed — please retry"), 502);
  }

  // Build-time CTA with the operator URL substituted for the sentinel (closes 5d).
  const operatorUrl = (ad.operator_url as string) || "";
  const cta = (content?.result?.cta as Record<string, unknown>) || {};
  const sub = (v: unknown) =>
    v === "cta_url_placeholder" ? operatorUrl : typeof v === "string" ? v : "";

  return c.json({
    headline: result.headline,
    summary: result.summary,
    sections: result.sections,
    cta: {
      primary_text: (cta.primary_text as string) ?? "",
      primary_url: sub(cta.primary_action),
      secondary_text: (cta.secondary_text as string) ?? "",
      secondary_url: sub(cta.secondary_action),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:businessId/:appId — owner-only hard delete of a generated app.
//
// The :appId param can be one of two things:
//   - `kind='asset'`     — a business_assets.id (the row for a successful or
//                          in-progress generation). Cascade order:
//                            1. app_configs  WHERE asset_id = :appId
//                            2. app_bug_log  WHERE asset_id = :appId
//                            3. business_assets WHERE id = :appId AND business_id
//                          The unique partial index on (business_id, app_slug)
//                          WHERE asset_type='app' means a half-deleted state
//                          isn't catastrophic — the slug becomes reusable as
//                          soon as the asset row goes.
//   - `kind='task_run'`  — a task_runs.id for a failed gen-app run that never
//                          produced an asset row. /list surfaces these in the
//                          operator UI so the operator can clear them out;
//                          this branch just deletes the one task_runs row
//                          (and only if the linked tasks.slug starts with
//                          'generate-business-app' — defensive against the
//                          endpoint being used to nuke unrelated task_runs).
//
// We try the asset path first; if no row matches, we fall back to the task_run
// path. If neither matches → 404.
//
// Auth: requireAuth + ownership re-verify on `businesses.user_id`. 401 unauthed,
// 403 owner mismatch, 404 if neither lookup matches, 500 on any DB error
// (with structured log).
//
// Logs an `app_deleted` row to stream_events for both paths, with
// event_data.kind set to 'asset' or 'task_run' so the difference is
// queryable later.
// ─────────────────────────────────────────────────────────────────────────────
app.delete("/:businessId/:appId", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const businessId = c.req.param("businessId");
  const appId = c.req.param("appId");
  const sb = createSupabaseClient(c.env);

  // Ownership check
  const { data: biz, error: bizErr } = await sb
    .from("businesses")
    .select("id, user_id")
    .eq("id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr) {
    log.error("generated_apps.delete.business_lookup_failed", {
      businessId,
      err: bizErr.message,
    });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!biz) {
    return c.json(errBody("not_found", "business not found"), 404);
  }
  if ((biz as { user_id: string }).user_id !== user_id) {
    log.warn("generated_apps.delete.forbidden", {
      businessId,
      appId,
      attempting_user_id: user_id,
    });
    return c.json(errBody("forbidden", "not owner"), 403);
  }

  // ── 1) Try the asset path first ─────────────────────────────────────
  const { data: asset, error: assetErr } = await sb
    .from("business_assets")
    .select("id, app_slug")
    .eq("id", appId)
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .maybeSingle();
  if (assetErr) {
    log.error("generated_apps.delete.asset_lookup_failed", {
      businessId,
      appId,
      err: assetErr.message,
    });
    return c.json(errBody("internal", "asset_lookup_failed"), 500);
  }

  if (asset) {
    // Cascade. Each step logs but continues — if step N fails we still
    // report 500 at the end. The asset row delete is the critical one;
    // if 1 or 2 fails but 3 succeeds, the orphaned rows are eventually-
    // consistent garbage that an admin sweep can clean up.
    const errors: string[] = [];

    const { error: cfgErr } = await sb
      .from("app_configs")
      .delete()
      .eq("asset_id", appId);
    if (cfgErr) {
      errors.push(`app_configs: ${cfgErr.message}`);
      log.error("generated_apps.delete.app_configs_failed", {
        appId,
        err: cfgErr.message,
      });
    }

    const { error: bugErr } = await sb
      .from("app_bug_log")
      .delete()
      .eq("asset_id", appId);
    if (bugErr) {
      errors.push(`app_bug_log: ${bugErr.message}`);
      log.error("generated_apps.delete.app_bug_log_failed", {
        appId,
        err: bugErr.message,
      });
    }

    const { error: assetDelErr } = await sb
      .from("business_assets")
      .delete()
      .eq("id", appId)
      .eq("business_id", businessId);
    if (assetDelErr) {
      errors.push(`business_assets: ${assetDelErr.message}`);
      log.error("generated_apps.delete.business_assets_failed", {
        appId,
        businessId,
        err: assetDelErr.message,
      });
      return c.json(
        errBody("internal", `delete_failed: ${assetDelErr.message}`),
        500,
      );
    }

    await persistStreamEvent(
      sb,
      appId,
      businessId,
      1,
      "app_deleted",
      {
        kind: "asset",
        asset_id: appId,
        app_slug: (asset as { app_slug: string | null }).app_slug,
        deleted_by_user_id: user_id,
        deleted_at: new Date().toISOString(),
        cascade_errors: errors.length > 0 ? errors : undefined,
      },
    );

    log.info("generated_apps.delete.complete", {
      businessId,
      appId,
      kind: "asset",
      cascade_errors: errors.length,
    });

    return c.json({ deleted: true, kind: "asset" });
  }

  // ── 2) Fallback: try the task_run path ──────────────────────────────
  // Failed gen-app runs have no asset row (that's how they surface in
  // /list as `status='failed'`). The id from the UI is the task_run_id.
  // Guard the lookup so this endpoint can't be used to delete unrelated
  // task_runs — we require an inner join against tasks with a slug that
  // starts with 'generate-business-app'.
  const { data: tr, error: trErr } = await sb
    .from("task_runs")
    .select("id, status, tasks!inner(slug)")
    .eq("id", appId)
    .eq("business_id", businessId)
    .like("tasks.slug", "generate-business-app%")
    .maybeSingle();
  if (trErr) {
    log.error("generated_apps.delete.task_run_lookup_failed", {
      businessId,
      appId,
      err: trErr.message,
    });
    return c.json(errBody("internal", "task_run_lookup_failed"), 500);
  }
  if (!tr) {
    return c.json(errBody("not_found", "no app or run matches this id"), 404);
  }

  type FoundTaskRun = { id: string; status: string; tasks: { slug: string } };
  const trRow = tr as unknown as FoundTaskRun;

  const { error: trDelErr } = await sb
    .from("task_runs")
    .delete()
    .eq("id", appId)
    .eq("business_id", businessId);
  if (trDelErr) {
    log.error("generated_apps.delete.task_run_delete_failed", {
      appId,
      businessId,
      err: trDelErr.message,
    });
    return c.json(
      errBody("internal", `delete_failed: ${trDelErr.message}`),
      500,
    );
  }

  await persistStreamEvent(
    sb,
    appId,
    businessId,
    1,
    "app_deleted",
    {
      kind: "task_run",
      task_run_id: appId,
      task_slug: trRow.tasks.slug,
      previous_status: trRow.status,
      deleted_by_user_id: user_id,
      deleted_at: new Date().toISOString(),
    },
  );

  log.info("generated_apps.delete.complete", {
    businessId,
    appId,
    kind: "task_run",
    task_slug: trRow.tasks.slug,
  });

  return c.json({ deleted: true, kind: "task_run" });
});

export default app;

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

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

export default app;

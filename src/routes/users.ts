// ─────────────────────────────────────────────────────────────────────────────
// User self-service endpoints (P1-2 + P1-3 batched per Rob's call).
//
//   GET   /api/users/me                       — profile + aggregated stats
//   PATCH /api/users/me                       — update profile (name only)
//   GET   /api/users/me/portal                — Stripe Customer Portal session
//   POST  /api/users/me/email-change          — initiate email change (sends SG)
//   POST  /api/users/me/email-change/verify   — complete email change
//
// All endpoints require auth. The verify endpoint additionally requires the
// authenticated user to own the verification token (prevents A from using B's
// link to change A's email to whatever B was approving).
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log, persistError } from "../lib/logger";
import { stripeCustomerIdColumn } from "../lib/stripe-mode";
import { loadUserProfile } from "../lib/user-profile";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── Helpers ─────────────────────────────────────────────────────────────────

function frontendUrl(env: Env): string {
  return env.FRONTEND_URL ?? "https://app.textos.ai";
}

/**
 * Sanitize a frontend-supplied `return_to` so the Stripe Portal can't be used
 * as an open redirect. Returns the validated path (always starts with "/") or
 * "/" if anything looks off.
 *
 * Rules:
 *  - must be a string
 *  - must start with a single "/" (rejects protocol-relative "//evil.com")
 *  - reject backslashes / angle brackets (defensive against weird XSS framing)
 *  - cap at 500 chars
 */
function validateReturnTo(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") return "/";
  if (raw.length > 500) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (/[\\<>]/.test(raw)) return "/";
  return raw;
}

/**
 * Append ?portal_return=1 to a sanitized path, preserving any existing query
 * string and trailing hash fragment.
 */
function withPortalReturnFlag(path: string): string {
  const hashIdx = path.indexOf("#");
  const before = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
  const hash   = hashIdx >= 0 ? path.slice(hashIdx)   : "";
  const sep    = before.includes("?") ? "&" : "?";
  return `${before}${sep}portal_return=1${hash}`;
}

/** Generate a 69-char verification token: uuid (36) + "-" + 32 hex chars. */
function generateVerificationToken(): string {
  const uuid = crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${uuid}-${hex}`;
}

// ── GET /me ─────────────────────────────────────────────────────────────────
//
// Returns the authenticated user's profile plus aggregated stats. The brief
// pegged "lifetime spend" as α-with-enhancement: surface topup_spend_cents
// (honest, locally tracked) AND per-business subscription_status. We do NOT
// fabricate a combined "total spent" — that would require Stripe invoice
// fetches, deferred to V1.1.

app.get("/me", async (c) => {
  const { user_id } = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  try {
    const profile = await loadUserProfile(supabase, user_id);
    if (!profile) {
      log.error("[users] user_not_found", { user_id });
      return c.json(errBody("not_found", "user not found"), 404);
    }
    return c.json(profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[users] profile_load_failed", { user_id, err: msg });
    return c.json(errBody("internal", "profile_load_failed", msg), 500);
  }
});

// ── PATCH /me ───────────────────────────────────────────────────────────────

const PatchBody = z.object({ name: z.string().min(1).max(100) }).strict();

app.patch("/me", async (c) => {
  const { user_id } = c.get("auth");

  let parsed: z.infer<typeof PatchBody>;
  try {
    parsed = PatchBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("users")
    .update({ name: parsed.name.trim() })
    .eq("id", user_id)
    .select("id, email, name, is_admin, created_at")
    .single();

  if (error || !data) {
    log.error("[users] update_failed", { user_id, err: error?.message });
    return c.json(errBody("internal", "update_failed"), 500);
  }

  return c.json(data);
});

// ── GET /me/portal ──────────────────────────────────────────────────────────

app.get("/me/portal", async (c) => {
  const { user_id } = c.get("auth");

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(errBody("not_configured", "Stripe not configured"), 503);
  }

  const supabase = createSupabaseClient(c.env);
  const customerCol = stripeCustomerIdColumn(c.env);
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select(customerCol)
    .eq("id", user_id)
    .single();

  if (userErr || !user) {
    log.error("[users] portal_user_lookup_failed", {
      user_id,
      err: userErr?.message,
    });
    return c.json(errBody("internal", "user_lookup_failed"), 500);
  }

  const customerId = (user as Record<string, unknown>)[customerCol] as string | null;
  if (!customerId) {
    return c.json(
      errBody(
        "not_found",
        "no billing history yet — subscribe or purchase a top-up first",
      ),
      404,
    );
  }

  // Caller passes ?return_to=/some/path so Stripe Portal returns to the
  // surface they invoked it from. Validated to prevent open-redirect abuse.
  const returnPath = withPortalReturnFlag(validateReturnTo(c.req.query("return_to")));
  const returnUrl = `${frontendUrl(c.env)}${returnPath}`;
  const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer:   customerId,
      return_url: returnUrl,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error("[users] portal_session_create_failed", {
      user_id,
      err: body,
    });
    await persistError(
      supabase,
      "error",
      "[users]",
      "portal_session_create_failed",
      { user_id, err: body },
    );
    return c.json(errBody("upstream_error", "portal_session_create_failed"), 502);
  }

  const session = (await res.json()) as { url: string };
  log.info("[users] portal_session_created", { user_id });
  return c.json({ url: session.url });
});

// ── POST /me/email-change (initiate) ────────────────────────────────────────

const EmailChangeBody = z
  .object({ new_email: z.string().email().max(254) })
  .strict();

app.post("/me/email-change", async (c) => {
  const auth = c.get("auth");
  const user_id = auth.user_id;
  const current_email = auth.email;

  let parsed: z.infer<typeof EmailChangeBody>;
  try {
    parsed = EmailChangeBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const new_email = parsed.new_email.toLowerCase().trim();

  if (new_email === current_email.toLowerCase()) {
    return c.json(
      errBody("bad_request", "new email is the same as current"),
      400,
    );
  }

  const supabase = createSupabaseClient(c.env);

  // Uniqueness pre-check (DB UNIQUE constraint is the final guard).
  const { data: existing, error: lookupErr } = await supabase
    .from("users")
    .select("id")
    .eq("email", new_email)
    .maybeSingle();
  if (lookupErr) {
    log.error("[users] email_lookup_failed", { user_id, err: lookupErr.message });
    return c.json(errBody("internal", "email_lookup_failed"), 500);
  }
  if (existing) {
    return c.json(errBody("conflict", "email already in use"), 409);
  }

  // Insert request row.
  const verification_token = generateVerificationToken();
  const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: insertErr } = await supabase
    .from("email_change_requests")
    .insert({
      user_id,
      old_email: current_email,
      new_email,
      verification_token,
      expires_at,
    });
  if (insertErr) {
    log.error("[users] email_change_insert_failed", {
      user_id,
      err: insertErr.message,
    });
    return c.json(errBody("internal", "email_change_insert_failed"), 500);
  }

  // Send via SendGrid. If send fails, roll back the request row so the user
  // can retry cleanly (no orphan pending request).
  const verifyLink = `${frontendUrl(c.env)}/verify-email-change?token=${encodeURIComponent(
    verification_token,
  )}`;
  const subject = "Verify your new TextOS email address";
  const body = [
    "You requested to change your TextOS email to this address.",
    "",
    "Click below to verify:",
    verifyLink,
    "",
    "This link expires in 24 hours.",
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  let sent = false;
  let sendError: string | undefined;
  if (c.env.SENDGRID_API_KEY && c.env.SENDGRID_API_KEY !== "PLACEHOLDER") {
    try {
      const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${c.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: new_email }] }],
          from:    { email: "hello@textos.ai", name: "TextOS" },
          subject,
          content: [{ type: "text/plain", value: body }],
        }),
      });
      sent = sgRes.ok;
      if (!sgRes.ok) sendError = `SendGrid ${sgRes.status}: ${await sgRes.text()}`;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }
  } else {
    sendError = "SendGrid not configured";
  }

  if (!sent) {
    log.error("[users] email_change_send_failed", {
      user_id,
      new_email,
      err: sendError,
    });
    await persistError(
      supabase,
      "error",
      "[users]",
      "email_change_send_failed",
      { user_id, new_email, err: sendError },
    );
    await supabase
      .from("email_change_requests")
      .delete()
      .eq("verification_token", verification_token);
    return c.json(errBody("upstream_error", "email_send_failed"), 502);
  }

  log.info("[users] email_change_initiated", { user_id, new_email });
  return c.json({ success: true, expires_at });
});

// ── POST /me/email-change/verify (complete) ─────────────────────────────────

const EmailVerifyBody = z.object({ token: z.string().min(1) }).strict();

app.post("/me/email-change/verify", async (c) => {
  const auth = c.get("auth");
  const user_id = auth.user_id;
  const previous_email = auth.email;

  let parsed: z.infer<typeof EmailVerifyBody>;
  try {
    parsed = EmailVerifyBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: req, error: reqErr } = await supabase
    .from("email_change_requests")
    .select("id, user_id, new_email, expires_at, verified_at")
    .eq("verification_token", parsed.token)
    .maybeSingle();

  if (reqErr) {
    log.error("[users] email_verify_lookup_failed", {
      user_id,
      err: reqErr.message,
    });
    return c.json(errBody("internal", "lookup_failed"), 500);
  }
  if (!req) {
    return c.json(errBody("not_found", "invalid or expired link"), 404);
  }

  // Token MUST belong to the authenticated user. Prevents A from completing
  // B's pending email change.
  if (req.user_id !== user_id) {
    log.error("[users] email_verify_owner_mismatch", {
      user_id,
      token_owner: req.user_id,
    });
    return c.json(
      errBody("forbidden", "this verification link does not belong to your account"),
      403,
    );
  }

  if (req.verified_at) {
    return c.json(errBody("conflict", "link already used"), 410);
  }
  if (new Date(req.expires_at as string).getTime() < Date.now()) {
    return c.json(errBody("conflict", "link expired"), 410);
  }

  const newEmail = req.new_email as string;

  // 1. Update public.users.email. UNIQUE constraint catches races.
  const { error: pubUpdateErr } = await supabase
    .from("users")
    .update({ email: newEmail })
    .eq("id", user_id);
  if (pubUpdateErr) {
    // Race: the email got taken between initiation and verify.
    if (
      pubUpdateErr.code === "23505" ||
      pubUpdateErr.message.toLowerCase().includes("unique")
    ) {
      return c.json(
        errBody(
          "conflict",
          "email no longer available — please initiate a new change",
        ),
        409,
      );
    }
    log.error("[users] email_verify_public_update_failed", {
      user_id,
      err: pubUpdateErr.message,
    });
    return c.json(errBody("internal", "update_failed"), 500);
  }

  // 2. Update auth.users.email via Supabase Auth admin API. Roll back
  //    public.users on failure so the two stores don't diverge.
  const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(
    user_id,
    { email: newEmail },
  );
  if (authUpdateErr) {
    log.error("[users] email_verify_auth_update_failed", {
      user_id,
      err: authUpdateErr.message,
    });
    await persistError(
      supabase,
      "error",
      "[users]",
      "email_verify_auth_update_failed",
      { user_id, err: authUpdateErr.message },
    );
    await supabase
      .from("users")
      .update({ email: previous_email })
      .eq("id", user_id);
    return c.json(errBody("internal", "auth_update_failed"), 500);
  }

  // 3. Mark request consumed.
  await supabase
    .from("email_change_requests")
    .update({ verified_at: new Date().toISOString() })
    .eq("id", req.id as string);

  log.info("[users] email_change_completed", {
    user_id,
    new_email: newEmail,
  });
  return c.json({ success: true, new_email: newEmail });
});

export default app;

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { verifySupabaseJwt } from "../lib/jwt";
import {
  createSupabaseClient,
  upsertUser,
  getUserById,
  createBusiness,
  upsertBusinessContext,
  countUserBusinesses,
  isHandleAvailable,
  setUserHandle,
} from "../services/supabase";
import type { AnonymousSnapshot, AnonymousInput } from "../lib/anonymous-research";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { pickAgentName } from "../lib/agentNames";
import { createCnameRecord } from "../services/cloudflare";
import { checkAnonIpLimit } from "../lib/anon-guards";

const app = new Hono<{ Bindings: Env }>();

/** Derives a handle suggestion from an email prefix for the handle-picker pre-fill. */
function suggestHandleFromEmail(email: string): string {
  const prefix = email.split("@")[0] ?? "";
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")   // keep only alphanumeric + hyphens
    .replace(/^-+|-+$/g, "")       // trim leading/trailing hyphens
    .slice(0, 28);
  return base || "user";
}

function slugifyName(name: string): string {
  const base = (name || "business")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")   // strip non-alphanumeric
    .trim()
    .replace(/[\s-]+/g, "-")         // spaces/dashes → single dash
    .replace(/^-+|-+$/g, "")         // trim leading/trailing dashes
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "business"}-${suffix}`;
}

// 3-30 chars, lowercase alphanumeric + hyphens, must start AND end with alphanumeric.
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

const RESERVED = new Set([
  "admin", "api", "app", "www", "mail", "support", "billing",
  "help", "docs", "status", "blog", "system", "root", "public",
]);

/**
 * Auto-generates and claims a handle for a user. Tries the base suggestion,
 * then variations with numbers if needed.
 */
async function autoGenerateHandle(
  supabase: any,
  env: any,
  userId: string,
  email: string
): Promise<{ handle: string; url: string } | null> {
  const base = suggestHandleFromEmail(email);

  // Try the base suggestion first
  let candidates = [base];

  // Add numbered variations if the base doesn't work
  for (let i = 2; i <= 99; i++) {
    candidates.push(`${base}${i}`);
  }

  for (const candidate of candidates) {
    // Skip if invalid format or reserved
    if (!HANDLE_REGEX.test(candidate) || RESERVED.has(candidate)) {
      continue;
    }

    try {
      // Check availability
      const available = await isHandleAvailable(supabase, candidate);
      if (!available) continue;

      // Try to claim it
      await setUserHandle(supabase, userId, candidate);

      // Create DNS record (non-fatal if fails)
      try {
        await createCnameRecord(env, `${candidate}.app`, "textos-web.pages.dev");
      } catch (dnsErr) {
        log.warn("auto_handle_dns_failed", {
          err: String(dnsErr),
          handle: candidate
        });
      }

      log.info("auto_handle_claimed", {
        user_id: userId,
        handle: candidate,
        base_suggestion: base
      });

      return {
        handle: candidate,
        url: `https://${candidate}.app.textos.ai`
      };

    } catch (err) {
      // Handle unique violation or other errors - try next candidate
      const msg = err instanceof Error ? err.message : String(err);
      const isUniqueViolation = msg.toLowerCase().includes("duplicate") || msg.includes("23505");
      if (!isUniqueViolation) {
        // Non-unique violation error, log and continue
        log.warn("auto_handle_attempt_failed", {
          err: msg,
          handle: candidate,
          user_id: userId
        });
      }
      continue;
    }
  }

  // Couldn't generate any handle
  log.error("auto_handle_generation_exhausted", {
    user_id: userId,
    email,
    base_suggestion: base
  });
  return null;
}

const CallbackBody = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  type: z.enum(["signup", "recovery", "magiclink"]).optional(),
  snapshot_token: z.string().max(32).optional(),
});

/**
 * Called by the frontend immediately after the OAuth or magic-link
 * redirect resolves. Validates the access token, upserts the user
 * into `public.users` (first-time only), and returns whether the
 * user has already picked a handle so the frontend can route them
 * to /onboarding (no handle) or / (returning user).
 *
 * The refresh_token is in the body for forward-compat (so we can
 * persist it server-side later if we want), but Sprint 3b doesn't
 * use it — frontend Supabase client manages the session.
 */
app.post("/callback", async (c) => {
  let parsed;
  try {
    parsed = CallbackBody.parse(await c.req.json());
  } catch (err) {
    return c.json(
      errBody(
        "bad_request",
        "invalid request body",
        err instanceof Error ? err.message : err,
      ),
      400,
    );
  }

  let auth;
  try {
    auth = await verifySupabaseJwt(parsed.access_token, c.env);
  } catch (err) {
    return c.json(
      errBody(
        "unauthorized",
        "invalid access_token",
        err instanceof Error ? err.message : err,
      ),
      401,
    );
  }

  if (!auth.email) {
    return c.json(errBody("unauthorized", "token missing email claim"), 401);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    await upsertUser(supabase, { id: auth.user_id, email: auth.email });
  } catch (err) {
    const errMsg = err instanceof Error
      ? err.message
      : JSON.stringify(err);
    log.error("user_upsert_failed", {
      err: errMsg,
      user_id: auth.user_id,
    });
    return c.json(errBody("upstream_error", errMsg), 502);
  }

  let user = await getUserById(supabase, auth.user_id);

  // ── Auto-handle generation ────────────────────────────────────────
  // If the user doesn't have a handle yet, automatically generate and claim one
  if (!user?.handle) {
    const autoHandleResult = await autoGenerateHandle(
      supabase,
      c.env,
      auth.user_id,
      auth.email
    );

    if (autoHandleResult) {
      // Refresh user data after auto-claiming handle
      user = await getUserById(supabase, auth.user_id);
    }
  }

  // ── C-Lite snapshot claim ─────────────────────────────────────────
  // CONVERT-IN-PLACE: if this user already owns a business (the pre-signup /
  // anonymous full-build path — the anon session created a real business, then
  // converted to permanent keeping the SAME uuid), the business already exists
  // and is already theirs. The snapshot-claim is a NO-OP here — never create a
  // duplicate. It still runs for the light path (user has no business yet).
  let claimed_business_slug: string | null = null;
  let existingBusinessCount = 0;
  try { existingBusinessCount = await countUserBusinesses(supabase, auth.user_id); } catch { /* treat as 0 */ }

  if (parsed.snapshot_token && existingBusinessCount > 0) {
    log.info("snapshot_claim_noop_convert_in_place", { user_id: auth.user_id, businesses: existingBusinessCount });
  } else if (parsed.snapshot_token) {
    const raw = await c.env.SNAPSHOT_KV.get(`snapshot:${parsed.snapshot_token}`);
    if (raw) {
      try {
        const { input, snapshot } = JSON.parse(raw) as {
          input: AnonymousInput;
          snapshot: AnonymousSnapshot;
        };
        const slug = slugifyName(snapshot.name);
        const biz = await createBusiness(supabase, {
          user_id: auth.user_id,
          slug,
          name: snapshot.name,
          kind: input.kind === "existing" ? "existing" : input.kind === "find_for_me" ? "find_for_me" : "new_idea",
          existing_business_url: input.url ?? undefined,
          // find_for_me: preserve interests+budget so research-strategy has context.
          // new_idea/existing: preserve description as idea.
          // Without this, find_for_me snapshot claims lost interests → Sonnet generated
          // generic "Venture Clarity"-style placeholder businesses.
          existing_business_data:
            input.kind === "find_for_me"
              ? {
                  interests: input.interests ?? "",
                  ...(input.budget ? { budget: input.budget } : {}),
                }
              : input.description
              ? { idea: input.description }
              : undefined,
        });
        const agentName = await pickAgentName(supabase, auth.user_id);
        log.info("snapshot_claim_agent_assigned", { user_id: auth.user_id, slug, agent_name: agentName });
        await upsertBusinessContext(supabase, {
          business_id: biz.id,
          user_id: auth.user_id,
          agent_name: agentName,
          business_summary: snapshot.summary,
          industry: snapshot.industry,
          target_customer: snapshot.target_customer,
          value_proposition: snapshot.value_proposition,
          competitors: snapshot.competitors,
          positioning_statement: snapshot.positioning,
          brand_voice: snapshot.brand_voice,
          key_differentiators: snapshot.key_differentiators,
          research_confidence_score: 60,
          last_research_run_at: new Date().toISOString(),
        });
        // One-time-use: delete token so it can't be claimed twice
        await c.env.SNAPSHOT_KV.delete(`snapshot:${parsed.snapshot_token}`);

        // Analytics: mark snapshot as claimed. IS NULL guard is idempotent —
        // double-clicking a magic link won't overwrite the first-click timestamp.
        try {
          await supabase
            .from("anonymous_snapshots")
            .update({
              claimed_at: new Date().toISOString(),
              claimed_user_id: auth.user_id,
              claimed_business_id: biz.id,
            })
            .eq("token", parsed.snapshot_token)
            .is("claimed_at", null);
        } catch (e) { log.warn("snapshot_claim_analytics_update_failed", { err: String(e) }); }

        claimed_business_slug = slug;
        log.info("snapshot_claimed", { user_id: auth.user_id, slug, name: snapshot.name });
      } catch (err) {
        // Non-fatal — user still signs in successfully; business just isn't pre-seeded
        log.warn("snapshot_claim_failed", { err: String(err) });
      }
    }
  }

  return c.json({
    user_id: auth.user_id,
    email: auth.email,
    has_handle: Boolean(user?.handle),
    handle: user?.handle ?? null,
    handle_confirmed: Boolean(user?.handle_confirmed_at),
    // Pre-fill suggestion for the handle picker: existing handle takes priority,
    // then email prefix. Frontend shows this as an editable default, not a locked value.
    suggested_handle: user?.handle ?? suggestHandleFromEmail(auth.email),
    claimed_business_slug,
  });
});

// ── POST /anon-init ───────────────────────────────────────────────────────────
// Provision the public.users row for a freshly-minted ANONYMOUS session so it can
// own a real business and run the full pre-signup build (the FKs need the row).
// Public (no requireAuth): the caller presents its anon access_token in the body;
// we verify it. Per-IP rate-limited (a full anon build is ~$1). email is null for
// an anon user — set for real on register (convert-in-place keeps the same uuid).
const AnonInitBody = z.object({ access_token: z.string().min(1) });

app.post("/anon-init", async (c) => {
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";

  let parsed;
  try {
    parsed = AnonInitBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : err), 400);
  }

  let auth;
  try {
    auth = await verifySupabaseJwt(parsed.access_token, c.env);
  } catch (err) {
    return c.json(errBody("unauthorized", "invalid access_token", err instanceof Error ? err.message : err), 401);
  }

  // Per-IP guard: cap how many anon sessions one IP can spin up per window.
  // Same env-gated ?letmein test bypass as the snapshot limiter.
  const bypass =
    new URL(c.req.url).searchParams.has("letmein") &&
    c.env.LETMEIN_BYPASS_ENABLED === "true";
  if (!bypass) {
    const ipGate = await checkAnonIpLimit(c.env, ip);
    if (!ipGate.allowed) {
      return c.json(errBody("rate_limited", "Too many anonymous sessions — try again later"), 429);
    }
  }

  const supabase = createSupabaseClient(c.env);
  try {
    // email is null for anon; migration 078 permits it. Idempotent.
    await upsertUser(supabase, { id: auth.user_id, email: auth.email ?? null });
  } catch (err) {
    // Log full detail server-side; return a generic message so DB internals
    // (constraint names, etc.) don't leak to the public caller.
    const detail =
      err && typeof err === "object"
        ? JSON.stringify(err, Object.getOwnPropertyNames(err))
        : String(err);
    log.error("anon_init_upsert_failed", { user_id: auth.user_id, err: detail });
    return c.json(errBody("upstream_error", "could not provision anonymous session"), 502);
  }

  log.info("anon_init_provisioned", { user_id: auth.user_id, has_email: Boolean(auth.email) });
  return c.json({ ok: true, user_id: auth.user_id, is_anonymous: !auth.email });
});

export default app;

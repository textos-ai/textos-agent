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
} from "../services/supabase";
import type { AnonymousSnapshot, AnonymousInput } from "../lib/anonymous-research";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { pickAgentName } from "../lib/agentNames";

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
    log.error("user_upsert_failed", {
      err: String(err),
      user_id: auth.user_id,
    });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  const user = await getUserById(supabase, auth.user_id);

  // ── C-Lite snapshot claim ─────────────────────────────────────────
  let claimed_business_slug: string | null = null;
  if (parsed.snapshot_token) {
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
          existing_business_data: input.description ? { idea: input.description } : undefined,
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
        // Store raw snapshot as a business_asset so the builder can render it immediately
        await supabase.from("business_assets").insert({
          business_id: biz.id,
          asset_type: "research_snapshot",
          asset_subtype: "anonymous",
          asset_data: { snapshot, input },
          is_current: true,
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
        log.info("snapshot_claimed", { user_id: auth.user_id, slug });
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

export default app;

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { verifySupabaseJwt } from "../lib/jwt";
import {
  createSupabaseClient,
  upsertUser,
  getUserById,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

const CallbackBody = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  type: z.enum(["signup", "recovery", "magiclink"]).optional(),
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

  return c.json({
    user_id: auth.user_id,
    email: auth.email,
    has_handle: Boolean(user?.handle),
    handle: user?.handle ?? null,
  });
});

export default app;

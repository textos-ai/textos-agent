import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  isHandleAvailable,
  setUserHandle,
  upsertUser,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

// 3-30 chars, lowercase alphanumeric + hyphens, must start AND end with alphanumeric.
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "www",
  "mail",
  "support",
  "billing",
  "help",
  "docs",
  "status",
  "blog",
  "system",
  "root",
  "public",
]);

const HandleBody = z.object({
  handle: z.string().min(3).max(30),
});

app.use("*", requireAuth);

app.post("/", async (c) => {
  let parsed;
  try {
    parsed = HandleBody.parse(await c.req.json());
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

  const handle = parsed.handle.toLowerCase().trim();

  if (!HANDLE_REGEX.test(handle)) {
    return c.json(
      errBody(
        "bad_request",
        "handle must be 3-30 chars, lowercase alphanumeric and hyphens, start and end with alphanumeric",
      ),
      400,
    );
  }

  if (RESERVED.has(handle)) {
    return c.json(errBody("bad_request", "that handle is reserved"), 400);
  }

  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  // Make sure the public.users row exists in case /auth/callback hasn't run.
  try {
    await upsertUser(supabase, { id: auth.user_id, email: auth.email });
  } catch (err) {
    log.error("user_upsert_failed_in_handles", {
      err: String(err),
      user_id: auth.user_id,
    });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  let available;
  try {
    available = await isHandleAvailable(supabase, handle);
  } catch (err) {
    log.error("handle_availability_check_failed", {
      err: String(err),
      handle,
    });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  if (!available) {
    return c.json(errBody("conflict", "that handle is taken"), 409);
  }

  // Reserve in DB. The unique index on users.handle racy-protects against
  // concurrent claims — a second writer hits a unique-violation error here.
  try {
    await setUserHandle(supabase, auth.user_id, handle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Postgres unique-violation surfaces as code 23505; supabase-js wraps it.
    const isUniqueViolation = msg.toLowerCase().includes("duplicate") || msg.includes("23505");
    if (isUniqueViolation) {
      return c.json(errBody("conflict", "that handle was just taken"), 409);
    }
    log.error("handle_reserve_failed", {
      err: msg,
      user_id: auth.user_id,
      handle,
    });
    return c.json(errBody("upstream_error", msg), 502);
  }

  // A handle is a username only — it has no public page or URL.
  return c.json({
    handle,
    user_id: auth.user_id,
  });
});

export default app;

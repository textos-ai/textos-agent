import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { errBody } from "./errors";
import { createSupabaseClient } from "../services/supabase";

/**
 * Hono middleware: require the authenticated user to have users.is_admin = true.
 *
 * Migrated 2026-05-14 from the legacy admin_users table to a single source of
 * truth on users.is_admin. The admin_users table is dropped post-deploy.
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const auth = c.get("auth");
  if (!auth?.user_id) {
    return c.json(errBody("unauthorized", "missing auth context"), 401);
  }

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("users")
    .select("is_admin")
    .eq("id", auth.user_id)
    .maybeSingle();

  if (error) {
    return c.json(errBody("upstream_error", error.message), 502);
  }
  if (!data?.is_admin) {
    return c.json(errBody("forbidden", "admin access required"), 403);
  }

  return next();
};

import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { errBody } from "./errors";
import { createSupabaseClient } from "../services/supabase";

/** Hono middleware: require the authenticated user to be in admin_users table. */
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
    .from("admin_users")
    .select("user_id")
    .eq("user_id", auth.user_id)
    .maybeSingle();

  if (error) {
    return c.json(errBody("upstream_error", error.message), 502);
  }
  if (!data) {
    return c.json(errBody("forbidden", "admin access required"), 403);
  }

  return next();
};

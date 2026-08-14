// =============================================================
// Cold-call module auth gate.
//
// Structural clone of requireAdmin (src/lib/admin.ts) with a different
// lookup: membership in coldcall_callers IS the role. There is no separate
// roles table and NO reuse of users.is_admin — gating on is_admin would hand
// callers the entire platform admin surface (prompts, models, users, tasks).
//
// SECURITY BOUNDARY. The frontend gate on /coldcall is cosmetic — exactly as
// it is for /admin today. The page HTML is publicly fetchable; only the API
// response is protected. Because coldcall_leads holds third-party prospect
// PII (names, phone numbers, addresses), THIS middleware plus deny-by-default
// RLS on the coldcall_* tables is the actual security boundary. Do not weaken
// either one on the assumption that the hidden page is doing any work.
// =============================================================

import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { errBody } from "./errors";
import { log } from "./logger";
import { createSupabaseClient } from "../services/supabase";

export interface ColdcallerContext {
  id: string;
  email: string;
  name: string | null;
}

declare module "hono" {
  interface ContextVariableMap {
    coldcaller: ColdcallerContext;
  }
}

/**
 * Hono middleware: require the authenticated user to be an active row in
 * coldcall_callers, matched on user_id OR email. Run AFTER requireAuth.
 *
 * Access is normally granted from /admin/users, which sets both columns at
 * once. The email fallback covers a row that was created before it could be
 * linked; user_id is backfilled here on first authenticated request.
 */
export const requireColdcaller: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const auth = c.get("auth");
  if (!auth?.user_id) {
    return c.json(errBody("unauthorized", "missing auth context"), 401);
  }
  // No-fallbacks: the allowlist is keyed on email. A token without an email
  // claim cannot be matched against it — fail loudly rather than letting an
  // empty string match an empty-string row.
  if (!auth.email) {
    return c.json(errBody("forbidden", "token has no email claim"), 403);
  }

  const email = auth.email.toLowerCase();
  const supabase = createSupabaseClient(c.env);

  type CallerRow = {
    id: string;
    email: string;
    name: string | null;
    user_id: string | null;
    active: boolean;
  };
  const COLS = "id, email, name, user_id, active";

  // Match on user_id FIRST, then fall back to email. Two queries rather than a
  // PostgREST `.or()` string so no user-controlled value is ever interpolated
  // into a filter expression.
  //
  // The user_id match is what keeps access alive when someone changes their
  // Victora email: once the row is linked, the stored email can go stale
  // without silently locking them out. The email match is what lets access be
  // granted before the row has ever been linked.
  const byId = await supabase
    .from("coldcall_callers")
    .select(COLS)
    .eq("user_id", auth.user_id)
    .maybeSingle();
  if (byId.error) {
    return c.json(errBody("upstream_error", byId.error.message), 502);
  }

  let caller = byId.data as CallerRow | null;

  if (!caller) {
    const byEmail = await supabase
      .from("coldcall_callers")
      .select(COLS)
      .eq("email", email)
      .maybeSingle();
    if (byEmail.error) {
      return c.json(errBody("upstream_error", byEmail.error.message), 502);
    }
    caller = byEmail.data as CallerRow | null;
  }

  if (!caller || !caller.active) {
    return c.json(errBody("forbidden", "coldcall access required"), 403);
  }

  // Backfill on first authenticated request. Best-effort: a failure here must
  // not deny access, because user_id is a marker and not a gate.
  if (!caller.user_id) {
    const { error: linkErr } = await supabase
      .from("coldcall_callers")
      .update({ user_id: auth.user_id })
      .eq("id", caller.id);
    if (linkErr) {
      log.error("[coldcall] user_id_backfill_failed", {
        caller_id: caller.id,
        err: linkErr.message,
      });
    }
  }

  c.set("coldcaller", { id: caller.id, email: caller.email, name: caller.name });
  return next();
};

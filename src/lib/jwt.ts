import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { Env } from "../env";
import { errBody } from "./errors";

export interface AuthContext {
  user_id: string;
  email: string;
}

// Tell Hono that c.set("auth", ...) / c.get("auth") is typed as AuthContext.
declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Hono middleware that verifies a Supabase-issued JWT in the
 * `Authorization: Bearer <jwt>` header and exposes `{user_id, email}`
 * via `c.get("auth")`.
 *
 * Returns 401 if the header is missing/malformed or the JWT fails
 * signature/claim verification.
 *
 * Supabase JWTs are HS256 with the project JWT secret as the symmetric
 * key. `hono/jwt`'s `verify` defaults to HS256 + checks `exp`.
 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const header =
    c.req.header("Authorization") ?? c.req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return c.json(errBody("unauthorized", "missing bearer token"), 401);
  }
  const token = header.slice(7).trim();
  if (!token) {
    return c.json(errBody("unauthorized", "empty bearer token"), 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await verify(
      token,
      c.env.SUPABASE_JWT_SECRET,
      "HS256",
    )) as Record<string, unknown>;
  } catch (err) {
    return c.json(
      errBody(
        "unauthorized",
        "invalid token",
        err instanceof Error ? err.message : err,
      ),
      401,
    );
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub) {
    return c.json(errBody("unauthorized", "token missing sub claim"), 401);
  }

  c.set("auth", { user_id: sub, email });
  return next();
};

/** Verify a token without the middleware shape — used by /auth/callback. */
export async function verifySupabaseJwt(
  token: string,
  secret: string,
): Promise<AuthContext> {
  const payload = (await verify(token, secret, "HS256")) as Record<
    string,
    unknown
  >;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub) throw new Error("token missing sub claim");
  return { user_id: sub, email };
}

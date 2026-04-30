import type { MiddlewareHandler } from "hono";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
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

/*
 * Supabase signs user JWTs with ES256 against an EC P-256 key whose
 * public half lives at:
 *   <SUPABASE_URL>/auth/v1/.well-known/jwks.json
 *
 * `jose`'s createRemoteJWKSet returns a function that resolves the
 * right key by `kid` header on every verify call, with internal
 * caching + automatic refetch on rotation. We memoize the factory
 * itself across requests within the same Worker isolate.
 */
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(env: Env) {
  if (_jwks) return _jwks;
  const url = new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  _jwks = createRemoteJWKSet(url, {
    // Min ms between fetch retries on a key miss (e.g., new kid seen).
    cooldownDuration: 30_000,
    // Refetch keys at most this often even if no miss has occurred.
    cacheMaxAge: 600_000, // 10 minutes
  });
  return _jwks;
}

async function verifyAndExtract(
  token: string,
  env: Env,
): Promise<AuthContext> {
  const { payload }: { payload: JWTPayload } = await jwtVerify(
    token,
    getJwks(env),
    { algorithms: ["ES256"] },
  );
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub) throw new Error("token missing sub claim");
  return { user_id: sub, email };
}

/** Hono middleware: require + verify an Authorization: Bearer <jwt> header. */
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

  let auth: AuthContext;
  try {
    auth = await verifyAndExtract(token, c.env);
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

  c.set("auth", auth);
  return next();
};

/** Verify a token outside the middleware shape — used by /auth/callback. */
export async function verifySupabaseJwt(
  token: string,
  env: Env,
): Promise<AuthContext> {
  return verifyAndExtract(token, env);
}

// Auth adapters for the external-retrieval engine.
//
// The ONLY non-config residue: a small library keyed by external_apis.auth_kind.
// A new platform on an existing auth shape = zero code (just an external_apis
// row). A genuinely new auth shape = one new adapter here, written once and
// reused by every platform that shares it.
//
// Adapters contain NO platform names, NO endpoints, NO secrets — every host,
// token URL, header name and secret env-var NAME comes from config (the
// external_apis row's metadata.auth). Secret VALUES are read from env by the
// name the config supplies; they never live in the DB.

import type { Env } from "../../env";
import type { StreamEvent } from "../stream-events";

/** A fetch-ready request produced by rendering metadata.request. */
export interface RenderedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface AuthConfig {
  /** Token-exchange endpoint (for session/oauth shapes). From config. */
  token_url?: string;
  /** Where an api key goes: "query" | "header". From config. */
  in?: string;
  /** Query-param or header name for an api key. From config. */
  name?: string;
  /** Map of logical secret -> env-var NAME (value stays in env). */
  env?: Record<string, string>;
}

export interface AdapterCtx {
  request: RenderedRequest;
  /** Resolved secret VALUES, keyed by the logical names in AuthConfig.env. */
  secrets: Record<string, string>;
  authConfig: AuthConfig;
  env: Env;
  kv: KVNamespace;
  emit?: (evt: StreamEvent) => Promise<void>;
}

export interface AuthAdapter {
  kind: string;
  prepare(ctx: AdapterCtx): Promise<RenderedRequest>;
}

// ── api_key_get: inject a key into a query param or a header ──────────────────
const apiKeyGet: AuthAdapter = {
  kind: "api_key_get",
  async prepare({ request, secrets, authConfig }) {
    const key = secrets.key;
    if (!key) throw new Error("adapter_api_key_get: missing secret 'key'");
    if (authConfig.in === "header") {
      const name = authConfig.name || "Authorization";
      return { ...request, headers: { ...request.headers, [name]: key } };
    }
    const u = new URL(request.url);
    u.searchParams.set(authConfig.name || "key", key);
    return { ...request, url: u.toString() };
  },
};

// ── session-token exchange (e.g. AT Protocol app-password login) ──────────────
// POSTs { identifier, password } to the configured token_url, caches the
// returned bearer, and attaches it. Host/token_url are config, not code.
const sessionTokenBearer: AuthAdapter = {
  kind: "atproto_session",
  async prepare({ request, secrets, authConfig, kv }) {
    const tokenUrl = authConfig.token_url;
    if (!tokenUrl) throw new Error("adapter_atproto_session: missing authConfig.token_url");
    if (!secrets.identifier || !secrets.app_password) {
      throw new Error("adapter_atproto_session: missing 'identifier'/'app_password' secrets");
    }
    const cacheKey = `session-jwt:${secrets.identifier}`;
    let jwt = await kv.get(cacheKey);
    if (!jwt) {
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: secrets.identifier,
          password: secrets.app_password,
        }),
      });
      if (!res.ok) {
        throw new Error(`adapter_atproto_session: login failed ${res.status}`);
      }
      const j = (await res.json()) as { accessJwt?: string };
      if (!j.accessJwt) throw new Error("adapter_atproto_session: no accessJwt in response");
      jwt = j.accessJwt;
      // Access JWTs are short-lived (~2h); refresh well before expiry.
      await kv.put(cacheKey, jwt, { expirationTtl: 3600 });
    }
    return {
      ...request,
      headers: { ...request.headers, Authorization: `Bearer ${jwt}` },
    };
  },
};

const REGISTRY: Record<string, AuthAdapter> = {
  [apiKeyGet.kind]: apiKeyGet,
  [sessionTokenBearer.kind]: sessionTokenBearer,
};

/** Look up an adapter by auth_kind. Loud failure on an unregistered kind. */
export function getAuthAdapter(authKind: string): AuthAdapter {
  const a = REGISTRY[authKind];
  if (!a) throw new Error(`retrieval_unknown_auth_kind: '${authKind}'`);
  return a;
}

/** Resolve secret VALUES from env using the config's logical->envVarName map. */
export function resolveSecrets(
  env: Env,
  envMap: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!envMap) return out;
  for (const [logical, envVarName] of Object.entries(envMap)) {
    const val = (env as unknown as Record<string, string | undefined>)[envVarName];
    if (val == null || val === "") {
      throw new Error(`retrieval_missing_secret: env var '${envVarName}' is not set`);
    }
    out[logical] = val;
  }
  return out;
}

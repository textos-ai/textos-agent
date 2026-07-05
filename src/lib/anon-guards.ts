/**
 * Guardrails for the anonymous pre-signup build (Stage 1).
 *
 * A full anon build is ~$1 (not the ~4¢ of a snapshot), so anonymous entry is
 * bounded two ways and results are cached by domain — all on the existing
 * SNAPSHOT_KV surface (same store the C-Lite snapshot flow uses).
 *
 *   - per-IP cap      : how many anon sessions/builds one IP can start per window
 *   - per-session cap : how many builds one anon session can start
 *   - per-domain cache : normalize the domain and reuse a prior build result
 */
import type { Env } from "../env";

export interface LimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/** Read-then-bump a rolling KV counter. `bump:false` only reads (pre-check). */
async function counter(
  env: Env,
  key: string,
  limit: number,
  ttlSeconds: number,
  bump: boolean,
): Promise<LimitResult> {
  const raw = await env.SNAPSHOT_KV.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count, limit };
  if (bump) {
    await env.SNAPSHOT_KV.put(key, String(count + 1), { expirationTtl: ttlSeconds });
  }
  return { allowed: true, count, limit };
}

// Defaults (tune later). Anon sessions per IP per hour; builds per anon session.
export const ANON_IP_LIMIT = 5;
export const ANON_SESSION_BUILD_LIMIT = 2;
export const ANON_TTL = 3600;

/** Per-IP gate for spinning up anon sessions/builds. */
export function checkAnonIpLimit(env: Env, ip: string, bump = true): Promise<LimitResult> {
  return counter(env, `rate:anon-ip:${ip}`, ANON_IP_LIMIT, ANON_TTL, bump);
}

/** Per-anon-session gate for how many builds one session may start. */
export function checkAnonSessionLimit(env: Env, anonUserId: string, bump = true): Promise<LimitResult> {
  return counter(env, `rate:anon-sess:${anonUserId}`, ANON_SESSION_BUILD_LIMIT, ANON_TTL, bump);
}

// Per-task external-call cap: how many retrieval calls one business may make
// through a given task per window. Guards against a task hammering an external
// API. Reused by the external-retrieval runner for any platform.
export const TASK_RETRIEVAL_LIMIT = 20;

export function checkTaskRetrievalLimit(
  env: Env,
  businessId: string,
  taskSlug: string,
  bump = true,
): Promise<LimitResult> {
  return counter(env, `rate:task:${businessId}:${taskSlug}`, TASK_RETRIEVAL_LIMIT, ANON_TTL, bump);
}

// ── Per-domain build cache ───────────────────────────────────────────────────

/** Normalize a URL/host to a bare, lowercased registrable-ish domain key. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = "https://" + s;
  try {
    const host = new URL(s).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

const CACHE_TTL = 86400; // 24h — a site's scan is stable enough for a day

export async function getCachedBuild<T = unknown>(env: Env, domain: string): Promise<T | null> {
  const raw = await env.SNAPSHOT_KV.get(`build:${domain}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function putCachedBuild(env: Env, domain: string, data: unknown, ttl = CACHE_TTL): Promise<void> {
  await env.SNAPSHOT_KV.put(`build:${domain}`, JSON.stringify(data), { expirationTtl: ttl });
}

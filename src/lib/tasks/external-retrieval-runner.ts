// The External-Retrieval runner — the generic dispatcher the task system was
// shaped for (migration 031: external_apis carries endpoint_url/auth_kind/
// metadata; task_apis binds a task to it). Selected by output_type='retrieval'.
//
// It reads the task's PRIMARY task_apis -> external_apis binding and executes
// the call entirely from config: renders metadata.request, runs the auth
// adapter keyed by auth_kind, fetches, maps the payload via response_map into
// canonical leads, and upserts them. There is NO platform name anywhere in this
// file — adding a platform is an external_apis row, not code.

import type { TaskCtx, TaskResult } from "./types";
import type { TaskRow } from "../../services/supabase";
import { renderPrompt } from "./generic-document-runner";
import {
  applyResponseMap,
  type ResponseMapSpec,
} from "../retrieval/response-map";
import {
  getAuthAdapter,
  resolveSecrets,
  type AuthConfig,
  type RenderedRequest,
} from "../retrieval/adapters";
import { checkTaskRetrievalLimit } from "../anon-guards";

interface RetrievalRequestSpec {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

interface RetrievalMeta {
  request: RetrievalRequestSpec;
  response_map: ResponseMapSpec;
  auth?: AuthConfig;
}

interface BoundApi {
  slug: string;
  provider: string;
  endpoint_url: string | null;
  auth_kind: string;
  metadata: RetrievalMeta;
}

/** Small stable hash for cache keys (djb2). */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Render metadata.request into a fetch-ready request (no auth yet). */
function renderRequest(
  endpointUrl: string,
  spec: RetrievalRequestSpec,
  vars: { business: unknown; ctx: unknown; user: unknown; config: unknown },
): { req: RenderedRequest; displayQuery: string } {
  const u = new URL(endpointUrl);
  let displayQuery = "";
  for (const [k, tpl] of Object.entries(spec.query ?? {})) {
    const val = renderPrompt(tpl, vars as never).trim();
    if (val) u.searchParams.set(k, val);
    if (k === "q" || k === "query") displayQuery = val;
  }
  const headers: Record<string, string> = {};
  for (const [k, tpl] of Object.entries(spec.headers ?? {})) {
    headers[k] = renderPrompt(tpl, vars as never);
  }
  const body = spec.body ? renderPrompt(spec.body, vars as never) : undefined;
  return {
    req: { method: (spec.method || "GET").toUpperCase(), url: u.toString(), headers, body },
    displayQuery,
  };
}

export async function runExternalRetrieval(
  tc: TaskCtx,
  task: TaskRow,
): Promise<TaskResult> {
  const { supabase, env, business, ctx, user, emit, taskRunId } = tc;

  // 1. Resolve the primary external_apis binding for this task.
  const bindingRes = await supabase
    .from("task_apis")
    .select("external_apis(slug, provider, endpoint_url, auth_kind, metadata)")
    .eq("task_id", task.id)
    .eq("role", "primary")
    .limit(1)
    .maybeSingle();
  if (bindingRes.error) {
    throw new Error(`retrieval_binding_lookup_failed: ${bindingRes.error.message}`);
  }
  const api = (bindingRes.data as { external_apis?: BoundApi } | null)?.external_apis;
  if (!api || !api.endpoint_url) {
    throw new Error(
      `retrieval_no_binding: task '${task.slug}' has no primary external_apis row with an endpoint_url`,
    );
  }
  const meta = api.metadata;
  if (!meta?.request || !meta?.response_map) {
    throw new Error(`retrieval_bad_config: external_apis '${api.slug}' missing request/response_map`);
  }

  // 2. Per-task rate limit (reuses the KV counter). Loud-skip, never crash.
  const gate = await checkTaskRetrievalLimit(env, business.id, task.slug);
  if (!gate.allowed) {
    await emit({
      type: "cmd",
      text: `Retrieval rate limit reached for '${task.slug}' (${gate.count}/${gate.limit}) — skipping`,
      ts: Date.now(),
    });
    return { output_data: { source: api.provider, found: 0, inserted: 0, skipped: "rate_limited" } };
  }

  // 3. Render the request from config.
  const { req, displayQuery } = renderRequest(api.endpoint_url, meta.request, {
    business,
    ctx,
    user,
    config: tc.config ?? {},
  });
  await emit({
    type: "cmd",
    text: `Searching ${api.provider} for: "${displayQuery || "(query)"}"`,
    ts: Date.now(),
  });

  // 4. Cache (per rendered request). Freshness-sensitive → short TTL.
  const cacheKey = `retr:${api.slug}:${hashKey(req.url + (req.body ?? ""))}`;
  let payload: unknown = null;
  const cached = await env.SNAPSHOT_KV.get(cacheKey);
  if (cached) {
    try { payload = JSON.parse(cached); } catch { payload = null; }
  }

  // 5. Auth adapter + fetch (only on cache miss).
  if (payload == null) {
    const adapter = getAuthAdapter(api.auth_kind);
    const secrets = resolveSecrets(env, meta.auth?.env);
    const finalReq = await adapter.prepare({
      request: req,
      secrets,
      authConfig: meta.auth ?? {},
      env,
      kv: env.SNAPSHOT_KV,
      emit,
    });
    const res = await fetch(finalReq.url, {
      method: finalReq.method,
      headers: finalReq.headers,
      body: finalReq.method === "GET" ? undefined : finalReq.body,
    });
    if (!res.ok) {
      throw new Error(`retrieval_fetch_failed: ${api.slug} returned ${res.status}`);
    }
    payload = await res.json();
    await env.SNAPSHOT_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 6 * 3600 });
  }

  // 6. Map payload -> canonical leads (pure config).
  const items = applyResponseMap(payload, meta.response_map, api.provider);

  // 7. Upsert into leads (dedup on business_id+source+external_id).
  let inserted = 0;
  for (const it of items) {
    if (!it.url || !it.external_id) continue;
    const up = await supabase.from("connection_leads").upsert(
      {
        business_id: business.id,
        source: it.source,
        external_id: it.external_id,
        url: it.url,
        title: it.title,
        snippet: it.snippet,
        published_at: it.published_at,
        status: "found",
        task_run_id: taskRunId,
      },
      { onConflict: "business_id,source,external_id", ignoreDuplicates: true },
    );
    if (!up.error) inserted++;
  }

  await emit({
    type: "cmd",
    text: `Found ${items.length} result(s) from ${api.provider} (${inserted} stored)`,
    ts: Date.now(),
  });

  return { output_data: { source: api.provider, found: items.length, inserted } };
}

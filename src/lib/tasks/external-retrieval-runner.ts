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
): { req: RenderedRequest; displayQuery: string; emptyQuery: boolean } {
  const u = new URL(endpointUrl);
  let displayQuery = "";
  // A query param literally named q/query is the search term. If the template
  // declares one but it renders empty, that is a no-silent-fallback failure —
  // flag it so the runner HALTS instead of searching nothing and reporting 0.
  let hasQueryParam = false;
  let emptyQuery = false;
  for (const [k, tpl] of Object.entries(spec.query ?? {})) {
    const val = renderPrompt(tpl, vars as never).trim();
    if (val) u.searchParams.set(k, val);
    if (k === "q" || k === "query") {
      hasQueryParam = true;
      displayQuery = val;
      if (!val) emptyQuery = true;
    }
  }
  if (!hasQueryParam) emptyQuery = false;
  const headers: Record<string, string> = {};
  for (const [k, tpl] of Object.entries(spec.headers ?? {})) {
    headers[k] = renderPrompt(tpl, vars as never);
  }
  const body = spec.body ? renderPrompt(spec.body, vars as never) : undefined;
  return {
    req: { method: (spec.method || "GET").toUpperCase(), url: u.toString(), headers, body },
    displayQuery,
    emptyQuery,
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
  const { req, displayQuery, emptyQuery } = renderRequest(api.endpoint_url, meta.request, {
    business,
    ctx,
    user,
    config: tc.config ?? {},
  });
  // No-silent-fallback: a required search term that renders empty HALTS the run
  // (loud) instead of calling the API with no query and reporting found:0 as a
  // success. Queries must originate from stored context (derive-search-queries).
  if (emptyQuery) {
    throw new Error(
      `retrieval_empty_query: task '${task.slug}' resolved an empty search phrase — ` +
      `queries must come from derived customer context, not an empty/absent config.query.`,
    );
  }
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
    // Bounded fetch — a dead or hanging upstream must NOT ride the full 15-min
    // consumer budget. A missing/invalid API key can hang the connection open
    // (this is exactly what a missing SOCIALCRAWL_API_KEY did on prod: a silent
    // 15-min freeze in 'searching'). Abort at 25s and SOFT-SKIP (same as a
    // rate-limit) so the pipeline continues to verify/enrich on what it has and
    // the UI shows a real "search timed out" note instead of freezing.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);
    let res: Response;
    try {
      res = await fetch(finalReq.url, {
        method: finalReq.method,
        headers: finalReq.headers,
        body: finalReq.method === "GET" ? undefined : finalReq.body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      await emit({
        type: "cmd",
        text: aborted
          ? `${api.provider} search timed out (25s) — skipping this search`
          : `${api.provider} search couldn't connect — skipping this search`,
        ts: Date.now(),
      });
      return { output_data: { source: api.provider, found: 0, inserted: 0, skipped: "search_timeout" } };
    } finally {
      clearTimeout(timeoutId);
    }
    // Credit exhaustion (402 Payment Required) is a HARD stop, distinct from a
    // rate limit: retrying won't help until credits are topped up. Return a
    // 'no_credits' signal (not a throw, so the run finishes cleanly instead of
    // retry-looping) — the caller stops searching and the UI says so plainly.
    if (res.status === 402) {
      await emit({
        type: "cmd",
        text: `${api.provider} search credits are used up — stopping`,
        ts: Date.now(),
      });
      return { output_data: { source: api.provider, found: 0, inserted: 0, skipped: "no_credits" } };
    }
    // Upstream rate-limit (429) / temporary unavailability (503) is a SOFT-SKIP,
    // never a crash — one busy platform must not fail a multi-platform run. Same
    // shape the internal rate limiter returns; the run completes on what it fetched.
    if (res.status === 429 || res.status === 503) {
      await emit({
        type: "cmd",
        text: `${api.provider} is busy (${res.status}) — skipping this search`,
        ts: Date.now(),
      });
      return { output_data: { source: api.provider, found: 0, inserted: 0, skipped: "rate_limited" } };
    }
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
    // Capture author identity at find-time into the metadata bag (migration
    // 086). Only set when the response_map produced one — otherwise leave {}
    // so downstream stages read it as "not captured". Safe against enrichment:
    // the upsert ignoreDuplicates, so re-finding an already-enriched lead is a
    // no-op and never clobbers metadata.alignment_read / reach_package.
    const authorMeta: Record<string, string> = {};
    if (it.author) authorMeta.author = it.author;
    if (it.author_url) authorMeta.author_url = it.author_url;
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
        metadata: Object.keys(authorMeta).length ? authorMeta : {},
      },
      { onConflict: "business_id,source,external_id", ignoreDuplicates: true },
    );
    if (!up.error) inserted++;
  }

  // Surface remaining credits (from the provider's envelope) so it's visible in
  // the run log / API before the next run — a heads-up before credits hit zero.
  const credits_remaining =
    typeof (payload as { credits_remaining?: number })?.credits_remaining === "number"
      ? (payload as { credits_remaining: number }).credits_remaining
      : null;
  const credits_used =
    typeof (payload as { credits_used?: number })?.credits_used === "number"
      ? (payload as { credits_used: number }).credits_used
      : 0;

  await emit({
    type: "cmd",
    text: `Found ${items.length} result(s) from ${api.provider} (${inserted} stored)`,
    ts: Date.now(),
  });

  return { output_data: { source: api.provider, found: items.length, inserted, credits_remaining, credits_used } };
}

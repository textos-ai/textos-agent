// =============================================================
// Leads — the in-product CRM page's API (configured task 'leads',
// config_page_path=/business/{slug}/leads). Read-mostly:
//   GET  /:slug/leads            list enriched leads + pool counts + the latest
//                                lead_search_queries (Search Intelligence panel)
//   POST /:slug/leads/find       one-click pipeline for the empty state — enqueue
//                                'find-my-customers' on the Task Queue (15-min
//                                budget). Thin profile fails loud downstream.
// Authed, scoped to the caller's own business. Mirrors the configured-page
// pattern used by routes/customer-understanding.ts.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { errBody } from "../lib/errors";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getTaskBySlug,
} from "../services/supabase";
import { LEAD_FINDER_SLUGS } from "../lib/tasks/lead-finders";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

const LEAD_COLS =
  "id, source, external_id, url, title, snippet, published_at, match_reason, " +
  "match_score, drafted_message, status, metadata, created_at";

// ── GET /:slug/leads ───────────────────────────────────────────────────────
// Query params: status (default 'drafted'), source, reach ('strong'|'weak').
app.get("/:slug/leads", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("internal", "business_lookup_failed", String(err)), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  // Pool scan — powers header counts, the "why" summary, the funnel, and the
  // per-stage progress counts. Pulls the fields the transparency panel needs.
  const { data: allRows, error: allErr } = await supabase
    .from("connection_leads")
    .select("status, match_reason, source, match_score, published_at, metadata")
    .eq("business_id", business.id);
  if (allErr) {
    log.error("[leads] counts_failed", { business_id: business.id, err: allErr.message });
    return c.json(errBody("internal", "leads_counts_failed"), 500);
  }
  type PoolRow = {
    status: string; match_reason: string | null; source: string | null;
    match_score: number | null; published_at: string | null;
    metadata: { author?: string; alignment_read?: unknown; reach_package?: unknown } | null;
  };
  const pool = (allRows ?? []) as PoolRow[];
  const counts: Record<string, number> = {};
  for (const r of pool) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const total = pool.length;

  // Platforms actually searched — distinct connection_leads.source with counts.
  const bySource: Record<string, number> = {};
  for (const r of pool) if (r.source) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const platforms = Object.entries(bySource)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  // Classify rejections. Stale reason is dynamic ("stale (>180d)") so match by
  // prefix; dead-link is exact; everything else is an LLM off-target reason.
  const reject = { stale: 0, dead_link: 0, off_target: 0 };
  const staleDates: string[] = [];
  const offScores: number[] = [];
  for (const r of pool) {
    if (r.status !== "rejected") continue;
    if (r.match_reason && r.match_reason.startsWith("stale")) { reject.stale++; if (r.published_at) staleDates.push(r.published_at); }
    else if (r.match_reason === "dead_link") reject.dead_link++;
    else { reject.off_target++; if (typeof r.match_score === "number") offScores.push(r.match_score); }
  }
  const rejTotal = reject.stale + reject.dead_link + reject.off_target;
  const dominant_rejection = rejTotal === 0 ? null
    : (Object.entries(reject).sort((a, b) => b[1] - a[1])[0][0] as "stale" | "dead_link" | "off_target");

  // "Wrong pond" signal: of the leads that actually reached the LLM match stage
  // (off-target + verified + drafted — stale/dead-link were rejected BEFORE
  // scoring and never judged for relevance), are ≥70% off-target? If so the
  // platform's fresh conversations aren't this customer, even when stale is
  // numerically higher — stale-and-off-topic shouldn't read as "relevant but old".
  const scored = reject.off_target + (counts["verified"] ?? 0) + (counts["drafted"] ?? 0);
  // Floor: need a meaningful sample (≥5 scored) before calling it the wrong pond,
  // so 2–3 off-target posts don't flip the message on thin evidence.
  const wrong_pond = scored >= 5 && reject.off_target / scored >= 0.70;

  // The funnel: what happened to every conversation we found (transparency panel).
  const kept = (counts["verified"] ?? 0) + (counts["drafted"] ?? 0);
  const contactable = pool.filter((r) => (r.status === "verified" || r.status === "drafted") && r.metadata?.author).length;
  staleDates.sort();
  const funnel = {
    found: total,
    stale: { count: reject.stale, oldest: staleDates[0] ?? null, newest: staleDates[staleDates.length - 1] ?? null },
    off_target: { count: reject.off_target, score_min: offScores.length ? Math.min(...offScores) : null, score_max: offScores.length ? Math.max(...offScores) : null },
    dead_link: reject.dead_link,
    kept,
    contactable,
  };

  // Per-stage progress counts for the live checklist (real pool arithmetic — no
  // baselines needed: 'checked' = everything that has left the 'found' queue).
  const alignment_read = pool.filter((r) => r.metadata?.alignment_read).length;
  const reach_package = pool.filter((r) => r.metadata?.reach_package).length;
  const progress = {
    total,
    found: counts["found"] ?? 0,
    checked: total - (counts["found"] ?? 0),
    verified: counts["verified"] ?? 0,
    drafted: counts["drafted"] ?? 0,
    alignment_read,
    reach_package,
  };

  // The gate rules — read from the DB config (tasks.config) so the panel never
  // drifts from the real verify thresholds. Defaults match the code fallbacks.
  const { data: verifyCfgRow } = await supabase
    .from("tasks").select("config").eq("slug", "match-verify-leads").maybeSingle();
  const vcfg = ((verifyCfgRow as { config?: { freshness_days?: number; match_threshold?: number } } | null)?.config) ?? {};
  const rules = {
    freshness_days: typeof vcfg.freshness_days === "number" ? vcfg.freshness_days : 180,
    match_threshold: typeof vcfg.match_threshold === "number" ? vcfg.match_threshold : 60,
  };

  // Token cost of one Find run — sourced from the find-my-customers task so the
  // "Costs N tokens" label on the card can never drift from what's actually charged.
  const { data: fmcRow } = await supabase
    .from("tasks").select("token_cost").eq("slug", "find-my-customers").maybeSingle();
  const find_token_cost =
    typeof (fmcRow as { token_cost?: number } | null)?.token_cost === "number"
      ? (fmcRow as { token_cost: number }).token_cost
      : 5;

  // The enriched table rows (default status='drafted'), with optional filters.
  const status = c.req.query("status") || "drafted";
  const source = c.req.query("source");
  const reach = c.req.query("reach"); // 'strong' | 'weak'
  let q = supabase
    .from("connection_leads")
    .select(LEAD_COLS)
    .eq("business_id", business.id)
    .eq("status", status)
    .order("match_score", { ascending: false, nullsFirst: false });
  if (source) q = q.eq("source", source);
  if (reach === "strong" || reach === "weak") {
    q = q.eq("metadata->reach_package->>reach_strength", reach);
  }
  const { data: leads, error: leadsErr } = await q;
  if (leadsErr) {
    log.error("[leads] list_failed", { business_id: business.id, err: leadsErr.message });
    return c.json(errBody("internal", "leads_list_failed"), 500);
  }

  // Header stats over the enriched set.
  const enriched = (leads ?? []) as unknown as Array<{
    match_score: number | null;
    metadata?: { reach_package?: { reach_strength?: string } };
  }>;
  const scores = enriched
    .map((l) => l.match_score)
    .filter((s): s is number => typeof s === "number");
  const strengthOf = (l: { metadata?: { reach_package?: { reach_strength?: string } } }) =>
    l.metadata?.reach_package?.reach_strength ?? "";
  const n_strong = enriched.filter((l) => strengthOf(l) === "strong").length;
  const n_weak = enriched.filter((l) => strengthOf(l) === "weak").length;

  // Search Intelligence — latest derivation for this business.
  const { data: search } = await supabase
    .from("lead_search_queries")
    .select("phrases, sources, created_at")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Profile-too-thin detection — did the most recent find/derive run fail because
  // the customer profile wasn't rich enough to search? Drives the "sharpen your
  // profile" guidance even after a reload (when total is still 0).
  let profile_thin = false;
  let rate_limited_platforms: string[] = [];
  let credits_exhausted_platforms: string[] = [];
  let credits_remaining: number | null = null;
  let credits_used: number | null = null;
  let duration_s: number | null = null;
  const { data: pipelineTasks } = await supabase
    .from("tasks").select("id").in("slug", ["find-my-customers", "derive-search-queries"]);
  const pipelineIds = (pipelineTasks ?? []).map((t: { id: string }) => t.id);
  if (pipelineIds.length) {
    const { data: lastRun } = await supabase
      .from("task_runs")
      .select("error, output_data, started_at, completed_at")
      .eq("business_id", business.id)
      .in("task_id", pipelineIds)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lr = lastRun as {
      error?: string; started_at?: string; completed_at?: string;
      output_data?: { rate_limited?: string[]; credits_exhausted?: string[]; credits_remaining?: number | null; credits_used?: number | null };
    } | null;
    profile_thin = typeof lr?.error === "string" && lr.error.includes("customer_profile_too_thin");
    if (Array.isArray(lr?.output_data?.rate_limited)) rate_limited_platforms = lr!.output_data!.rate_limited!;
    if (Array.isArray(lr?.output_data?.credits_exhausted)) credits_exhausted_platforms = lr!.output_data!.credits_exhausted!;
    if (typeof lr?.output_data?.credits_remaining === "number") credits_remaining = lr!.output_data!.credits_remaining!;
    if (typeof lr?.output_data?.credits_used === "number") credits_used = lr!.output_data!.credits_used!;
    if (lr?.started_at && lr?.completed_at) {
      const d = (Date.parse(lr.completed_at) - Date.parse(lr.started_at)) / 1000;
      if (isFinite(d) && d >= 0) duration_s = Math.round(d);
    }
  }

  const source_tier = ((search as { sources?: { source_tier?: string } } | null)?.sources?.source_tier) ?? null;

  // Planned search platforms — the providers of the finders the pipeline runs
  // (LEAD_FINDER_SLUGS → task_apis → external_apis.provider). Names the platform
  // in the meter/chips even before any leads land. Data-driven, not hardcoded.
  const { data: finderTaskRows } = await supabase
    .from("tasks").select("id").in("slug", LEAD_FINDER_SLUGS);
  const finderIds = (finderTaskRows ?? []).map((t: { id: string }) => t.id);
  let search_platforms: string[] = [];
  if (finderIds.length) {
    const { data: binds } = await supabase
      .from("task_apis")
      .select("external_apis(provider)")
      .in("task_id", finderIds)
      .eq("role", "primary");
    search_platforms = [...new Set(
      (binds ?? [])
        .map((b) => (b as { external_apis?: { provider?: string } }).external_apis?.provider)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    )];
  }

  return c.json({
    counts,
    total,
    stats: {
      enriched: enriched.length,
      rejected: counts["rejected"] ?? 0,
      score_min: scores.length ? Math.min(...scores) : null,
      score_max: scores.length ? Math.max(...scores) : null,
      n_strong,
      n_weak,
    },
    // Plain-language "why you got these results" inputs — the page maps these to
    // jargon-free copy. dominant_rejection: what killed most leads when few passed.
    summary: {
      reject_reasons: reject,
      dominant_rejection,
      wrong_pond,
      source_tier,
      profile_thin,
      rate_limited_platforms,
      credits_exhausted_platforms,
      credits_remaining,
    },
    // Transparency: the gate rules (from config), the funnel, live stage counts,
    // and this run's cost/duration — everything the "how these happened" panel shows.
    rules,
    find_token_cost,
    funnel,
    progress,
    run_stats: { credits_used, credits_remaining, duration_s },
    // Platforms: what was actually queried (real, per-source counts) + the
    // planned finder providers (names platforms before leads land).
    platforms,
    search_platforms,
    leads: enriched,
    search: search ?? null,
  });
});

// ── GET /:slug/leads/rejected ──────────────────────────────────────────────
// The audit list — every rejected conversation with its specific reason, so the
// user can check the judgment themselves (transparency panel, loaded on expand).
app.get("/:slug/leads/rejected", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);
  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("internal", "business_lookup_failed", String(err)), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data, error } = await supabase
    .from("connection_leads")
    .select("id, title, url, published_at, match_reason, match_score, source")
    .eq("business_id", business.id)
    .eq("status", "rejected")
    .order("match_score", { ascending: false, nullsFirst: false })
    .order("published_at", { ascending: false })
    .limit(500);
  if (error) {
    log.error("[leads] rejected_list_failed", { business_id: business.id, err: error.message });
    return c.json(errBody("internal", "rejected_list_failed"), 500);
  }
  return c.json({ rejected: data ?? [] });
});

// ── POST /:slug/leads/find ─────────────────────────────────────────────────
// Enqueue the one-click pipeline (find-my-customers) on the Task Queue.
app.post("/:slug/leads/find", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("internal", "business_lookup_failed", String(err)), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const task = await getTaskBySlug(supabase, "find-my-customers");
  if (!task) return c.json(errBody("not_found", "find-my-customers task not found"), 404);

  // Subscription gate — Customers/Leads is a $49-plan feature (find-my-customers
  // is plan_required='core_paid', token_cost=5). This route enqueues the pipeline
  // DIRECTLY, bypassing the standard run route where the gate normally lives, so
  // we enforce it HERE. Fail closed: no active/trialing subscription → 403 before
  // we enqueue. Without this, a non-subscriber runs the whole pipeline (LLM +
  // SocialCrawl credits) and only fails at the post-run token debit — wasteful.
  const { data: subRow } = await supabase
    .from("business_subscriptions")
    .select("status")
    .eq("business_id", business.id)
    .in("status", ["trialing", "active"])
    .maybeSingle();
  if (!subRow) {
    return c.json(
      {
        error: "subscription_required",
        message: "Subscribe to Victora to find customers.",
        task_slug: "find-my-customers",
        business_id: business.id,
        plan_required: task.plan_required,
      },
      403,
    );
  }

  // One run at a time for this (business, task).
  const { data: running } = await supabase
    .from("task_runs")
    .select("id")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .in("status", ["queued", "running"])
    .maybeSingle();
  if (running) {
    return c.json({ accepted: true, task_run_id: (running as { id: string }).id, already_running: true }, 202);
  }

  const { data: runRow, error: insErr } = await supabase
    .from("task_runs")
    .insert({ user_id: auth.user_id, business_id: business.id, task_id: task.id, status: "queued", config: null })
    .select("id")
    .single();
  if (insErr || !runRow) {
    log.error("[leads] find_run_insert_failed", { business_id: business.id, err: insErr?.message });
    return c.json(errBody("internal", "find_run_insert_failed"), 500);
  }
  const taskRunId = (runRow as { id: string }).id;

  if (!c.env.TASK_QUEUE) {
    await supabase.from("task_runs").update({ status: "failed", error: "task_queue_unavailable", completed_at: new Date().toISOString() }).eq("id", taskRunId);
    return c.json(errBody("internal", "task_queue_unavailable"), 500);
  }
  try {
    await c.env.TASK_QUEUE.send({ taskRunId, businessId: business.id, userId: auth.user_id, taskSlug: "find-my-customers" });
  } catch (sendErr) {
    await supabase.from("task_runs").update({ status: "failed", error: "queue_send_failed", completed_at: new Date().toISOString() }).eq("id", taskRunId);
    log.error("[leads] queue_send_failed", { task_run_id: taskRunId, err: sendErr instanceof Error ? sendErr.message : String(sendErr) });
    return c.json(errBody("internal", "queue_send_failed"), 500);
  }

  return c.json({ accepted: true, task_run_id: taskRunId, poll_url: `/api/businesses/${slug}/task_runs/${taskRunId}` }, 202);
});

export default app;

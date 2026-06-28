// Per-business task run + poll endpoints (TA-3).
//
// Mounted at /api/businesses in index.ts:
//   POST /api/businesses/:slug/tasks/:taskSlug/run   → 202 + task_run_id (fire-and-poll)
//   GET  /api/businesses/:slug/task_runs/:id         → current task_run state
//
// Check-first-charge-after pattern (D2):
//   1. Pre-check subscription + balance — return 402/403 before any work.
//   2. Create task_run row (status=running).
//   3. Use c.executionCtx.waitUntil to run the task in the background.
//   4. Only deduct tokens AFTER the task succeeds and the asset persists.
//      If the runner throws, no tokens are debited; task_run flips to failed.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { createAnthropicClient } from "../services/anthropic";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { errBody } from "../lib/errors";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getTaskBySlug,
  getBusinessContext,
  getUserById,
  type BusinessRow,
  type BusinessContextRow,
  type UserRow,
  type TaskRow,
} from "../services/supabase";
import { buildBundleSuggestions } from "../lib/withTokenDeduction";
import { genericDocumentRunner } from "../lib/tasks/generic-document-runner";
import type { TaskCtx, SourceAsset } from "../lib/tasks/types";
import { loadModelConfig } from "../lib/model-config";
import { loadFeatureConfig, type FeatureConfig } from "../lib/non-task-model-config";
import {
  genAppLog,
  takeGenAppEvents,
  clearGenAppEvents,
  setGenAppLogSink,
} from "../lib/gen-app-log";
import { serializeGenAppError } from "../lib/gen-app-error";

// Slug → handler dispatch map (acceptable code constant; not a list of slugs).
// The actual "what's in the free build" list comes from the DB at request time.
import { FREE_BUILD_TASK_HANDLERS } from "../lib/free-build-orchestrator";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── POST /:slug/tasks/:taskSlug/run ─────────────────────────────────────
app.post("/:slug/tasks/:taskSlug/run", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const taskSlug = c.req.param("taskSlug");
  const supabase = createSupabaseClient(c.env);

  // Optional request body: { config?: object } — passed through to the
  // task_runs row so handlers can read user-provided params (description,
  // llm_tier, etc.). Body is optional; treat empty / missing / non-JSON as
  // "no config". Strict validation lives in the handler that reads it.
  let bodyConfig: Record<string, unknown> | null = null;
  try {
    const raw = await c.req.json().catch(() => null);
    if (raw && typeof raw === "object" && "config" in raw) {
      const candidate = (raw as { config: unknown }).config;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        bodyConfig = candidate as Record<string, unknown>;
      }
    }
  } catch {
    bodyConfig = null;
  }

  // 1. Resolve business + ownership
  let business: BusinessRow | null;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("[task-run] business_lookup_failed", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  // 2. Resolve task
  let task: TaskRow | null;
  try {
    task = await getTaskBySlug(supabase, taskSlug);
  } catch (err) {
    log.error("[task-run] task_lookup_failed", { taskSlug, err: String(err) });
    return c.json(errBody("internal", "task_lookup_failed"), 500);
  }
  if (!task) {
    return c.json(errBody("not_found", `task '${taskSlug}' not found`), 404);
  }

  // 3. Runnability checks — fail fast with structured 400/403/409/402

  // Configured tasks route to their dedicated page (migration 045: this keys
  // off output_type='configured', NOT kind, since 'configured' left the kind
  // axis). Tasks with a dedicated handler and no config_page_path run directly.
  if (task.output_type === "configured") {
    const hasDedicatedHandler = task.slug in FREE_BUILD_TASK_HANDLERS;
    if (!hasDedicatedHandler || task.config_page_path) {
      return c.json(
        {
          error: "task_is_configured",
          message:
            "This task is configured via its dedicated page. Navigate to config_page_path.",
          config_page_path:
            task.config_page_path?.replace("{slug}", business.slug) ?? null,
        },
        400,
      );
    }
  }

  if (task.kind === "system") {
    return c.json(
      { error: "task_is_system", message: "System tasks cannot be run from UI." },
      400,
    );
  }

  if (task.status === "draft") {
    return c.json(
      {
        error: "task_not_yet_available",
        message: "This task is not yet available."
      },
      403,
    );
  }

  // ── Regeneratable task guard ──────────────────────────────────────
  // BLOCK standalone run only if:
  //   - A free build is actively running for this business
  //   - AND this task is currently part of that running build
  // ALLOW standalone run if:
  //   - No active free build OR
  //   - Task is is_regeneratable = true (can always re-run) OR
  //   - Task has already completed in the current context
  if (task.is_default && !task.is_regeneratable) {
    // Check for active free build (now a playbook_run — migration 044)
    const { data: activeBuild, error: buildErr } = await supabase
      .from("playbook_runs")
      .select("id")
      .eq("business_id", business.id)
      .eq("status", "running")
      .maybeSingle();

    if (buildErr) {
      log.error("[task-run] free_build_check_failed", {
        business_id: business.id,
        err: buildErr.message,
      });
      return c.json(errBody("internal", "free_build_check_failed"), 500);
    }

    if (activeBuild) {
      // Free build is running - check if this task is currently part of it
      const { data: taskInBuild, error: taskErr } = await supabase
        .from("task_runs")
        .select("status")
        .eq("business_id", business.id)
        .eq("task_id", task.id)
        .in("status", ["running", "pending"])
        .maybeSingle();

      if (taskErr) {
        log.error("[task-run] task_in_build_check_failed", {
          business_id: business.id,
          task_id: task.id,
          err: taskErr.message,
        });
        return c.json(errBody("internal", "task_in_build_check_failed"), 500);
      }

      if (taskInBuild) {
        return c.json(
          {
            error: "task_in_active_build",
            message: "This task is currently running as part of the free build.",
          },
          409,
        );
      }
    }
  }

  // Coming soon check — but exclude free build tasks that have dedicated handlers
  const hasDedicatedHandler = task.slug in FREE_BUILD_TASK_HANDLERS;
  const isComingSoon = !hasDedicatedHandler && (
    !task.token_cost ||
    task.token_cost === 0 ||
    !task.prompt_template ||
    task.prompt_template.trim() === ""
  );

  if (isComingSoon) {
    return c.json(
      {
        error: "task_not_ready",
        message: "This task ships in a future phase.",
        task_slug: task.slug,
      },
      400,
    );
  }

  // 4. Subscription gate
  const { data: subRow, error: subErr } = await supabase
    .from("business_subscriptions")
    .select("status")
    .eq("business_id", business.id)
    .in("status", ["trialing", "active"])
    .maybeSingle();

  if (subErr) {
    log.error("[task-run] sub_check_failed", {
      business_id: business.id,
      err: subErr.message,
    });
    return c.json(errBody("internal", "sub_check_failed"), 500);
  }
  if (!subRow) {
    return c.json(
      {
        error: "subscription_required",
        message: "Subscribe to Victora to run this task.",
        task_slug: task.slug,
        business_id: business.id,
        plan_required: task.plan_required,
      },
      403,
    );
  }

  // 5. Free-build completion gate (D3) — only applies to non-regeneratable tasks
  // Regeneratable tasks can always run, even during active free builds.
  // Free-build slug list comes from the DB (tasks WHERE is_default=true
  // AND status='active') — no hardcoded slug array.
  if (!task.is_regeneratable) {
    const { data: freeBuildDefRows, error: freeBuildDefErr } = await supabase
      .from("tasks")
      .select("slug")
      .eq("is_default", true)
      .eq("status", "active");

    if (freeBuildDefErr) {
      log.error("[task-run] free_build_list_failed", {
        business_id: business.id,
        err: freeBuildDefErr.message,
      });
      return c.json(errBody("internal", "free_build_list_failed"), 500);
    }

    const freeBuildSlugs = (freeBuildDefRows ?? []).map(
      (r) => (r as { slug: string }).slug,
    );

    if (freeBuildSlugs.length === 0) {
      log.error("[task-run] free_build_list_empty", { business_id: business.id });
      return c.json(errBody("internal", "no_active_default_tasks"), 500);
    }

    const { data: freeBuildRuns, error: freeBuildErr } = await supabase
      .from("task_runs")
      .select("status, tasks!inner(slug)")
      .eq("business_id", business.id)
      .in("tasks.slug", freeBuildSlugs);

    if (freeBuildErr) {
      log.error("[task-run] free_build_check_failed", {
        business_id: business.id,
        err: freeBuildErr.message,
      });
      return c.json(errBody("internal", "free_build_check_failed"), 500);
    }

    type FreeBuildRow = { status: string; tasks: { slug: string } };
    const runs = (freeBuildRuns ?? []) as unknown as FreeBuildRow[];
    const completedSlugs = new Set(
      runs.filter((r) => r.status === "completed").map((r) => r.tasks.slug),
    );
    const freeBuildComplete = freeBuildSlugs.every((s) => completedSlugs.has(s));

    if (!freeBuildComplete) {
      return c.json(
        {
          error: "free_build_in_progress",
          message: "Free build still in progress. Try again in a moment.",
        },
        409,
      );
    }
  }

  // 6. Pre-check token balance (D2)
  const { data: balance, error: balErr } = await supabase
    .from("token_balances")
    .select("period_tokens_included, period_tokens_used, topup_tokens_remaining")
    .eq("business_id", business.id)
    .maybeSingle();

  if (balErr) {
    log.error("[task-run] balance_lookup_failed", {
      business_id: business.id,
      err: balErr.message,
    });
    return c.json(errBody("internal", "balance_lookup_failed"), 500);
  }
  if (!balance) {
    return c.json(errBody("internal", "no_balance_row"), 500);
  }

  const periodRemaining = Math.max(
    0,
    (balance.period_tokens_included as number) -
      (balance.period_tokens_used as number),
  );
  const available = periodRemaining + (balance.topup_tokens_remaining as number);

  // Token model is PER-POST (per idea): one generate request = one token,
  // regardless of how many platforms it casts to. NOT batch × platform_count.
  // We still confirm at least one publishable platform is connected so the
  // request fails fast with a friendly message instead of a generic task error.
  const preCheckCost = task.token_cost;
  if (task.slug === "generate-social-post") {
    const { data: zInt } = await supabase
      .from("business_integrations")
      .select("config")
      .eq("business_id", business.id)
      .eq("provider", "zernio")
      .eq("is_active", true)
      .maybeSingle();
    const zCfg = ((zInt as any)?.config ?? {}) as { accounts?: { platform: string }[] };
    const slugs = (zCfg.accounts ?? []).map((a: { platform: string }) => a.platform).filter(Boolean);
    let platformCount = 0;
    if (slugs.length > 0) {
      const { data: pRows } = await supabase
        .from("platforms")
        .select("slug")
        .in("slug", slugs)
        .eq("publish_supported", true)
        .eq("is_active", true);
      platformCount = (pRows ?? []).length;
    }
    if (platformCount === 0) {
      return c.json(
        {
          error: "no_platforms_connected",
          message: "Connect a social account first — go to Platforms in the sidebar.",
        },
        422,
      );
    }
  }

  if (available < preCheckCost) {
    const deficit = preCheckCost - available;
    return c.json(
      {
        error: "insufficient_tokens",
        available,
        requested: preCheckCost,
        deficit,
        bundle_suggestions: buildBundleSuggestions(deficit),
        business_id: business.id,
        task_slug: task.slug,
      },
      402,
    );
  }

  // 6a. Concurrency lock: reject if this (business, task) is already running.
  // Prevents the test harness (or a double-click) from stacking stuck runs.
  const { data: runningRow, error: lockErr } = await supabase
    .from("task_runs")
    .select("id")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .eq("status", "running")
    .maybeSingle();
  if (lockErr) {
    log.error("[task-run] concurrency_lock_check_failed", {
      business_id: business.id,
      task_slug: task.slug,
      err: lockErr.message,
    });
    return c.json(errBody("internal", "concurrency_lock_check_failed"), 500);
  }
  if (runningRow) {
    return c.json(
      {
        error: "task_already_running",
        message: "This task is already running for this business.",
        task_slug: task.slug,
      },
      409,
    );
  }

  // 6b. Attempt cap: block if >= 2 failures since the last admin clear.
  // Non-fatal if the table doesn't exist yet (migration 051 pending):
  // blockErr is logged and the check is skipped so existing flow is preserved.
  const { data: blockRow, error: blockErr } = await supabase
    .from("task_trigger_blocks")
    .select("blocked_at")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .is("cleared_at", null)
    .maybeSingle();
  if (blockErr) {
    log.warn("[task-run] attempt_block_check_failed", {
      business_id: business.id,
      task_slug: task.slug,
      err: blockErr.message,
    });
  } else if (blockRow) {
    return c.json(
      {
        error: "task_attempt_limit_reached",
        message: "2 failed attempts — needs review",
        task_slug: task.slug,
        blocked_at: blockRow.blocked_at,
      },
      429,
    );
  }

  // 7. Create task_run row — status=running, no tokens debited yet.
  // config is jsonb; null when no body was sent or it had no config field.
  const { data: taskRunRow, error: insertErr } = await supabase
    .from("task_runs")
    .insert({
      user_id: auth.user_id,
      business_id: business.id,
      task_id: task.id,
      status: "running",
      started_at: new Date().toISOString(),
      config: bodyConfig,
    })
    .select("id")
    .single();

  if (insertErr || !taskRunRow) {
    log.error("[task-run] task_run_insert_failed", {
      business_id: business.id,
      task_slug: task.slug,
      err: insertErr?.message,
    });
    return c.json(errBody("internal", "task_run_insert_failed"), 500);
  }

  const taskRunId = (taskRunRow as { id: string }).id;

  // 8. Background work via c.executionCtx.waitUntil
  const env = c.env;
  const user_id = auth.user_id;

  c.executionCtx.waitUntil(
    runTaskInBackground(env, business, task, user_id, taskRunId),
  );

  // 9. Return 202 immediately
  return c.json(
    {
      accepted: true,
      task_run_id: taskRunId,
      poll_url: `/api/businesses/${slug}/task_runs/${taskRunId}`,
    },
    202,
  );
});

// ── POST /:slug/task_runs/:id/cancel ─────────────────────────────────────
// User-initiated cancellation. Cloudflare doesn't expose a way to actually
// abort a running waitUntil() invocation, so we can't kill the Anthropic
// call mid-stream. What we CAN do is flip the task_run row to 'failed'
// immediately — the frontend poll picks that up within 2s and the runner's
// status-update queries below gate on status='running' so they no-op if
// the user already cancelled. Tokens are never debited if the cancel
// lands before the runner reaches the debit RPC.
app.post("/:slug/task_runs/:id/cancel", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const taskRunId = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let business: BusinessRow | null;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("[task-run] business_lookup_failed_cancel", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  // Atomic update gated on status='running' — if user double-clicks or the
  // task completes a moment before the cancel arrives, this returns zero
  // rows and we report 409.
  const { data: updated, error } = await supabase
    .from("task_runs")
    .update({
      status: "failed",
      error: "cancelled_by_user",
      completed_at: new Date().toISOString(),
    })
    .eq("id", taskRunId)
    .eq("business_id", business.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();

  if (error) {
    log.error("[task-run] cancel_failed", { taskRunId, err: error.message });
    return c.json(errBody("internal", "cancel_failed"), 500);
  }
  if (!updated) {
    return c.json({
      error: "not_running",
      message: "Task is not currently running (already completed, failed, or doesn't exist).",
    }, 409);
  }

  log.info("[task-run] cancelled_by_user", { taskRunId, business_id: business.id });
  return c.json({ ok: true, task_run_id: taskRunId });
});

// ── GET /:slug/task_runs/:id ─────────────────────────────────────────────
app.get("/:slug/task_runs/:id", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const taskRunId = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  // Ownership check via slug+user — cheaper than a join here
  let business: BusinessRow | null;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("[task-run] business_lookup_failed_poll", {
      slug,
      err: String(err),
    });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  // Inline timeout sweep — every poll prunes stale rows for this business
  // before reading. Cheap (one UPDATE filtered to this biz) and makes the
  // watchdog cron a safety net rather than the only line of defense.
  // Polls happen every 2s while a task is in flight, so a stuck row
  // clears within seconds instead of waiting for the next cron tick.
  // Two-tier: free-build tasks (expected <30s) swept at 60s; long tasks
  // (generate-business-app* + public-business-website) kept at 300s —
  // they legitimately run 60-120s and must not be swept early.
  {
    const { data: longTaskRows } = await supabase
      .from("tasks")
      .select("id")
      .or("slug.like.generate-business-app%,slug.eq.public-business-website");
    const longTaskIds = (longTaskRows ?? []).map((r: { id: string }) => r.id);

    const shortCutoff = new Date(Date.now() - 60_000).toISOString();
    const shortQ = supabase
      .from("task_runs")
      .update({ status: "failed", error: "timeout_60s", completed_at: new Date().toISOString() })
      .eq("business_id", business.id)
      .eq("status", "running")
      .lt("started_at", shortCutoff);
    await (longTaskIds.length > 0
      ? shortQ.not("task_id", "in", `(${longTaskIds.join(",")})`)
      : shortQ);

    if (longTaskIds.length > 0) {
      const longCutoff = new Date(Date.now() - 300_000).toISOString();
      await supabase
        .from("task_runs")
        .update({ status: "failed", error: "timeout_5min", completed_at: new Date().toISOString() })
        .eq("business_id", business.id)
        .eq("status", "running")
        .lt("started_at", longCutoff)
        .in("task_id", longTaskIds);
    }
  }

  const { data: row, error } = await supabase
    .from("task_runs")
    .select(
      "id, task_id, status, started_at, completed_at, output_data, error",
    )
    .eq("id", taskRunId)
    .eq("business_id", business.id)
    .maybeSingle();

  if (error) {
    log.error("[task-run] poll_lookup_failed", {
      task_run_id: taskRunId,
      err: error.message,
    });
    return c.json(errBody("internal", "task_run_lookup_failed"), 500);
  }
  if (!row) {
    return c.json(errBody("not_found", `task_run '${taskRunId}' not found`), 404);
  }

  return c.json(row);
});

// ── GET /:slug/is-owner ────────────────────────────────────────────────
// Returns { is_owner: boolean } for the authed user against this business
// slug. Used by the public homepage (/sites/{slug}/) client-side to
// decide whether to reveal the "Create another app" nudge card without
// leaking ownership info to non-owners (the public payload of
// /api/sites/{slug} doesn't expose user_id).
//
// Auth: required (Bearer token). 404 if business slug doesn't exist —
// keeps the "is this real" answer the same as the public site would
// return, so an enumeration attacker can't tell "slug exists but I'm
// not the owner" from "slug doesn't exist".
app.get("/:slug/is-owner", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const { data: biz, error } = await supabase
    .from("businesses")
    .select("user_id")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    log.error("[is-owner] lookup_failed", { slug, err: error.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!biz) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  return c.json({ is_owner: (biz as { user_id: string }).user_id === auth.user_id });
});

// NOTE (2026-05-25): the previous GET /:slug/app-logs handler that
// lived here was moved to src/routes/app-logs.ts and remounted at the
// dedicated prefix /api/app-logs. The /api/businesses prefix has five
// sibling sub-apps mounted on it (business-manager, marketing-carousels,
// billing, business-task-run, apps-businesses) and the new handler was
// 404'ing despite being registered — fall-through across sibling
// sub-app mounts wasn't reliably matching it. Keeping the rest of this
// file's routes here unchanged; only the app-logs route moved.

// ── Background runner ────────────────────────────────────────────────────
// Build the full TaskCtx, run the generic runner, then debit tokens via
// debit_tokens RPC. On any failure, mark task_run as failed and DO NOT
// debit tokens. Token bookkeeping happens ONCE, after success.

// Slug code-constants for the generate-business-app chain. Acceptable
// per the CLAUDE.md "tasks-as-data" rule (this is execution logic,
// not task metadata duplication). Long-term fix is schema columns
// charge_at_chain_end + parent_task_slug on tasks — backlog'd.
const GEN_APP_DESIGN_SLUG = "generate-business-app";
const GEN_APP_HTML_SLUG   = "generate-business-app-html";
const GEN_APP_SLUG_PREFIX = "generate-business-app";

// Tier → tokens for the chained HTML step's debit. Mirrors the
// llm-tier-model.ts map but at the cost dimension. Keep in lockstep
// with that file when adding a tier.
const TIER_TO_TOKEN_COST: Record<string, number> = {
  haiku: 2,
  sonnet: 5,
  opus: 10,
};

export async function runTaskInBackground(
  env: Env,
  business: BusinessRow,
  task: TaskRow,
  user_id: string,
  taskRunId: string,
  signal?: AbortSignal,
  isHarness = false,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // Wire the gen-app-log durable sink for this Worker invocation so
  // every genAppLog() call fires a fire-and-forget INSERT into
  // gen_app_logs. Safe to wire even for non-gen-app tasks — the table
  // only receives rows when genAppLog is called, which only happens
  // from gen-app code paths.
  setGenAppLogSink(supabase);

  // ── Concurrency lock — Design step only ────────────────────────────────
  // Block a new Design start if any other 'generate-business-app%' task_run
  // is already in flight for this business. This includes a chained HTML
  // task from a previous Design that hasn't completed.
  //
  // The lock is applied at the Design entry, NOT on the HTML step — the
  // HTML step is itself a child of an in-flight Design and would otherwise
  // self-conflict. internal.ts dispatches the HTML step; that's the
  // legitimate "running app generation" the second user click should bounce
  // off of.
  if (task.slug === GEN_APP_DESIGN_SLUG) {
    genAppLog("runner_concurrency_lock_check", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
    const { data: conflicting, error: lockErr } = await supabase
      .from("task_runs")
      .select("id, tasks!inner(slug)")
      .eq("business_id", business.id)
      .eq("status", "running")
      .neq("id", taskRunId)
      .like("tasks.slug", `${GEN_APP_SLUG_PREFIX}%`);

    if (lockErr) {
      log.warn("[task-run] concurrency_lock_query_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        err: lockErr.message,
      });
      genAppLog("runner_concurrency_lock_query_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        err: lockErr.message,
      });
      // Don't block on a DB hiccup — best-effort lock.
    } else if (conflicting && conflicting.length > 0) {
      log.info("[task-run] concurrency_blocked", {
        business_id: business.id,
        task_run_id: taskRunId,
        conflicting_ids: conflicting.map((r: { id: string }) => r.id),
      });
      genAppLog("runner_concurrency_lock_hit", {
        business_id: business.id,
        task_run_id: taskRunId,
        conflicting_ids: conflicting.map((r: { id: string }) => r.id),
      });
      await supabase
        .from("task_runs")
        .update({
          status: "failed",
          error: serializeGenAppError(
            "concurrent_generation_in_progress",
            takeGenAppEvents(taskRunId),
          ),
          completed_at: new Date().toISOString(),
        })
        .eq("id", taskRunId)
        .eq("status", "running");
      return;
    }
  }

  try {
    const [ctx, user] = await Promise.all([
      getBusinessContext(supabase, business.id),
      getUserById(supabase, user_id),
    ]);

    if (!ctx) {
      throw new Error("business_context_not_found");
    }
    if (!user) {
      throw new Error("user_not_found");
    }

    // Load source asset when the task_runs.config contains a source_asset_id.
    // Ownership is enforced via business_id — one business cannot reference another's assets.
    let sourceAsset: SourceAsset | null = null;
    const { data: cfgForSource } = await supabase
      .from("task_runs")
      .select("config")
      .eq("id", taskRunId)
      .maybeSingle();
    const sourceAssetId =
      typeof (cfgForSource?.config as Record<string, unknown> | null)?.source_asset_id === "string"
        ? ((cfgForSource!.config as Record<string, unknown>).source_asset_id as string)
        : null;
    if (sourceAssetId) {
      const { data: saRow, error: saErr } = await supabase
        .from("business_assets")
        .select("id, asset_type, asset_subtype, asset_text, asset_data")
        .eq("id", sourceAssetId)
        .eq("business_id", business.id)
        .maybeSingle();
      if (saErr) {
        throw new Error(`source_asset_load_failed: ${saErr.message}`);
      }
      if (!saRow) {
        throw new Error(`source_asset_not_found: ${sourceAssetId}`);
      }
      // Extract plain text from the asset. Prefer asset_text if pre-extracted;
      // otherwise flatten the standard {title, sections} document shape.
      let text = "";
      if (saRow.asset_text) {
        text = saRow.asset_text as string;
      } else if (saRow.asset_data && typeof saRow.asset_data === "object") {
        const doc = saRow.asset_data as {
          title?: string;
          sections?: Array<{ heading: string; body: string }>;
        };
        if (doc.title && Array.isArray(doc.sections)) {
          text = `${doc.title}\n\n${doc.sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n")}`;
        } else {
          text = JSON.stringify(saRow.asset_data);
        }
      }
      sourceAsset = {
        id: saRow.id as string,
        text,
        subtype: (saRow.asset_subtype as string | null) ?? null,
        assetType: saRow.asset_type as string,
      };
    }

    const anthropic = createAnthropicClient(env);
    // Accumulate token usage across all LLM calls in this task run so we can
    // write input_tokens / output_tokens to task_runs on completion.
    let _accInputTokens = 0, _accOutputTokens = 0;
    const _origCreate = anthropic.messages.create.bind(anthropic.messages);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (anthropic.messages as any).create = async (...args: any[]) => {
      const msg = await _origCreate(...args);
      // Only non-streaming responses have .usage directly on the result.
      const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (u) { _accInputTokens += u.input_tokens ?? 0; _accOutputTokens += u.output_tokens ?? 0; }
      return msg;
    };
    // Load featureConfig only for dedicated-handler tasks (generate-business-app*)
    // that actually read it via resolveFeatureModel. Generic document runner
    // never reads featureConfig — skipping the load removes a dead DB query.
    const dedicatedHandler = FREE_BUILD_TASK_HANDLERS[task.slug];
    const [models, featureConfig] = await Promise.all([
      loadModelConfig(supabase),
      dedicatedHandler
        ? loadFeatureConfig(supabase)
        : Promise.resolve({ defaultTier: "sonnet", overrides: {} } as FeatureConfig),
    ]);

    // runId is free-build-orchestrator-specific. Generic runs reuse the
    // task_run_id here — the runner doesn't read it, but TaskCtx requires
    // the field be non-null.
    let seq = 0;
    const taskCtx: TaskCtx = {
      env,
      supabase,
      anthropic,
      models,
      featureConfig,
      business,
      ctx: ctx as BusinessContextRow,
      user: user as UserRow,
      runId: taskRunId,
      taskRunId,
      nextSeq: () => ++seq,
      emit: async () => {
        /* no-op: paid V1 tasks don't stream SSE */
      },
      cfLocation: null,
      abortSignal: signal ?? null,
      isHarness,
      sourceAsset,
      config: (cfgForSource?.config as Record<string, unknown> | null) ?? null,
    };

    // Check for dedicated handler first (free build tasks), fallback to generic runner
    const isGenAppTask = task.slug.startsWith(GEN_APP_SLUG_PREFIX);
    if (isGenAppTask) {
      genAppLog("runner_handler_dispatch_start", {
        business_id: business.id,
        task_run_id: taskRunId,
        task_slug: task.slug,
      });
    }
    const result = dedicatedHandler
      ? await dedicatedHandler(taskCtx)
      : await genericDocumentRunner(taskCtx, task);
    if (isGenAppTask) {
      genAppLog("runner_handler_dispatch_complete", {
        business_id: business.id,
        task_run_id: taskRunId,
        task_slug: task.slug,
        has_output_data: !!result.output_data,
      });
    }

    // Cancellation check: if the user cancelled while the Anthropic call
    // was in flight, the asset has already been written to business_assets
    // (genericDocumentRunner does that inside), but we should NOT debit
    // tokens — the user explicitly aborted. The status check below catches
    // this race. Asset persists either way (it's free this once).
    const { data: preDebitRow } = await supabase
      .from("task_runs")
      .select("status")
      .eq("id", taskRunId)
      .maybeSingle();
    if (preDebitRow && preDebitRow.status !== "running") {
      log.info("[task-run] cancelled_before_debit", {
        task_run_id: taskRunId,
        observed_status: preDebitRow.status,
      });
      return;
    }

    // ── Chain-aware debit override ────────────────────────────────────
    // For the generate-business-app chain, charge once at the HTML
    // (chained child) step's completion, not at the Design step.
    // Tier-aware: read llm_tier from THIS task_run's config and map.
    //
    // Specifically:
    //   - 'generate-business-app'      → SKIP debit (chained child charges)
    //   - 'generate-business-app-html' → tier-aware debit (Haiku 2, Sonnet 5, Opus 10)
    //   - everything else              → existing behavior (task.token_cost)
    //
    // Long-term fix is data-driven (tasks.charge_at_chain_end +
    // tasks.parent_task_slug + tasks.tier_costs). Code constant for now.
    let effectiveCost = task.token_cost ?? 0;
    let debitSkipReason: string | null = null;

    if (task.slug === GEN_APP_DESIGN_SLUG) {
      // Design step never debits — child (HTML step) owns the charge.
      effectiveCost = 0;
      debitSkipReason = "chain_charges_on_child";
    } else if (task.slug === GEN_APP_HTML_SLUG) {
      // Read the chained tier from this task_run's config (forwarded by
      // the Design handler via internal.ts).
      const { data: cfgRow } = await supabase
        .from("task_runs")
        .select("config")
        .eq("id", taskRunId)
        .maybeSingle();
      const cfg = (cfgRow?.config as Record<string, unknown> | null) || null;
      const tier =
        typeof cfg?.llm_tier === "string" ? (cfg.llm_tier as string) : "haiku";
      const mapped = TIER_TO_TOKEN_COST[tier];
      if (typeof mapped !== "number") {
        log.error("[task-run] unknown_llm_tier_for_chain_debit", {
          business_id: business.id,
          task_run_id: taskRunId,
          tier,
        });
        await supabase
          .from("task_runs")
          .update({
            status: "failed",
            error: `unknown_llm_tier_for_debit: ${tier}`,
            completed_at: new Date().toISOString(),
          })
          .eq("id", taskRunId)
          .eq("status", "running");
        return;
      }
      effectiveCost = mapped;
    }
    // generate-social-post stays at task.token_cost — one token PER POST (per idea),
    // regardless of how many platforms the idea casts to. No platform-count multiplier.

    if (effectiveCost === 0) {
      log.info("[task-run] no_debit", {
        business_id: business.id,
        task_slug: task.slug,
        task_run_id: taskRunId,
        reason: debitSkipReason ?? "token_cost_zero",
      });
      if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
        genAppLog("runner_debit_skipped", {
          business_id: business.id,
          task_run_id: taskRunId,
          task_slug: task.slug,
          reason: debitSkipReason ?? "token_cost_zero",
        });
      }
    } else {
      // Debit AFTER the asset persists. Failure here is rare but possible —
      // log loudly and mark the run as failed (user keeps the asset because
      // business_assets is the receipt; they just got it for free this once).
      if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
        genAppLog("runner_debit_start", {
          business_id: business.id,
          task_run_id: taskRunId,
          task_slug: task.slug,
          tokens: effectiveCost,
          user_id,
        });
      }
      const { data: debitResult, error: debitErr } = await supabase.rpc(
        "debit_tokens",
        {
          p_business_id: business.id,
          p_user_id: user_id,
          p_tokens: effectiveCost,
          p_task_slug: task.slug,
          p_task_run_id: taskRunId,
          p_description: `Task: ${task.name}`,
        },
      );

      if (debitErr || !(debitResult as { ok?: boolean })?.ok) {
        log.error("[task-run] post_run_debit_failed", {
          business_id: business.id,
          task_slug: task.slug,
          task_run_id: taskRunId,
          effective_cost: effectiveCost,
          err: debitErr?.message,
          result: debitResult,
        });
        if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
          genAppLog("runner_debit_failed", {
            business_id: business.id,
            task_run_id: taskRunId,
            task_slug: task.slug,
            err: debitErr?.message ?? String(debitResult),
          });
        }
        const failError = task.slug.startsWith(GEN_APP_SLUG_PREFIX)
          ? serializeGenAppError(
              "token_deduct_failed_post_run",
              takeGenAppEvents(taskRunId),
            )
          : "token_deduct_failed_post_run";
        await supabase
          .from("task_runs")
          .update({
            status: "failed",
            error: failError,
            completed_at: new Date().toISOString(),
          })
          .eq("id", taskRunId)
          .eq("status", "running"); // don't overwrite a user cancellation
        return;
      }
      if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
        genAppLog("runner_debit_complete", {
          business_id: business.id,
          task_run_id: taskRunId,
          task_slug: task.slug,
          tokens: effectiveCost,
        });
      }
    }

    // Final completion update — also gated on status='running' so a
    // cancellation that landed during debit (rare window) keeps the
    // user's cancelled status instead of getting flipped to completed.
    await supabase
      .from("task_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        output_data: result.output_data,
        model: result.model ?? null,
        input_tokens: _accInputTokens || null,
        output_tokens: _accOutputTokens || null,
      })
      .eq("id", taskRunId)
      .eq("status", "running");

    log.info("[task-run] completed", {
      business_id: business.id,
      task_slug: task.slug,
      task_run_id: taskRunId,
      tokens_debited: effectiveCost,
      is_free_task: effectiveCost === 0,
    });
    // Drop the per-task-run event buffer on success — there's no error
    // payload to attach it to, and we don't want it lingering across
    // back-to-back consumer batches in the same Worker invocation.
    if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
      clearGenAppEvents(taskRunId);
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "timeout_60s"
        : err instanceof Error ? err.message : String(err) || "unknown_error";
    log.error("[task-run] background_failed", {
      business_id: business.id,
      task_slug: task.slug,
      task_run_id: taskRunId,
      err: message,
    });
    // Structured error for the generate-business-app chain so apps.astro
    // can show a human-readable summary to the operator instead of the
    // raw technical message. Other tasks keep plain-text error storage
    // (their UIs don't parse JSON).
    //
    // We log runner_handler_dispatch_failed FIRST so it lands in the
    // event buffer for this task_run before we drain it via
    // takeGenAppEvents — otherwise the operator-facing log would be
    // missing the very last entry that names the dispatch failure.
    if (task.slug.startsWith(GEN_APP_SLUG_PREFIX)) {
      genAppLog("runner_handler_dispatch_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        task_slug: task.slug,
        err_name: err instanceof Error ? err.name : "unknown",
        err_message: message,
      });
    }
    const isGenApp = task.slug.startsWith(GEN_APP_SLUG_PREFIX);
    const events = isGenApp ? takeGenAppEvents(taskRunId) : [];
    const errorPayload = isGenApp
      ? serializeGenAppError(message, events)
      : message;
    await supabase
      .from("task_runs")
      .update({
        status: "failed",
        error: errorPayload,
        completed_at: new Date().toISOString(),
      })
      .eq("id", taskRunId)
      .eq("status", "running") // preserve a user cancellation if it landed first
      .then(undefined, (e: unknown) => {
        log.error("[task-run] fail_update_failed", {
          task_run_id: taskRunId,
          err: e instanceof Error ? e.message : String(e),
        });
      });

    // ── Attempt-cap: insert block after 2nd failure ─────────────────────
    // Counts failures since the last admin clear (or ever if never cleared).
    // Non-fatal: a DB error here just means the block wasn't set this time.
    try {
      const { data: existingBlock } = await supabase
        .from("task_trigger_blocks")
        .select("cleared_at")
        .eq("business_id", business.id)
        .eq("task_id", task.id)
        .maybeSingle();
      const clearAnchor = existingBlock?.cleared_at ?? "1970-01-01T00:00:00Z";
      const { count: failedCount } = await supabase
        .from("task_runs")
        .select("*", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("task_id", task.id)
        .eq("status", "failed")
        .gte("started_at", clearAnchor);
      if ((failedCount ?? 0) >= 2) {
        await supabase
          .from("task_trigger_blocks")
          .upsert(
            {
              business_id: business.id,
              task_id: task.id,
              blocked_at: new Date().toISOString(),
              cleared_at: null,
            },
            { onConflict: "business_id,task_id" },
          );
        log.info("[task-run] attempt_block_inserted", {
          business_id: business.id,
          task_slug: task.slug,
          failed_count: failedCount,
        });
      }
    } catch (blockErr) {
      log.warn("[task-run] attempt_block_insert_failed", {
        business_id: business.id,
        task_slug: task.slug,
        err: blockErr instanceof Error ? blockErr.message : String(blockErr),
      });
    }
  }
}

export default app;

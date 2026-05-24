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
import type { TaskCtx } from "../lib/tasks/types";

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

  if (task.kind === "configured") {
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
    // Check for active free build
    const { data: activeBuild, error: buildErr } = await supabase
      .from("free_build_runs")
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
    task.prompt_template.trim() === "" ||
    task.output_type === "generated_site" ||
    task.output_type === "dashboard_view"
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
        message: "Subscribe to TextOS to run this task.",
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

  if (available < task.token_cost) {
    const deficit = task.token_cost - available;
    return c.json(
      {
        error: "insufficient_tokens",
        available,
        requested: task.token_cost,
        deficit,
        bundle_suggestions: buildBundleSuggestions(deficit),
        business_id: business.id,
        task_slug: task.slug,
      },
      402,
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
  // Threshold: 5 min — accommodates the longer LLM-heavy paid tasks
  // (generate-business-app-html in particular). The handler's own
  // withTimeout wrappers still fail fast at their own thresholds.
  const timeoutCutoff = new Date(Date.now() - 300_000).toISOString();
  await supabase
    .from("task_runs")
    .update({
      status: "failed",
      error: "timeout_5min",
      completed_at: new Date().toISOString(),
    })
    .eq("business_id", business.id)
    .eq("status", "running")
    .lt("started_at", timeoutCutoff);

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

// ── Background runner ────────────────────────────────────────────────────
// Build the full TaskCtx, run the generic runner, then debit tokens via
// debit_tokens RPC. On any failure, mark task_run as failed and DO NOT
// debit tokens. Token bookkeeping happens ONCE, after success.

export async function runTaskInBackground(
  env: Env,
  business: BusinessRow,
  task: TaskRow,
  user_id: string,
  taskRunId: string,
): Promise<void> {
  const supabase = createSupabaseClient(env);

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

    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    // runId is free-build-orchestrator-specific. Generic runs reuse the
    // task_run_id here — the runner doesn't read it, but TaskCtx requires
    // the field be non-null.
    let seq = 0;
    const taskCtx: TaskCtx = {
      env,
      supabase,
      anthropic,
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
    };

    // Check for dedicated handler first (free build tasks), fallback to generic runner
    const dedicatedHandler = FREE_BUILD_TASK_HANDLERS[task.slug];
    const result = dedicatedHandler
      ? await dedicatedHandler(taskCtx)
      : await genericDocumentRunner(taskCtx, task);

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

    // Token deduction — skip entirely for free tasks (token_cost = 0)
    if (!task.token_cost || task.token_cost === 0) {
      // Free task — skip token deduction entirely
      log.info("[task-run] free_task_no_deduction", {
        business_id: business.id,
        task_slug: task.slug,
        task_run_id: taskRunId,
        token_cost: task.token_cost,
      });
    } else {
      // Debit AFTER the asset persists. Failure here is rare but possible —
      // log loudly and mark the run as failed (user keeps the asset because
      // business_assets is the receipt; they just got it for free this once).
      const { data: debitResult, error: debitErr } = await supabase.rpc(
        "debit_tokens",
        {
          p_business_id: business.id,
          p_user_id: user_id,
          p_tokens: task.token_cost,
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
          err: debitErr?.message,
          result: debitResult,
        });
        await supabase
          .from("task_runs")
          .update({
            status: "failed",
            error: "token_deduct_failed_post_run",
            completed_at: new Date().toISOString(),
          })
          .eq("id", taskRunId)
          .eq("status", "running"); // don't overwrite a user cancellation
        return;
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
      })
      .eq("id", taskRunId)
      .eq("status", "running");

    log.info("[task-run] completed", {
      business_id: business.id,
      task_slug: task.slug,
      task_run_id: taskRunId,
      tokens_debited: (!task.token_cost || task.token_cost === 0) ? 0 : task.token_cost,
      is_free_task: (!task.token_cost || task.token_cost === 0),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err) || "unknown_error";
    log.error("[task-run] background_failed", {
      business_id: business.id,
      task_slug: task.slug,
      task_run_id: taskRunId,
      err: message,
    });
    await supabase
      .from("task_runs")
      .update({
        status: "failed",
        error: message,
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
  }
}

export default app;

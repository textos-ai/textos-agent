import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import {
  createSupabaseClient,
  getTaskBySlug,
  type BusinessRow,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { runTaskInBackground } from "./business-task-run";
import { runScheduledReconcile } from "../cron/reconcileScheduledPosts";

// ─────────────────────────────────────────────────────────────────────────────
// /api/internal/* — worker→worker chain trigger routes.
//
// Mounted in src/index.ts under /api/internal. NOT user-facing. Validated by
// shared secret in `x-internal-secret` (env.INTERNAL_TRIGGER_SECRET).
//
// Today's only route: POST /run-task — start a task_run for {businessId,
// userId, taskSlug} as if it had been triggered by the user. Each call
// gets its own Worker invocation budget via c.executionCtx.waitUntil.
//
// Used by chain-pattern task handlers (e.g. generate-business-app-design
// triggers generate-business-app-html after saving the design draft) to
// split a long-running task into two independent Worker invocations.
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// POST /api/internal/reconcile-scheduled — on-demand run of the scheduled-post
// reconciler (same routine the */5 cron runs). Lets us trigger/verify it on
// environments where cron is disabled (e.g. test). Secret-guarded.
app.post("/reconcile-scheduled", async (c) => {
  const expected = c.env.INTERNAL_TRIGGER_SECRET;
  if (!expected) return c.json(errBody("not_configured", "INTERNAL_TRIGGER_SECRET unset"), 503);
  if ((c.req.header("x-internal-secret") ?? "") !== expected) {
    return c.json(errBody("unauthorized", "bad internal secret"), 401);
  }
  const supabase = createSupabaseClient(c.env);
  const stats = await runScheduledReconcile(supabase, c.env.ZERNIO_API_KEY);
  return c.json({ ok: true, ...stats });
});

const RunTaskBody = z.object({
  businessId: z.string().uuid(),
  userId: z.string().uuid(),
  taskSlug: z.string().min(1),
  // Optional pass-through config — used by chain-pattern handlers to
  // forward state from the parent task_run to the chained child
  // task_run (e.g. llm_tier so the chained step bills by tier).
  // Stored verbatim on task_runs.config (jsonb).
  config: z.record(z.unknown()).optional(),
  // Optional: route a long-running task through the generic Queue (15-min
  // consumer budget) instead of the inline ~60s waitUntil path. Chain-pattern
  // callers omit it (unchanged behaviour); an operator sets it when a
  // whole-pool loop stage (enrichment) must process every row in one run.
  queue: z.boolean().optional(),
});

app.post("/run-task", async (c) => {
  const expected = c.env.INTERNAL_TRIGGER_SECRET;
  if (!expected) {
    log.error("internal.run_task.secret_unset", {});
    return c.json(errBody("not_configured", "INTERNAL_TRIGGER_SECRET unset"), 503);
  }

  const got = c.req.header("x-internal-secret") ?? "";
  if (got !== expected) {
    log.warn("internal.run_task.bad_secret", { had_header: got !== "" });
    return c.json(errBody("unauthorized", "bad internal secret"), 401);
  }

  let body: z.infer<typeof RunTaskBody>;
  try {
    body = RunTaskBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const { businessId, userId, taskSlug, config, queue } = body;

  const supabase = createSupabaseClient(c.env);

  // Resolve business (no user-ownership check — caller is the worker itself).
  const { data: bizRow, error: bizErr } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr) {
    log.error("internal.run_task.business_lookup_failed", { businessId, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!bizRow) {
    return c.json(errBody("not_found", `business '${businessId}' not found`), 404);
  }
  const business = bizRow as BusinessRow;

  // Resolve task by slug.
  let task;
  try {
    task = await getTaskBySlug(supabase, taskSlug);
  } catch (err) {
    log.error("internal.run_task.task_lookup_failed", { taskSlug, err: String(err) });
    return c.json(errBody("internal", "task_lookup_failed"), 500);
  }
  if (!task) {
    return c.json(errBody("not_found", `task '${taskSlug}' not found`), 404);
  }

  // ── Concurrency lock: reject if already running ──────────────────────
  const { data: runningRow, error: lockErr } = await supabase
    .from("task_runs")
    .select("id")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .eq("status", "running")
    .maybeSingle();
  if (lockErr) {
    log.error("internal.run_task.concurrency_lock_failed", {
      business_id: business.id,
      taskSlug,
      err: lockErr.message,
    });
    return c.json(errBody("internal", "concurrency_lock_check_failed"), 500);
  }
  if (runningRow) {
    return c.json(
      {
        error: "task_already_running",
        message: "This task is already running for this business.",
        task_slug: taskSlug,
      },
      409,
    );
  }

  // ── Attempt cap: block if >= 2 failures since last admin clear ────────
  // Non-fatal if table doesn't exist yet (migration 051 pending).
  const { data: blockRow, error: blockErr } = await supabase
    .from("task_trigger_blocks")
    .select("blocked_at")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .is("cleared_at", null)
    .maybeSingle();
  if (blockErr) {
    log.warn("internal.run_task.attempt_block_check_failed", {
      business_id: business.id,
      taskSlug,
      err: blockErr.message,
    });
  } else if (blockRow) {
    return c.json(
      {
        error: "task_attempt_limit_reached",
        message: "2 failed attempts — needs review",
        task_slug: taskSlug,
        blocked_at: blockRow.blocked_at,
      },
      429,
    );
  }

  // Optional queue routing: a long-running task with `queue:true` goes through
  // the generic Queue (15-min consumer budget) so whole-pool loop stages finish
  // in one run instead of plateauing at the ~60s waitUntil ceiling. Mirrors the
  // user endpoint's long-running path. Chain callers omit `queue` → inline path.
  if (queue && task.is_long_running && c.env.TASK_QUEUE) {
    const { data: qRow, error: qErr } = await supabase
      .from("task_runs")
      .insert({
        user_id: userId,
        business_id: business.id,
        task_id: task.id,
        status: "queued",
        config: config ?? null,
      })
      .select("id")
      .single();
    if (qErr || !qRow) {
      log.error("internal.run_task.queued_insert_failed", {
        business_id: business.id, taskSlug, err: qErr?.message,
      });
      return c.json(errBody("internal", "queued_row_insert_failed"), 500);
    }
    const qId = (qRow as { id: string }).id;
    try {
      await c.env.TASK_QUEUE.send({ taskRunId: qId, businessId: business.id, userId, taskSlug });
    } catch (sendErr) {
      await supabase
        .from("task_runs")
        .update({ status: "failed", error: "queue_send_failed", completed_at: new Date().toISOString() })
        .eq("id", qId);
      log.error("internal.run_task.queue_send_failed", {
        task_run_id: qId, taskSlug, err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
      return c.json(errBody("internal", "queue_send_failed"), 500);
    }
    return c.json({ accepted: true, task_run_id: qId, queued: true }, 202);
  }

  // Create the task_run row. No ownership / subscription / balance gates here —
  // this is an internal continuation of work the user already authorized in the
  // parent task. The parent task already passed those gates and (if applicable)
  // already paid the token cost.
  const { data: taskRunRow, error: insertErr } = await supabase
    .from("task_runs")
    .insert({
      user_id: userId,
      business_id: business.id,
      task_id: task.id,
      status: "running",
      started_at: new Date().toISOString(),
      // Forwarded config from parent chain task (see chain-pattern
      // handlers, e.g. generate-business-app-design).
      config: config ?? null,
    })
    .select("id")
    .single();

  if (insertErr || !taskRunRow) {
    log.error("internal.run_task.insert_failed", {
      business_id: business.id,
      task_slug: taskSlug,
      err: insertErr?.message,
    });
    return c.json(errBody("internal", "task_run_insert_failed"), 500);
  }

  const taskRunId = (taskRunRow as { id: string }).id;

  // Hand off to the existing background runner. Each internal call gets its
  // own Worker invocation, so this waitUntil has its own CPU/wall-clock budget.
  c.executionCtx.waitUntil(
    runTaskInBackground(c.env, business, task, userId, taskRunId),
  );

  return c.json(
    {
      accepted: true,
      task_run_id: taskRunId,
    },
    202,
  );
});

export default app;

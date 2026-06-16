import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient, updatePlaybookRun } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

/**
 * POST /api/builds/:run_id/resume
 *
 * Unblocks a free_build_run that the watchdog marked 'failed' after an SSE
 * disconnect. Resets the run to 'pending' so the next SSE reconnect re-enters
 * the orchestrator, which skips completed tasks and re-runs only the failed ones.
 *
 * Guards:
 *   - run must belong to the authenticated user
 *   - run must be in status='failed' (not completed or still running)
 *   - at least one failed task_run must have retry_count < max_retries
 *
 * On success: increments retry_count on all failed task_runs for this business,
 * resets free_build_run to status='pending', returns { resumed, run_id, retry_count }.
 */
app.post("/:run_id/resume", async (c) => {
  const auth = c.get("auth");
  const runId = c.req.param("run_id");
  const supabase = createSupabaseClient(c.env);

  // Load the run and verify ownership
  const { data: run, error: runErr } = await supabase
    .from("playbook_runs")
    .select("id, business_id, user_id, status")
    .eq("id", runId)
    .maybeSingle();

  if (runErr) {
    log.error("resume_run_query_failed", { run_id: runId, err: runErr.message });
    return c.json(errBody("internal", "DB error loading run"), 500);
  }
  if (!run) {
    return c.json(errBody("not_found", "build run not found"), 404);
  }
  if ((run as { user_id: string }).user_id !== auth.user_id) {
    return c.json(errBody("forbidden", "not your build"), 403);
  }
  if ((run as { status: string }).status !== "failed") {
    return c.json(errBody("conflict", `build is '${(run as { status: string }).status}', not 'failed'`), 409);
  }

  const businessId = (run as { business_id: string }).business_id;

  // Check if any failed task_runs still have retries available. Scoped by
  // the run_id FK (migration 044) — the failed tasks of THIS build only.
  const { data: failedRuns, error: trErr } = await supabase
    .from("task_runs")
    .select("id, retry_count, max_retries")
    .eq("run_id", runId)
    .eq("status", "failed");

  if (trErr) {
    log.error("resume_task_runs_query_failed", { run_id: runId, err: trErr.message });
    return c.json(errBody("internal", "DB error loading task runs"), 500);
  }

  const resumable = (failedRuns ?? []) as { id: string; retry_count: number; max_retries: number }[];
  const hasRetries = resumable.some((r) => r.retry_count < r.max_retries);

  if (!hasRetries) {
    return c.json(
      errBody("conflict", "max retries reached — build cannot be resumed"),
      409,
    );
  }

  // Increment retry_count on all failed task_runs that still have attempts left
  const resumableIds = resumable
    .filter((r) => r.retry_count < r.max_retries)
    .map((r) => r.id);

  const newRetryCount = Math.max(...resumable.map((r) => r.retry_count)) + 1;

  const { error: incrErr } = await supabase
    .from("task_runs")
    .update({ retry_count: newRetryCount })
    .in("id", resumableIds);

  if (incrErr) {
    log.warn("resume_retry_count_increment_failed", { run_id: runId, err: incrErr.message });
    // Non-fatal — continue with the resume
  }

  // Reset the playbook_run to pending so the SSE handler re-enters the orchestrator
  await updatePlaybookRun(supabase, runId, {
    status: "pending",
    failed_at: null,
    failure_reason: null,
  });

  log.info("build_resumed", { run_id: runId, business_id: businessId, retry_count: newRetryCount });

  return c.json({ resumed: true, run_id: runId, retry_count: newRetryCount });
});

export default app;

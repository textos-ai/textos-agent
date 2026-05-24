import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../lib/logger";

/**
 * Watchdog cron — runs every 60 seconds via Cloudflare cron trigger.
 *
 * Any free_build_run stuck in status='running' with a last_heartbeat_at
 * older than 90 seconds is assumed orphaned (the Worker died mid-build,
 * e.g. hard browser refresh that killed the SSE connection).
 *
 * For each orphaned run:
 *   1. Mark free_build_runs.status = 'failed', error = 'heartbeat_timeout'
 *   2. Mark any still-running task_runs for that business as failed
 *      so they don't block the resume flow
 */
export async function runHeartbeatWatchdog(supabase: SupabaseClient): Promise<void> {
  const staleCutoff = new Date(Date.now() - 90_000).toISOString();

  // Find all builds whose heartbeat stopped > 90 s ago
  const { data: staleRuns, error: queryErr } = await supabase
    .from("free_build_runs")
    .select("id, business_id")
    .eq("status", "running")
    .lt("last_heartbeat_at", staleCutoff);

  if (queryErr) {
    log.error("watchdog_query_failed", { err: queryErr.message });
    return;
  }

  // Sweep paid task_runs that have been 'running' > 5 min. Paid tasks
  // should complete in <90s in the happy path; anything past 5 min is
  // almost always a crashed worker (waitUntil cancellation, Anthropic
  // timeout, OOM). Extended from 3min to 5min so the chained
  // generate-business-app-html step (Sonnet + 4000 max_tokens) has room
  // on the long tail. The per-business inline sweep in
  // business-task-run.ts uses the same 5-min cutoff. Per-task wall clock
  // still belongs to each handler's withTimeout wrapper.
  const taskTimeoutCutoff = new Date(Date.now() - 300_000).toISOString();
  const { data: stalePaidTasks, error: paidErr } = await supabase
    .from("task_runs")
    .update({
      status: "failed",
      error: "timeout_2min",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", taskTimeoutCutoff)
    .select("id, business_id");
  if (paidErr) {
    log.error("watchdog_paid_sweep_failed", { err: paidErr.message });
  } else if (stalePaidTasks && stalePaidTasks.length > 0) {
    log.warn("watchdog_paid_timeout", {
      count: stalePaidTasks.length,
      ids: (stalePaidTasks as { id: string }[]).map((r) => r.id),
    });
  }

  if (!staleRuns || staleRuns.length === 0) return;

  log.warn("watchdog_found_stale_runs", { count: staleRuns.length });

  for (const run of staleRuns as { id: string; business_id: string }[]) {
    log.warn("watchdog_timing_out_run", { run_id: run.id, business_id: run.business_id });

    // 1. Mark the build failed
    const { error: runErr } = await supabase
      .from("free_build_runs")
      .update({
        status: "failed",
        error: "heartbeat_timeout",
        failed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("status", "running"); // guard against race with a legitimate completion

    if (runErr) {
      log.error("watchdog_run_update_failed", { run_id: run.id, err: runErr.message });
      continue;
    }

    // 2. Mark any task_runs still 'running' for this business as failed.
    // task_runs link to free_build_runs through business_id (no FK column).
    // retry_count is intentionally left alone — it is incremented by the
    // resume endpoint when the user explicitly retries, not by the watchdog.
    const { error: taskErr } = await supabase
      .from("task_runs")
      .update({
        status: "failed",
        state: "failed",
        error: "orchestrator died — auto-recovered",
        failed_at: new Date().toISOString(),
      })
      .eq("business_id", run.business_id)
      .eq("state", "running");

    if (taskErr) {
      log.warn("watchdog_task_update_failed", { business_id: run.business_id, err: taskErr.message });
    }
  }
}

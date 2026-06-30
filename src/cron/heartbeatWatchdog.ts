import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../lib/logger";

/**
 * Watchdog cron — runs every 60 seconds via Cloudflare cron trigger.
 *
 * Any playbook_run stuck in status='running' with a last_heartbeat_at
 * older than 90 seconds is assumed orphaned (the Worker died mid-build,
 * e.g. hard browser refresh that killed the SSE connection).
 *
 * For each orphaned run:
 *   1. Mark playbook_runs.status = 'failed', failure_reason = 'heartbeat_timeout'
 *   2. Mark any still-running task_runs for that run as failed
 *      so they don't block the resume flow
 */
export async function runHeartbeatWatchdog(supabase: SupabaseClient): Promise<void> {
  const staleCutoff = new Date(Date.now() - 90_000).toISOString();

  // Find all builds whose heartbeat stopped > 90 s ago
  const { data: staleRuns, error: queryErr } = await supabase
    .from("playbook_runs")
    .select("id, business_id")
    .eq("status", "running")
    .lt("last_heartbeat_at", staleCutoff);

  if (queryErr) {
    log.error("watchdog_query_failed", { err: queryErr.message });
    return;
  }

  // Two-tier task_run sweep:
  //   60s  — free-build and other short tasks (expected <30s in happy path)
  //   300s — generate-business-app* + public-business-website + customer-understanding
  //          (legitimately run 60-120s — deep synthesis over full business context)
  // Long tasks are excluded from the 60s sweep to prevent killing healthy runs.
  // The per-business inline sweep in business-task-run.ts uses the same two-tier logic.
  const { data: longTaskRows } = await supabase
    .from("tasks")
    .select("id")
    .or("slug.like.generate-business-app%,slug.eq.public-business-website,slug.eq.customer-understanding");
  const longTaskIds = (longTaskRows ?? []).map((r: { id: string }) => r.id);

  const shortCutoff = new Date(Date.now() - 60_000).toISOString();
  const shortQ = supabase
    .from("task_runs")
    .update({ status: "failed", error: "timeout_60s", completed_at: new Date().toISOString() })
    .eq("status", "running")
    .lt("started_at", shortCutoff)
    .select("id, business_id");
  const { data: stalePaidTasks, error: paidErr } = await (longTaskIds.length > 0
    ? shortQ.not("task_id", "in", `(${longTaskIds.join(",")})`)
    : shortQ);
  if (paidErr) {
    log.error("watchdog_paid_sweep_failed", { err: paidErr.message });
  } else if (stalePaidTasks && stalePaidTasks.length > 0) {
    log.warn("watchdog_paid_timeout", {
      count: stalePaidTasks.length,
      ids: (stalePaidTasks as { id: string }[]).map((r) => r.id),
    });
  }

  if (longTaskIds.length > 0) {
    const longCutoff = new Date(Date.now() - 300_000).toISOString();
    const { data: staleAppTasks, error: appErr } = await supabase
      .from("task_runs")
      .update({ status: "failed", error: "timeout_5min", completed_at: new Date().toISOString() })
      .eq("status", "running")
      .lt("started_at", longCutoff)
      .in("task_id", longTaskIds)
      .select("id, business_id");
    if (appErr) {
      log.error("watchdog_app_sweep_failed", { err: appErr.message });
    } else if (staleAppTasks && staleAppTasks.length > 0) {
      log.warn("watchdog_app_timeout", {
        count: staleAppTasks.length,
        ids: (staleAppTasks as { id: string }[]).map((r) => r.id),
      });
    }
  }

  if (!staleRuns || staleRuns.length === 0) return;

  log.warn("watchdog_found_stale_runs", { count: staleRuns.length });

  for (const run of staleRuns as { id: string; business_id: string }[]) {
    log.warn("watchdog_timing_out_run", { run_id: run.id, business_id: run.business_id });

    // 1. Mark the build failed
    const { error: runErr } = await supabase
      .from("playbook_runs")
      .update({
        status: "failed",
        failure_reason: "heartbeat_timeout",
        failed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("status", "running"); // guard against race with a legitimate completion

    if (runErr) {
      log.error("watchdog_run_update_failed", { run_id: run.id, err: runErr.message });
      continue;
    }

    // 2. Mark any task_runs still 'running' for THIS run as failed.
    // task_runs now link to playbook_runs through the run_id FK (migration
    // 044), so we scope by run_id rather than the old business_id+timing
    // heuristic. retry_count is intentionally left alone — it is incremented
    // by the resume endpoint when the user explicitly retries, not the watchdog.
    const { error: taskErr } = await supabase
      .from("task_runs")
      .update({
        status: "failed",
        state: "failed",
        error: "orchestrator died — auto-recovered",
        failed_at: new Date().toISOString(),
      })
      .eq("run_id", run.id)
      .eq("state", "running");

    if (taskErr) {
      log.warn("watchdog_task_update_failed", { business_id: run.business_id, err: taskErr.message });
    }
  }
}

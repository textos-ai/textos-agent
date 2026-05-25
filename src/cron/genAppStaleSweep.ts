import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../lib/logger";

/**
 * runGenAppStaleSweep — 10-minute cron sweep for stuck
 * generate-business-app% task_runs.
 *
 * Belt-and-suspenders cleanup. The handler-level 45s/90s timeouts on the
 * Anthropic calls SHOULD catch hung generations; this is the safety net
 * for cases where the Worker invocation was killed before the handler
 * could flip status (Cloudflare wall-clock cap on waitUntil, OOM, etc.).
 *
 * SHARED-STATE NOTE: task_runs has no environment identifier column.
 * Test and prod agents share the same Supabase. This cron is wired to
 * run ONLY on prod (top-level [triggers] in wrangler.toml; [env.test.triggers]
 * is empty by design). When it fires, it sweeps task_runs from BOTH
 * environments — there is no way to scope by env at the row level today.
 * Acceptable today: any generate-business-app% row >10 min old is
 * legitimately stuck regardless of env. Document the risk in the cron
 * file and the handler comment, revisit if a per-env identifier ever
 * gets added to task_runs.
 *
 * Threshold: 10 minutes. The two handlers' own AbortController timeouts
 * fire at 45s (design) and 90s (HTML); the per-poll inline sweep at
 * business-task-run.ts:458 fires at 5 min; this cron is the last line.
 */
export async function runGenAppStaleSweep(
  supabase: SupabaseClient,
): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  // Two-step: fetch the task_ids whose slug matches the prefix, then
  // UPDATE task_runs where task_id IN (...). PostgREST doesn't support
  // UPDATE...FROM-style joins through the client, so a Postgres RPC
  // or two-step is the choice. Two-step is the least magic; the row
  // count is small (4 task slugs at most for this chain).
  const { data: matchingTasks, error: taskErr } = await supabase
    .from("tasks")
    .select("id")
    .like("slug", "generate-business-app%");

  if (taskErr) {
    log.error("genapp_stale_sweep_task_lookup_failed", { err: taskErr.message });
    return;
  }
  const taskIds = (matchingTasks ?? []).map((t: { id: string }) => t.id);
  if (taskIds.length === 0) {
    log.warn("genapp_stale_sweep_no_matching_tasks", {});
    return;
  }

  const { data: swept, error: updateErr } = await supabase
    .from("task_runs")
    .update({
      status: "failed",
      error: "timeout_stale",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .in("task_id", taskIds)
    .select("id, business_id, task_id");

  if (updateErr) {
    log.error("genapp_stale_sweep_update_failed", { err: updateErr.message });
    return;
  }

  if (swept && swept.length > 0) {
    log.warn("genapp_stale_sweep_swept", {
      count: swept.length,
      ids: (swept as { id: string }[]).map((r) => r.id),
    });
  } else {
    log.info("genapp_stale_sweep_clean", { cutoff });
  }
}

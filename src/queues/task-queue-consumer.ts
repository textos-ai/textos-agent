import type { Env } from "../env";
import {
  createSupabaseClient,
  getTaskBySlug,
  type BusinessRow,
} from "../services/supabase";
import { runTaskInBackground } from "../routes/business-task-run";
import { log } from "../lib/logger";
import type { TaskQueueMessage } from "./types";

/**
 * Consumer for textos-task-queue-{prod,test} — the GENERIC long-task path.
 *
 * Any task flagged tasks.is_long_running is routed here by the run endpoint
 * instead of the inline waitUntil path. Each consumer invocation gets a
 * ~15-minute wall-clock budget, so loop stages (retrieval + per-lead
 * enrichment) process the FULL pool instead of dying at the ~60s waitUntil
 * ceiling that produced the 5/7 plateau.
 *
 * Idempotency contract (same as app-gen-html, per Rob 2026-05-25):
 *   - row exists, status='completed' → ack + skip
 *   - row exists, status='running'   → ack + skip
 *   - row exists, status='queued'    → atomic claim → run
 *   - row exists, status='failed'    → atomic claim → run (retry)
 *   - row missing                    → log + ack + skip (unexpected)
 *
 * On handler failure we retry() so CF redelivers (≤ max_retries). The shared
 * runTaskInBackground flips the row to 'failed' on exception via its own catch;
 * the throw/retry here just signals the queue runtime, and the next attempt
 * re-claims via the atomic 'failed'→'running' flip — no double-charge, and the
 * per-lead commits inside the runner are idempotent on re-run.
 */
export async function processTaskQueueBatch(
  batch: MessageBatch<TaskQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(message.body, env, message.attempts ?? 0);
      message.ack();
    } catch (err) {
      log.error("[task-queue] consumer_failed", {
        task_run_id: message.body.taskRunId,
        task_slug: message.body.taskSlug,
        attempt: message.attempts ?? 0,
        err: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}

async function processOne(
  job: TaskQueueMessage,
  env: Env,
  attempt: number,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // ── Idempotency: read current row state ───────────────────────────────────
  const { data: existing, error: lookupErr } = await supabase
    .from("task_runs")
    .select("status")
    .eq("id", job.taskRunId)
    .maybeSingle();
  if (lookupErr) {
    // DB hiccup — throw so CF retries rather than silently dropping the job.
    throw new Error(`task_run_lookup_failed: ${lookupErr.message}`);
  }
  if (!existing) {
    // Producer pre-creates the row; a missing row means manual delete or a
    // failed insert. Don't reconstruct — ack so it stops retrying.
    log.warn("[task-queue] consumer_skipped", {
      task_run_id: job.taskRunId,
      reason: "task_run_row_missing",
    });
    return;
  }
  const status = existing.status as string;
  if (status === "completed" || status === "running") {
    log.info("[task-queue] consumer_skipped", {
      task_run_id: job.taskRunId,
      reason: `existing_status_${status}`,
    });
    return;
  }

  // Claim states: 'queued' (first) or 'failed' (retry). Atomic flip.
  const { data: claimed, error: claimErr } = await supabase
    .from("task_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.taskRunId)
    .in("status", ["queued", "failed"])
    .select("id")
    .maybeSingle();
  if (claimErr) throw new Error(`task_run_claim_failed: ${claimErr.message}`);
  if (!claimed) {
    log.info("[task-queue] consumer_skipped", {
      task_run_id: job.taskRunId,
      reason: "claim_lost",
      previous_status: status,
    });
    return;
  }

  // ── Load business + task to build the runTaskInBackground args ─────────────
  const { data: bizRow, error: bizErr } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", job.businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr || !bizRow) {
    const errMsg = bizErr?.message ?? "business_not_found_or_inactive";
    await supabase
      .from("task_runs")
      .update({ status: "failed", error: `consumer_business_lookup_failed: ${errMsg}`, completed_at: new Date().toISOString() })
      .eq("id", job.taskRunId)
      .eq("status", "running");
    throw new Error(`business_lookup_failed: ${errMsg}`);
  }
  const business = bizRow as BusinessRow;

  const task = await getTaskBySlug(supabase, job.taskSlug);
  if (!task) {
    await supabase
      .from("task_runs")
      .update({ status: "failed", error: `task_row_missing: ${job.taskSlug}`, completed_at: new Date().toISOString() })
      .eq("id", job.taskRunId)
      .eq("status", "running");
    return;
  }

  // ── Dispatch the SHARED runner, inline, within the 15-min budget ──────────
  log.info("[task-queue] consumer_dispatch_start", {
    task_run_id: job.taskRunId,
    task_slug: job.taskSlug,
    previous_status: status,
    attempt,
  });
  await runTaskInBackground(env, business, task, job.userId, job.taskRunId);

  // runTaskInBackground swallows exceptions (flips row to 'failed' itself).
  // Read final status to decide ack vs retry.
  const { data: final } = await supabase
    .from("task_runs")
    .select("status")
    .eq("id", job.taskRunId)
    .maybeSingle();
  if (final?.status === "failed") {
    log.warn("[task-queue] consumer_dispatch_failed", {
      task_run_id: job.taskRunId,
      task_slug: job.taskSlug,
      attempt,
    });
    throw new Error("task_handler_failed_signaling_queue_retry");
  }
  log.info("[task-queue] consumer_dispatch_complete", {
    task_run_id: job.taskRunId,
    task_slug: job.taskSlug,
    final_status: final?.status ?? "unknown",
    attempt,
  });
}

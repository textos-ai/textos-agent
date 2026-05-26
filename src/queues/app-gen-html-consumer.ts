import type { Env } from "../env";
import {
  createSupabaseClient,
  getTaskBySlug,
  type BusinessRow,
} from "../services/supabase";
import { runTaskInBackground } from "../routes/business-task-run";
import {
  genAppLog,
  takeGenAppEvents,
  setGenAppLogSink,
} from "../lib/gen-app-log";
import { serializeGenAppError } from "../lib/gen-app-error";
import type { HtmlJobMessage } from "./types";

/**
 * Consumer for textos-app-gen-html-{prod,test}. Each consumer invocation
 * gets a 15-minute wall-clock budget — replacing the Service Binding
 * chain trigger fixes the silent-kill problem that hit
 * generate-business-app-html on long streaming responses inside the
 * waitUntil-driven request lifecycle.
 *
 * Idempotency contract (per Rob, 2026-05-25):
 *   - row exists, status='completed' → ACK + skip
 *   - row exists, status='running'   → ACK + skip
 *   - row exists, status='queued'    → atomic claim → run
 *   - row exists, status='failed'    → atomic claim → run (retry)
 *   - row missing                    → log + ACK + skip (unexpected)
 *
 * On handler failure we throw so CF Queue retries (max_retries=3 per
 * wrangler.toml). runTaskInBackground sets task_runs.status='failed' on
 * exception via its internal catch block — the throw here just signals
 * the queue runtime to redeliver. Each retry runs the idempotency check
 * again and the 'failed' → 'running' atomic flip claims the row.
 */
// Canonical [GEN-APP] event names for this consumer (per Rob's spec
// 2026-05-25). Hardcoded as constants so renames don't accidentally drift
// from the handler-side logs Rob filters on:
//   consumer_message_received   one per message at entry
//   consumer_task_run_check     before/after the idempotency lookup
//   consumer_skipped            row is in completed/running, or missing,
//                               or we lost the atomic claim race
//   consumer_dispatch_start     atomic claim won → about to run handler
//   consumer_dispatch_complete  handler returned successfully
//   consumer_failed             any thrown error (also triggers CF retry)
// Additional auxiliary events use the consumer_ prefix for grep symmetry
// but are not part of the canonical six.

export async function processAppGenHtmlBatch(
  batch: MessageBatch<HtmlJobMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await processOne(job, env, message.attempts ?? 0);
      message.ack();
    } catch (err) {
      genAppLog("consumer_failed", {
        business_id: job.businessId,
        task_run_id: job.htmlTaskRunId,
        design_task_run_id: job.designTaskRunId,
        attempt: message.attempts ?? 0,
        err_message: err instanceof Error ? err.message : String(err),
      });
      // Let CF retry up to max_retries. Explicit retry() to be defensive
      // against runtime variations in retry-on-throw semantics.
      message.retry();
    }
  }
}

async function processOne(
  job: HtmlJobMessage,
  env: Env,
  attempt: number,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // Wire the durable gen_app_logs sink for this consumer invocation.
  // Without this, genAppLog calls inside the consumer (and inside the
  // HTML handler it dispatches) write only to wrangler tail and the
  // in-memory buffer — they never land in the gen_app_logs table that
  // apps.astro now reads from on page load.
  setGenAppLogSink(supabase);

  genAppLog("consumer_message_received", {
    business_id: job.businessId,
    task_run_id: job.htmlTaskRunId,
    design_task_run_id: job.designTaskRunId,
    attempt,
  });

  // ── Idempotency: check existing row state ─────────────────────────────────
  genAppLog("consumer_task_run_check", {
    business_id: job.businessId,
    task_run_id: job.htmlTaskRunId,
    phase: "start",
  });
  const { data: existing, error: lookupErr } = await supabase
    .from("task_runs")
    .select("status")
    .eq("id", job.htmlTaskRunId)
    .maybeSingle();

  if (lookupErr) {
    genAppLog("consumer_task_run_check", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      phase: "failed",
      err: lookupErr.message,
    });
    // Throw so CF retries — DB hiccups should not silently drop the job.
    throw new Error(`task_run_lookup_failed: ${lookupErr.message}`);
  }

  if (!existing) {
    // Row should exist — producer pre-creates before sending the message.
    // If it's missing, something is wrong (manual delete, prior failed
    // INSERT, etc.). Don't try to reconstruct — log and ACK so the message
    // doesn't keep retrying forever.
    genAppLog("consumer_skipped", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      design_task_run_id: job.designTaskRunId,
      reason: "task_run_row_missing",
    });
    return;
  }

  const status = existing.status as string;
  genAppLog("consumer_task_run_check", {
    business_id: job.businessId,
    task_run_id: job.htmlTaskRunId,
    phase: "complete",
    observed_status: status,
  });

  // Skip-states per Rob's contract.
  if (status === "completed" || status === "running") {
    genAppLog("consumer_skipped", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      reason: `existing_status_${status}`,
    });
    return;
  }

  // Claim states: 'queued' (first time) or 'failed' (retry).
  // Atomic flip via UPDATE WHERE id=X AND status IN (...). If another
  // consumer beat us to it, this returns zero rows and we skip.
  const { data: claimed, error: claimErr } = await supabase
    .from("task_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.htmlTaskRunId)
    .in("status", ["queued", "failed"])
    .select("id")
    .maybeSingle();

  if (claimErr) {
    genAppLog("consumer_claim_failed", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      err: claimErr.message,
    });
    throw new Error(`task_run_claim_failed: ${claimErr.message}`);
  }

  if (!claimed) {
    // Lost the race — another consumer claimed it between our lookup and
    // the atomic UPDATE. Rare with max_batch_size=1 but possible across
    // retry windows. Treat the same as the skip path.
    genAppLog("consumer_skipped", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      reason: "claim_lost",
      previous_status: status,
    });
    return;
  }

  // ── Look up business + task to build the runTaskInBackground args ─────────
  const { data: bizRow, error: bizErr } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", job.businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr || !bizRow) {
    const errMsg = bizErr?.message ?? "business_not_found_or_inactive";
    genAppLog("consumer_business_lookup_failed", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      err: errMsg,
    });
    await supabase
      .from("task_runs")
      .update({
        status: "failed",
        error: serializeGenAppError(
          `consumer_business_lookup_failed: ${errMsg}`,
          takeGenAppEvents(job.htmlTaskRunId),
        ),
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.htmlTaskRunId)
      .eq("status", "running");
    throw new Error(`business_lookup_failed: ${errMsg}`);
  }
  const business = bizRow as BusinessRow;

  let htmlTask;
  try {
    htmlTask = await getTaskBySlug(supabase, "generate-business-app-html");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    genAppLog("consumer_task_lookup_failed", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      err: errMsg,
    });
    throw new Error(`task_lookup_failed: ${errMsg}`);
  }
  if (!htmlTask) {
    genAppLog("consumer_task_lookup_failed", {
      business_id: job.businessId,
      task_run_id: job.htmlTaskRunId,
      err: "task_row_missing",
    });
    await supabase
      .from("task_runs")
      .update({
        status: "failed",
        error: serializeGenAppError(
          "generate-business-app-html task row missing",
          takeGenAppEvents(job.htmlTaskRunId),
        ),
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.htmlTaskRunId)
      .eq("status", "running");
    return;
  }

  // ── Dispatch the handler ──────────────────────────────────────────────────
  // runTaskInBackground manages the rest of the lifecycle: it dispatches
  // runGenerateBusinessAppHtml, then runs the tier-aware debit, then sets
  // task_runs.status='completed'. On exception it sets status='failed' via
  // its own catch block (and writes the structured error payload for the
  // gen-app slug). We await it inline — the consumer has the full 15-min
  // wall-clock budget so waitUntil indirection isn't needed.
  genAppLog("consumer_dispatch_start", {
    business_id: business.id,
    task_run_id: job.htmlTaskRunId,
    previous_status: status,
    attempt,
  });
  await runTaskInBackground(env, business, htmlTask, job.userId, job.htmlTaskRunId);

  // If runTaskInBackground encountered an error it already flipped the row
  // to 'failed' and returned (it swallows exceptions internally). Look at
  // the final status to decide whether to ACK or throw-for-retry.
  const { data: final } = await supabase
    .from("task_runs")
    .select("status")
    .eq("id", job.htmlTaskRunId)
    .maybeSingle();

  if (final?.status === "failed") {
    genAppLog("consumer_dispatch_complete", {
      business_id: business.id,
      task_run_id: job.htmlTaskRunId,
      final_status: "failed",
      attempt,
    });
    // Throw so CF Queue retries up to max_retries=3. The next retry will
    // see status='failed', atomically claim it, and re-dispatch.
    throw new Error("html_handler_failed_signaling_queue_retry");
  }

  genAppLog("consumer_dispatch_complete", {
    business_id: business.id,
    task_run_id: job.htmlTaskRunId,
    final_status: final?.status ?? "unknown",
    attempt,
  });
}

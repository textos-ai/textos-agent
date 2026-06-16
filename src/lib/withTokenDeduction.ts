import type { TaskCtx, TaskResult, TaskFn } from "./tasks/types";
import { log } from "./logger";

// ── Bundle catalog ────────────────────────────────────────────────────────
// Must stay in sync with STRIPE_PRICE_TOPUP_* env vars and checkout.ts bundles.
const BUNDLES = [
  { slug: "topup_10", tokens: 10,  price_cents:  999 },
  { slug: "topup_30", tokens: 30,  price_cents: 2499 },
  { slug: "topup_75", tokens: 75,  price_cents: 4999 },
];

export function buildBundleSuggestions(deficit: number) {
  return BUNDLES.map((b) => ({ ...b, sufficient: b.tokens >= deficit }));
}

// ── Error classes ─────────────────────────────────────────────────────────

export class InsufficientTokensError extends Error {
  constructor(
    public readonly details: {
      available:          number;
      requested:          number;
      deficit:            number;
      bundle_suggestions: ReturnType<typeof buildBundleSuggestions>;
      business_id:        string;
      task_slug:          string;
    },
  ) {
    super(`insufficient_tokens: ${details.task_slug}`);
    this.name = "InsufficientTokensError";
  }
}

export class SubscriptionRequiredError extends Error {
  constructor(
    public readonly details: {
      business_id: string;
      task_slug:   string;
      token_cost:  number;
    },
  ) {
    super(`subscription_required: ${details.task_slug}`);
    this.name = "SubscriptionRequiredError";
  }
}

// ── Pipeline step type (mirrors PIPELINE array in free-build-orchestrator) ─
export interface PipelineStep {
  slug: string;
  name: string;
  fn:   TaskFn;
}

// ── debit_tokens RPC response shape ──────────────────────────────────────
interface DebitResult {
  ok:               boolean;
  reason?:          string;
  available?:       number;
  requested?:       number;
  from_period?:     number;
  from_topup?:      number;
  period_remaining?: number;
  topup_remaining?:  number;
}

// ── Main wrapper ──────────────────────────────────────────────────────────

export async function runTaskWithDeduction(
  step:    PipelineStep,
  taskCtx: TaskCtx,
): Promise<TaskResult> {
  const { supabase, business, user, taskRunId, runId } = taskCtx;
  // taskRunId and runId are guaranteed populated by free-build-orchestrator's
  // createTaskRunForBuild + createPlaybookRun. This wrapper is currently only
  // called from the orchestrator's line 313; if a V1.1 single-task-run path is
  // added later, ensure it constructs TaskCtx with both fields.

  // 1. Look up task to get token_cost (and task.id for retry scoping)
  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, slug, name, token_cost")
    .eq("slug", step.slug)
    .single();

  if (taskErr || !task) {
    log.error("[deduct] task_not_found", { slug: step.slug, err: taskErr?.message });
    throw new Error(`task_not_found: ${step.slug}`);
  }

  log.info("[deduct] start", {
    task_slug:   step.slug,
    token_cost:  task.token_cost,
    business_id: business.id,
  });

  // 2. Free task short-circuit — no DB writes, no log noise
  if ((task.token_cost as number) === 0) {
    return step.fn(taskCtx);
  }

  // 3. Scope retry detection to this run: fetch run's start time
  const { data: runRow, error: runErr } = await supabase
    .from("playbook_runs")
    .select("started_at")
    .eq("id", runId)
    .single();

  if (runErr || !runRow) {
    // Run row must always exist — runId came from the orchestrator.
    // Halt rather than silently mis-charge the user.
    log.error("[deduct] run_lookup_failed", { run_id: runId, err: runErr?.message });
    throw new Error(`run_lookup_failed: ${runErr?.message}`);
  }

  // 4. Retry detection: prior failed task_run within this run's lifetime
  const { data: priorFailed, error: priorErr } = await supabase
    .from("task_runs")
    .select("id")
    .eq("business_id", business.id)
    .eq("task_id", task.id as string)
    .eq("status", "failed")
    .gte("started_at", (runRow as { started_at: string }).started_at);

  if (priorErr) {
    log.error("[deduct] retry_check_failed", {
      business_id: business.id,
      task_slug:   step.slug,
      err:         priorErr.message,
    });
    throw new Error(`retry_check_failed: ${priorErr.message}`);
  }

  const isRetry = (priorFailed?.length ?? 0) > 0;

  if (isRetry) {
    log.info("[deduct] retry_free", {
      business_id:    business.id,
      task_slug:      step.slug,
      prior_failures: priorFailed!.length,
    });
    return step.fn(taskCtx);
  }

  // 5. Active subscription required for paid tasks (past_due is blocked)
  const { data: sub, error: subErr } = await supabase
    .from("business_subscriptions")
    .select("status")
    .eq("business_id", business.id)
    .in("status", ["trialing", "active"])
    .maybeSingle();

  if (subErr) {
    log.error("[deduct] sub_check_failed", {
      business_id: business.id,
      task_slug:   step.slug,
      err:         subErr.message,
    });
    throw new Error(`sub_check_failed: ${subErr.message}`);
  }

  if (!sub) {
    throw new SubscriptionRequiredError({
      business_id: business.id,
      task_slug:   step.slug,
      token_cost:  task.token_cost as number,
    });
  }

  // 6. Debit tokens
  const { data: rawDebit, error: debitErr } = await supabase.rpc("debit_tokens", {
    p_business_id: business.id,
    p_user_id:     user.id,
    p_tokens:      task.token_cost as number,
    p_task_slug:   task.slug as string,
    p_task_run_id: taskRunId,
    p_description: `Task: ${task.name as string}`,
  });

  if (debitErr) {
    log.error("[deduct] rpc_failed", {
      business_id: business.id,
      task_slug:   step.slug,
      err:         debitErr.message,
    });
    throw new Error(`debit_tokens_failed: ${debitErr.message}`);
  }

  const debitResult = rawDebit as DebitResult;

  // 7. Handle RPC rejection
  if (!debitResult?.ok) {
    if (debitResult?.reason === "insufficient_tokens") {
      const available = debitResult.available ?? 0;
      const requested = debitResult.requested ?? (task.token_cost as number);
      const deficit   = requested - available;
      throw new InsufficientTokensError({
        available,
        requested,
        deficit,
        bundle_suggestions: buildBundleSuggestions(deficit),
        business_id:        business.id,
        task_slug:          step.slug,
      });
    }
    // no_balance_row or invalid_token_count are system errors, not user errors
    log.error("[deduct] rpc_rejected", {
      business_id: business.id,
      task_slug:   step.slug,
      reason:      debitResult?.reason,
    });
    throw new Error(`debit_rejected: ${debitResult?.reason ?? "unknown"}`);
  }

  // 8. Debit succeeded — run the task
  log.info("[deduct] debited", {
    business_id: business.id,
    task_slug:   step.slug,
    debited:     task.token_cost,
    from_period: debitResult.from_period,
    from_topup:  debitResult.from_topup,
  });

  return step.fn(taskCtx);
}

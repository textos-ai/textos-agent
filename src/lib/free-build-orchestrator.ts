import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { StreamEvent } from "./stream-events";
import type { BusinessRow, BusinessContextRow, UserRow } from "../services/supabase";
import {
  getFreeBuildRunByBusiness,
  createFreeBuildRun,
  updateFreeBuildRun,
  persistStreamEvent,
  getTaskBySlug,
  createTaskRunForBuild,
  completeTaskRun,
  failTaskRun,
  getCompletedTaskRunSlugs,
  upsertBusinessContext,
} from "../services/supabase";
import type { TaskCtx, TaskFn } from "./tasks/types";
import {
  runTaskWithDeduction,
  InsufficientTokensError,
  SubscriptionRequiredError,
} from "./withTokenDeduction";
import { log } from "./logger";
import { extractErrorMessage } from "./extract-error";

import { runResearchStrategy } from "./tasks/research-strategy";
import { runWelcomeEmail } from "./tasks/welcome-email";
import { runLaunchTweet } from "./tasks/launch-tweet";
import { runBusinessLandingPage } from "./tasks/business-landing-page";
import { runLogo } from "./tasks/logo";
import { runMissionDocument } from "./tasks/mission-document";
import { runDashboardBriefing } from "./tasks/dashboard-briefing";
import { runTamSamSom } from "./tasks/tam-sam-som";
import { runPersonalizedPitchEmail } from "./tasks/personalized-pitch-email";
import { runSocialContentPlan } from "./tasks/social-content-plan";
import { runColdEmailOutreach } from "./tasks/cold-email-outreach";

// Slug → TaskFn dispatch map. Acceptable code constant per CLAUDE.md:
// it maps slug → handler function, which is execution logic, not DB data.
// The actual list of which slugs run in the free build comes from the DB
// (tasks WHERE is_default = true AND status = 'active' ORDER BY execution_order).
//
// Add an entry here only when a new task has a dedicated handler. Tasks
// without a dedicated handler fall through to genericDocumentRunner.
export const FREE_BUILD_TASK_HANDLERS: Record<string, TaskFn> = {
  "research-strategy":         runResearchStrategy,
  "mission-document":          runMissionDocument,
  "tam-sam-som":               runTamSamSom,
  "business-landing-page":     runBusinessLandingPage,
  "launch-tweet":              runLaunchTweet,
  "logo":                      runLogo,
  "cold-email-outreach":       runColdEmailOutreach,
  "welcome-email":             runWelcomeEmail,
  "social-content-plan":       runSocialContentPlan,
  "personalized-pitch-email":  runPersonalizedPitchEmail,
  "dashboard-briefing":        runDashboardBriefing,
};

/**
 * Runs the complete free-build pipeline for a business.
 *
 * Called directly from the SSE stream handler. Every SSE event is both
 * emitted on the live stream AND persisted to stream_events for replay.
 *
 * Idempotent: already-completed tasks are skipped, so a reconnect after
 * a partial run resumes rather than restarts.
 */
export async function runFreeBuild(
  env: Env,
  supabase: SupabaseClient,
  business: BusinessRow,
  user: UserRow,
  sseEmit: (evt: StreamEvent) => Promise<void>,
  cfLocation?: { lat: number; lng: number } | null,
): Promise<void> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // ── Load the free-build pipeline from the DB ──────────────────────
  // Single source of truth: tasks WHERE is_default=true AND status=active.
  // No hardcoded slug list — adding/removing a free build task is a DB write.
  const { data: pipelineRows, error: pipelineErr } = await supabase
    .from("tasks")
    .select("slug, name, execution_order")
    .eq("is_default", true)
    .eq("status", "active")
    .order("execution_order", { ascending: true });

  if (pipelineErr) {
    log.error("[orchestrator] pipeline_query_failed", {
      business_id: business.id,
      err: pipelineErr.message,
    });
    await sseEmit({
      type: "error" as StreamEvent["type"],
      message: `Build failed: pipeline query failed (${pipelineErr.message})`,
      ts: Date.now(),
    } as unknown as StreamEvent).catch(() => {});
    throw new Error(`pipeline_query_failed: ${pipelineErr.message}`);
  }

  const pipeline = (pipelineRows ?? []) as Array<{
    slug: string;
    name: string;
    execution_order: number;
  }>;

  if (pipeline.length === 0) {
    log.error("[orchestrator] pipeline_empty", { business_id: business.id });
    await sseEmit({
      type: "error" as StreamEvent["type"],
      message: "Build failed: no active default tasks configured in DB",
      ts: Date.now(),
    } as unknown as StreamEvent).catch(() => {});
    throw new Error("pipeline_empty: no active default tasks");
  }

  console.log("[orchestrator] pipeline_loaded_from_db", JSON.stringify({
    business_id: business.id,
    count: pipeline.length,
    slugs: pipeline.map((p) => p.slug),
  }));

  // ── Find or create the free_build_run row ─────────────────────────
  let run = await getFreeBuildRunByBusiness(supabase, business.id);

  if (!run) {
    run = await createFreeBuildRun(supabase, business.id, user.id, pipeline.length);
  }

  const runId = run.id;
  let seq = 0;
  const nextSeq = () => ++seq;

  const emit = async (evt: StreamEvent) => {
    await sseEmit(evt);
    await persistStreamEvent(supabase, runId, business.id, seq, evt.type, evt as unknown as Record<string, unknown>);
  };

  // ── Mark run as running + start heartbeat ────────────────────────
  await updateFreeBuildRun(supabase, runId, {
    status: "running",
    last_heartbeat_at: new Date().toISOString(),
  });

  // Heartbeat: update last_heartbeat_at every 10 s so the watchdog cron
  // knows this orchestrator is still alive. Cleared in finally{} below.
  const heartbeatInterval = setInterval(() => {
    const ts = new Date().toISOString();
    console.log("[heartbeat]", runId, ts);
    updateFreeBuildRun(supabase, runId, { last_heartbeat_at: ts }).catch(() => {});
  }, 10_000);

  // ── Janitor: fix zombie task_runs from prior Worker crashes ───────
  // If the existing run's heartbeat is stale (>30s), the previous Worker
  // process died — clean up ALL its running task_runs so the in-flight
  // check doesn't skip them on resume. If the heartbeat is fresh (Worker
  // genuinely alive on a concurrent connection), only clean up runs older
  // than 10 minutes as a safety net.
  {
    const prevHeartbeatAge = run.last_heartbeat_at
      ? Date.now() - new Date(run.last_heartbeat_at).getTime()
      : Infinity;
    const zombieUpdate = { state: "failed", status: "failed", failed_at: new Date().toISOString() };

    if (prevHeartbeatAge > 30_000) {
      // Previous Worker is dead — all running task_runs are orphans
      await supabase
        .from("task_runs")
        .update(zombieUpdate)
        .eq("business_id", business.id)
        .eq("state", "running")
        .then(() => {}, () => {});
    } else {
      // Worker may still be alive — only clean up ancient zombies as a safety net
      await supabase
        .from("task_runs")
        .update(zombieUpdate)
        .eq("business_id", business.id)
        .eq("state", "running")
        .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .then(() => {}, () => {});
    }
  }

  // ── Load business context (may have partial data from prior tasks) ─
  let ctx: BusinessContextRow;
  {
    const { data } = await supabase
      .from("business_context")
      .select("*")
      .eq("business_id", business.id)
      .maybeSingle();

    if (data) {
      ctx = data as BusinessContextRow;
      // Belt-and-suspenders: if the row exists but agent_name is NULL (can happen
      // when a DB trigger pre-creates the row before createEmptyBusinessContext runs),
      // assign a name now so the pipeline uses and persists it.
      if (!ctx.agent_name) {
        const agentName = "Inkthorn";
        console.log(`[orchestrator] ctx exists but agent_name NULL — assigning ${agentName} for business_id=${business.id}`);
        ctx = await upsertBusinessContext(supabase, {
          business_id: business.id,
          user_id: user.id,
          agent_name: agentName,
        }).catch((err) => {
          console.error("[orchestrator] agent_name fill failed:", err);
          return { ...ctx, agent_name: agentName };
        });
      }
    } else {
      // No context row — seed one with an agent name before any task upsert can
      // create the row without it. If upsert fails, use an in-memory fallback so
      // the build still runs (agent name won't persist but build completes).
      const agentName = "Inkthorn";
      console.log(`[orchestrator] no context found — seeding agent_name=${agentName} for business_id=${business.id}`);
      ctx = await upsertBusinessContext(supabase, {
        business_id: business.id,
        user_id: user.id,
        agent_name: agentName,
      }).catch((err) => {
        console.error("[orchestrator] context seed failed:", err);
        return {
          id: "",
          business_id: business.id,
          user_id: user.id,
          agent_name: agentName,
          user_profile: {},
          user_research_log: [],
          business_summary: null,
          industry: null,
          business_model: null,
          target_customer: {},
          value_proposition: null,
          market_size: {},
          competitors: [],
          market_trends: [],
          positioning_statement: null,
          brand_voice: null,
          key_differentiators: [],
          financial_snapshot: {},
          customer_signals: {},
          open_questions: [],
          telegram_chat_id: null,
          last_research_run_at: null,
          research_confidence_score: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as BusinessContextRow;
      });
    }
  }

  // ── Which tasks already completed? ────────────────────────────────
  const doneTaskSlugs = await getCompletedTaskRunSlugs(supabase, business.id);

  // ── Diagnostic: log state before pipeline starts ─────────────────
  console.log("[orchestrator] pipeline_start", JSON.stringify({
    business_id: business.id,
    business_name: business.name,
    business_kind: business.kind,
    business_slug: business.slug,
    ctx_business_summary: ctx.business_summary?.slice(0, 80) ?? null,
    ctx_industry: ctx.industry,
    ctx_value_proposition: ctx.value_proposition?.slice(0, 80) ?? null,
    ctx_agent_name: ctx.agent_name,
    existing_business_data_keys: business.existing_business_data
      ? Object.keys(business.existing_business_data as Record<string, unknown>)
      : [],
  }));

  await emit({ type: "narrative", text: `Initializing ${ctx.agent_name ?? "TextOS agent"} for ${business.name}…`, ts: Date.now() });
  await emit({ type: "cmd", text: "Spinning up research sandbox", ts: Date.now() });

  // Base count from the actual number of already-completed tasks (not the stored
  // tasks_completed, which can drift high if the orchestrator runs multiple times
  // on the same partially-finished build).
  let completedCount = doneTaskSlugs.size;

  // ── Execute each task (outer try guarantees free_build_run is never left running) ──
  try {
  for (const row of pipeline) {
    const handler = FREE_BUILD_TASK_HANDLERS[row.slug];
    if (!handler) {
      // DB lists this task as a default but the Worker has no dedicated
      // handler for it. Emit a warning event and skip gracefully — do NOT
      // crash the orchestrator. Fix: add a handler to FREE_BUILD_TASK_HANDLERS
      // or unset is_default on the task row.
      log.warn("[orchestrator] no_handler_for_default_task", {
        business_id: business.id,
        slug: row.slug,
      });
      await emit({
        type: "cmd",
        text: `[skip] '${row.slug}' has is_default=true but no Worker handler — skipping`,
        ts: Date.now(),
      });
      continue;
    }
    const step: { slug: string; name: string; fn: TaskFn } = {
      slug: row.slug,
      name: row.name,
      fn: handler,
    };

    console.log(`[orchestrator] starting task: ${step.slug} at ${new Date().toISOString()}`);
    let taskDef;
    try {
      taskDef = await getTaskBySlug(supabase, step.slug);
    } catch (lookupErr: unknown) {
      const e = lookupErr as Record<string, unknown> | null;
      const errMsg = (e?.message as string) || (e?.code as string) || JSON.stringify(lookupErr) || String(lookupErr);
      await emit({ type: "cmd", text: `[skip] task '${step.slug}' lookup failed: ${errMsg}`, ts: Date.now() });
      continue;
    }
    if (!taskDef) {
      await emit({ type: "cmd", text: `[skip] task '${step.slug}' truly not in catalog`, ts: Date.now() });
      continue;
    }

    // Skip if this task already completed in a prior run — do NOT increment
    // completedCount here; the skip is already reflected in doneTaskSlugs.size above.
    if (doneTaskSlugs.has(step.slug)) {
      await emit({ type: "task_start", task_slug: step.slug, task_name: step.name, task_run_id: "prior", ts: Date.now() });
      await emit({ type: "task_complete", task_slug: step.slug, task_name: step.name, task_run_id: "prior", output_summary: "Previously completed.", ts: Date.now() });
      continue;
    }

    // Idempotency guard: if a task_run for this task is already 'running' on
    // this business (from a concurrent or interrupted SSE connection that the
    // janitor hasn't aged out yet), skip rather than create a duplicate row.
    // The janitor at build-start ages out runs > 10 min, so this only catches
    // genuinely in-flight concurrent connections.
    {
      const inFlightResult = await supabase
        .from("task_runs")
        .select("id")
        .eq("business_id", business.id)
        .eq("task_id", taskDef.id)
        .eq("is_current", true)
        .eq("status", "running")
        .maybeSingle();
      const inFlight = inFlightResult.data;

      if (inFlight?.id) {
        await emit({ type: "cmd", text: `[skip] ${step.slug} already in-flight — skipping duplicate`, ts: Date.now() });
        continue;
      }
    }

    // Clear is_current on any prior failed task_run rows for this task+business
    // so the new row we're about to insert is the only is_current=true row.
    // Without this, a re-run after a failure leaves both rows with is_current=true
    // and the frontend sees duplicate completed+failed entries.
    await supabase
      .from("task_runs")
      .update({ is_current: false })
      .eq("business_id", business.id)
      .eq("task_id", taskDef.id)
      .eq("is_current", true)
      .eq("status", "failed")
      .then(() => {}, (e: unknown) => {
        log.warn("[orchestrator] clear_failed_is_current_failed", {
          business_id: business.id,
          task_id: taskDef.id,
          err: e instanceof Error ? e.message : String(e),
        });
      });

    // Create task_run row
    let taskRunId: string;
    try {
      taskRunId = await createTaskRunForBuild(supabase, {
        user_id: user.id,
        business_id: business.id,
        task_id: taskDef.id,
      });
    } catch (err) {
      await emit({ type: "task_failed", task_slug: step.slug, task_name: step.name, task_run_id: "err", error: `DB error: ${String(err)}`, ts: Date.now() });
      continue;
    }

    await emit({ type: "task_start", task_slug: step.slug, task_name: step.name, task_run_id: taskRunId, ts: Date.now() });

    const taskCtx: TaskCtx = {
      env,
      supabase,
      anthropic,
      business,
      ctx,
      user,
      runId,
      taskRunId,
      nextSeq,
      emit,
      cfLocation,
    };

    // Guard: only call failTaskRun if completeTaskRun hasn't fired yet.
    // Without this, a upsertBusinessContext throw after completeTaskRun would
    // overwrite state='complete' back to 'failed'.
    let taskCompleted = false;
    try {
      console.log(`[orchestrator] task_ctx_snapshot task=${step.slug}`, JSON.stringify({
        business_id: business.id,
        business_name: business.name,
        ctx_business_summary: ctx.business_summary?.slice(0, 80) ?? null,
        ctx_industry: ctx.industry,
        ctx_value_proposition: ctx.value_proposition?.slice(0, 80) ?? null,
      }));
      const result = await runTaskWithDeduction(step, taskCtx);

      // Persist task_run output — after this succeeds, task is done
      await completeTaskRun(supabase, taskRunId, result.output_data);
      taskCompleted = true;

      // Apply context updates so the next task sees them
      if (result.context_updates && Object.keys(result.context_updates).length > 0) {
        ctx = await upsertBusinessContext(supabase, {
          business_id: business.id,
          user_id: user.id,
          ...result.context_updates,
        }).catch((e) => {
          // Non-fatal: context update failure must not revert a completed task_run
          emit({ type: "cmd", text: `[warn] context update failed: ${String(e)}`, ts: Date.now() }).catch(() => {});
          return ctx; // keep current ctx so build continues
        });
      }

      completedCount++;
      await updateFreeBuildRun(supabase, runId, { tasks_completed: completedCount });

      const summary = extractSummary(step.slug, result.output_data);
      await emit({
        type: "task_complete",
        task_slug: step.slug,
        task_name: step.name,
        task_run_id: taskRunId,
        output_summary: summary,
        ts: Date.now(),
      });
    } catch (err) {
      // Billing errors halt the build entirely (return), not just this task.
      // Extra fields on the emit are preserved in stream_events.event_data JSONB
      // for Phase 7 frontend to read when deciding which recovery modal to show.
      if (err instanceof InsufficientTokensError) {
        try {
          await failTaskRun(supabase, taskRunId, "insufficient_tokens");
        } catch (failErr) {
          log.error("[orchestrator] fail_task_run_during_billing_error", {
            business_id: business.id,
            task_run_id: taskRunId,
            original_error: "insufficient_tokens",
            fail_err: failErr instanceof Error ? failErr.message : String(failErr),
          });
        }
        // stream_events.event_data is JSONB — extra fields beyond the StreamEvent
        // type are preserved in storage. Phase 7 reads them from the JSONB column.
        // V1.1: extend StreamEvent union with a billing-specific task_failed variant.
        await emit({
          type: "task_failed",
          task_slug: step.slug,
          task_name: step.name,
          task_run_id: taskRunId,
          error: err.message,
          available: err.details.available,
          requested: err.details.requested,
          deficit: err.details.deficit,
          bundle_suggestions: err.details.bundle_suggestions,
          ts: Date.now(),
        } as unknown as StreamEvent);
        try {
          await updateFreeBuildRun(supabase, runId, {
            status: "failed",
            failure_reason: "insufficient_tokens",
            failed_at: new Date().toISOString(),
          });
        } catch (updateErr) {
          log.error("[orchestrator] update_run_during_billing_error", {
            business_id: business.id,
            run_id: runId,
            original_error: "insufficient_tokens",
            update_err: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }
        return;
      }

      if (err instanceof SubscriptionRequiredError) {
        try {
          await failTaskRun(supabase, taskRunId, "subscription_required");
        } catch (failErr) {
          log.error("[orchestrator] fail_task_run_during_billing_error", {
            business_id: business.id,
            task_run_id: taskRunId,
            original_error: "subscription_required",
            fail_err: failErr instanceof Error ? failErr.message : String(failErr),
          });
        }
        // stream_events.event_data is JSONB — extra fields beyond the StreamEvent
        // type are preserved in storage. Phase 7 reads them from the JSONB column.
        // V1.1: extend StreamEvent union with a billing-specific task_failed variant.
        await emit({
          type: "task_failed",
          task_slug: step.slug,
          task_name: step.name,
          task_run_id: taskRunId,
          error: err.message,
          token_cost: err.details.token_cost,
          ts: Date.now(),
        } as unknown as StreamEvent);
        try {
          await updateFreeBuildRun(supabase, runId, {
            status: "failed",
            failure_reason: "subscription_required",
            failed_at: new Date().toISOString(),
          });
        } catch (updateErr) {
          log.error("[orchestrator] update_run_during_billing_error", {
            business_id: business.id,
            run_id: runId,
            original_error: "subscription_required",
            update_err: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }
        return;
      }

      const errMsg = extractErrorMessage(err);
      if (!taskCompleted) {
        // Task itself failed — transition task_run to failed
        try {
          await failTaskRun(supabase, taskRunId, errMsg);
        } catch {
          // zombie — cleaned up by janitor on next connect
        }
        await emit({
          type: "task_failed",
          task_slug: step.slug,
          task_name: step.name,
          task_run_id: taskRunId,
          error: errMsg,
          ts: Date.now(),
        });
      }
      // Non-fatal either way: continue with the next task
    }
  }

  // ── Derive final completed count from DB — source of truth ──────────
  // completedCount may lag if tasks were already done before this run started.
  const { count: dbCount } = await supabase
    .from("task_runs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business.id)
    .eq("status", "completed")
    .eq("is_current", true)
    .gte("started_at", run.started_at)
    .then((r) => r, () => ({ count: completedCount }));

  const finalCount = dbCount ?? completedCount;

  // ── Mark build complete ───────────────────────────────────────────
  try {
    await updateFreeBuildRun(supabase, runId, {
      status: "completed",
      tasks_completed: finalCount,
      completed_at: new Date().toISOString(),
    });
  } catch (updateErr: unknown) {
    const e = updateErr as Record<string, unknown> | null;
    const msg = (e?.message as string) || (e?.code as string) || JSON.stringify(updateErr) || String(updateErr);
    await emit({ type: "cmd", text: `[warn] final status update failed: ${msg}`, ts: Date.now() }).catch(() => {});
  }

  await emit({
    type: "narrative",
    text: "Free build complete. Your business is ready to run.",
    ts: Date.now(),
  });

  await emit({
    type: "build_complete",
    completed_count: finalCount,
    summary: `${finalCount} tasks complete. Unlock paid bundle to continue building.`,
    ts: Date.now(),
  });

  } catch (fatalErr: unknown) {
    // A crash outside the per-task catch (e.g., DB error loading context,
    // fatal emit failure). Mark the free_build_run failed so it isn't
    // stuck in 'running' forever.
    const fe = fatalErr as Record<string, unknown> | null;
    const errMsg = (fe?.message as string)
      || (fe?.code as string)
      || (typeof fatalErr === "object" ? JSON.stringify(fatalErr) : String(fatalErr));
    await updateFreeBuildRun(supabase, runId, {
      status: "failed",
      error: errMsg.slice(0, 500),
      completed_at: new Date().toISOString(),
    }).catch(() => {});
    await sseEmit({
      type: "error" as StreamEvent["type"],
      message: `Build failed: ${errMsg}`,
      ts: Date.now(),
    } as unknown as StreamEvent).catch(() => {});
    throw fatalErr;
  } finally {
    clearInterval(heartbeatInterval);
  }
}

function extractSummary(slug: string, data: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
  switch (slug) {
    case "research-strategy":
      return `Strategy: ${s(data.positioning_statement || data.value_proposition)}`;
    case "welcome-email":
      return s(data.preview) || "Welcome email staged.";
    case "launch-tweet":
      return s(data.tweet) || "Tweet drafted.";
    case "logo":
      return data.r2_uploaded ? "Logo saved to R2." : "Logo generated.";
    case "business-landing-page":
      return typeof data.url === "string" ? `Site planned at ${data.url}` : "Landing page generated.";
    case "mission-document":
      return s(data.mission) || "Mission documented.";
    case "task-queue-built":
      return s(data.message) || "Task queue built.";
    case "dashboard-briefing":
      return s(data.briefing) || "Briefing ready.";
    case "personalized-pitch-email":
      return s(data.body_summary) || "Pitch email queued.";
    case "tam-sam-som": {
      const tam = data.tam as Record<string, unknown> | undefined;
      return tam ? `TAM: ${tam.label} · SAM/SOM unlock on subscription.` : "Market sizing complete.";
    }
    default:
      return "Task complete.";
  }
}

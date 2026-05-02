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

import { runResearchStrategy } from "./tasks/research-strategy";
import { runWelcomeEmail } from "./tasks/welcome-email";
import { runLaunchTweet } from "./tasks/launch-tweet";
import { runPersonalLandingPage } from "./tasks/personal-landing-page";
import { runMissionDocument } from "./tasks/mission-document";
import { runTaskQueueBuilt } from "./tasks/task-queue-built";
import { runDashboardBriefing } from "./tasks/dashboard-briefing";
import { runPersonalizedPitchEmail } from "./tasks/personalized-pitch-email";
import { runTamSamSom } from "./tasks/tam-sam-som";
import { runDaycycleConnect } from "./tasks/daycycle-connect";

// The 9 free-build tasks in execution order.
// research-strategy runs first because all other tasks read from business_context.
const PIPELINE: Array<{ slug: string; name: string; fn: TaskFn }> = [
  { slug: "research-strategy",       name: "Research Strategy",      fn: runResearchStrategy },
  { slug: "welcome-email",           name: "Welcome Email",          fn: runWelcomeEmail },
  { slug: "launch-tweet",            name: "Launch Tweet",           fn: runLaunchTweet },
  { slug: "personal-landing-page",   name: "Personal Landing Page",  fn: runPersonalLandingPage },
  { slug: "mission-document",        name: "Mission Document",       fn: runMissionDocument },
  { slug: "task-queue-built",        name: "Task Queue",             fn: runTaskQueueBuilt },
  { slug: "dashboard-briefing",      name: "Dashboard Briefing",     fn: runDashboardBriefing },
  { slug: "personalized-pitch-email",name: "Personalized Pitch Email",fn: runPersonalizedPitchEmail },
  { slug: "tam-sam-som",             name: "Market Sizing",          fn: runTamSamSom },
  { slug: "daycycle-connect",        name: "DayCycle Setup",         fn: runDaycycleConnect },
];

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
): Promise<void> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // ── Find or create the free_build_run row ─────────────────────────
  let run = await getFreeBuildRunByBusiness(supabase, business.id);

  if (!run) {
    run = await createFreeBuildRun(supabase, business.id, user.id, PIPELINE.length);
  }

  const runId = run.id;
  let seq = 0;
  const nextSeq = () => ++seq;

  const emit = async (evt: StreamEvent) => {
    await sseEmit(evt);
    await persistStreamEvent(supabase, runId, business.id, seq, evt.type, evt as unknown as Record<string, unknown>);
  };

  // ── Mark run as running ───────────────────────────────────────────
  await updateFreeBuildRun(supabase, runId, { status: "running" });

  // ── Janitor: fix zombie task_runs from prior Worker crashes ───────
  // Any task_run for this business still in state='running' after 10 minutes
  // is a zombie (Worker died before the state transition completed).
  // Mark them failed now so they don't pollute getCompletedTaskRunSlugs.
  {
    const zombieCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase
      .from("task_runs")
      .update({ state: "failed", status: "failed" })
      .eq("business_id", business.id)
      .eq("state", "running")
      .lt("created_at", zombieCutoff)
      .then(
        () => {},  // non-fatal success
        () => {},  // non-fatal error
      );
  }

  // ── Load business context (may have partial data from prior tasks) ─
  let ctx: BusinessContextRow;
  {
    const { data } = await supabase
      .from("business_context")
      .select("*")
      .eq("business_id", business.id)
      .maybeSingle();
    ctx = (data as BusinessContextRow) ?? ({
      id: "",
      business_id: business.id,
      user_id: user.id,
      agent_name: null,
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
    } as BusinessContextRow);
  }

  // ── Which tasks already completed? ────────────────────────────────
  const doneTaskSlugs = await getCompletedTaskRunSlugs(supabase, business.id);

  await emit({ type: "narrative", text: `Initializing ${ctx.agent_name ?? "TextOS agent"} for ${business.name}…`, ts: Date.now() });
  await emit({ type: "cmd", text: "Spinning up research sandbox", ts: Date.now() });

  // Base count from the actual number of already-completed tasks (not the stored
  // tasks_completed, which can drift high if the orchestrator runs multiple times
  // on the same partially-finished build).
  let completedCount = doneTaskSlugs.size;

  // ── Execute each task (outer try guarantees free_build_run is never left running) ──
  try {
  for (const step of PIPELINE) {
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
    };

    // Guard: only call failTaskRun if completeTaskRun hasn't fired yet.
    // Without this, a upsertBusinessContext throw after completeTaskRun would
    // overwrite state='complete' back to 'failed'.
    let taskCompleted = false;
    try {
      const result = await step.fn(taskCtx);

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
      const errMsg = String(err);
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
    case "personal-landing-page":
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

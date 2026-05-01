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

  let completedCount = run.tasks_completed;

  // ── Execute each task ─────────────────────────────────────────────
  for (const step of PIPELINE) {
    const taskDef = await getTaskBySlug(supabase, step.slug).catch(() => null);
    if (!taskDef) {
      await emit({ type: "cmd", text: `[skip] task '${step.slug}' not found in catalog`, ts: Date.now() });
      continue;
    }

    // Skip if this task already completed in a prior run
    if (doneTaskSlugs.has(step.slug)) {
      await emit({ type: "task_start", task_slug: step.slug, task_name: step.name, task_run_id: "prior", ts: Date.now() });
      await emit({ type: "task_complete", task_slug: step.slug, task_name: step.name, task_run_id: "prior", output_summary: "Previously completed.", ts: Date.now() });
      completedCount++;
      continue;
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
      nextSeq,
      emit,
    };

    try {
      const result = await step.fn(taskCtx);

      // Persist task_run output
      await completeTaskRun(supabase, taskRunId, result.output_data);

      // Apply context updates from this task so the next task sees them
      if (result.context_updates && Object.keys(result.context_updates).length > 0) {
        ctx = await upsertBusinessContext(supabase, {
          business_id: business.id,
          user_id: user.id,
          ...result.context_updates,
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
      await failTaskRun(supabase, taskRunId, errMsg);
      await emit({
        type: "task_failed",
        task_slug: step.slug,
        task_name: step.name,
        task_run_id: taskRunId,
        error: errMsg,
        ts: Date.now(),
      });
      // Non-fatal: continue with the next task
    }
  }

  // ── Mark build complete ───────────────────────────────────────────
  await updateFreeBuildRun(supabase, runId, {
    status: "completed",
    tasks_completed: completedCount,
    completed_at: new Date().toISOString(),
  });

  await emit({
    type: "narrative",
    text: "Free build complete. Your business is ready to run.",
    ts: Date.now(),
  });

  await emit({
    type: "build_complete",
    completed_count: completedCount,
    summary: `${completedCount} tasks complete. Unlock paid bundle to continue building.`,
    ts: Date.now(),
  });
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

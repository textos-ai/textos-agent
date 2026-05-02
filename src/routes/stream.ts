import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getTaskRunsForBusiness,
  getFreeBuildRunByBusiness,
  getStreamEventsForRun,
  getUserById,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { sseEvent, type StreamEvent } from "../lib/stream-events";
import { runFreeBuild } from "../lib/free-build-orchestrator";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

/**
 * GET /stream/business/:slug[?mode=simulate]
 *
 * SSE stream for a business free build.
 *
 * Modes:
 *   default   — runs (or resumes) the real free-build pipeline.
 *               Already-completed tasks are skipped; the build picks up
 *               where it left off if the connection was interrupted.
 *   simulate  — plays back a scripted ~90-second sequence for UI dev/demos.
 *               Triggered by ?mode=simulate.
 */
app.get("/business/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const mode = c.req.query("mode");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug).catch(() => null);
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  return streamSSE(c, async (stream) => {
    const send = async (evt: StreamEvent) => {
      await stream.writeSSE({ event: evt.type, data: JSON.stringify(evt) });
    };

    await send({ type: "status", message: "connected", ts: Date.now() });

    // ── Simulation mode ──────────────────────────────────────────────
    if (mode === "simulate") {
      await runSimulation(business.name, auth.user_id, send);
      return;
    }

    // ── Check if build is already complete or running ────────────────
    const existingRun = await getFreeBuildRunByBusiness(supabase, business.id).catch(() => null);

    if (existingRun?.status === "completed" || existingRun?.status === "running") {
      // Replay the last N events so the terminal shows something meaningful on reconnect
      try {
        const events = await getStreamEventsForRun(supabase, existingRun.id);
        const last20 = events.slice(-20);
        for (const e of last20) {
          await send(e.event_data as unknown as StreamEvent);
        }
      } catch {
        // Non-fatal — fall through to status message
      }
      const statusMsg = existingRun.status === "running"
        ? "build_already_running"
        : "build_already_complete";
      await send({ type: "status", message: statusMsg, ts: Date.now() });
      return;
    }

    // ── Check legacy task_runs for backward compat (seed data) ───────
    const runs = await getTaskRunsForBusiness(supabase, business.id).catch(() => []);
    const allDone = runs.length > 0 && runs.every((r) => r.status === "completed");
    if (allDone && !existingRun) {
      await send({ type: "status", message: "build_already_complete", ts: Date.now() });
      return;
    }

    // ── Run or resume the free build ─────────────────────────────────
    const user = await getUserById(supabase, auth.user_id).catch(() => null);
    if (!user) {
      await send({ type: "error", message: "User not found", ts: Date.now() });
      return;
    }

    try {
      await runFreeBuild(c.env, supabase, business, user, send);
    } catch (err) {
      await send({ type: "error", message: String(err), ts: Date.now() });
    }
  });
});

// ── Simulation fallback ────────────────────────────────────────────────────
// Kept for ?mode=simulate so the frontend can be tested independently
// of the real Anthropic API.

async function runSimulation(
  businessName: string,
  userId: string,
  send: (evt: StreamEvent) => Promise<void>,
): Promise<void> {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await send({ type: "narrative", text: `Initializing agent for ${businessName}…`, ts: Date.now() });
  await delay(800);
  await send({ type: "cmd", text: "Spinning up research sandbox", ts: Date.now() });
  await delay(600);

  const tasks: Array<[string, string, string, string]> = [
    ["research-strategy",        "Research Strategy",       "sim-1", "Strategy locked. Confidence 78%."],
    ["welcome-email",            "Welcome Email",           "sim-2", "Welcome email dispatched."],
    ["launch-tweet",             "Launch Tweet",            "sim-3", "Tweet drafted and ready to post."],
    ["personal-landing-page",    "Personal Landing Page",   "sim-4", "Personal site planned."],
    ["mission-document",         "Mission Document",        "sim-5", "Mission + vision + values documented."],
    ["task-queue-built",         "Task Queue",              "sim-6", "24 tasks staged."],
    ["dashboard-briefing",       "Dashboard Briefing",      "sim-7", "Briefing ready."],
    ["personalized-pitch-email", "Personalized Pitch Email","sim-8", "Personalized pitch delivered."],
    ["tam-sam-som",              "Market Sizing",           "sim-9", "TAM visible; SAM/SOM unlock on subscription."],
  ];

  const cmds: Record<string, string[]> = {
    "research-strategy":        [`Searching: "${businessName}" market size 2025`, `Deep searching: ${businessName} competitors`],
    "welcome-email":            ["Drafting welcome email", "Queuing via SendGrid"],
    "launch-tweet":             ["Drafting tweet with brand voice"],
    "personal-landing-page":    ["Generating personal website", `Deploying to ${userId.slice(0, 8)}.app.textos.ai`],
    "mission-document":         ["Writing mission document", "Saving to business context"],
    "task-queue-built":         ["Proposing 3 immediate tasks", "Staging 21 paid-bundle tasks"],
    "dashboard-briefing":       ["Generating executive briefing"],
    "personalized-pitch-email": [`Sending pitch to ${userId.slice(0, 8)}@…`],
    "tam-sam-som":              ["Calculating TAM/SAM/SOM from research"],
  };

  const narratives: Record<string, string> = {
    "research-strategy":  "Market is larger than expected — found 3 underserved segments.",
    "mission-document":   "Writing the mission — this defines everything downstream.",
    "personalized-pitch-email": "Writing a pitch email that actually knows who you are.",
    "tam-sam-som":        "Market is real and measurable.",
  };

  for (const [taskSlug, taskName, taskRunId, summary] of tasks) {
    await send({ type: "task_start", task_slug: taskSlug, task_name: taskName, task_run_id: taskRunId, ts: Date.now() });
    await delay(400);
    for (const cmd of cmds[taskSlug] ?? []) {
      await send({ type: "cmd", text: cmd, ts: Date.now() });
      await delay(900);
    }
    if (narratives[taskSlug]) {
      await send({ type: "narrative", text: narratives[taskSlug], ts: Date.now() });
      await delay(700);
    }
    await send({ type: "task_complete", task_slug: taskSlug, task_name: taskName, task_run_id: taskRunId, output_summary: summary, ts: Date.now() });
    await delay(500);
  }

  await send({ type: "narrative", text: "Free build complete. Your business is ready to run.", ts: Date.now() });
  await delay(600);
  await send({ type: "build_complete", completed_count: 9, summary: "9 tasks complete. Unlock paid bundle to continue building.", ts: Date.now() });
}

export default app;

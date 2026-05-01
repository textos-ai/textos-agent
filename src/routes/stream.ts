import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient, getBusinessBySlug, getTaskRunsForBusiness } from "../services/supabase";
import { errBody } from "../lib/errors";
import { sseEvent, type StreamEvent } from "../lib/stream-events";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

/**
 * GET /stream/business/:slug[?mode=simulate]
 *
 * SSE stream for a business build.
 *
 * Modes:
 *   default   — emits current status; idles if build is already complete.
 *               Sprint 5 Phase 3 will replace idle with live agent events.
 *   simulate  — plays back a scripted ~90-second build sequence useful for
 *               UI development and demos. Triggered by ?mode=simulate.
 */
app.get("/business/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const mode = c.req.query("mode"); // "simulate" | undefined
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug).catch(() => null);
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  const runs = await getTaskRunsForBusiness(supabase, business.id).catch(() => []);
  const hasActiveRun = runs.some(r => r.status === "running" || r.status === "queued");
  const allDone = runs.length > 0 && runs.every(r => r.status === "completed");

  return streamSSE(c, async (stream) => {
    const send = async (evt: StreamEvent) => {
      await stream.writeSSE({ event: evt.type, data: JSON.stringify(evt) });
    };

    // ── Keepalive ──────────────────────────────────────────────────────
    await send({ type: "status", message: "connected", ts: Date.now() });

    if (allDone && mode !== "simulate") {
      await send({ type: "status", message: "build_already_complete", ts: Date.now() });
      return;
    }

    if (!hasActiveRun && mode !== "simulate") {
      await send({ type: "status", message: "idle_no_active_run", ts: Date.now() });
      return;
    }

    // ── Simulation sequence ────────────────────────────────────────────
    // Used for: ?mode=simulate, or when the real agent loop wires in.
    // Plays a realistic 9-task free build to validate the streaming UX.
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    await send({ type: "narrative", text: `Initializing agent for ${business.name}…`, ts: Date.now() });
    await delay(800);
    await send({ type: "cmd", text: "Spinning up research sandbox", ts: Date.now() });
    await delay(600);

    // Task 1: research-strategy
    await send({ type: "task_start", task_slug: "research-strategy", task_name: "Research Strategy", task_run_id: "sim-1", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: `Searching web for: ${business.name} market size 2025`, ts: Date.now() });
    await delay(1200);
    await send({ type: "cmd", text: `Deep searching: ${business.name} competitors funding`, ts: Date.now() });
    await delay(1000);
    await send({ type: "narrative", text: "Market is larger than expected — found 3 underserved segments.", ts: Date.now() });
    await delay(800);
    await send({ type: "cmd", text: "Saving strategy: Novel Idea", ts: Date.now() });
    await delay(400);
    await send({ type: "task_complete", task_slug: "research-strategy", task_name: "Research Strategy", task_run_id: "sim-1", output_summary: "Strategy locked: Novel Idea. Confidence 78%.", ts: Date.now() });
    await delay(600);

    // Task 2: welcome-email
    await send({ type: "task_start", task_slug: "welcome-email", task_name: "Welcome Email", task_run_id: "sim-2", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Drafting welcome email from agent context", ts: Date.now() });
    await delay(1200);
    await send({ type: "cmd", text: "Queuing email via SendGrid", ts: Date.now() });
    await delay(600);
    await send({ type: "task_complete", task_slug: "welcome-email", task_name: "Welcome Email", task_run_id: "sim-2", output_summary: "Welcome email dispatched.", ts: Date.now() });
    await delay(500);

    // Task 3: launch-tweet
    await send({ type: "task_start", task_slug: "launch-tweet", task_name: "Launch Tweet", task_run_id: "sim-3", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Drafting launch tweet with brand voice", ts: Date.now() });
    await delay(900);
    await send({ type: "task_complete", task_slug: "launch-tweet", task_name: "Launch Tweet", task_run_id: "sim-3", output_summary: "Tweet drafted and ready to post.", ts: Date.now() });
    await delay(500);

    // Task 4: personal-landing-page
    await send({ type: "task_start", task_slug: "personal-landing-page", task_name: "Personal Landing Page", task_run_id: "sim-4", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Generating personal website from profile", ts: Date.now() });
    await delay(1500);
    await send({ type: "cmd", text: `Deploying to ${auth.user_id.slice(0, 8)}.app.textos.ai`, ts: Date.now() });
    await delay(800);
    await send({ type: "task_complete", task_slug: "personal-landing-page", task_name: "Personal Landing Page", task_run_id: "sim-4", output_summary: "Personal site deployed.", ts: Date.now() });
    await delay(500);

    // Task 5: mission-document
    await send({ type: "task_start", task_slug: "mission-document", task_name: "Mission Document", task_run_id: "sim-5", ts: Date.now() });
    await delay(400);
    await send({ type: "narrative", text: "Writing the mission — this is the part that defines everything downstream.", ts: Date.now() });
    await delay(1200);
    await send({ type: "cmd", text: "Saving mission document to business context", ts: Date.now() });
    await delay(600);
    await send({ type: "task_complete", task_slug: "mission-document", task_name: "Mission Document", task_run_id: "sim-5", output_summary: "Mission + vision + values documented.", ts: Date.now() });
    await delay(500);

    // Task 6: task-queue-built
    await send({ type: "task_start", task_slug: "task-queue-built", task_name: "Task Queue", task_run_id: "sim-6", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Proposing 3 immediate tasks from strategy", ts: Date.now() });
    await delay(600);
    await send({ type: "cmd", text: "Staging 21 paid-bundle tasks for subscription", ts: Date.now() });
    await delay(400);
    await send({ type: "task_complete", task_slug: "task-queue-built", task_name: "Task Queue", task_run_id: "sim-6", output_summary: "24 tasks staged.", ts: Date.now() });
    await delay(500);

    // Task 7: dashboard-briefing
    await send({ type: "task_start", task_slug: "dashboard-briefing", task_name: "Dashboard Briefing", task_run_id: "sim-7", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Generating executive briefing from all context", ts: Date.now() });
    await delay(1000);
    await send({ type: "task_complete", task_slug: "dashboard-briefing", task_name: "Dashboard Briefing", task_run_id: "sim-7", output_summary: "Briefing ready.", ts: Date.now() });
    await delay(500);

    // Task 8: personalized-pitch-email
    await send({ type: "task_start", task_slug: "personalized-pitch-email", task_name: "Personalized Pitch Email", task_run_id: "sim-8", ts: Date.now() });
    await delay(400);
    await send({ type: "narrative", text: "Writing a pitch email that actually knows who you are.", ts: Date.now() });
    await delay(1200);
    await send({ type: "cmd", text: `Sending pitch email to ${auth.user_id.slice(0, 8)}@…`, ts: Date.now() });
    await delay(600);
    await send({ type: "task_complete", task_slug: "personalized-pitch-email", task_name: "Personalized Pitch Email", task_run_id: "sim-8", output_summary: "Personalized pitch delivered.", ts: Date.now() });
    await delay(500);

    // Task 9: tam-sam-som
    await send({ type: "task_start", task_slug: "tam-sam-som", task_name: "Market Sizing", task_run_id: "sim-9", ts: Date.now() });
    await delay(400);
    await send({ type: "cmd", text: "Calculating TAM/SAM/SOM from research data", ts: Date.now() });
    await delay(1000);
    await send({ type: "narrative", text: "Market is real and measurable. Numbers ready.", ts: Date.now() });
    await delay(600);
    await send({ type: "task_complete", task_slug: "tam-sam-som", task_name: "Market Sizing", task_run_id: "sim-9", output_summary: "Market sizing complete. TAM visible; SAM/SOM unlock on subscription.", ts: Date.now() });
    await delay(800);

    // Build complete
    await send({ type: "narrative", text: "Free build complete. Your business is ready to run.", ts: Date.now() });
    await delay(600);
    await send({
      type: "build_complete",
      completed_count: 9,
      summary: "9 tasks complete. Unlock paid bundle to continue building.",
      ts: Date.now(),
    });
  });
});

export default app;

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

    // ── Check if build is already complete or genuinely running ────────
    const existingRun = await getFreeBuildRunByBusiness(supabase, business.id).catch(() => null);

    if (existingRun?.status === "completed") {
      try {
        const events = await getStreamEventsForRun(supabase, existingRun.id);
        for (const e of events.slice(-20)) await send(e.event_data as unknown as StreamEvent);
      } catch { /* non-fatal */ }
      await send({ type: "status", message: "build_already_complete", ts: Date.now() });
      return;
    }

    if (existingRun?.status === "running") {
      // Only bail if the heartbeat is fresh — the Worker process is genuinely alive.
      // A stale heartbeat (>30s) means the Worker died mid-build; fall through to
      // re-enter the orchestrator so it resumes from where it left off.
      const heartbeatAge = existingRun.last_heartbeat_at
        ? Date.now() - new Date(existingRun.last_heartbeat_at).getTime()
        : Infinity;
      const heartbeatFresh = heartbeatAge < 30_000;

      if (heartbeatFresh) {
        try {
          const events = await getStreamEventsForRun(supabase, existingRun.id);
          for (const e of events.slice(-20)) await send(e.event_data as unknown as StreamEvent);
        } catch { /* non-fatal */ }
        await send({ type: "status", message: "build_already_running", ts: Date.now() });
        return;
      }
      // Heartbeat stale — fall through to re-run orchestrator below
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

    // Extract Cloudflare IP geolocation headers for tasks that need location
    const cfLatRaw = c.req.raw.headers.get("cf-iplatitude");
    const cfLngRaw = c.req.raw.headers.get("cf-iplongitude");
    let cfLocation: { lat: number; lng: number } | null = null;
    if (cfLatRaw && cfLngRaw) {
      const lat = parseFloat(cfLatRaw);
      const lng = parseFloat(cfLngRaw);
      if (!isNaN(lat) && !isNaN(lng)) cfLocation = { lat, lng };
    }

    try {
      await runFreeBuild(c.env, supabase, business, user, send, cfLocation);
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
    ["research-strategy",     "Research Strategy",     "sim-1", "Strategy locked. Confidence 78%."],
    ["mission-document",      "Mission Document",      "sim-2", "Mission + vision + values documented."],
    ["logo",                  "Logo",                  "sim-3", "SVG logo generated."],
    ["business-landing-page", "Business Landing Page", "sim-4", "Landing page built."],
    ["launch-tweet",          "Launch Tweet",          "sim-5", "Tweet drafted and ready to post."],
  ];

  const cmds: Record<string, string[]> = {
    "research-strategy":     [`Searching: "${businessName}" market size 2025`, `Deep searching: ${businessName} competitors`],
    "mission-document":      ["Writing mission document", "Saving to business context"],
    "logo":                  ["Generating SVG logo with Recraft V3", "Saving to business assets"],
    "business-landing-page": ["Generating business landing page", "Writing SEO metadata"],
    "launch-tweet":          ["Drafting tweet with brand voice"],
  };

  const narratives: Record<string, string> = {
    "research-strategy":     "Market is larger than expected — found 3 underserved segments.",
    "mission-document":      "Writing the mission — this defines everything downstream.",
    "logo":                  "Visual identity locked — SVG vector logo ready.",
    "business-landing-page": "Landing page built and ready for deployment.",
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

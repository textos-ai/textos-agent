import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import healthRoutes from "./routes/health";
import chatRoutes from "./routes/chat";
import taskRoutes from "./routes/tasks";
import meRoutes from "./routes/me";
import authRoutes from "./routes/auth";
import handleRoutes from "./routes/handles";
import businessRoutes from "./routes/businesses";
import streamRoutes from "./routes/stream";
import adminRoutes from "./routes/admin";
import anonymousRoutes from "./routes/anonymous";
import catalogRoutes from "./routes/catalog";
import sitesRoutes from "./routes/sites";
import checkoutRoutes from "./routes/checkout";
import stripeRoutes from "./routes/stripe";
import envInfoRoutes from "./routes/env-info";
import usersRoutes from "./routes/users";
import { errBody } from "./lib/errors";
import { log } from "./lib/logger";
import buildsRoutes from "./routes/builds";
import businessManagerRoutes from "./routes/business-manager";
import businessFactsRoutes from "./routes/business-facts";
import operatorSchoolRoutes from "./routes/operator-school";
import settingsRoutes from "./routes/settings";
import generateStoriesRoutes from "./routes/generate-stories";
import marketingCarouselsRoutes from "./routes/marketing-carousels";
import marketingContentRoutes from "./routes/marketing-content";
import socialConnectRoutes from "./routes/social-connect";
import socialPublishRoutes from "./routes/social-publish";
import billingRoutes from "./routes/billing";
import businessTaskRunRoutes from "./routes/business-task-run";
import customerUnderstandingRoutes from "./routes/customer-understanding";
import leadsRoutes from "./routes/leads";
import appsCatalogRoutes from "./routes/apps-catalog";
import appsBusinessesRoutes from "./routes/apps-businesses";
import appsInstancesRoutes from "./routes/apps-instances";
import xaiFyiRoutes from "./routes/xai-fyi";
import generatedAppsRoutes from "./routes/generated-apps";
import internalRoutes from "./routes/internal";
import factoryV2ProofRoutes from "./routes/factory-v2-proof"; // TEMP: factory-v2 step-3 proof (delete after)
import factoryV2AppRoutes from "./routes/factory-v2-app"; // TEMP DEV: factory-v2 step-4 wizard app (retire at cutover)
import factoryV2ApiRoutes from "./routes/factory-v2-api"; // STABLE: factory-v2 published-app result endpoint + publish action
import factoryAssessmentAppRoutes from "./routes/factory-assessment-app"; // TEMP DEV: factory-v2 Assessment app (Phase 3 /dev/ proof)
import factoryCalculatorAppRoutes from "./routes/factory-calculator-app"; // TEMP DEV: factory-v2 Calculator app (Compute archetype /dev/ proof)
import appLogsRoutes from "./routes/app-logs";
import { runHeartbeatWatchdog } from "./cron/heartbeatWatchdog";
import { runGenAppStaleSweep } from "./cron/genAppStaleSweep";
import { runScheduledReconcile } from "./cron/reconcileScheduledPosts";
import { processAppGenHtmlBatch } from "./queues/app-gen-html-consumer";
import { processTaskQueueBatch } from "./queues/task-queue-consumer";
import type { HtmlJobMessage, TaskQueueMessage } from "./queues/types";
import { createClient } from "@supabase/supabase-js";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      // Permissive CORS for /xai-fyi/* (Bearer-token protected)
      if (c.req.path.startsWith('/xai-fyi/')) return origin || '*';
      if (!origin) return origin;
      // Allow textos.ai apex + any subdomain, plus local Astro dev ports.
      if (/^https:\/\/([a-z0-9-]+\.)*textos\.ai$/.test(origin)) return origin;
      // Allow victora.ai apex + any subdomain (production rebrand).
      if (/^https:\/\/([a-z0-9-]+\.)*victora\.ai$/.test(origin)) return origin;
      // Allow textos-web-test.pages.dev (test frontend) + hash-prefixed previews.
      if (/^https:\/\/([a-z0-9-]+\.)*textos-web-test\.pages\.dev$/.test(origin)) return origin;
      // Allow textos-web.pages.dev preview deploys (production frontend's preview URLs).
      if (/^https:\/\/([a-z0-9-]+\.)*textos-web\.pages\.dev$/.test(origin)) return origin;
      if (/^https:\/\/([a-z0-9-]+\.)*claude\.ai$/.test(origin)) return origin;
      if (/^https:\/\/([a-z0-9-]+\.)*claude\.site$/.test(origin)) return origin;
      if (/^https:\/\/([a-z0-9-]+\.)*anthropic\.com$/.test(origin)) return origin;
      if (origin === "http://localhost:4321") return origin;
      if (origin === "http://localhost:5173") return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.route("/healthz", healthRoutes);
app.route("/version", healthRoutes);
app.route("/me", meRoutes);
app.route("/auth", authRoutes);
app.route("/handles", handleRoutes);
app.route("/chat", chatRoutes);
app.route("/tasks", taskRoutes);
app.route("/businesses", businessRoutes);
app.route("/stream", streamRoutes);
app.route("/admin", adminRoutes);
app.route("/api/anonymous", anonymousRoutes);
app.route("/api/catalog", catalogRoutes);
app.route("/api/sites", sitesRoutes);
app.route("/api/checkout", checkoutRoutes);
app.route("/api/stripe", stripeRoutes);
app.route("/api/env", envInfoRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/builds", buildsRoutes);
app.route("/api/businesses", businessManagerRoutes);
app.route("/api/operator-school", operatorSchoolRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/generate-stories", generateStoriesRoutes);
app.route("/api/businesses", marketingCarouselsRoutes);
app.route("/api/businesses", marketingContentRoutes);
app.route("/api/businesses", socialConnectRoutes);
app.route("/api/businesses", socialPublishRoutes);
app.route("/api/businesses", billingRoutes);
// Website Manager Phase 1A — business facts (NAP, hours, license, services, areas)
app.route("/api/businesses", businessFactsRoutes);
app.route("/api/businesses", businessTaskRunRoutes);
app.route("/api/businesses", customerUnderstandingRoutes);
app.route("/api/businesses", leadsRoutes);
app.route("/api/apps", appsCatalogRoutes);
app.route("/api/businesses", appsBusinessesRoutes);
app.route("/api/business-apps", appsInstancesRoutes);
app.route("/xai-fyi", xaiFyiRoutes);
app.route("/api/generated-apps", generatedAppsRoutes);
app.route("/api/internal", internalRoutes);
app.route("/api/factory-v2-proof", factoryV2ProofRoutes); // TEMP: factory-v2 step-3 proof (delete after)
app.route("/dev/factory-strategy-app", factoryV2AppRoutes); // TEMP DEV: factory-v2 step-4 wizard app (retire at cutover)
app.route("/api/factory-v2", factoryV2ApiRoutes); // STABLE: factory-v2 published-app result endpoint + publish action
app.route("/dev/factory-assessment-app", factoryAssessmentAppRoutes); // TEMP DEV: factory-v2 Assessment app (Phase 3 /dev/ proof)
app.route("/dev/factory-calculator-app", factoryCalculatorAppRoutes); // TEMP DEV: factory-v2 Calculator app (Compute archetype /dev/ proof)
// Dedicated /api/app-logs prefix — see src/routes/app-logs.ts for the
// reason it lives outside /api/businesses (multi-sub-app mount fall-
// through wasn't reliably matching the new handler).
app.route("/api/app-logs", appLogsRoutes);


app.notFound((c) =>
  c.json(
    errBody("not_found", `no route for ${c.req.method} ${c.req.path}`, {
      path: c.req.path,
    }),
    404,
  ),
);

app.onError((err, c) => {
  log.error("unhandled_error", { err: String(err), path: c.req.path });
  return c.json(errBody("internal", String(err)), 500);
});

export default {
  fetch: app.fetch.bind(app),

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    // Dispatch by cron schedule (see wrangler.toml [triggers]).
    // Every-minute cron runs the heartbeat watchdog; the 10-minute cron
    // runs the generate-business-app stale sweep. Each scheduled invocation
    // gets only one trigger; we branch on event.cron to avoid running
    // both jobs on every minute tick.
    if (event.cron === "*/10 * * * *") {
      await runGenAppStaleSweep(supabase);
      return;
    }
    // Every 5 minutes → reconcile scheduled posts that have fired on Zernio's
    // clock so our DB learns they published (scheduled→published/failed).
    if (event.cron === "*/5 * * * *") {
      await runScheduledReconcile(supabase, env.ZERNIO_API_KEY);
      return;
    }
    // Default (covers "* * * * *" and any future schedule we forget to
    // branch on — heartbeat is safe to run more often than needed).
    await runHeartbeatWatchdog(supabase);
  },

  /**
   * Cloudflare Queue consumer entry point. CF dispatches incoming batches
   * here based on the [[queues.consumers]] declarations in wrangler.toml.
   * Each consumer invocation gets a fresh wall-clock budget (~15 min on
   * Workers Standard) — this is the key reason we moved
   * generate-business-app-html off the Service Binding chain.
   *
   * Branches by `batch.queue` (the queue name as a string). New queue
   * consumers add their dispatch line here.
   */
  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (
      batch.queue === "textos-app-gen-html-prod" ||
      batch.queue === "textos-app-gen-html-test"
    ) {
      await processAppGenHtmlBatch(batch as MessageBatch<HtmlJobMessage>, env);
      return;
    }
    if (
      batch.queue === "textos-task-queue-prod" ||
      batch.queue === "textos-task-queue-test"
    ) {
      await processTaskQueueBatch(batch as MessageBatch<TaskQueueMessage>, env);
      return;
    }
    // Unknown queue — log and ack all (don't loop). New queues need an
    // explicit branch above.
    log.error("queue_unknown_consumer", { queue: batch.queue });
    for (const m of batch.messages) m.ack();
  },
};
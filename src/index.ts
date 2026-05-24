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
import operatorSchoolRoutes from "./routes/operator-school";
import settingsRoutes from "./routes/settings";
import generateStoriesRoutes from "./routes/generate-stories";
import marketingCarouselsRoutes from "./routes/marketing-carousels";
import billingRoutes from "./routes/billing";
import businessTaskRunRoutes from "./routes/business-task-run";
import appsCatalogRoutes from "./routes/apps-catalog";
import appsBusinessesRoutes from "./routes/apps-businesses";
import appsInstancesRoutes from "./routes/apps-instances";
import xaiFyiRoutes from "./routes/xai-fyi";
import generatedAppsRoutes from "./routes/generated-apps";
import { runHeartbeatWatchdog } from "./cron/heartbeatWatchdog";
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
app.route("/api/businesses", billingRoutes);
app.route("/api/businesses", businessTaskRunRoutes);
app.route("/api/apps", appsCatalogRoutes);
app.route("/api/businesses", appsBusinessesRoutes);
app.route("/api/business-apps", appsInstancesRoutes);
app.route("/xai-fyi", xaiFyiRoutes);
app.route("/api/generated-apps", generatedAppsRoutes);


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

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await runHeartbeatWatchdog(supabase);
  },
};
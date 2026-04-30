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
import { errBody } from "./lib/errors";
import { log } from "./lib/logger";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      // Allow textos.ai apex + any subdomain, plus local Astro dev ports.
      if (/^https:\/\/([a-z0-9-]+\.)*textos\.ai$/.test(origin)) return origin;
      if (origin === "http://localhost:4321") return origin;
      if (origin === "http://localhost:5173") return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
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

export default app;

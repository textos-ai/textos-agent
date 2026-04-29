import { Hono } from "hono";
import type { Env } from "../env";

const app = new Hono<{ Bindings: Env }>();

// Bumped manually per release until we wire git SHA injection at build time.
const SERVICE_VERSION = "0.1.0-sprint2";

function payload(env: Env) {
  return {
    ok: true,
    service: "textos-agent",
    version: SERVICE_VERSION,
    environment: env.ENVIRONMENT ?? "dev",
    ts: new Date().toISOString(),
  };
}

app.get("/", (c) => c.json(payload(c.env)));

export default app;

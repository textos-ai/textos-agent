import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAuth);

app.get("/", (c) => {
  const auth = c.get("auth");
  return c.json(auth);
});

export default app;

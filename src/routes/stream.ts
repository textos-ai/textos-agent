import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { errBody } from "../lib/errors";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// GET /business/:slug — SSE skeleton.
// Sprint 4: sends 3 mock events then closes.
// Sprint 5: replace body with real agent activity stream.
app.get("/business/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(
    supabase,
    auth.user_id,
    slug,
  ).catch(() => null);

  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "status",
      data: JSON.stringify({ message: "Worker connected", ts: Date.now() }),
    });
    await stream.writeSSE({
      event: "status",
      data: JSON.stringify({ message: "Listening for activity", ts: Date.now() }),
    });
    await stream.writeSSE({
      event: "status",
      data: JSON.stringify({
        message: "Demo mode active — real stream wires in Sprint 5",
        ts: Date.now(),
      }),
    });
  });
});

export default app;

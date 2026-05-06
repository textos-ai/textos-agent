import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { generateStoryCards } from "../services/storyCardGenerator";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

const VALID_COUNTS = [3, 5, 8, 10];

app.post("/", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const kvKey = `ratelimit:stories:${ip}`;
  const current = parseInt((await c.env.SNAPSHOT_KV.get(kvKey)) ?? "0", 10);
  if (current >= 50) {
    return c.json({ ok: false, error: "Rate limit exceeded. Try again in an hour." }, 429);
  }
  await c.env.SNAPSHOT_KV.put(kvKey, String(current + 1), { expirationTtl: 3600 });

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const count = typeof body.count === "number" ? body.count : 8;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";

  if (!VALID_COUNTS.includes(count)) {
    return c.json({ ok: false, error: "count must be 3, 5, 8, or 10" }, 400);
  }
  if (topic.length > 500) {
    return c.json({ ok: false, error: "topic too long" }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const result = await generateStoryCards(
    { topic, count, context: { kind: "textos" } },
    c.env,
    supabase,
  );

  if (!result.ok) {
    log.error("generate_stories_route_error", { error: result.error });
    return c.json(result, 502);
  }
  return c.json(result);
});

export default app;

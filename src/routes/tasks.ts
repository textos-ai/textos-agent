import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSupabaseClient, getTaskBySlug } from "../services/supabase";
import { stubRun } from "../agent/loop";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

const RunBody = z.object({
  taskSlug: z.string().min(1).max(120),
  businessId: z.string().uuid().optional(),
  inputs: z.record(z.unknown()).optional(),
});

app.post("/run", async (c) => {
  let parsed;
  try {
    parsed = RunBody.parse(await c.req.json());
  } catch (err) {
    return c.json(
      errBody(
        "bad_request",
        "invalid request body",
        err instanceof Error ? err.message : err,
      ),
      400,
    );
  }

  const supabase = createSupabaseClient(c.env);

  let task;
  try {
    task = await getTaskBySlug(supabase, parsed.taskSlug);
  } catch (err) {
    log.error("task_lookup_failed", {
      slug: parsed.taskSlug,
      err: String(err),
    });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  if (!task) {
    return c.json(
      errBody("not_found", `task '${parsed.taskSlug}' not found`),
      404,
    );
  }

  return c.json({
    task,
    ...stubRun({
      task,
      businessId: parsed.businessId,
      inputs: parsed.inputs,
    }),
  });
});

export default app;

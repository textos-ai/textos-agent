import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import {
  createSupabaseClient,
  getTaskBySlug,
  type BusinessRow,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { runTaskInBackground } from "./business-task-run";

// ─────────────────────────────────────────────────────────────────────────────
// /api/internal/* — worker→worker chain trigger routes.
//
// Mounted in src/index.ts under /api/internal. NOT user-facing. Validated by
// shared secret in `x-internal-secret` (env.INTERNAL_TRIGGER_SECRET).
//
// Today's only route: POST /run-task — start a task_run for {businessId,
// userId, taskSlug} as if it had been triggered by the user. Each call
// gets its own Worker invocation budget via c.executionCtx.waitUntil.
//
// Used by chain-pattern task handlers (e.g. generate-business-app-design
// triggers generate-business-app-html after saving the design draft) to
// split a long-running task into two independent Worker invocations.
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

const RunTaskBody = z.object({
  businessId: z.string().uuid(),
  userId: z.string().uuid(),
  taskSlug: z.string().min(1),
});

app.post("/run-task", async (c) => {
  const expected = c.env.INTERNAL_TRIGGER_SECRET;
  if (!expected) {
    log.error("internal.run_task.secret_unset", {});
    return c.json(errBody("not_configured", "INTERNAL_TRIGGER_SECRET unset"), 503);
  }

  const got = c.req.header("x-internal-secret") ?? "";
  if (got !== expected) {
    log.warn("internal.run_task.bad_secret", { had_header: got !== "" });
    return c.json(errBody("unauthorized", "bad internal secret"), 401);
  }

  let body: z.infer<typeof RunTaskBody>;
  try {
    body = RunTaskBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const { businessId, userId, taskSlug } = body;

  const supabase = createSupabaseClient(c.env);

  // Resolve business (no user-ownership check — caller is the worker itself).
  const { data: bizRow, error: bizErr } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr) {
    log.error("internal.run_task.business_lookup_failed", { businessId, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!bizRow) {
    return c.json(errBody("not_found", `business '${businessId}' not found`), 404);
  }
  const business = bizRow as BusinessRow;

  // Resolve task by slug.
  let task;
  try {
    task = await getTaskBySlug(supabase, taskSlug);
  } catch (err) {
    log.error("internal.run_task.task_lookup_failed", { taskSlug, err: String(err) });
    return c.json(errBody("internal", "task_lookup_failed"), 500);
  }
  if (!task) {
    return c.json(errBody("not_found", `task '${taskSlug}' not found`), 404);
  }

  // Create the task_run row. No ownership / subscription / balance gates here —
  // this is an internal continuation of work the user already authorized in the
  // parent task. The parent task already passed those gates and (if applicable)
  // already paid the token cost.
  const { data: taskRunRow, error: insertErr } = await supabase
    .from("task_runs")
    .insert({
      user_id: userId,
      business_id: business.id,
      task_id: task.id,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !taskRunRow) {
    log.error("internal.run_task.insert_failed", {
      business_id: business.id,
      task_slug: taskSlug,
      err: insertErr?.message,
    });
    return c.json(errBody("internal", "task_run_insert_failed"), 500);
  }

  const taskRunId = (taskRunRow as { id: string }).id;

  // Hand off to the existing background runner. Each internal call gets its
  // own Worker invocation, so this waitUntil has its own CPU/wall-clock budget.
  c.executionCtx.waitUntil(
    runTaskInBackground(c.env, business, task, userId, taskRunId),
  );

  return c.json(
    {
      accepted: true,
      task_run_id: taskRunId,
    },
    202,
  );
});

export default app;

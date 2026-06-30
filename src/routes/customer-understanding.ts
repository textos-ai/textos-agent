// =============================================================
// Customer Understanding — configured-task page endpoints.
//
// customer-understanding is an output_type='configured' task (migration 057):
// its Playbook modal opens the dedicated page at config_page_path, and the
// generic POST /run refuses it. THIS route is the page's generation entry.
//
// It drives the EXISTING generic document pipeline for storage — it does NOT
// use a bespoke table. generate → runTaskInBackground → genericDocumentRunner →
// task_runs.output_data + business_assets, identical to a normal document task.
// Sharpen is the same run with config.founder_answers (already wired into the
// runner via taskCtx.config).
//
// Charge policy (the page owns it, since /run no longer charges a configured
// task and migration 057 zeroed tasks.token_cost so the shared runner won't
// debit): the DRAFT generate charges CU_DRAFT_TOKEN_COST once; SHARPEN re-runs
// (founder_answers present) are FREE — you don't pay to refine the same
// profile. Debit happens AFTER the run succeeds, inside the same waitUntil, so
// a failed generation costs nothing.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { errBody } from "../lib/errors";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getTaskBySlug,
} from "../services/supabase";
import { runTaskInBackground } from "./business-task-run";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

const CU_SLUG = "customer-understanding";

// Token cost charged once per DRAFT generation. Mirrors the task's prior
// tasks.token_cost (zeroed in migration 057 so the shared runner won't also
// debit); the value lives here because this endpoint now owns the charge.
const CU_DRAFT_TOKEN_COST = 3;

// ── GET /:slug/customer-understanding ─────────────────────────────────────
// Returns the latest run for this business's customer-understanding task plus
// its lock state, so the page can render the current profile on load.
app.get("/:slug/customer-understanding", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("internal", "business_lookup_failed", String(err)), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const task = await getTaskBySlug(supabase, CU_SLUG);
  if (!task) return c.json(errBody("not_found", "task not found"), 404);

  // Latest run (any status) — the page shows running/failed/completed state.
  const { data: run } = await supabase
    .from("task_runs")
    .select("id, status, output_data, completed_at, config")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let is_locked = false;
  let asset_id: string | null = null;
  if (run?.id) {
    const { data: asset } = await supabase
      .from("business_assets")
      .select("id, metadata")
      .eq("business_id", business.id)
      .eq("task_run_id", run.id)
      .eq("asset_type", "document")
      .maybeSingle();
    if (asset) {
      asset_id = asset.id as string;
      const meta = (asset.metadata as Record<string, unknown>) ?? {};
      is_locked = meta.is_locked === true;
    }
  }

  const cfg = (run?.config as Record<string, unknown> | null) ?? null;
  const sharpened = !!(cfg && typeof cfg.founder_answers === "string" && cfg.founder_answers.trim());

  return c.json({
    run_id: run?.id ?? null,
    status: run?.status ?? null,
    doc: run?.output_data ?? null,
    completed_at: run?.completed_at ?? null,
    sharpened,
    is_locked,
    asset_id,
  });
});

// ── POST /:slug/customer-understanding/generate ───────────────────────────
// Body: { founder_answers?: string }. Absent/empty → DRAFT (charged once).
// Present → SHARPEN re-run (free). Triggers the generic pipeline; returns 202
// with the task_run_id for the page to poll via GET /:slug/task_runs/:id.
app.post("/:slug/customer-understanding/generate", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let founderAnswers = "";
  try {
    const raw = await c.req.json().catch(() => null);
    if (raw && typeof raw === "object" && typeof (raw as any).founder_answers === "string") {
      founderAnswers = ((raw as any).founder_answers as string).trim();
    }
  } catch {
    founderAnswers = "";
  }
  const isSharpen = founderAnswers.length > 0;

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("internal", "business_lookup_failed", String(err)), 500);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const task = await getTaskBySlug(supabase, CU_SLUG);
  if (!task) return c.json(errBody("not_found", "task not found"), 404);

  // Concurrency lock — one run at a time for this (business, task).
  const { data: runningRow, error: lockErr } = await supabase
    .from("task_runs")
    .select("id")
    .eq("business_id", business.id)
    .eq("task_id", task.id)
    .eq("status", "running")
    .maybeSingle();
  if (lockErr) {
    log.error("[customer-understanding] concurrency_lock_failed", { business_id: business.id, err: lockErr.message });
    return c.json(errBody("internal", "concurrency_lock_failed"), 500);
  }
  if (runningRow) {
    return c.json({ error: "task_already_running", message: "A profile is already generating." }, 409);
  }

  // Draft charge pre-check. Sharpen re-runs are free, so no balance gate.
  if (!isSharpen) {
    const { data: balance, error: balErr } = await supabase
      .from("token_balances")
      .select("period_tokens_included, period_tokens_used, topup_tokens_remaining")
      .eq("business_id", business.id)
      .maybeSingle();
    if (balErr || !balance) {
      log.error("[customer-understanding] balance_lookup_failed", { business_id: business.id, err: balErr?.message });
      return c.json(errBody("internal", "balance_lookup_failed"), 500);
    }
    const available =
      Math.max(0, (balance.period_tokens_included as number) - (balance.period_tokens_used as number)) +
      (balance.topup_tokens_remaining as number);
    if (available < CU_DRAFT_TOKEN_COST) {
      return c.json(
        {
          error: "insufficient_tokens",
          available,
          requested: CU_DRAFT_TOKEN_COST,
          business_id: business.id,
          task_slug: CU_SLUG,
        },
        402,
      );
    }
  }

  // Create the run (config carries founder_answers for the sharpen re-run —
  // the runner renders {{config.founder_answers}}).
  const { data: runRow, error: insertErr } = await supabase
    .from("task_runs")
    .insert({
      user_id: auth.user_id,
      business_id: business.id,
      task_id: task.id,
      status: "running",
      started_at: new Date().toISOString(),
      config: isSharpen ? { founder_answers: founderAnswers } : null,
    })
    .select("id")
    .single();
  if (insertErr || !runRow) {
    log.error("[customer-understanding] task_run_insert_failed", { business_id: business.id, err: insertErr?.message });
    return c.json(errBody("internal", "task_run_insert_failed"), 500);
  }
  const taskRunId = (runRow as { id: string }).id;

  const env = c.env;
  const userId = auth.user_id;
  const biz = business;
  const isDraft = !isSharpen;

  c.executionCtx.waitUntil(
    (async () => {
      await runTaskInBackground(env, biz, task, userId, taskRunId);
      // Charge the draft AFTER success only. tasks.token_cost is 0, so the
      // shared runner debited nothing; this is the sole charge for a draft.
      if (isDraft) {
        const { data: run } = await supabase
          .from("task_runs")
          .select("status")
          .eq("id", taskRunId)
          .maybeSingle();
        if (run?.status === "completed") {
          const { data: debit, error: debitErr } = await supabase.rpc("debit_tokens", {
            p_business_id: biz.id,
            p_user_id: userId,
            p_tokens: CU_DRAFT_TOKEN_COST,
            p_task_slug: CU_SLUG,
            p_task_run_id: taskRunId,
            p_description: `Task: ${task.name}`,
          });
          if (debitErr || !(debit as { ok?: boolean })?.ok) {
            // Non-fatal: the user keeps the profile (business_assets is the
            // receipt); they just got this draft free. Log loudly.
            log.error("[customer-understanding] draft_debit_failed", {
              business_id: biz.id,
              task_run_id: taskRunId,
              err: debitErr?.message ?? String(debit),
            });
          }
        }
      }
    })(),
  );

  return c.json({ accepted: true, task_run_id: taskRunId, mode: isSharpen ? "sharpen" : "draft" }, 202);
});

export default app;

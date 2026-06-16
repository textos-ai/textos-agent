import type { TaskCtx, TaskResult } from "./types";
import type { ModelConfig } from "../model-config";
import { genAppLog } from "../gen-app-log";

// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app-design — step 1 of 2 in the chain pattern.
//
// Responsibilities:
//   1. Make Call 1 (design JSON spec) with a 45s timeout.
//   2. Persist the spec to business_assets as asset_type='app_draft'.
//   3. Self-call /api/internal/run-task to dispatch step 2
//      ('generate-business-app-html') in a SEPARATE Worker invocation so
//      it gets its own CPU / wall-clock budget.
//
// Why the chain: Workers waitUntil has finite wall-clock budget. The
// original single-handler approach (two sequential Claude calls + 8000-token
// HTML output) crowded the 2-minute task_run sweep at business-task-run.ts:437
// and risked Worker-side termination. Splitting buys each call its own
// invocation.
//
// Token accounting: this handler owns the token charge for the whole
// generate-business-app feature. The chained 'generate-business-app-html' task
// row has token_cost=0 — see the SQL note in the brief.
// ─────────────────────────────────────────────────────────────────────────────

interface AppDesign {
  app_type: string;
  app_title: string;
  app_tagline: string;
  app_description: string;
  app_icon: string;
  questions: Array<{
    id: string;
    text: string;
    type: "single_choice" | "multi_choice" | "text" | "number" | "scale";
    options?: string[];
    min?: number;
    max?: number;
  }>;
  free_tier_reveals: string;
  paid_tier_reveals: string;
  cta_label: string;
  result_logic: string;
  accent_color: string;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Validate an LLM-supplied emoji icon. Accept if it's a short string (<=12
 * chars after trimming) containing at least one Extended_Pictographic code
 * point — this catches both single emoji and short emoji sequences while
 * rejecting plain text labels like "rocket".
 */
function isReasonableIcon(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t || t.length > 12) return false;
  return /\p{Extended_Pictographic}/u.test(t);
}

/**
 * Deterministic fallback when the LLM didn't supply a reasonable icon.
 * Order matters: 'quiz' is checked before 'assessment' so 'assessment_quiz'
 * → 🎯 (the quizzy thing) rather than ✅ (the generic assessment).
 */
function fallbackIconForAppType(appType: string): string {
  const t = (appType || "").toLowerCase();
  if (t.includes("quiz")) return "🎯";
  if (t.includes("calculator")) return "🧮";
  if (t.includes("recommendation")) return "✨";
  if (t.includes("pricing")) return "💰";
  if (t.includes("generator")) return "⚡";
  if (t.includes("comparison")) return "🔬";
  if (t.includes("planner")) return "📋";
  if (t.includes("assessment")) return "✅";
  return "🧩";
}

/**
 * Apply the icon validation chain to a design returned from the LLM:
 *   1. LLM-picked icon if reasonable
 *   2. Deterministic map by app_type
 *   3. '🧩' (the catchall lives in fallbackIconForAppType)
 *
 * Returns the chosen icon string. Caller is expected to write it back to
 * design.app_icon so downstream (html step + DB column promotion) sees a
 * non-empty value.
 */
function resolveAppIcon(design: AppDesign): string {
  if (isReasonableIcon(design.app_icon)) return design.app_icon.trim();
  return fallbackIconForAppType(design.app_type);
}

function resolveAgentUrl(env: TaskCtx["env"]): string {
  if (env.AGENT_URL) return env.AGENT_URL;
  return env.ENVIRONMENT === "test"
    ? "https://textos-agent-test.rgaudet2023.workers.dev"
    : "https://api.victora.ai";
}

const CALL_TIMEOUT_MS = 45_000;

async function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)), ms),
  );
  return Promise.race([p, timeout]);
}

export async function runGenerateBusinessAppDesign(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, env, taskRunId, user } = tc;
  const handlerStart = Date.now();

  // ── Diagnostic checkpoint writer ─────────────────────────────────────────
  // Awaited writes to task_runs.work_log[] — the same row the frontend is
  // already polling. By being awaited inside the handler (not fire-and-
  // forget on a module-scope sink), every checkpoint lands in the row
  // BEFORE the next step runs and BEFORE the handler returns. Read-modify-
  // write is safe here because the entire Design handler runs serially in
  // a single Worker invocation — no concurrent writers.
  //
  // Why this exists alongside genAppLog (which writes to stream_events +
  // task_runs.work_log via the gen-app-log sink): the sink is fire-and-
  // forget and has been silently dropping writes (zero gen_app_% rows in
  // stream_events despite confirmed handler execution). Until we know why,
  // we need at least one authoritative signal channel that we can prove
  // landed by reading task_runs.work_log right after the run.
  async function checkpoint(event: string, data: Record<string, unknown> = {}) {
    const entry = { event, ts: new Date().toISOString(), ...data };
    try {
      const { data: row } = await supabase
        .from("task_runs")
        .select("work_log")
        .eq("id", taskRunId)
        .maybeSingle();
      const current = Array.isArray(row?.work_log)
        ? (row!.work_log as unknown[])
        : [];
      current.push(entry);
      await supabase
        .from("task_runs")
        .update({ work_log: current })
        .eq("id", taskRunId);
    } catch (err) {
      // Don't crash the run on a diagnostic write failure — just log to
      // console (which will land in tail when tail is alive).
      console.error(
        "[design.checkpoint] write_failed",
        JSON.stringify({
          event,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  await checkpoint("design_entry", {
    business_id: business.id,
    task_run_id: taskRunId,
    environment: env.ENVIRONMENT,
  });

  // ── Runtime-binding probe (kept as awaited checkpoint) ─────────────────
  // Surfaces the actual shape of env.APP_GEN_HTML_QUEUE at runtime AND the
  // presence of INTERNAL_TRIGGER_SECRET. Both lands in task_runs.work_log
  // synchronously so Rob can SELECT the row right after a failed run and
  // see exactly what the binding state was at handler entry.
  const queueBinding = env.APP_GEN_HTML_QUEUE as unknown as
    | { send?: unknown }
    | undefined;
  await checkpoint("design_probe", {
    business_id: business.id,
    task_run_id: taskRunId,
    has_queue: typeof queueBinding,
    has_queue_send_fn:
      queueBinding && typeof queueBinding === "object"
        ? typeof queueBinding.send
        : "n/a",
    has_internal_secret: typeof env.INTERNAL_TRIGGER_SECRET,
    internal_secret_len:
      typeof env.INTERNAL_TRIGGER_SECRET === "string"
        ? env.INTERNAL_TRIGGER_SECRET.length
        : 0,
  });
  // Also fire the genAppLog so the console.log lane (for wrangler tail when
  // it works) and the fire-and-forget sink lanes still get the event.
  genAppLog("design_handler_entry_probe", {
    business_id: business.id,
    task_run_id: taskRunId,
    has_queue: typeof queueBinding,
    has_queue_send_fn:
      queueBinding && typeof queueBinding === "object"
        ? typeof queueBinding.send
        : "n/a",
    has_internal_secret: typeof env.INTERNAL_TRIGGER_SECRET,
    internal_secret_len:
      typeof env.INTERNAL_TRIGGER_SECRET === "string"
        ? env.INTERNAL_TRIGGER_SECRET.length
        : 0,
    environment: env.ENVIRONMENT,
  });

  // INTERNAL_TRIGGER_SECRET guard moved into the SELF.fetch fallback
  // branch below (search "x-internal-secret"). The queue path
  // (APP_GEN_HTML_QUEUE) does not need this secret — it dispatches step
  // 2 via Cloudflare Queues, not via the /api/internal/run-task chain
  // trigger. When the queue binding is present, the secret is optional
  // and this top-of-handler guard would block a perfectly-working queue
  // dispatch path on a stale config issue.

  // Optional user-provided description and tier — passed through task_runs.config
  // by the business-task-run dispatch path.
  const taskRunRow = await supabase
    .from("task_runs")
    .select("config")
    .eq("id", taskRunId)
    .maybeSingle();
  const config = (taskRunRow.data?.config as Record<string, unknown> | null) || null;
  const userDescription =
    typeof config?.description === "string" ? config.description : "";
  const llmTier = typeof config?.llm_tier === "string" ? (config.llm_tier as string) : "haiku";

  genAppLog("design_handler_entry", {
    business_id: business.id,
    task_run_id: taskRunId,
    llm_tier: llmTier,
    has_user_description: userDescription.length > 0,
  });

  await emit({ type: "cmd", text: "Designing your custom app...", ts: Date.now() });

  // ── CALL 1 — App design ────────────────────────────────────────────────────
  const systemPrompt = `You are an expert web app designer for ${business.name}, a ${ctx.industry ?? "small"} business. ${ctx.business_summary ?? ""}. Return ONLY valid JSON. First character must be {.`;

  const userPrompt = `Design a custom mini-app for this business website. The app must be specific to this industry and serve the target customer directly.

Business context:
- Industry: ${ctx.industry ?? "unknown"}
- Summary: ${ctx.business_summary ?? "unknown"}
- Target customer: ${ctx.target_customer ? JSON.stringify(ctx.target_customer) : "unknown"}
- Value proposition: ${ctx.value_proposition ?? "unknown"}
- Brand voice: ${ctx.brand_voice ?? "professional"}
- Business kind: ${business.kind}

${userDescription ? `User-provided description (HONOR THIS): ${userDescription}` : ""}

Choose the BEST app type from this list based on the business:
  - assessment_quiz: customer readiness/fit quiz
  - quote_calculator: instant price estimator
  - roi_calculator: return on investment tool
  - recommendation_engine: product/service matcher
  - lead_qualifier: qualify visitor's needs
  - booking_intake: pre-booking question form
  - knowledge_checker: educational quiz

Return JSON:
{
  "app_type": "string",
  "app_title": "string",
  "app_tagline": "string",
  "app_description": "string (shown to visitor)",
  "app_icon": "string — a single emoji representing the app's purpose (e.g. 🎯 for a quiz, 🧮 for a calculator). One emoji only, no surrounding text.",
  "questions": [
    {
      "id": "q1",
      "text": "string",
      "type": "single_choice|multi_choice|text|number|scale",
      "options": ["..."],
      "min": 0,
      "max": 10
    }
  ],
  "free_tier_reveals": "string — what the free tier shows after submit",
  "paid_tier_reveals": "string — what the paid tier unlocks",
  "cta_label": "string — paywall button text",
  "result_logic": "string — plain English: how to score/calculate results",
  "accent_color": "string — hex color matching the business brand"
}`;

  // Resolve the concrete Anthropic model from the admin-configured tier map.
  // Throws on unknown tier — fail-fast rather than silently fall back.
  const designModel = (models as unknown as Record<string, string | undefined>)[llmTier];
  if (!designModel) throw new Error(`unknown_llm_tier: ${llmTier}`);

  let design: AppDesign;
  const callStart = Date.now();
  genAppLog("design_anthropic_call_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    model: designModel,
    max_tokens: 2000,
    prompt_chars: systemPrompt.length + userPrompt.length,
    timeout_ms: CALL_TIMEOUT_MS,
  });
  try {
    // AbortController-driven timeout. Unlike the legacy Promise.race
    // withTimeout helper, this actually cancels the underlying fetch
    // when the timer fires, freeing the Worker invocation budget.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      genAppLog("design_abort_fired", {
        business_id: business.id,
        task_run_id: taskRunId,
        elapsed_ms: Date.now() - callStart,
      });
      controller.abort();
    }, CALL_TIMEOUT_MS);
    let msg;
    try {
      msg = await anthropic.messages.create(
        {
          model: designModel,
          max_tokens: 2000,
          stream: false,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }
    const block = msg.content[0];
    const text = block && block.type === "text" ? (block as { text: string }).text : "";
    const stopReason = (msg as { stop_reason?: string }).stop_reason ?? "unknown";
    const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
    genAppLog("design_anthropic_call_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
      stop_reason: stopReason,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      elapsed_ms: Date.now() - callStart,
      response_chars: text.length,
    });
    design = JSON.parse(stripFences(text.trim())) as AppDesign;
    // ── Icon validation chain (Phase 1, 2026-05-26) ─────────────────────
    // LLM-picked icon → deterministic by app_type → '🧩'. resolveAppIcon
    // returns a guaranteed-non-empty string. Stored back on design so the
    // app_draft row carries it through to the HTML step, which then
    // promotes it onto the top-level app_icon column at INSERT time.
    const originalIcon = (design as { app_icon?: unknown }).app_icon;
    const resolvedIcon = resolveAppIcon(design);
    design.app_icon = resolvedIcon;
    genAppLog("design_icon_resolved", {
      business_id: business.id,
      task_run_id: taskRunId,
      app_type: design.app_type,
      llm_supplied: typeof originalIcon === "string" ? originalIcon : null,
      llm_supplied_reasonable: isReasonableIcon(originalIcon),
      resolved: resolvedIcon,
    });
  } catch (err) {
    genAppLog("design_anthropic_call_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      elapsed_ms: Date.now() - callStart,
      err_name: err instanceof Error ? err.name : "unknown",
      err_message: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `App design call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await emit({
    type: "cmd",
    text: "App design complete — building interface...",
    ts: Date.now(),
  });

  // ── Persist draft ──────────────────────────────────────────────────────────
  // Stored as asset_type='app_draft'. The HTML step reads this row, then deletes
  // it once the final 'app' row is saved.
  genAppLog("design_draft_write_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    app_type: design.app_type,
  });
  const { error: draftErr } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "app_draft",
      asset_subtype: "design_spec",
      asset_url: null,
      asset_data: {
        design,
        llm_tier: llmTier,
        designed_at: new Date().toISOString(),
      },
      metadata: { model: designModel, step: "design" },
    });
  if (draftErr) {
    genAppLog("design_draft_write_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      err: draftErr.message,
    });
    throw new Error(`Failed to save app_draft: ${draftErr.message}`);
  }
  genAppLog("design_draft_write_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
  });

  // ── Dispatch step 2 in a separate Worker invocation ────────────────────────
  // Two dispatch paths, picked by binding presence:
  //
  //   1. APP_GEN_HTML_QUEUE (preferred). Producer pre-creates the HTML
  //      task_run row in status='queued', then sends a message containing
  //      its id. The consumer (src/queues/app-gen-html-consumer.ts) atomically
  //      flips queued→running and dispatches runTaskInBackground inside a
  //      fresh 15-min wall-clock budget — this avoids the Cloudflare
  //      subrequest body timeout that silently killed the SELF.fetch path
  //      on long Anthropic streams.
  //   2. env.SELF.fetch (fallback). Original chain trigger via the
  //      /api/internal/run-task service binding. Kept alive as a safety
  //      net during the queue soak period — if the queue binding is ever
  //      undefined we still dispatch the HTML step.
  //
  // Both paths return next_task_run_id so the frontend poll logic in
  // /business/apps.astro is unchanged.
  let htmlTaskRunId: string | null = null;

  await checkpoint("design_dispatch_choice", {
    branch: env.APP_GEN_HTML_QUEUE ? "queue" : "self_fetch_fallback",
  });

  if (env.APP_GEN_HTML_QUEUE) {
    // Queue path: pre-create the HTML task_run row in status='queued', then
    // enqueue the message. The consumer applies Rob's idempotency contract
    // (queued/failed → atomic claim; running/completed → skip) so retries
    // don't double-charge or duplicate assets.
    genAppLog("design_queue_dispatch_start", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
    const { data: htmlTaskLookup, error: htmlTaskErr } = await supabase
      .from("tasks")
      .select("id")
      .eq("slug", "generate-business-app-html")
      .maybeSingle();
    if (htmlTaskErr || !htmlTaskLookup) {
      genAppLog("design_queue_html_task_lookup_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        err: htmlTaskErr?.message ?? "html_task_row_missing",
      });
      throw new Error(
        `generate-business-app-html task row missing: ${htmlTaskErr?.message ?? "not found"}`,
      );
    }

    const { data: queuedRow, error: queuedErr } = await supabase
      .from("task_runs")
      .insert({
        user_id: user.id,
        business_id: business.id,
        task_id: (htmlTaskLookup as { id: string }).id,
        status: "queued",
        // started_at intentionally null — the consumer sets it on the
        // atomic queued→running flip so dashboards reflect actual run start.
        config: {
          llm_tier: llmTier,
          parent_design_task_run_id: taskRunId,
        },
      })
      .select("id")
      .single();

    if (queuedErr || !queuedRow) {
      genAppLog("design_queue_row_insert_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        err: queuedErr?.message,
      });
      throw new Error(
        `Failed to insert queued HTML task_run: ${queuedErr?.message ?? "no row returned"}`,
      );
    }

    const claimedHtmlId = (queuedRow as { id: unknown }).id;
    if (typeof claimedHtmlId !== "string" || claimedHtmlId.length === 0) {
      // Defensive — Supabase .single() should always return {id} matching
      // the inserted row, but if PostgREST ever changes the shape silently
      // we want a loud failure instead of letting `htmlTaskRunId` stay
      // null and corrupt output_data downstream (which is what produced
      // the "step 2 did not start" frontend fallback before this guard).
      genAppLog("design_queue_row_id_malformed", {
        business_id: business.id,
        task_run_id: taskRunId,
        observed_shape: typeof claimedHtmlId,
      });
      throw new Error(
        `Queued HTML task_run insert returned a row but its id field was missing or not a string (got ${typeof claimedHtmlId}).`,
      );
    }
    htmlTaskRunId = claimedHtmlId;
    genAppLog("design_queue_row_inserted", {
      business_id: business.id,
      task_run_id: taskRunId,
      html_task_run_id: htmlTaskRunId,
    });

    try {
      await env.APP_GEN_HTML_QUEUE.send({
        htmlTaskRunId,
        businessId: business.id,
        userId: user.id,
        designTaskRunId: taskRunId,
      });
    } catch (sendErr) {
      // Queue send failed — flip the pre-created row to failed so it
      // doesn't sit in 'queued' forever and so the stale-sweep cron
      // doesn't have to clean it up. Then bubble the error.
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      genAppLog("design_queue_send_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        html_task_run_id: htmlTaskRunId,
        err: msg,
      });
      await supabase
        .from("task_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: `queue_send_failed: ${msg}`.slice(0, 4000),
        })
        .eq("id", htmlTaskRunId)
        .eq("status", "queued");
      throw new Error(`Failed to enqueue HTML step: ${msg}`);
    }

    genAppLog("design_queue_dispatch_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
      html_task_run_id: htmlTaskRunId,
    });
  } else {
    // Fallback path: Service Binding chain trigger. Cloudflare blocks
    // Worker→same-Worker fetches over the public hostname (CF error 1042),
    // so we route via the SELF binding declared in wrangler.toml. The
    // Request URL hostname is a placeholder the Hono router matches against.
    //
    // Secret guard scoped to this branch only. The queue path (above)
    // doesn't need INTERNAL_TRIGGER_SECRET; only the /api/internal/run-task
    // route validates it. Surfacing the misconfiguration here keeps the
    // failure tight to the actual code path that depends on the secret.
    if (!env.INTERNAL_TRIGGER_SECRET) {
      genAppLog("design_secret_missing", {
        business_id: business.id,
        task_run_id: taskRunId,
        branch: "self_fetch_fallback",
      });
      throw new Error(
        "INTERNAL_TRIGGER_SECRET is unset — cannot chain to generate-business-app-html via SELF.fetch fallback. " +
          "Set it via: wrangler secret put INTERNAL_TRIGGER_SECRET --env <env>",
      );
    }
    const triggerReq = new Request("http://internal/api/internal/run-task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.INTERNAL_TRIGGER_SECRET,
      },
      body: JSON.stringify({
        businessId: business.id,
        userId: user.id,
        taskSlug: "generate-business-app-html",
        // Forward the tier so the HTML step's task_run carries it, and
        // the chain-aware debit override in runTaskInBackground can map
        // tier → cost for the chained HTML task.
        config: { llm_tier: llmTier, parent_design_task_run_id: taskRunId },
      }),
    });
    genAppLog("design_chain_trigger_start", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
    const triggerRes = await env.SELF.fetch(triggerReq);

    if (!triggerRes.ok) {
      const txt = await triggerRes.text().catch(() => "");
      genAppLog("design_chain_trigger_failed", {
        business_id: business.id,
        task_run_id: taskRunId,
        status: triggerRes.status,
        body_preview: txt.slice(0, 200),
      });
      throw new Error(
        `Failed to trigger generate-business-app-html (status ${triggerRes.status}): ${txt.slice(0, 200)}`,
      );
    }

    const triggerJson = (await triggerRes.json().catch(() => ({}))) as {
      task_run_id?: string;
    };
    htmlTaskRunId = triggerJson.task_run_id ?? null;
    genAppLog("design_chain_trigger_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
      html_task_run_id: htmlTaskRunId,
    });
  }

  await checkpoint("design_dispatch_complete", {
    html_task_run_id: htmlTaskRunId,
    has_html_task_run_id:
      typeof htmlTaskRunId === "string" && htmlTaskRunId.length > 0,
  });

  // Persist output_data on the Design task_run directly, BEFORE the
  // return. runTaskInBackground does write `output_data: result.output_data`
  // at completion time, but only when the status='running' gate still
  // matches at that moment. If anything flips the row's status between
  // here and the framework write (a cancellation, the inline 5-min
  // sweep at business-task-run.ts:458, etc.), the framework's write
  // silently no-ops — and the frontend then sees status='completed' but
  // output_data missing, which hits apps.astro:933 with the misleading
  // "INTERNAL_TRIGGER_SECRET is unset" message. This explicit pre-write
  // is the belt-and-suspenders fix: by the time we return, the field is
  // in the DB regardless of what happens later. (Both paths flow
  // through this write — queue branch and SELF.fetch branch alike.)
  const designOutputData = {
    step: "design",
    app_type: design.app_type,
    app_title: design.app_title,
    app_tagline: design.app_tagline,
    next_step: "generate-business-app-html",
    next_task_run_id: htmlTaskRunId,
  };
  genAppLog("design_output_data_write_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    html_task_run_id: htmlTaskRunId,
    has_next_task_run_id: typeof htmlTaskRunId === "string" && htmlTaskRunId.length > 0,
  });
  const { error: outputWriteErr } = await supabase
    .from("task_runs")
    .update({ output_data: designOutputData })
    .eq("id", taskRunId);
  if (outputWriteErr) {
    genAppLog("design_output_data_write_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      err: outputWriteErr.message,
    });
    // Non-fatal — the framework write still runs after the return and
    // may succeed. We just lose the early-persist guarantee.
  } else {
    genAppLog("design_output_data_write_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
  }

  await checkpoint("design_exit", {
    total_elapsed_ms: Date.now() - handlerStart,
    outcome: "success",
    html_task_run_id: htmlTaskRunId,
    output_data_persisted: !outputWriteErr,
  });

  genAppLog("design_handler_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
    total_elapsed_ms: Date.now() - handlerStart,
    outcome: "success",
    html_task_run_id: htmlTaskRunId,
  });

  return { output_data: designOutputData };
}

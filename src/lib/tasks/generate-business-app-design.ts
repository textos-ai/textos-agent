import type { TaskCtx, TaskResult } from "./types";
import { resolveModelForTier } from "../llm-tier-model";

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

function resolveAgentUrl(env: TaskCtx["env"]): string {
  if (env.AGENT_URL) return env.AGENT_URL;
  return env.ENVIRONMENT === "test"
    ? "https://textos-agent-test.rgaudet2023.workers.dev"
    : "https://textos-agent-dev.rgaudet2023.workers.dev";
}

const CALL_TIMEOUT_MS = 45_000;

async function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)), ms),
  );
  return Promise.race([p, timeout]);
}

export async function runGenerateBusinessAppDesign(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit, supabase, env, taskRunId, user } = tc;

  // Surface a clear setup error early — without the secret, the chain cannot
  // dispatch step 2 and the user would never see their app finished.
  if (!env.INTERNAL_TRIGGER_SECRET) {
    throw new Error(
      "INTERNAL_TRIGGER_SECRET is unset — cannot chain to generate-business-app-html. " +
        "Set it via: wrangler secret put INTERNAL_TRIGGER_SECRET --env <env>",
    );
  }

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

  // Resolve the concrete Anthropic model from the user-selected tier.
  // Throws on unknown tier — fail-fast rather than silently fall back.
  const designModel = resolveModelForTier(llmTier);

  let design: AppDesign;
  try {
    // AbortController-driven timeout. Unlike the legacy Promise.race
    // withTimeout helper, this actually cancels the underlying fetch
    // when the timer fires, freeing the Worker invocation budget.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
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
    design = JSON.parse(stripFences(text.trim())) as AppDesign;
  } catch (err) {
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
    throw new Error(`Failed to save app_draft: ${draftErr.message}`);
  }

  // ── Dispatch step 2 in a separate Worker invocation ────────────────────────
  // Use the SELF service binding rather than a public-URL fetch — Cloudflare
  // blocks Worker→same-Worker fetches over the public hostname (CF error 1042).
  // Service Bindings route by binding name; the Request URL hostname is just
  // a placeholder the Hono router will match against.
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
      config: { llm_tier: llmTier },
    }),
  });
  const triggerRes = await env.SELF.fetch(triggerReq);

  if (!triggerRes.ok) {
    const txt = await triggerRes.text().catch(() => "");
    throw new Error(
      `Failed to trigger generate-business-app-html (status ${triggerRes.status}): ${txt.slice(0, 200)}`,
    );
  }

  const triggerJson = (await triggerRes.json().catch(() => ({}))) as {
    task_run_id?: string;
  };
  const htmlTaskRunId = triggerJson.task_run_id ?? null;

  return {
    output_data: {
      step: "design",
      app_type: design.app_type,
      app_title: design.app_title,
      app_tagline: design.app_tagline,
      next_step: "generate-business-app-html",
      next_task_run_id: htmlTaskRunId,
    },
  };
}

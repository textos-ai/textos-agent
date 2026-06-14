// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app-v2 — STYLE_GUIDE §13 strategy app builder.
//
// BUILD step only: the LLM (APP_BUILDER_MODEL) emits the §13 build contract
// (questions + result.section_plan directives + cta); it is Zod-validated
// (no-fallbacks → throw on any missing field), then assembled and stored.
// The result BODIES are generated later, at runtime, from the visitor's actual
// answers (POST /api/generated-apps/:businessId/by-slug/:slug/result).
//
// Strategy archetype only this increment. No placeholder transform, no
// fallbacks — see docs/backlog-v2-architectural-debt.md / app-builder audit.
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskCtx, TaskResult } from "./types";
import { log } from "../logger";
import {
  buildStrategyBuildPrompt,
  extractBusinessContext,
} from "../prompts/app-content-prompts";
import { assembleApp, type AssemblerOutput } from "../assembler";
import { StrategyContentSchema } from "../assembler/validation/schemas";
import { resolveFeatureModel } from "../non-task-model-config";
import { appendWorkLog } from "../work-log";
import { logFailure } from "../failure-log";

const V2_EVENTS = {
  LLM_CALL_STARTED: "v2_llm_call_started",
  LLM_CALL_COMPLETED: "v2_llm_call_completed",
  CONTENT_VALIDATED: "v2_content_validated",
  CONTENT_VALIDATION_FAILED: "v2_content_validation_failed",
  ASSEMBLY_COMPLETED: "v2_assembly_completed",
  ASSET_STORED: "v2_asset_stored",
  APP_COMPLETED: "v2_app_completed",
  APP_FAILED: "v2_app_failed",
} as const;

interface V2Config {
  archetype_id: "strategy" | "assessment" | "calculator";
  description: string;
  llm_tier?: "haiku" | "sonnet" | "opus";
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Main handler for the generate-business-app-v2 task.
 * Called from the task dispatch in business-task-run.ts.
 */
export async function runGenerateBusinessAppV2(taskCtx: TaskCtx): Promise<TaskResult> {
  const { supabase, anthropic, business, ctx, taskRunId } = taskCtx;

  try {
    const config = await parseV2Config(taskCtx);

    // Strategy-only this increment. Honest halt rather than mis-generating an
    // assessment/calculator through a strategy-shaped pipeline (audit #4).
    if (config.archetype_id !== "strategy") {
      throw new Error(
        `archetype_not_supported: '${config.archetype_id}' — only 'strategy' is wired in v2 (assessment/calculator deferred)`,
      );
    }

    const llmTier = config.llm_tier || "sonnet"; // recorded for billing only
    const model = resolveFeatureModel("feature-app-builder", taskCtx.featureConfig, taskCtx.models);
    const isDevOrTest =
      taskCtx.env.ENVIRONMENT === "test" || taskCtx.env.ENVIRONMENT === "dev";

    // Business context — NO-FALLBACKS: missing load-bearing field throws.
    const bc = extractBusinessContext(ctx);
    bc.name = business.name;
    if (!bc.name || !bc.name.trim()) {
      throw new Error("missing businesses.name (no-fallbacks)");
    }

    const { system, user } = buildStrategyBuildPrompt(bc, config.description);

    await appendWorkLog(taskCtx, V2_EVENTS.LLM_CALL_STARTED, {
      model,
      llm_tier: llmTier,
      archetype_id: config.archetype_id,
      ...(isDevOrTest && { full_system_prompt: system, full_user_prompt: user }),
    });

    // ── Design call (single + one parse-retry) ──────────────────────────
    const callStart = Date.now();
    let parsed: unknown;
    try {
      const msg = await anthropic.messages.create({
        model,
        max_tokens: 4000,
        stream: false,
        system,
        messages: [{ role: "user", content: user }],
      });
      const block = msg.content[0];
      const text = block && block.type === "text" ? (block as { text: string }).text : "";
      const usage =
        (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};

      await appendWorkLog(taskCtx, V2_EVENTS.LLM_CALL_COMPLETED, {
        elapsed_ms: Date.now() - callStart,
        response_chars: text.length,
        input_tokens: usage.input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
        ...(isDevOrTest && { full_response_text: text }),
      });

      try {
        parsed = JSON.parse(stripFences(text.trim()));
      } catch (parseErr) {
        // One retry with explicit error feedback.
        const retryMsg = await anthropic.messages.create({
          model,
          max_tokens: 4000,
          stream: false,
          system: `${system}\n\nYour previous response was not valid JSON (${parseErr instanceof Error ? parseErr.message : String(parseErr)}). Return ONLY the JSON object, first character "{".`,
          messages: [{ role: "user", content: user }],
        });
        const retryBlock = retryMsg.content[0];
        const retryText =
          retryBlock && retryBlock.type === "text" ? (retryBlock as { text: string }).text : "";
        parsed = JSON.parse(stripFences(retryText.trim())); // throws → caught below
      }
    } catch (err) {
      await logFailure(taskCtx, "v2_llm_call_failed", "Design call failed", {
        error: err instanceof Error ? err.message : String(err),
        model,
        elapsed_ms: Date.now() - callStart,
      });
      throw new Error(`Design call failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Validate against the §13 build schema — NO-FALLBACKS ─────────────
    let content: ReturnType<typeof StrategyContentSchema.parse>;
    try {
      content = StrategyContentSchema.parse(parsed);
    } catch (zerr) {
      await appendWorkLog(taskCtx, V2_EVENTS.CONTENT_VALIDATION_FAILED, {
        error: zerr instanceof Error ? zerr.message : String(zerr),
      });
      await logFailure(taskCtx, "v2_content_validation_failed", "Content validation failed (no-fallbacks)", {
        zod_error: zerr instanceof Error ? zerr.message : String(zerr),
        raw: JSON.stringify(parsed).slice(0, 1500),
      });
      throw new Error(
        `Content validation failed (no-fallbacks): ${zerr instanceof Error ? zerr.message : String(zerr)}`,
      );
    }

    await appendWorkLog(taskCtx, V2_EVENTS.CONTENT_VALIDATED, {
      archetype_id: config.archetype_id,
      question_count: content.questions.length,
      section_plan_count: content.result.section_plan.length,
    });

    // ── Assemble ────────────────────────────────────────────────────────
    const appTitle = content.app_title;
    const appSlug = await generateUniqueAppSlug(supabase, business.id, appTitle);

    const frontendUrl = taskCtx.env.FRONTEND_URL || "https://app.textos.ai";
    const agentUrl =
      taskCtx.env.AGENT_URL ||
      (taskCtx.env.ENVIRONMENT === "test"
        ? "https://textos-agent-test.rgaudet2023.workers.dev"
        : "https://textos-agent-dev.rgaudet2023.workers.dev");

    let assemblerResult: AssemblerOutput;
    try {
      assemblerResult = assembleApp({
        archetype_id: config.archetype_id,
        content,
        business_context: {
          slug: business.slug || "",
          name: bc.name,
          operator_url: `${frontendUrl}/business/${business.slug}`,
        },
        app_id: "temp-id",
        api_base: agentUrl,
        frontend_url: frontendUrl,
      });
    } catch (assemblerErr) {
      await logFailure(taskCtx, "v2_assembler_failed", "App assembly failed", {
        assembler_error: String(assemblerErr),
        archetype_id: config.archetype_id,
      });
      throw new Error(`App assembly failed: ${assemblerErr}`);
    }

    await appendWorkLog(taskCtx, V2_EVENTS.ASSEMBLY_COMPLETED, {
      html_bytes: assemblerResult.html.length,
      component_count: assemblerResult.manifest.rendered_components.length,
    });

    // ── Store (multi-app asset_url always; no legacy /app singleton) ─────
    const assetUrl = `/sites/${business.slug}/apps/${appSlug}/`;
    const assetData = {
      html: assemblerResult.html,
      generation_version: 2,
      archetype_id: config.archetype_id,
      app_title: content.app_title,
      app_tagline: content.app_tagline,
      app_type: config.archetype_id,
      hero_icon: content.hero_icon, // Tabler slug (no emoji fallback)
      image_prompt: content.image_prompt, // stored; fal.ai wires in 3b
      content, // full §13 build content — questions + section_plan + cta
      build_context: bc, // context snapshot for runtime result generation
      operator_url: `${frontendUrl}/business/${business.slug}`, // cta sentinel target
      manifest: assemblerResult.manifest,
      llm_tier: llmTier,
      llm_model: model,
    };

    const { data: assetRow, error: assetErr } = await supabase
      .from("business_assets")
      .insert({
        business_id: business.id,
        asset_type: "app",
        app_slug: appSlug,
        app_icon: content.hero_icon,
        asset_url: assetUrl,
        asset_data: assetData,
      })
      .select("id")
      .single();

    if (assetErr || !assetRow) {
      throw new Error(`Failed to store business asset: ${assetErr?.message}`);
    }
    const assetId = (assetRow as { id: string }).id;

    await appendWorkLog(taskCtx, V2_EVENTS.ASSET_STORED, { asset_id: assetId, app_slug: appSlug });
    await appendWorkLog(taskCtx, V2_EVENTS.APP_COMPLETED, { asset_url: assetUrl });

    return {
      output_data: {
        asset_id: assetId,
        app_slug: appSlug,
        app_icon: content.hero_icon,
        asset_url: assetUrl,
        manifest: assemblerResult.manifest,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendWorkLog(taskCtx, V2_EVENTS.APP_FAILED, {
      failure_reason: errorMessage,
      task_run_id: taskRunId,
    });
    log.error("[v2-app-gen] generation_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      error: errorMessage,
    });
    throw err;
  }
}

/** Parse + validate the request config from the task_run row. */
async function parseV2Config(taskCtx: TaskCtx): Promise<V2Config> {
  const { taskRunId, supabase } = taskCtx;

  const taskRunRow = await supabase
    .from("task_runs")
    .select("config")
    .eq("id", taskRunId)
    .maybeSingle();

  const config = (taskRunRow.data?.config as Record<string, unknown> | null) || null;

  if (typeof config?.archetype_id !== "string") {
    throw new Error("archetype_id is required in config");
  }
  if (!["strategy", "assessment", "calculator"].includes(config.archetype_id)) {
    throw new Error(`Invalid archetype_id: ${config.archetype_id}`);
  }
  if (typeof config?.description !== "string" || config.description.trim().length === 0) {
    throw new Error("description is required in config");
  }
  const llmTier = typeof config?.llm_tier === "string" ? config.llm_tier : undefined;
  if (llmTier && !["haiku", "sonnet", "opus"].includes(llmTier)) {
    throw new Error(`Invalid llm_tier: ${llmTier}`);
  }

  return {
    archetype_id: config.archetype_id as V2Config["archetype_id"],
    description: config.description.trim(),
    llm_tier: llmTier as V2Config["llm_tier"],
  };
}

/** Slugify a title for use as an app slug base. */
function slugifyTitle(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/** Pick a unique app_slug for this business by scanning existing rows. */
async function pickUniqueAppSlug(
  supabase: { from: (t: string) => any },
  businessId: string,
  candidateBase: string,
): Promise<string> {
  const base = candidateBase || "app-" + Date.now().toString(36).slice(-6);

  const { data } = await supabase
    .from("business_assets")
    .select("app_slug")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .like("app_slug", base + "%");

  const taken = new Set<string>();
  for (const row of (data ?? []) as Array<{ app_slug: string | null }>) {
    const s = row.app_slug;
    if (typeof s !== "string") continue;
    if (s === base || s.startsWith(base + "-")) taken.add(s);
  }

  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = base + "-" + n;
    if (!taken.has(candidate)) return candidate;
  }
  return base + "-" + Date.now().toString(36).slice(-6);
}

async function generateUniqueAppSlug(
  supabase: any,
  businessId: string,
  title: string,
): Promise<string> {
  return await pickUniqueAppSlug(supabase, businessId, slugifyTitle(title));
}

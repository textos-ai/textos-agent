// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app-v2: plain-JSON Anthropic call + transformation layer →
// assembled app stored in business_assets with generation_version=2.
// Currently strategy-only; archetype generalization deferred.
// See docs/v1-vs-v2-prompt-comparison.md for the 2026-05-28 incident background
// and docs/backlog-v2-architectural-debt.md for the deferred debts.
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskCtx, TaskResult } from "./types";
import { zodToJsonSchema } from "zod-to-json-schema";
import { log } from "../logger";
import {
  buildSystemPrompt,
  buildUserPrompt,
  extractBusinessContext
} from "../prompts/app-content-prompts";
import {
  getArchetype,
  type Archetype
} from "../archetypes";
import {
  assembleApp,
  type AssemblerOutput
} from "../assembler";
import {
  StrategyContentSchema,
  AssessmentContentSchema,
  CalculatorContentSchema
} from "../assembler/validation/schemas";
import { resolveModelForTier } from "../llm-tier-model";
import { appendWorkLog } from "../work-log";
import { logFailure } from "../failure-log";

// V2-specific stream event types as specified in the brief
const V2_EVENTS = {
  STARTED: 'v2_app_started',
  ARCHETYPE_LOADED: 'v2_archetype_loaded',
  LLM_CALL_STARTED: 'v2_llm_call_started',
  LLM_CALL_COMPLETED: 'v2_llm_call_completed',
  CONTENT_VALIDATED: 'v2_content_validated',
  CONTENT_VALIDATION_FAILED: 'v2_content_validation_failed',
  ASSEMBLY_COMPLETED: 'v2_assembly_completed',
  ASSET_STORED: 'v2_asset_stored',
  APP_COMPLETED: 'v2_app_completed',
  APP_FAILED: 'v2_app_failed'
} as const;

interface V2Config {
  archetype_id: 'strategy' | 'assessment' | 'calculator';
  description: string;
  llm_tier?: 'haiku' | 'sonnet' | 'opus';
}

interface LLMToolResponse {
  content: unknown;
}

/**
 * Main handler for generate-business-app-v2 task.
 * Called from the task dispatch in business-task-run.ts.
 */
export async function runGenerateBusinessAppV2(taskCtx: TaskCtx): Promise<TaskResult> {
  const { supabase, anthropic, business, ctx, taskRunId } = taskCtx;

  try {
    // Parse config
    const config = await parseV2Config(taskCtx);
    const archetype = getArchetype(config.archetype_id);
    const llmTier = config.llm_tier || 'sonnet';
    const model = resolveModelForTier(llmTier);
    const zodSchemaMap = {
      strategy: StrategyContentSchema,
      assessment: AssessmentContentSchema,
      calculator: CalculatorContentSchema,
    };
    const zodSchema = zodSchemaMap[config.archetype_id];

    // Generate JSON schema reference for prompt (not as tool definition)
    const jsonSchemaRef = zodToJsonSchema(zodSchema, { target: 'openApi3' });

    const businessContext = extractBusinessContext(ctx);
    businessContext.name = business.name;
    const baseSystemPrompt = buildSystemPrompt(config.archetype_id, archetype.name, businessContext, config.description);
    const userPrompt = buildUserPrompt(config.description);

    // Add JSON output instructions to system prompt
    const systemPrompt = `${baseSystemPrompt}

Return ONLY valid JSON matching this exact structure:
${JSON.stringify(jsonSchemaRef, null, 2)}

Respond with ONLY a valid JSON object matching this structure. No markdown, no code fences, no explanatory text before or after the JSON. First character must be {.`;

    // Strip markdown code fences from the model's text response.
    function stripFences(s: string): string {
      return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    }

    let contentPayload: unknown;
    const callStart = Date.now();

    const workingSystemPrompt = `You are designing a strategy app for ${business.name}. Return ONLY valid JSON. First character must be {.`;

    const simpleAppPrompt = `Design a simple strategy app with this structure:

{
  "app_title": "string",
  "app_description": "string",
  "questions": [
    {
      "id": "q1",
      "text": "string",
      "type": "single_choice",
      "options": ["option1", "option2", "option3"]
    }
  ],
  "free_tier_reveals": "string - what free users see",
  "paid_tier_reveals": "string - what paid users get",
  "cta_label": "string - paywall button text"
}

Create exactly 10 questions about: "${config.description}"`;

    // Environment-conditional full prompt logging for test/dev
    const isDevOrTest = taskCtx.env.ENVIRONMENT === 'test' || taskCtx.env.ENVIRONMENT === 'dev';

    await appendWorkLog(taskCtx, V2_EVENTS.LLM_CALL_STARTED, {
      model,
      llm_tier: llmTier,
      prompt_chars: workingSystemPrompt.length + simpleAppPrompt.length,
      request_type: 'no_tool_instructions',
      ...(isDevOrTest && {
        full_system_prompt: workingSystemPrompt,
        full_user_prompt: simpleAppPrompt,
        original_user_prompt: userPrompt,
        original_system_prompt_preview: systemPrompt.slice(0, 500) + '...[TRUNCATED]...' + systemPrompt.slice(-200)
      })
    });

    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        stream: false,
        system: workingSystemPrompt,
        messages: [{ role: "user", content: simpleAppPrompt }],
      });
      const block = msg.content[0];
      const text = block && block.type === "text" ? (block as { text: string }).text : "";
      const stopReason = (msg as { stop_reason?: string }).stop_reason ?? "unknown";
      const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};

      await appendWorkLog(taskCtx, V2_EVENTS.LLM_CALL_COMPLETED, {
        stop_reason: stopReason,
        input_tokens: usage.input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
        elapsed_ms: Date.now() - callStart,
        response_chars: text.length,
        response_preview: text.slice(0, 200),
        ...(isDevOrTest && {
          full_response_text: text,
          full_anthropic_response: msg
        })
      });

      // Parse JSON response
      const cleanedText = stripFences(text.trim());
      let parsedContent: unknown;

      try {
        parsedContent = JSON.parse(cleanedText);
        await appendWorkLog(taskCtx, 'v2_content_parsed', {
          parsed_successfully: true,
          content_preview: JSON.stringify(parsedContent).slice(0, 200),
          ...(isDevOrTest && {
            full_parsed_content: parsedContent,
            cleaned_text: cleanedText
          })
        });
      } catch (parseErr) {
        await appendWorkLog(taskCtx, 'v2_content_parse_failed', {
          parse_error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          raw_text_preview: cleanedText.slice(0, 200)
        });

        // Retry once with error feedback
        const retrySystemPrompt = `${systemPrompt}

Your previous response was not valid JSON. Error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}
Respond with ONLY valid JSON matching the required shape.`;

        const retryStart = Date.now();

        try {
          const retryMsg = await anthropic.messages.create({
            model,
            max_tokens: 2000,
            stream: false,
            temperature: 0.7,
            system: retrySystemPrompt,
            messages: [{ role: "user" as const, content: userPrompt }]
          });

          const retryBlock = retryMsg.content[0];
          const retryText = retryBlock && retryBlock.type === "text" ? (retryBlock as { text: string }).text : "";
          const retryCleanedText = stripFences(retryText.trim());
          parsedContent = JSON.parse(retryCleanedText);

          await appendWorkLog(taskCtx, 'v2_content_retry_success', {
            retry_elapsed_ms: Date.now() - retryStart,
            content_preview: JSON.stringify(parsedContent).slice(0, 200)
          });
        } catch (retryErr) {
          await logFailure(taskCtx, "v2_llm_parse_retry_failed", {
            original_error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            retry_error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            raw_response: cleanedText.slice(0, 500)
          });
          throw new Error(`Failed to parse JSON after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        }
      }

      contentPayload = parsedContent;

    } catch (err) {
      await logFailure(taskCtx, "v2_llm_call_failed", {
        error: err instanceof Error ? err.message : String(err),
        model,
        llm_tier: llmTier,
        elapsed_ms: Date.now() - callStart
      });
      throw new Error(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Transform simple structure to expected schema format
    let validatedContent: unknown;
    let validationWarnings: any[] = [];

    try {
      // Basic validation - ensure required fields exist
      const content = contentPayload as any;
      if (!content.app_title || !content.questions || !Array.isArray(content.questions)) {
        throw new Error('Missing required fields: app_title, questions array');
      }

      if (content.questions.length === 0) {
        throw new Error('Questions array cannot be empty');
      }

      // Transform simple structure to expected StrategyContentSchema format
      const transformedContent = {
        hero: {
          title: content.app_title,
          subtitle: content.app_description || `${content.app_title} - Interactive Strategy Tool`
        },
        questions: content.questions.map((q: any, index: number) => ({
          id: q.id || `q${index + 1}`,
          step: Math.min(Math.floor(index / 3) + 1, 3), // Distribute across 3 steps
          label: q.text || q.label,
          placeholder: `Enter your response for: ${q.text || q.label}`,
          type: q.type === 'single_choice' ? 'radio_cards' : 'text',
          required: true,
          ...(q.options && q.type === 'single_choice' ? {
            options: q.options.map((opt: string, optIndex: number) => ({
              value: `option_${optIndex + 1}`,
              title: opt,
              desc: `Choose ${opt} for your strategy`
            }))
          } : {})
        })),
        paywall: {
          title: content.free_tier_reveals || "Get Your Complete Strategy Report",
          body: content.paid_tier_reveals || "Upgrade to access your personalized strategy plan with detailed action items and next steps.",
          cta_label: content.cta_label || "Get Full Report",
          email_label: "Email Address",
          footer: "Secure payment • Cancel anytime"
        },
        result: {
          plan_title: `${content.app_title} - Your Strategy Plan`,
          intro: `Based on your responses, here's your personalized ${content.app_title.toLowerCase()} strategy plan:`,
          sections: [
            {
              heading: "Key Recommendations",
              body: "Your strategy recommendations will appear here based on your responses.",
              action_items: [
                "Review your current approach",
                "Implement suggested changes",
                "Monitor progress regularly"
              ]
            },
            {
              heading: "Next Steps",
              body: "Follow these action items to execute your strategy effectively.",
              action_items: [
                "Set measurable goals",
                "Create implementation timeline",
                "Track key metrics"
              ]
            }
          ],
          cta: {
            headline: "Ready to Implement Your Strategy?",
            body: "Get expert guidance to execute your plan effectively.",
            cta_label: "Get Expert Help",
            cta_url_placeholder: "/business/{{business_slug}}/contact"
          }
        }
      };

      validatedContent = transformedContent;
      validationWarnings = [];
    } catch (validationErr) {
      const validationErrorMessage = validationErr instanceof Error ? validationErr.message : String(validationErr);

      await appendWorkLog(taskCtx, V2_EVENTS.CONTENT_VALIDATION_FAILED, {
        content_payload: contentPayload,
        validation_error: validationErrorMessage,
        task_run_id: taskRunId
      });

      await logFailure(taskCtx, 'v2_validation_failed', {
        content_payload: contentPayload,
        validation_error: validationErrorMessage
      });

      throw new Error(`Content validation failed: ${validationErrorMessage}`);
    }

    await appendWorkLog(taskCtx, V2_EVENTS.CONTENT_VALIDATED, {
      archetype_id: config.archetype_id,
      content_payload: validatedContent,
      validation_warnings: validationWarnings,
      task_run_id: taskRunId,
    });

    // 9. Generate app slug and icon
    const appTitle = extractAppTitle(validatedContent, config.archetype_id);
    const appSlug = await generateUniqueAppSlug(supabase, business.id, appTitle);
    const appIcon = extractAppIcon(validatedContent, config.archetype_id);

    // 10. Assemble the app
    let assemblerResult: AssemblerOutput;
    try {
      const frontendUrl = taskCtx.env.FRONTEND_URL || 'https://app.textos.ai';
      const agentUrl = taskCtx.env.AGENT_URL || (
        taskCtx.env.ENVIRONMENT === "test"
          ? "https://textos-agent-test.rgaudet2023.workers.dev"
          : "https://textos-agent-dev.rgaudet2023.workers.dev"
      );

      assemblerResult = assembleApp({
        archetype_id: config.archetype_id,
        content: validatedContent,
        business_context: {
          slug: business.slug || '',
          name: businessContext.name,
          operator_url: `${frontendUrl}/business/${business.slug}`,
        },
        app_id: 'temp-id', // Will be replaced after asset creation
        api_base: agentUrl,
        frontend_url: frontendUrl,
      });
    } catch (assemblerErr) {
      await logFailure(taskCtx, 'v2_assembler_failed',
        `App assembly failed: ${assemblerErr}`,
        {
          content_payload: validatedContent,
          assembler_error: String(assemblerErr),
          archetype_id: config.archetype_id
        }
      );
      throw new Error(`App assembly failed: ${assemblerErr}`);
    }

    await appendWorkLog(taskCtx, V2_EVENTS.ASSEMBLY_COMPLETED, {
      html_bytes: assemblerResult.html.length,
      manifest_summary: {
        component_count: assemblerResult.manifest.rendered_components.length,
        validation_warnings: assemblerResult.validation_warnings.length
      },
      task_run_id: taskRunId,
    });

    // 11. Store in business_assets
    const assetData = {
      html: assemblerResult.html,
      generation_version: 2,
      archetype_id: config.archetype_id,
      content: validatedContent,
      manifest: assemblerResult.manifest,
      llm_tier: llmTier,
      llm_model: model,
    };

    const { data: assetRow, error: assetErr } = await supabase
      .from('business_assets')
      .insert({
        business_id: business.id,
        asset_type: 'app',
        app_slug: appSlug,
        app_icon: appIcon,
        asset_url: `/sites/${business.slug}/apps/${appSlug}/`,
        asset_data: assetData,
      })
      .select('id')
      .single();

    if (assetErr || !assetRow) {
      throw new Error(`Failed to store business asset: ${assetErr?.message}`);
    }

    const assetId = (assetRow as { id: string }).id;

    await appendWorkLog(taskCtx, V2_EVENTS.ASSET_STORED, {
      asset_id: assetId,
      app_slug: appSlug,
      task_run_id: taskRunId,
    });

    const assetUrl = `/sites/${business.slug}/apps/${appSlug}/`;

    await appendWorkLog(taskCtx, V2_EVENTS.APP_COMPLETED, {
      asset_url: assetUrl,
      task_run_id: taskRunId,
    });

    // 12. Return success
    return {
      output_data: {
        asset_id: assetId,
        app_slug: appSlug,
        app_icon: appIcon,
        asset_url: assetUrl,
        manifest: assemblerResult.manifest,
      }
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

/**
 * Parse and validate the request config from the task_run row.
 */
async function parseV2Config(taskCtx: TaskCtx): Promise<V2Config> {
  const { taskRunId, supabase } = taskCtx;

  const taskRunRow = await supabase
    .from("task_runs")
    .select("config")
    .eq("id", taskRunId)
    .maybeSingle();

  const config = (taskRunRow.data?.config as Record<string, unknown> | null) || null;

  // Extract and validate required fields
  if (typeof config?.archetype_id !== 'string') {
    throw new Error('archetype_id is required in config');
  }

  if (!['strategy', 'assessment', 'calculator'].includes(config.archetype_id)) {
    throw new Error(`Invalid archetype_id: ${config.archetype_id}`);
  }

  if (typeof config?.description !== 'string' || config.description.trim().length === 0) {
    throw new Error('description is required in config');
  }

  const llmTier = typeof config?.llm_tier === 'string' ? config.llm_tier : undefined;
  if (llmTier && !['haiku', 'sonnet', 'opus'].includes(llmTier)) {
    throw new Error(`Invalid llm_tier: ${llmTier}`);
  }

  return {
    archetype_id: config.archetype_id as 'strategy' | 'assessment' | 'calculator',
    description: config.description.trim(),
    llm_tier: llmTier as 'haiku' | 'sonnet' | 'opus' | undefined,
  };
}

/**
 * Extract app title from validated content based on archetype.
 */
function extractAppTitle(content: unknown, archetypeId: string): string {
  // Content now has the expected hero.title structure after transformation
  if (content && typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    if (obj.hero && typeof obj.hero === 'object' && obj.hero !== null) {
      const hero = obj.hero as Record<string, unknown>;
      if (typeof hero.title === 'string' && hero.title.trim().length > 0) {
        return hero.title.trim();
      }
    }
  }

  // Fallback based on archetype
  const fallbacks = {
    strategy: 'Strategy Plan',
    assessment: 'Assessment Tool',
    calculator: 'Business Calculator'
  };

  return fallbacks[archetypeId as keyof typeof fallbacks] || 'Mini-App';
}

/**
 * Slugify a title string for use as app slug base.
 * Reused from generate-business-app-html.ts.
 */
function slugifyTitle(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics (Unicode block U+0300..U+036F) so titles
    // like "Café Picker" slugify to "cafe-picker" rather than "caf-picker".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/**
 * Pick a unique app_slug for this business by scanning existing rows
 * whose slug starts with the candidate, then appending -2, -3, ...
 * until a free value is found.
 *
 * Reused from generate-business-app-html.ts.
 */
async function pickUniqueAppSlug(
  supabase: { from: (t: string) => any },
  businessId: string,
  candidateBase: string,
): Promise<string> {
  const base = candidateBase || ("app-" + Date.now().toString(36).slice(-6));

  // LIKE narrows; client-side filter is exact.
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

  // Pathological — should never happen at our scale.
  return base + "-" + Date.now().toString(36).slice(-6);
}

/**
 * Generate a unique app slug for this business.
 */
async function generateUniqueAppSlug(supabase: any, businessId: string, title: string): Promise<string> {
  const candidateBase = slugifyTitle(title);
  return await pickUniqueAppSlug(supabase, businessId, candidateBase);
}

/**
 * Extract or determine app icon from content or archetype defaults.
 */
function extractAppIcon(content: unknown, archetypeId: string): string {
  // Check if content has an icon field, otherwise use archetype defaults
  const archetypeIcons = {
    strategy: '🎯',
    assessment: '📊',
    calculator: '🧮'
  };

  return archetypeIcons[archetypeId as keyof typeof archetypeIcons] || '🧩';
}


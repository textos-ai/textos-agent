// Generic document runner — used by the /run endpoint for paid tasks.
// Reads tasks.prompt_template, substitutes {{business.x}} / {{ctx.x}} /
// {{user.x}}, calls Claude, validates output shape, saves to
// business_assets. Throws on failure — caller handles task_runs state.
//
// Standard output shape (D4):
//   { title: string, sections: [{ heading: string, body: string }] }
// body is markdown. Frontend doc-modal renders via _renderGenericDoc.

import type { TaskCtx, TaskResult } from "./types";
import type { TaskRow } from "../../services/supabase";

import type { ModelConfig } from "../model-config";

// Maps external_apis.slug to a tier key so task_apis bindings control which
// tier is used (haiku for speed, sonnet for quality, opus for heavy tasks)
// while the actual model ID comes from tc.models (admin-configurable).
const SLUG_TO_TIER: Record<string, keyof ModelConfig> = {
  "anthropic-claude-haiku":  "haiku",
  "anthropic-claude-sonnet": "sonnet",
  "anthropic-claude-opus":   "opus",
};

/**
 * Resolves the model ID for a task by reading its primary task_apis binding,
 * mapping the bound slug to a tier, then reading the live model ID from
 * tc.models (loaded from external_apis.metadata.model at run start).
 *
 * Throws if the bound slug is not a recognized anthropic tier slug —
 * per NO-FALLBACKS, missing config is a loud error, not a silent sonnet default.
 * If no primary binding exists the task falls through to sonnet (safe default
 * since migration 032 binds every task to anthropic-claude-sonnet).
 */
async function resolveModelForTask(
  supabase: TaskCtx["supabase"],
  models: ModelConfig,
  taskId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("task_apis")
    .select("external_apis(slug)")
    .eq("task_id", taskId)
    .eq("role", "primary")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`model_resolve_failed: task_apis lookup error: ${error.message}`);
  if (!data) return models.sonnet;

  const slug = (data as { external_apis?: { slug?: string } }).external_apis?.slug;
  if (!slug) return models.sonnet;

  const tier = SLUG_TO_TIER[slug];
  if (!tier) {
    throw new Error(`model_resolve_failed: unrecognized api slug '${slug}' — add it to SLUG_TO_TIER`);
  }
  return models[tier];
}

const SYSTEM = `You are a TextOS task agent generating a structured document for a business owner.

Output requirements (strict):
- Return ONLY a valid JSON object. No markdown fences, no commentary, no preamble.
- Shape: { "title": string, "sections": [{ "heading": string, "body": string }] }
- Each section.body uses GitHub-flavored markdown (headings, lists, bold, links).
- Title is concise (5-10 words), Title Case.
- 3 to 8 sections is typical. Each section heading is 2-6 words, Title Case.
- Write for an operator/founder audience. Concrete, specific, and grounded in the business
  context provided. Avoid fluff, clichés, and generic management-speak.`;

const SHAPE_HINT =
  '{ "title": "string", "sections": [{ "heading": "string", "body": "string (markdown)" }] }';

function stripFences(s: string): string {
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Defensive JSON repair for common LLM malformations.
 *   • Replace smart quotes (Unicode " " ' ') with ASCII equivalents
 *   • Trim anything after the final closing brace (stray commentary)
 *   • Strip trailing commas before } or ]
 */
function repairJSON(raw: string): string {
  let s = raw
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const lastBrace = s.lastIndexOf("}");
  if (lastBrace >= 0 && lastBrace < s.length - 1) {
    s = s.slice(0, lastBrace + 1);
  }

  s = s.replace(/,(\s*[\]}])/g, "$1");

  return s;
}

/**
 * Aggressive repair tier — used only after repairJSON() fails.
 *
 * Targets the dominant LLM JSON failure mode: literal newlines / tabs
 * inside string values. Claude often writes a multi-line markdown body
 * like:
 *   "body": "Paragraph one.
 *   Paragraph two."
 * which is invalid JSON because raw newlines are illegal inside string
 * literals. Collapsing every control character to a space recovers the
 * data losslessly for our use case (section.body is markdown — the
 * single-line collapsed version still renders correctly via marked).
 *
 * Side effect on the rest of the JSON: insignificant whitespace between
 * keys/values becomes spaces too. JSON.parse doesn't care.
 *
 * Preserves `\n` ESCAPE sequences (two chars: \ + n) that Claude wrote
 * correctly — those are already valid inside JSON strings.
 */
function repairJSONAggressive(raw: string): string {
  return repairJSON(raw).replace(/[\n\r\t]/g, " ");
}

/**
 * Renders a prompt template with {{path.dotted}} substitution.
 *
 * - Dot-path traversal (e.g. {{ctx.target_customer.description}})
 * - null/undefined → empty string (silently)
 * - Objects → JSON.stringify
 * - Other values → String(v)
 *
 * No sandboxing. Templates are admin-edited in the tasks table; not
 * end-user input.
 */
export function renderPrompt(
  template: string,
  vars: { business: unknown; ctx: unknown; user: unknown },
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
    const keys = path.split(".");
    let v: unknown = vars as Record<string, unknown>;
    for (const k of keys) {
      if (v == null || typeof v !== "object") return "";
      v = (v as Record<string, unknown>)[k];
    }
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

interface GenericDoc {
  title: string;
  sections: Array<{ heading: string; body: string }>;
}

/**
 * Validates the parsed JSON has the standard document shape.
 * Returns the validated doc or null if shape is bad.
 */
function validateDoc(parsed: unknown): GenericDoc | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.title !== "string" || obj.title.trim() === "") return null;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) return null;
  for (const s of obj.sections) {
    if (!s || typeof s !== "object") return null;
    const sec = s as Record<string, unknown>;
    if (typeof sec.heading !== "string" || sec.heading.trim() === "") return null;
    if (typeof sec.body !== "string" || sec.body.trim() === "") return null;
  }
  return {
    title: obj.title.trim(),
    sections: (obj.sections as Array<{ heading: string; body: string }>).map((s) => ({
      heading: s.heading.trim(),
      body: s.body,
    })),
  };
}

/**
 * Runs one paid task end-to-end:
 *  1. Validate task has a prompt_template
 *  2. Render variables into the template
 *  3. Call Claude (one attempt; one retry on parse/shape failure)
 *  4. Insert into business_assets (failure → throw; user paid for this)
 *  5. Return TaskResult — caller persists to task_runs + debits tokens
 *
 * Throws on:
 *  - Missing/empty prompt_template (should be pre-filtered at endpoint)
 *  - Anthropic API error
 *  - Two consecutive shape/parse failures
 *  - business_assets insert error
 */
export async function genericDocumentRunner(
  taskCtx: TaskCtx,
  task: TaskRow,
): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, supabase, taskRunId } = taskCtx;

  if (!task.prompt_template || task.prompt_template.trim() === "") {
    throw new Error(`task_missing_prompt_template: ${task.slug}`);
  }

  const rendered = renderPrompt(task.prompt_template, {
    business,
    ctx,
    user,
  });

  // Pick the model from this task's primary task_apis binding. Admin can
  // change it from Task Manager per-task — Haiku for heavier tasks that
  // need to fit under the waitUntil window, Sonnet for tasks where output
  // quality matters more than speed.
  const model = await resolveModelForTask(supabase, models, task.id);

  let parsed: GenericDoc | null = null;
  let lastErr = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote =
      attempt === 1
        ? ""
        : `\n\n⚠️ Your previous response failed validation: ${lastErr}. ` +
          `Return ONLY a valid JSON object matching this shape, no markdown, no commentary: ${SHAPE_HINT}`;

    // max_tokens picked to fit comfortably under the worker waitUntil
    // window. Sonnet at ~70 tok/s → ~17s for 1200 tokens; Haiku at ~200
    // tok/s → ~6s. Realistic output for our prompts (3-4 sections × 60-120
    // words) is ~700-900 tokens, leaving ~300+ token buffer for occasional
    // verbosity before truncation triggers JSON parse failure.
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: rendered + retryNote }],
    });

    const block = msg.content[0];
    const text =
      block && block.type === "text" ? (block as { text: string }).text : "";
    const raw = stripFences(text.trim());

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch (firstErr) {
      // Tier 1: cheap repair (smart quotes, trailing commentary, trailing commas)
      let parsed = false;
      try {
        candidate = JSON.parse(repairJSON(raw));
        parsed = true;
      } catch { /* fall through to tier 2 */ }

      if (!parsed) {
        // Tier 2: aggressive repair — collapse raw newlines/tabs to spaces.
        // Recovers cases where Claude wrote a multi-line markdown body
        // without escaping the newlines (the most common position-N parse
        // failure we've seen).
        try {
          candidate = JSON.parse(repairJSONAggressive(raw));
          parsed = true;
        } catch (repairErr) {
          // Surface a snippet of the raw output AROUND the parse position
          // so the user-visible error has enough context to diagnose
          // without needing wrangler tail. Also log the full head/tail.
          const posMatch = (firstErr as Error).message.match(/position\s+(\d+)/i);
          const pos = posMatch ? parseInt(posMatch[1], 10) : -1;
          let nearSnippet = "";
          if (pos >= 0) {
            const start = Math.max(0, pos - 40);
            const end = Math.min(raw.length, pos + 40);
            nearSnippet = raw.slice(start, end).replace(/\s+/g, " ");
          }

          console.error("[generic-runner] parse_failure", {
            task_slug: task.slug,
            attempt,
            err: (firstErr as Error).message,
            repair_err: (repairErr as Error).message,
            raw_head: raw.slice(0, 200),
            raw_tail: raw.length > 400 ? "…" + raw.slice(-200) : raw,
            raw_len: raw.length,
            near: nearSnippet,
          });

          lastErr = nearSnippet
            ? `JSON parse error: ${(firstErr as Error).message} — near: "${nearSnippet}"`
            : `JSON parse error: ${(firstErr as Error).message}`;
          continue;
        }
      }
    }

    const valid = validateDoc(candidate);
    if (valid) {
      parsed = valid;
      break;
    }
    lastErr = "shape mismatch (need { title, sections: [{ heading, body }] })";
  }

  if (!parsed) {
    throw new Error(`generic_runner_invalid_output: ${task.slug} — ${lastErr}`);
  }

  // Persist to business_assets — paid tasks fail loudly on insert error.
  const { error: assetErr } = await supabase.from("business_assets").insert({
    business_id: business.id,
    task_run_id: taskRunId,
    asset_type: "document",
    asset_subtype: task.slug,
    asset_data: parsed,
    asset_url: null,
    asset_text: null,
    metadata: {
      model,
      token_cost: task.token_cost,
      lifecycle_phase_id: task.lifecycle_phase_id,
    },
  });

  if (assetErr) {
    throw new Error(`business_assets_insert_failed: ${assetErr.message}`);
  }

  return {
    output_data: parsed as unknown as Record<string, unknown>,
  };
}

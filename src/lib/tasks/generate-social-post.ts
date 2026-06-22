// Custom handler for generate-social-post.
// Dual-mode: context-only (no sourceAsset) or document+context (sourceAsset present).
// Writes to content_assets (not business_assets) and returns structured output.

import type { TaskCtx, TaskResult } from "./types";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

interface SocialPostOutput {
  post: string;
  platform_hint: string;
  hook: string;
  cta: string;
  character_count: number;
}

function stripFences(s: string): string {
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function validateOutput(parsed: unknown): SocialPostOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.post !== "string" || obj.post.trim() === "") return null;
  if (typeof obj.platform_hint !== "string" || obj.platform_hint.trim() === "") return null;
  if (typeof obj.hook !== "string" || obj.hook.trim() === "") return null;
  if (typeof obj.cta !== "string" || obj.cta.trim() === "") return null;
  const cc = typeof obj.character_count === "number"
    ? obj.character_count
    : obj.post.length;
  return {
    post: obj.post.trim(),
    platform_hint: obj.platform_hint.trim(),
    hook: obj.hook.trim(),
    cta: obj.cta.trim(),
    character_count: cc,
  };
}

export async function runGenerateSocialPost(taskCtx: TaskCtx): Promise<TaskResult> {
  const {
    business, ctx, user,
    anthropic, models, supabase,
    taskRunId, abortSignal, sourceAsset,
  } = taskCtx;

  const promptDef = await resolvePrompt(supabase, "generate-social-post");
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error("task_missing_system_prompt: generate-social-post");
  }

  // Build source object for template substitution.
  // {{source.block}} expands to a labeled document block when a source asset
  // is present, or empty string in context-only mode.
  const sourceBlock = sourceAsset
    ? `## Source: ${sourceAsset.subtype ?? sourceAsset.assetType}\n\n${sourceAsset.text}\n\nUse the above document as primary context for this post.\n\n`
    : "";

  const source = {
    block: sourceBlock,
    text: sourceAsset?.text ?? "",
    id: sourceAsset?.id ?? "",
    subtype: sourceAsset?.subtype ?? "",
  };

  const rendered = renderPrompt(promptDef.user_prompt_template, {
    business, ctx, user, source,
  });

  const model = models.sonnet;

  let result: SocialPostOutput | null = null;
  let lastErr = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote = attempt === 1
      ? ""
      : `\n\n⚠ Previous response failed validation: ${lastErr}. Return ONLY valid JSON matching {"post":"...","platform_hint":"...","hook":"...","cta":"...","character_count":0}.`;

    const msg = await anthropic.messages.create(
      {
        model,
        max_tokens: 1024,
        system: promptDef.system_prompt,
        messages: [{ role: "user", content: rendered + retryNote }],
      },
      abortSignal ? { signal: abortSignal } : undefined,
    );

    if (msg.stop_reason === "max_tokens") {
      throw new Error("task_output_truncated:generate-social-post stop_reason=max_tokens");
    }

    const block = msg.content[0];
    const text = block && block.type === "text" ? (block as { text: string }).text : "";
    const raw = stripFences(text.trim());

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Collapse raw newlines (most common LLM JSON failure mode) and retry parse.
      try {
        parsed = JSON.parse(raw.replace(/[\n\r\t]/g, " "));
      } catch (e) {
        lastErr = `JSON parse error: ${(e as Error).message}`;
        continue;
      }
    }

    const valid = validateOutput(parsed);
    if (valid) {
      result = valid;
      break;
    }
    lastErr = "shape mismatch (need { post, platform_hint, hook, cta, character_count })";
  }

  if (!result) {
    throw new Error(`generate_social_post_invalid_output: ${lastErr}`);
  }

  // Write to content_assets — source_asset_id links back to the input doc when present.
  const { data: caRow, error: caErr } = await supabase
    .from("content_assets")
    .insert({
      business_id: business.id,
      source_asset_id: sourceAsset?.id ?? null,
      task_run_id: taskRunId,
      content_type: "social_post",
      target_platform: result.platform_hint,
      generated_body: result.post,
      status: "draft",
    })
    .select("id")
    .single();

  if (caErr || !caRow) {
    throw new Error(`content_assets_insert_failed: ${caErr?.message ?? "no row returned"}`);
  }

  return {
    output_data: {
      content_asset_id: (caRow as { id: string }).id,
      post: result.post,
      platform_hint: result.platform_hint,
      hook: result.hook,
      cta: result.cta,
      character_count: result.character_count,
      mode: sourceAsset ? "document" : "context_only",
    },
    model,
  };
}

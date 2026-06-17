import type { TaskCtx, TaskResult } from "./types";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

const TASK_SLUG = "launch-tweet";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runLaunchTweet(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Drafting launch tweet with brand voice", ts: Date.now() });

  const promptDef = await resolvePrompt(supabase, TASK_SLUG);
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error(`task_missing_system_prompt: ${TASK_SLUG}`);
  }
  // Pre-resolve first differentiator only — matches original behavior (no raw JSON array in tweet prompt)
  const firstDiff = (Array.isArray(ctx.key_differentiators) ? (ctx.key_differentiators as string[])[0] : null) ?? "";
  const prompt = renderPrompt(promptDef.user_prompt_template, {
    business,
    ctx: { ...(ctx as Record<string, unknown>), key_differentiators: firstDiff },
    user,
  });

  const llmController = new AbortController();
  const llmTimeoutId = setTimeout(() => llmController.abort(), 45_000);
  let msg;
  try {
    msg = await anthropic.messages.create(
      {
        model: models.haiku,
        max_tokens: 400,
        system: promptDef.system_prompt,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: llmController.signal },
    );
  } catch (err) {
    if (llmController.signal.aborted) throw new Error(`task_timeout_45s:${TASK_SLUG}`);
    throw err;
  } finally {
    clearTimeout(llmTimeoutId);
  }

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { tweet: string; character_count: number; hook: string; hashtags: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `task_json_parse_failed:${TASK_SLUG} stop_reason=${msg?.stop_reason ?? "unknown"} raw_start=${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "tweet",
      asset_subtype: "launch_tweet",
      asset_text: parsed.tweet,
      metadata: {
        model: models.haiku,
        character_count: parsed.character_count,
        hook: parsed.hook,
        hashtags: parsed.hashtags,
        status: "draft",
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      tweet: parsed.tweet,
      character_count: parsed.character_count ?? parsed.tweet?.length ?? 0,
      hook: parsed.hook,
      hashtags: parsed.hashtags ?? [],
      status: "draft",
    },
  };
}

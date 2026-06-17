import type { TaskCtx, TaskResult } from "./types";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

const TASK_SLUG = "mission-document";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runMissionDocument(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Writing the mission — this is the part that defines everything downstream.",
    ts: Date.now(),
  });

  const promptDef = await resolvePrompt(supabase, TASK_SLUG);
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error(`task_missing_system_prompt: ${TASK_SLUG}`);
  }
  const prompt = renderPrompt(promptDef.user_prompt_template, { business, ctx, user });

  const llmController = new AbortController();
  const llmTimeoutId = setTimeout(() => llmController.abort(), 45_000);
  let msg;
  try {
    msg = await anthropic.messages.create(
      {
        model: models.sonnet,
        max_tokens: 1024,
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

  let parsed: {
    mission: string;
    vision: string;
    values: Array<{ name: string; description: string }>;
    tagline: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `task_json_parse_failed:${TASK_SLUG} stop_reason=${msg?.stop_reason ?? "unknown"} raw_start=${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  await emit({ type: "cmd", text: "Saving mission document to business context", ts: Date.now() });

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "mission_document",
      asset_data: parsed,
      metadata: { model: models.sonnet },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      mission: parsed.mission,
      vision: parsed.vision,
      values: parsed.values,
      tagline: parsed.tagline,
    },
    context_updates: {
      business_summary: parsed.mission,
    },
  };
}

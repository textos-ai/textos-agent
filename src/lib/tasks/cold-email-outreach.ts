import type { TaskCtx, TaskResult } from "./types";
import { queueColdEmail } from "../email-queue";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

const TASK_SLUG = "cold-email-outreach";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runColdEmailOutreach(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, supabase, env, emit, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Creating a cold email outreach strategy with ready-to-send templates.",
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
        max_tokens: 1200,
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
  let parsed: { title: string; sections: Array<{ heading: string; body: string }> };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `task_json_parse_failed:${TASK_SLUG} stop_reason=${msg?.stop_reason ?? "unknown"} raw_start=${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  // Queue the first email template for review if we have a good parsed result
  let queuedId: string | null = null;
  if (parsed.sections.length > 0) {
    await emit({ type: "cmd", text: `Queueing outreach template for review`, ts: Date.now() });

    try {
      const threshold = parseInt(env.AUTO_APPROVE_AFTER_USER_COUNT ?? "100", 10);
      const firstEmail = parsed.sections[0].body;
      const subjectMatch = firstEmail.match(/\*\*Subject:\*\*\s*([^\n]+)/);
      const bodyMatch = firstEmail.match(/\*\*Body:\*\*\s*([\s\S]+)/);

      if (subjectMatch && bodyMatch) {
        const result = await queueColdEmail(supabase, threshold, {
          business_id: business.id,
          user_id: user.id,
          to_email: user.email,
          subject: subjectMatch[1].trim(),
          body: bodyMatch[1].trim(),
        });
        queuedId = result.id;
      }
    } catch {
      // Non-fatal
    }
  }

  // Save to business_assets
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "cold_email_templates",
      asset_data: parsed,
      metadata: {
        model: models.sonnet,
        template_count: parsed.sections.length,
        queued_id: queuedId
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      ...parsed,
      queued_id: queuedId,
      template_count: parsed.sections.length
    } as unknown as Record<string, unknown>,
  };
}
import type { TaskCtx, TaskResult } from "./types";
import { queueColdEmail } from "../email-queue";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

const TASK_SLUG = "personalized-pitch-email";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runPersonalizedPitchEmail(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, supabase, env, emit, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Writing a pitch email that actually knows who you are.",
    ts: Date.now(),
  });

  const promptDef = await resolvePrompt(supabase, TASK_SLUG);
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error(`task_missing_system_prompt: ${TASK_SLUG}`);
  }
  // Pre-resolve first differentiator only — matches original behavior (no raw JSON array in email prompt)
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
        model: models.sonnet,
        max_tokens: 800,
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
  let parsed: { subject: string; body: string; body_summary: string; target_role: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `task_json_parse_failed:${TASK_SLUG} stop_reason=${msg?.stop_reason ?? "unknown"} raw_start=${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  let queuedId: string | null = null;
  await emit({ type: "cmd", text: `Queueing pitch email for review`, ts: Date.now() });

  try {
    const threshold = parseInt(env.AUTO_APPROVE_AFTER_USER_COUNT ?? "100", 10);
    const result = await queueColdEmail(supabase, threshold, {
      business_id: business.id,
      user_id: user.id,
      to_email: user.email,
      subject: parsed.subject,
      body: parsed.body,
    });
    queuedId = result.id;
  } catch {
    // Non-fatal
  }

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "email",
      asset_subtype: "pitch_email",
      asset_text: parsed.body,
      metadata: {
        model: models.sonnet,
        subject: parsed.subject,
        target_role: parsed.target_role,
        queued_id: queuedId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      subject: parsed.subject,
      body: parsed.body,
      body_summary: parsed.body_summary,
      target_role: parsed.target_role,
      queued_id: queuedId,
    },
  };
}

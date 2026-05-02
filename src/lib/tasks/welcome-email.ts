import type { TaskCtx, TaskResult } from "./types";
import { extractErrorMessage } from "../extract-error";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runWelcomeEmail(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, env, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Drafting welcome email from agent context", ts: Date.now() });

  const prompt = `Write a short, warm welcome email to a new TextOS user who just set up their first business.

Business: ${business.name}
Industry: ${ctx.industry ?? "business"}
Agent name (their assigned TextOS agent): ${ctx.agent_name ?? "your TextOS agent"}
User email: ${user.email}
Value proposition: ${ctx.value_proposition ?? ""}
Business summary: ${ctx.business_summary ?? ""}

Guidelines:
- Subject line: punchy, personal, max 60 chars — specific to the industry
- Body: 3 short paragraphs — welcome them, tell them what just happened (research complete, tasks staged), what's next
- Sign off as: ${ctx.agent_name ?? "Your TextOS Agent"}
- Tone: ${ctx.brand_voice ?? "confident, warm, direct"}
- NO generic filler phrases like "I hope this email finds you well"
- Reference the specific industry and what was researched

Return ONLY valid JSON (no markdown, no backticks):
{
  "subject": "string",
  "body": "string — full email body, newlines as \\n",
  "preview": "string — first 100 chars of body for dashboard display"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { subject: string; body: string; preview: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      subject: `${business.name} is live — here's what we found`,
      body: `Hi there,\n\n${ctx.agent_name ?? "Your TextOS agent"} just finished researching ${business.name} in the ${ctx.industry ?? "market"}. Your task queue is ready.\n\nCheck your dashboard to see what's next.\n\n— ${ctx.agent_name ?? "Your TextOS Agent"}`,
      preview: `${business.name} research complete. Your task queue is ready.`,
    };
  }

  let sent = false;
  let sendError: string | undefined;

  if (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY !== "PLACEHOLDER") {
    await emit({ type: "cmd", text: "Sending via SendGrid", ts: Date.now() });
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: user.email }] }],
          from: { email: "hello@textos.ai", name: "TextOS" },
          subject: parsed.subject,
          content: [{ type: "text/plain", value: parsed.body }],
        }),
      });
      sent = res.ok;
      if (!res.ok) sendError = `SendGrid ${res.status}`;
    } catch (err) {
      sendError = extractErrorMessage(err);
    }
  } else {
    await emit({ type: "cmd", text: "SendGrid not configured — email staged for later", ts: Date.now() });
  }

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "email",
      asset_subtype: "welcome_email",
      asset_text: parsed.body,
      metadata: {
        model: "claude-haiku-4-5-20251001",
        subject: parsed.subject,
        to: user.email,
        sent,
        send_error: sendError ?? null,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      subject: parsed.subject,
      body: parsed.body,
      preview: parsed.preview,
      sent,
      send_error: sendError ?? null,
    },
  };
}

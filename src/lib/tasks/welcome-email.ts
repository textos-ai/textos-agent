import type { TaskCtx, TaskResult } from "./types";

export async function runWelcomeEmail(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, env, emit } = tc;

  await emit({ type: "cmd", text: "Drafting welcome email from agent context", ts: Date.now() });

  const prompt = `Write a short, warm welcome email to a new TextOS user who just set up their first business.

Business: ${business.name}
Industry: ${ctx.industry ?? "business"}
Agent name (their assigned TextOS agent): ${ctx.agent_name ?? "your TextOS agent"}
User email: ${user.email}
Value proposition: ${ctx.value_proposition ?? ""}

Guidelines:
- Subject line: punchy, personal, max 60 chars
- Body: 3 short paragraphs — welcome them, tell them what just happened (research complete, tasks staged), what's next
- Sign off as: ${ctx.agent_name ?? "Your TextOS Agent"}
- Tone: ${ctx.brand_voice ?? "confident, warm, direct"}
- NO generic filler phrases like "I hope this email finds you well"

Return ONLY valid JSON:
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

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: { subject: string; body: string; preview: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      subject: `Welcome to TextOS — ${business.name} is live`,
      body: `Hi there,\n\nYour business ${business.name} has been set up and ${ctx.agent_name ?? "your TextOS agent"} has completed your initial research.\n\nCheck your dashboard to see what's ready.\n\n— ${ctx.agent_name ?? "Your TextOS Agent"}`,
      preview: `Your business ${business.name} is live and research is complete.`,
    };
  }

  let sent = false;
  let sendError: string | undefined;

  if (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY !== "PLACEHOLDER") {
    await emit({ type: "cmd", text: "Queuing email via SendGrid", ts: Date.now() });
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
      sendError = String(err);
    }
  } else {
    await emit({ type: "cmd", text: "SendGrid not configured — email staged for later", ts: Date.now() });
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

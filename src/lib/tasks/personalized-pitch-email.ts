import type { TaskCtx, TaskResult } from "./types";
import { queueColdEmail } from "../email-queue";

export async function runPersonalizedPitchEmail(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, supabase, env, emit } = tc;

  await emit({ type: "narrative", text: "Writing a pitch email that actually knows who you are.", ts: Date.now() });

  const prompt = `Write a personalized outreach email FROM this founder TO a potential customer or partner.

Sender: ${user.email}
Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? "direct and genuine"}
Key differentiator: ${(ctx.key_differentiators as string[])?.[0] ?? ""}

Guidelines:
- Subject: specific, curiosity-inducing, under 50 chars
- Body: 3 short paragraphs (problem → solution → CTA)
- NO generic opener ("I hope this finds you well", "My name is...")
- Start with the PROBLEM or INSIGHT — grab attention immediately
- Personalized: reference the recipient's likely role and pain point
- CTA: one specific, low-friction ask (15-min call, reply with a question, etc.)
- Sign off as the founder
- Total body: under 200 words

Return ONLY valid JSON:
{
  "subject": "string",
  "body": "string — full email, newlines as \\n",
  "body_summary": "string — 80-char summary for dashboard",
  "target_role": "string — the recipient persona this is written for"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: { subject: string; body: string; body_summary: string; target_role: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      subject: `Quick question about ${(ctx.target_customer as Record<string, string>)?.description ?? "your business"}`,
      body: `I built ${business.name} to solve the exact problem you're facing.\n\nWould you have 15 minutes to tell me if I'm on the right track?\n\n— ${user.email.split("@")[0]}`,
      body_summary: `Personalized outreach for ${business.name}`,
      target_role: (ctx.target_customer as Record<string, string>)?.description ?? "potential customer",
    };
  }

  let queuedId: string | null = null;

  await emit({ type: "cmd", text: `Sending pitch email to ${user.email}`, ts: Date.now() });

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
    // Non-fatal — email stored in output_data regardless
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

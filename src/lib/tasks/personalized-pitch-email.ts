import type { TaskCtx, TaskResult } from "./types";
import { queueColdEmail } from "../email-queue";

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
- Subject: specific, curiosity-inducing, under 50 chars — industry-specific
- Body: 3 short paragraphs (problem → solution → CTA)
- NO generic opener ("I hope this finds you well", "My name is...")
- Start with the PROBLEM or INSIGHT specific to this industry
- CTA: one specific, low-friction ask (15-min call, reply with a question, etc.)
- Sign off as the founder
- Total body: under 200 words

Return ONLY valid JSON (no markdown, no backticks):
{
  "subject": "string",
  "body": "string — full email, newlines as \\n",
  "body_summary": "string — 80-char summary for dashboard",
  "target_role": "string — the recipient persona this is written for"
}`;

  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { subject: string; body: string; body_summary: string; target_role: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const customerDesc =
      (ctx.target_customer as Record<string, string>)?.description ?? "your customers";
    parsed = {
      subject: `Quick question about ${customerDesc}`,
      body: `The problem ${customerDesc} face is real — and most solutions miss the mark.\n\n${business.name} addresses this differently: ${ctx.value_proposition ?? "by taking a focused approach"}.\n\nWould you have 15 minutes to tell me if we're on the right track?\n\n— ${user.email.split("@")[0]}`,
      body_summary: `Personalized outreach for ${business.name} targeting ${customerDesc}`,
      target_role: customerDesc,
    };
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

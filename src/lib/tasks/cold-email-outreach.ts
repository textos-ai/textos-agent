import type { TaskCtx, TaskResult } from "./types";
import { queueColdEmail } from "../email-queue";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runColdEmailOutreach(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, supabase, env, emit, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Creating a cold email outreach strategy with ready-to-send templates.",
    ts: Date.now(),
  });

  const prompt = `Create a cold email outreach strategy with 3 email templates for this business.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? "direct and genuine"}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}

Create 3 email templates:
1. Initial outreach (problem-focused)
2. Follow-up #1 (value-focused)
3. Follow-up #2 (social proof/urgency)

Each template should be:
- Subject line under 50 chars
- Body under 150 words
- Industry-specific hooks
- Clear, single CTA
- Signed from the founder

Return ONLY valid JSON:
{
  "title": "Cold Email Outreach Strategy",
  "sections": [
    {
      "heading": "Email 1: Initial Outreach",
      "body": "**Subject:** subject line\\n\\n**Body:**\\nemail body text"
    },
    {
      "heading": "Email 2: Value Follow-up",
      "body": "**Subject:** subject line\\n\\n**Body:**\\nemail body text"
    },
    {
      "heading": "Email 3: Final Follow-up",
      "body": "**Subject:** subject line\\n\\n**Body:**\\nemail body text"
    }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { title: string; sections: Array<{ heading: string; body: string }> };

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback structure
    const customerDesc = (ctx.target_customer as Record<string, string>)?.description ?? "your ideal customers";
    parsed = {
      title: "Cold Email Outreach Strategy",
      sections: [
        {
          heading: "Email 1: Initial Outreach",
          body: `**Subject:** Quick question about ${customerDesc}\n\n**Body:**\nI noticed ${customerDesc} often struggle with [specific problem]. ${business.name} helps solve this by ${ctx.value_proposition ?? "taking a focused approach"}.\n\nWould you have 10 minutes to share your experience with this challenge?\n\nBest,\n${user.email.split("@")[0]}`
        },
        {
          heading: "Email 2: Value Follow-up",
          body: `**Subject:** Re: ${customerDesc}\n\n**Body:**\nFollowing up on my previous email about ${business.name}.\n\nHere's a quick insight: [relevant industry insight or tip].\n\nStill interested in that 10-minute conversation?\n\nBest,\n${user.email.split("@")[0]}`
        }
      ]
    };
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
        model: "claude-sonnet-4-6",
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
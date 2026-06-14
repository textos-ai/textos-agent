import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runSocialContentPlan(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, supabase, emit, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Creating a 30-day social content plan that actually converts.",
    ts: Date.now(),
  });

  const prompt = `Create a 30-day social content plan for this business.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? "direct and genuine"}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}

Create a strategic content plan with:
- 4 weeks of posts (LinkedIn, Twitter, Instagram)
- Mix of content types: insights, behind-the-scenes, customer wins, tips
- Each post includes caption + suggested hashtags
- CTAs that drive to business website or email signup
- Content hooks that differentiate from competitors

Return ONLY valid JSON:
{
  "title": "30-Day Social Content Plan",
  "sections": [
    {
      "heading": "Week 1: Foundation",
      "body": "markdown with post ideas, captions, hashtags"
    },
    {
      "heading": "Week 2: Value",
      "body": "markdown with post ideas, captions, hashtags"
    }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { title: string; sections: Array<{ heading: string; body: string }> };

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback structure
    parsed = {
      title: "30-Day Social Content Plan",
      sections: [
        {
          heading: "Week 1: Foundation",
          body: `# Week 1: Foundation\n\n**Post 1:** Introduce the problem ${business.name} solves\n**Post 2:** Share founder story\n**Post 3:** Customer pain point insight\n**Post 4:** Behind-the-scenes content\n**Post 5:** Value proposition highlight`
        },
        {
          heading: "Week 2: Value",
          body: `# Week 2: Value\n\n**Post 1:** Educational tip related to your industry\n**Post 2:** Case study or customer win\n**Post 3:** Industry insight or trend\n**Post 4:** Product/service highlight\n**Post 5:** Testimonial or review`
        }
      ]
    };
  }

  // Save to business_assets
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "social_content_plan",
      asset_data: parsed,
      metadata: {
        model: models.sonnet,
        content_weeks: 4,
        platforms: ["LinkedIn", "Twitter", "Instagram"]
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: parsed as unknown as Record<string, unknown>,
  };
}
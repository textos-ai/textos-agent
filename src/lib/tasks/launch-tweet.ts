import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runLaunchTweet(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Drafting launch tweet with brand voice", ts: Date.now() });

  const prompt = `Write a launch tweet announcing this business. It must be authentic and engaging — not corporate.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
What it does: ${ctx.business_summary ?? business.name}
Target customer: ${JSON.stringify(ctx.target_customer)}
Brand voice: ${ctx.brand_voice ?? "bold and direct"}
Key differentiator: ${(ctx.key_differentiators as string[])?.[0] ?? ""}
Value proposition: ${ctx.value_proposition ?? ""}

Requirements:
- Max 240 characters (leave room for a link)
- No hashtag spam (1-2 relevant hashtags max, or none)
- Hook in the first 5 words — specific to the industry
- Specific and real — not vague marketing speak
- Reference what makes this different from generic alternatives
- End with a call to action if it fits

Return ONLY valid JSON (no markdown, no backticks):
{
  "tweet": "string — the tweet text",
  "character_count": 123,
  "hook": "string — the opening 5-word hook",
  "hashtags": ["string"]
}`;

  const msg = await anthropic.messages.create({
    model: models.haiku,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { tweet: string; character_count: number; hook: string; hashtags: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const tweet = `Just launched ${business.name} — built with @TextOS. Check it out.`;
    parsed = { tweet, character_count: tweet.length, hook: "Just launched", hashtags: [] };
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

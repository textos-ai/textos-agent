import type { TaskCtx, TaskResult } from "./types";

export async function runDashboardBriefing(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit } = tc;

  await emit({ type: "cmd", text: "Generating executive briefing from all context", ts: Date.now() });

  const prompt = `Write a concise executive briefing for a solopreneur's TextOS dashboard.
This is the first thing they'll read after their free build completes.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Mission: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Positioning: ${ctx.positioning_statement ?? ""}
Competitors: ${JSON.stringify(ctx.competitors)}
Market trends: ${JSON.stringify(ctx.market_trends)}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}
Confidence score: ${ctx.research_confidence_score}%

Guidelines:
- Lead with the single most important insight
- 3-4 sentences total — ruthlessly brief
- Name 1 specific opportunity and 1 specific risk
- End with one clear next action
- Tone: like a smart advisor who's done the work and gets to the point

Return ONLY valid JSON:
{
  "briefing": "string — the full briefing text",
  "opportunity": "string — one-sentence opportunity",
  "risk": "string — one-sentence risk",
  "next_action": "string — one specific thing to do today",
  "confidence_note": "string — one sentence on data confidence"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: { briefing: string; opportunity: string; risk: string; next_action: string; confidence_note: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      briefing: `${business.name} is positioned in ${ctx.industry ?? "the market"} with a clear value proposition. Research is complete and your task queue is ready.`,
      opportunity: ctx.value_proposition ?? "Market opportunity identified.",
      risk: "Competition exists — differentiation is key.",
      next_action: "Review your task queue and unlock paid tasks to continue building.",
      confidence_note: `Research confidence: ${ctx.research_confidence_score}%.`,
    };
  }

  return {
    output_data: {
      briefing: parsed.briefing,
      opportunity: parsed.opportunity,
      risk: parsed.risk,
      next_action: parsed.next_action,
      confidence_note: parsed.confidence_note,
    },
  };
}

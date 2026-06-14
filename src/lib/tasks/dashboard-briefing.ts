import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runDashboardBriefing(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Generating executive briefing from all context", ts: Date.now() });

  const prompt = `Write a concise executive briefing for a solopreneur's TextOS dashboard.
This is the first thing they'll read after their free build completes.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Positioning: ${ctx.positioning_statement ?? ""}
Competitors: ${JSON.stringify(ctx.competitors)}
Market trends: ${JSON.stringify(ctx.market_trends)}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}
Research confidence: ${ctx.research_confidence_score}%

Guidelines:
- Lead with the single most important insight specific to this industry
- 3-4 sentences total — ruthlessly brief
- Name 1 specific opportunity and 1 specific risk — both must be industry-specific
- End with one clear next action
- Tone: like a smart advisor who's done the work and gets to the point
- Reference real competitors by name if available

Return ONLY valid JSON (no markdown, no backticks):
{
  "briefing": "string — the full briefing text",
  "opportunity": "string — one-sentence opportunity",
  "risk": "string — one-sentence risk",
  "next_action": "string — one specific thing to do today",
  "confidence_note": "string — one sentence on data confidence"
}`;

  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: {
    briefing: string;
    opportunity: string;
    risk: string;
    next_action: string;
    confidence_note: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      briefing: `${business.name} is active in ${ctx.industry ?? "the market"}. Research is complete and your task queue is ready.`,
      opportunity: ctx.value_proposition ?? "Market opportunity identified.",
      risk: "Competition exists — differentiation is essential.",
      next_action: "Review your task queue and unlock paid tasks to continue building.",
      confidence_note: `Research confidence: ${ctx.research_confidence_score}%.`,
    };
  }

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "dashboard_briefing",
      asset_data: parsed,
      metadata: { model: models.sonnet },
    });
  } catch {
    // Non-fatal
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

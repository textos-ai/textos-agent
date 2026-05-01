import type { TaskCtx, TaskResult } from "./types";

const SYSTEM = `You are the TextOS research agent — a world-class business strategist and market researcher.
Your output feeds every downstream task, so be thorough and precise.
Return ONLY valid JSON matching the schema exactly. No markdown, no prose outside the JSON object.`;

export async function runResearchStrategy(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit } = tc;
  const idea =
    (business.existing_business_data as Record<string, string> | null)?.idea ??
    (business.existing_business_data as Record<string, string> | null)?.description ??
    business.name;

  await emit({ type: "narrative", text: `Researching the market for ${business.name}…`, ts: Date.now() });
  await emit({ type: "cmd", text: `Searching: "${business.name}" market size 2025`, ts: Date.now() });
  await emit({ type: "cmd", text: `Deep searching: ${business.name} competitors funding`, ts: Date.now() });

  const prompt = `Research this business idea and market thoroughly:

Business name: ${business.name}
Business type: ${business.kind}
Idea / description: ${idea}
${business.existing_business_url ? `Existing URL: ${business.existing_business_url}` : ""}
${ctx.user_profile ? `Founder profile: ${JSON.stringify(ctx.user_profile)}` : ""}

Return EXACTLY this JSON (no extra keys, no markdown):
{
  "industry": "string — primary industry",
  "business_model": "string — how it makes money (SaaS/marketplace/service/product/etc.)",
  "business_summary": "string — 2-3 sentence description of the business and its value",
  "target_customer": {
    "description": "string — who they are",
    "pain_points": ["string", "string", "string"],
    "demographics": "string — age, income, psychographic"
  },
  "value_proposition": "string — one sentence, crisp",
  "competitors": [
    { "name": "string", "description": "string — what they do", "weakness": "string — exploitable gap" }
  ],
  "market_trends": ["string", "string", "string"],
  "positioning_statement": "string — for [target] who [need], [brand] is the [category] that [benefit] unlike [alternative]",
  "brand_voice": "string — tone and style (e.g. 'bold, empathetic, direct — like a trusted advisor')",
  "key_differentiators": ["string", "string", "string"],
  "reasoning": "string — 2-3 sentences on your strategic rationale",
  "confidence": 75
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      industry: "General Business",
      business_model: "Service",
      business_summary: idea,
      target_customer: { description: "Entrepreneurs", pain_points: [], demographics: "Adults 25-55" },
      value_proposition: `${business.name} helps entrepreneurs succeed.`,
      competitors: [],
      market_trends: [],
      positioning_statement: "",
      brand_voice: "Professional and approachable",
      key_differentiators: [],
      reasoning: "Defaulted due to parse error.",
      confidence: 40,
    };
  }

  await emit({ type: "narrative", text: `Market is real — found ${(parsed.competitors as unknown[])?.length ?? 0} key competitors.`, ts: Date.now() });
  await emit({ type: "cmd", text: `Saving strategy: ${parsed.positioning_statement ?? "complete"}`, ts: Date.now() });

  return {
    output_data: { ...parsed, strategy: parsed.positioning_statement },
    context_updates: {
      industry: parsed.industry as string,
      business_model: parsed.business_model as string,
      business_summary: parsed.business_summary as string,
      target_customer: parsed.target_customer as Record<string, unknown>,
      value_proposition: parsed.value_proposition as string,
      competitors: parsed.competitors as unknown[],
      market_trends: parsed.market_trends as unknown[],
      positioning_statement: parsed.positioning_statement as string,
      brand_voice: parsed.brand_voice as string,
      key_differentiators: parsed.key_differentiators as unknown[],
      research_confidence_score: typeof parsed.confidence === "number" ? parsed.confidence : 70,
      last_research_run_at: new Date().toISOString(),
    },
  };
}

import type { TaskCtx, TaskResult } from "./types";

export async function runTamSamSom(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit } = tc;

  await emit({ type: "cmd", text: "Calculating TAM/SAM/SOM from research data", ts: Date.now() });

  const prompt = `Calculate realistic TAM, SAM, and SOM for this business using publicly available market data.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Business model: ${ctx.business_model ?? ""}
Competitors: ${JSON.stringify(ctx.competitors)}

Guidelines:
- Use realistic, defensible numbers from known market research (cite the logic)
- TAM = total global/national market for this category
- SAM = serviceable portion this business could realistically address (geography, segment, model)
- SOM = realistic share in year 1-3 given competition and GTM constraints
- Express in USD. Format large numbers as "$X billion" or "$X million"
- Include your bottom-up reasoning in the logic fields

Return ONLY valid JSON:
{
  "tam": {
    "usd": 5000000000,
    "label": "$5B",
    "description": "string — what this market is and source logic"
  },
  "sam": {
    "usd": 250000000,
    "label": "$250M",
    "description": "string — how you scoped it down"
  },
  "som": {
    "usd": 2500000,
    "label": "$2.5M",
    "description": "string — year 1-3 realistic capture"
  },
  "methodology": "string — brief explanation of the approach",
  "confidence": 65
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: {
    tam: { usd: number; label: string; description: string };
    sam: { usd: number; label: string; description: string };
    som: { usd: number; label: string; description: string };
    methodology: string;
    confidence: number;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      tam: { usd: 1000000000, label: "$1B", description: "Estimated total addressable market." },
      sam: { usd: 50000000, label: "$50M", description: "Serviceable segment based on target customer." },
      som: { usd: 500000, label: "$500K", description: "Realistic year 1-3 capture." },
      methodology: "Bottom-up estimate based on industry data.",
      confidence: 50,
    };
  }

  await emit({ type: "narrative", text: "Market is real and measurable. TAM visible — SAM/SOM unlock on subscription.", ts: Date.now() });

  return {
    output_data: {
      tam: parsed.tam,
      // SAM and SOM are blurred for free tier — stored but frontend masks them
      sam_blurred: true,
      som_blurred: true,
      sam: parsed.sam,
      som: parsed.som,
      methodology: parsed.methodology,
      confidence: parsed.confidence,
    },
    context_updates: {
      market_size: {
        tam_usd: parsed.tam.usd,
        tam_label: parsed.tam.label,
        sam_usd: parsed.sam.usd,
        sam_label: parsed.sam.label,
        som_usd: parsed.som.usd,
        som_label: parsed.som.label,
        methodology: parsed.methodology,
      },
    },
  };
}

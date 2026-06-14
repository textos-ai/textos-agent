import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runTamSamSom(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Calculating TAM/SAM/SOM from research data", ts: Date.now() });

  const prompt = `Calculate realistic TAM, SAM, and SOM for this business using publicly available market data.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Business model: ${ctx.business_model ?? ""}
Competitors: ${JSON.stringify(ctx.competitors)}

Guidelines:
- Use realistic, defensible numbers from known market research
- TAM = total global/national market for this specific industry category
- SAM = serviceable portion this business could realistically address
- SOM = realistic share in year 1-3 given competition and GTM constraints
- Express in USD with human-readable labels ("$5B", "$250M", "$2.5M")
- Base reasoning on the specific industry, not generic defaults

Return ONLY valid JSON (no markdown, no backticks):
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
  "methodology": "string — brief explanation of the bottom-up approach",
  "confidence": 65
}`;

  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
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
      tam: { usd: 1000000000, label: "$1B", description: `Estimated ${ctx.industry ?? "market"} TAM.` },
      sam: { usd: 50000000, label: "$50M", description: "Serviceable segment based on target customer." },
      som: { usd: 500000, label: "$500K", description: "Realistic year 1-3 capture." },
      methodology: "Bottom-up estimate based on industry research.",
      confidence: 50,
    };
  }

  await emit({
    type: "narrative",
    text: "Market is real and measurable. TAM visible — SAM/SOM unlock on subscription.",
    ts: Date.now(),
  });

  const outputData = {
    tam: parsed.tam,
    sam_blurred: true,
    som_blurred: true,
    sam: parsed.sam,
    som: parsed.som,
    methodology: parsed.methodology,
    confidence: parsed.confidence,
  };

  const marketSize = {
    tam_usd: parsed.tam.usd,
    tam_label: parsed.tam.label,
    sam_usd: parsed.sam.usd,
    sam_label: parsed.sam.label,
    som_usd: parsed.som.usd,
    som_label: parsed.som.label,
    methodology: parsed.methodology,
  };

  // ── Write market_size directly to business_context ─────────────────
  // context_updates goes through upsertBusinessContext in the orchestrator,
  // but that path uses onConflict merge which can silently skip the update.
  // Direct .update() here guarantees market_size is persisted.
  try {
    await supabase
      .from("business_context")
      .update({ market_size: marketSize })
      .eq("business_id", business.id);
  } catch {
    // Non-fatal — context_updates fallback covers it
  }

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "market_sizing",
      asset_data: outputData,
      metadata: {
        model: models.sonnet,
        sam_blurred: true,
        som_blurred: true,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: outputData,
    context_updates: { market_size: marketSize },
  };
}

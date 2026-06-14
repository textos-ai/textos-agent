import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runMissionDocument(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Writing the mission — this is the part that defines everything downstream.",
    ts: Date.now(),
  });

  const prompt = `Write a mission, vision, and values document for this business.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
What it does: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? ""}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}

Guidelines:
- Mission: what the company does TODAY (present tense, 1-2 sentences, specific to this industry)
- Vision: what the world looks like if you succeed (future tense, inspiring but achievable)
- Values: 3-5 core principles — real ones specific to this business, not clichés like "integrity" or "excellence"
- Each value gets: name (2-3 words) + explanation (1 sentence)
- Tagline: 5-10 words, memorable and specific to this business
- Do NOT start mission or vision with the company name — write them as statements about purpose

Return ONLY valid JSON (no markdown, no backticks):
{
  "mission": "string — purpose statement, does not start with the company name",
  "vision": "string — future-state statement, does not start with the company name",
  "values": [
    { "name": "string", "description": "string" }
  ],
  "tagline": "string — 5-10 words, memorable"
}`;

  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());

  let parsed: {
    mission: string;
    vision: string;
    values: Array<{ name: string; description: string }>;
    tagline: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback without duplicate-prefix bug: use value_prop directly, not composed with name
    const customerDesc =
      (ctx.target_customer as Record<string, string>)?.description ?? "those who need it most";
    parsed = {
      mission: ctx.value_proposition
        ? `Providing ${ctx.value_proposition.replace(/^[^a-z]*/i, "").toLowerCase()}.`
        : `Delivering real results for ${customerDesc}.`,
      vision: `A world where ${customerDesc} have the tools, support, and resources to succeed.`,
      values: [
        { name: "Results Over Process", description: "We measure success by outcomes, not effort." },
      ],
      tagline: `${business.name} — built to matter.`,
    };
  }

  await emit({ type: "cmd", text: "Saving mission document to business context", ts: Date.now() });

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "mission_document",
      asset_data: parsed,
      metadata: { model: models.sonnet },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      mission: parsed.mission,
      vision: parsed.vision,
      values: parsed.values,
      tagline: parsed.tagline,
    },
    context_updates: {
      business_summary: parsed.mission,
    },
  };
}

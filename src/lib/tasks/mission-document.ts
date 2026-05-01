import type { TaskCtx, TaskResult } from "./types";

export async function runMissionDocument(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit } = tc;

  await emit({ type: "narrative", text: "Writing the mission — this is the part that defines everything downstream.", ts: Date.now() });

  const prompt = `Write a mission, vision, and values document for this business.

Business: ${business.name}
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? ""}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}

Guidelines:
- Mission: what the company does TODAY (present tense, 1-2 sentences, specific)
- Vision: what the world looks like if you succeed (future tense, inspiring but achievable)
- Values: 3-5 core principles — real ones, not "integrity" and "excellence" clichés
- Each value gets: name (2-3 words) + explanation (1 sentence)
- Tone matches brand voice

Return ONLY valid JSON:
{
  "mission": "string",
  "vision": "string",
  "values": [
    { "name": "string", "description": "string" }
  ],
  "tagline": "string — 5-10 words, memorable"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: { mission: string; vision: string; values: Array<{ name: string; description: string }>; tagline: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      mission: `${business.name} helps ${ctx.value_proposition ?? "customers succeed"}.`,
      vision: `A world where ${(ctx.target_customer as Record<string, string>)?.description ?? "entrepreneurs"} have the tools to thrive.`,
      values: [{ name: "Results First", description: "We measure success by outcomes, not effort." }],
      tagline: `${business.name} — built to win.`,
    };
  }

  await emit({ type: "cmd", text: "Saving mission document to business context", ts: Date.now() });

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

import type { TaskCtx, TaskResult } from "./types";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";

const TASK_SLUG = "tam-sam-som";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runTamSamSom(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Calculating TAM/SAM/SOM from research data", ts: Date.now() });

  const promptDef = await resolvePrompt(supabase, TASK_SLUG);
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error(`task_missing_system_prompt: ${TASK_SLUG}`);
  }
  const prompt = renderPrompt(promptDef.user_prompt_template, { business, ctx, user });

  const llmController = new AbortController();
  const llmTimeoutId = setTimeout(() => llmController.abort(), 45_000);
  let msg;
  try {
    msg = await anthropic.messages.create(
      {
        model: models.sonnet,
        max_tokens: 800,
        system: promptDef.system_prompt,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: llmController.signal },
    );
  } catch (err) {
    if (llmController.signal.aborted) throw new Error(`task_timeout_45s:${TASK_SLUG}`);
    throw err;
  } finally {
    clearTimeout(llmTimeoutId);
  }

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
    throw new Error(
      `task_json_parse_failed:${TASK_SLUG} stop_reason=${msg?.stop_reason ?? "unknown"} raw_start=${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
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

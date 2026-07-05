// draft-reply — source-agnostic first-message drafter. For each 'verified'
// lead it drafts a helpful reply grounded in the thread + the business context,
// using a config prompt (prompt_definitions), and writes it to
// leads.drafted_message. Reuses the generation pattern; no platform names.

import type { TaskCtx, TaskResult } from "./types";
import { renderPrompt } from "./generic-document-runner";
import { resolvePrompt } from "./prompt-resolver";

interface LeadRow {
  id: string;
  url: string | null;
  title: string | null;
  snippet: string | null;
}

function messageText(msg: unknown): string {
  const blocks = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

export async function runDraftReply(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit } = tc;

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, url, title, snippet")
    .eq("business_id", business.id)
    .eq("status", "verified");
  if (error) throw new Error(`draft_reply_load_failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    return { output_data: { drafted: 0 } };
  }

  const promptDef = await resolvePrompt(supabase, "draft-reply");
  let drafted = 0;

  for (const lead of leads as LeadRow[]) {
    const rendered = renderPrompt(promptDef.user_prompt_template, { business, ctx, user, lead });
    const msg = await anthropic.messages.create({
      model: models.sonnet,
      max_tokens: 500,
      system: promptDef.system_prompt ?? "",
      messages: [{ role: "user", content: rendered }],
    });
    const reply = messageText(msg);
    if (!reply) continue;
    await supabase.from("leads").update({ status: "drafted", drafted_message: reply }).eq("id", lead.id);
    drafted++;
  }

  await emit({ type: "cmd", text: `Drafted ${drafted} repl(y/ies)`, ts: Date.now() });
  return { output_data: { drafted } };
}

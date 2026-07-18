// reach-package-lead — source-agnostic per-lead "how to contact this human".
//
// For each drafted lead it assembles what the business owner needs to reach the
// prospect THEMSELVES (the system never contacts anyone). Written to
// leads.metadata.reach_package:
//   - person:         the author handle/name if the finder captured it, else a
//                     clear note to reply via the permalink
//   - where_to_reach: the exact permalink to reply publicly, or a profile to DM
//   - channel:        human-readable channel for this source
//   - reach_strength: "strong" (a reachable individual) | "weak" (e.g. a review =
//                     a business, not a person)
//   - caveat:         one line flagging any weakness (missing handle, review, ...)
//   - opener:         the existing drafted_message, REUSED VERBATIM (not rewritten)
//
// The model reasons about channel/strength/caveat source-agnostically from the
// row (source, url, snippet); the opener is injected from drafted_message so the
// approved copy is preserved exactly. Merges the existing metadata jsonb.

import type { TaskCtx, TaskResult } from "./types";
import { renderPrompt } from "./generic-document-runner";
import { resolvePrompt } from "./prompt-resolver";
import { mergeLeadMetadata } from "./lead-metadata";

interface LeadRow {
  id: string;
  source: string | null;
  url: string | null;
  title: string | null;
  snippet: string | null;
  drafted_message: string | null;
  metadata: Record<string, unknown> | null;
}

function messageText(msg: unknown): string {
  const blocks = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

function parseJson(raw: string): Record<string, unknown> {
  let s = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s) as Record<string, unknown>;
}

export async function runReachPackageLead(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit } = tc;

  // Idempotent: only drafted rows without a reach_package yet. A redelivered or
  // cut-short run resumes on the remainder instead of re-packaging everything.
  const { data: leads, error } = await supabase
    .from("connection_leads")
    .select("id, source, url, title, snippet, drafted_message, metadata")
    .eq("business_id", business.id)
    .eq("status", "drafted")
    .is("metadata->>reach_package", null);
  if (error) throw new Error(`reach_package_load_failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    return { output_data: { checked: 0, packaged: 0, skipped: 0 } };
  }

  const promptDef = await resolvePrompt(supabase, "reach-package-lead");
  let packaged = 0, skipped = 0;

  for (const lead of leads as LeadRow[]) {
    // Pass the alignment_read (if stage 1 ran) so the package can lean on it,
    // and the author identity the finder captured (if any) so the package can
    // resolve a real handle → "DM @handle" with strong reach instead of the
    // permalink-only fallback.
    const md = lead.metadata ?? {};
    const alignment = md["alignment_read"] ?? null;
    const author = (md["author"] as string | undefined) ?? null;
    const author_url = (md["author_url"] as string | undefined) ?? null;
    const rendered = renderPrompt(promptDef.user_prompt_template, {
      business, ctx, user, lead, alignment, author, author_url,
    });
    let pkg: Record<string, unknown>;
    try {
      // Resilience: one lead's LLM error/unparseable output skips THAT lead, never
      // throws the whole run (that throw is what provoked queue redelivery). It
      // resumes next run via the skip-filter above.
      const msg = await anthropic.messages.create({
        model: models.sonnet,
        max_tokens: 500,
        system: promptDef.system_prompt ?? "",
        messages: [{ role: "user", content: rendered }],
      });
      pkg = parseJson(messageText(msg));
    } catch {
      skipped++;
      continue;
    }
    // Opener is the approved copy, reused verbatim — never model-regenerated.
    const reach_package = { ...pkg, opener: lead.drafted_message ?? null };
    // Atomic merge — never clobber a sibling stage's key (age_days/alignment_read).
    await mergeLeadMetadata(supabase, lead.id, { reach_package });
    packaged++;
  }

  await emit({
    type: "cmd",
    text: `Reach package assembled for ${packaged} lead(s)${skipped ? `, ${skipped} skipped` : ""}`,
    ts: Date.now(),
  });
  return { output_data: { checked: leads.length, packaged, skipped } };
}

// understand-lead — source-agnostic per-lead alignment read.
//
// For each verified/drafted lead it reads the person's post + author signals and
// writes an alignment read to leads.metadata.alignment_read:
//   - activity:         how active they seem (posting cadence / recency signals)
//   - engagement_style: how they engage (direct questions / venting / seeking recs)
//   - readiness:        how ready-to-talk they seem
//   - fit_line:         one line — why THIS person fits the business's customer
// Scoring/inference is driven by a config prompt (prompt_definitions). It reads
// and merges the existing metadata jsonb so it never clobbers another stage's
// key. No platform names here — works for every source.

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
  published_at: string | null;
  match_reason: string | null;
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

export async function runUnderstandLead(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit } = tc;

  // Idempotent: only rows that don't already carry an alignment_read. A
  // redelivered run (or one cut short mid-loop) resumes on the remainder instead
  // of reprocessing — no wasted LLM calls, no re-write to race on.
  const { data: leads, error } = await supabase
    .from("connection_leads")
    .select("id, source, url, title, snippet, published_at, match_reason, metadata")
    .eq("business_id", business.id)
    .in("status", ["verified", "drafted"])
    .is("metadata->>alignment_read", null);
  if (error) throw new Error(`understand_lead_load_failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    return { output_data: { checked: 0, enriched: 0, skipped: 0 } };
  }

  const promptDef = await resolvePrompt(supabase, "understand-lead");
  let enriched = 0, skipped = 0;

  for (const lead of leads as LeadRow[]) {
    const rendered = renderPrompt(promptDef.user_prompt_template, { business, ctx, user, lead });
    let read: Record<string, unknown>;
    try {
      // Resilience: a single lead's LLM error (e.g. the 90s client timeout) or
      // unparseable output must skip THAT lead, never throw the whole run — an
      // uncaught throw here is what marked the run 'failed' and provoked the
      // queue redelivery that raced the metadata writes. It resumes next run
      // (the skip-filter above re-selects it).
      const msg = await anthropic.messages.create({
        model: models.sonnet,
        max_tokens: 600,
        system: promptDef.system_prompt ?? "",
        messages: [{ role: "user", content: rendered }],
      });
      read = parseJson(messageText(msg));
    } catch {
      skipped++;
      continue;
    }
    // Atomic merge — never clobber a sibling stage's key (age_days/reach_package).
    await mergeLeadMetadata(supabase, lead.id, { alignment_read: read });
    enriched++;
  }

  await emit({
    type: "cmd",
    text: `Alignment read written for ${enriched} lead(s)${skipped ? `, ${skipped} skipped` : ""}`,
    ts: Date.now(),
  });
  return { output_data: { checked: leads.length, enriched, skipped } };
}

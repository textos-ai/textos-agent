// match-verify-leads — the ONE source-agnostic verify/score runner.
//
// Works for EVERY platform because the retrieval engine already normalized all
// sources to the canonical leads shape ({url, snippet, published_at, ...}).
// For each 'found' lead it: (1) gates freshness < 90d from published_at,
// (2) verifies the link resolves (drops dead links), (3) scores relevance vs
// ctx.target_customer via a config prompt (prompt_definitions), keeping a
// verbatim snippet as proof. No platform names here.

import type { TaskCtx, TaskResult } from "./types";
import { renderPrompt } from "./generic-document-runner";
import { resolvePrompt } from "./prompt-resolver";

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MATCH_THRESHOLD = 60;

interface LeadRow {
  id: string;
  url: string | null;
  title: string | null;
  snippet: string | null;
  published_at: string | null;
}

interface ScoreResult {
  match_score: number;
  match_reason: string;
  quote?: string;
}

function messageText(msg: unknown): string {
  const blocks = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

function parseScore(raw: string): ScoreResult {
  let s = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  const parsed = JSON.parse(s) as Record<string, unknown>;
  const score = Number(parsed.match_score);
  return {
    match_score: isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    match_reason: typeof parsed.match_reason === "string" ? parsed.match_reason : "",
    quote: typeof parsed.quote === "string" ? parsed.quote : undefined,
  };
}

export async function runMatchVerifyLeads(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit } = tc;

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, url, title, snippet, published_at")
    .eq("business_id", business.id)
    .eq("status", "found");
  if (error) throw new Error(`match_verify_leads_load_failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    return { output_data: { checked: 0, verified: 0, rejected: 0, dropped: 0 } };
  }

  const promptDef = await resolvePrompt(supabase, "match-verify-leads");
  const now = Date.now();
  let verified = 0, rejected = 0, dropped = 0;

  for (const lead of leads as LeadRow[]) {
    // (1) freshness gate — exact, from published_at
    const pub = lead.published_at ? Date.parse(lead.published_at) : NaN;
    if (!isFinite(pub) || now - pub > MAX_AGE_MS) {
      await supabase.from("leads").update({ status: "rejected", match_reason: "stale (>90d)" }).eq("id", lead.id);
      rejected++;
      continue;
    }
    // (2) link-resolves verify — drop dead links
    let resolves = false;
    if (lead.url) {
      try {
        const r = await fetch(lead.url, { method: "GET", redirect: "follow" });
        resolves = r.ok;
      } catch { resolves = false; }
    }
    if (!resolves) {
      await supabase.from("leads").update({ status: "rejected", match_reason: "dead_link" }).eq("id", lead.id);
      dropped++;
      continue;
    }
    // (3) relevance score vs target_customer (config prompt)
    const rendered = renderPrompt(promptDef.user_prompt_template, { business, ctx, user, lead });
    const msg = await anthropic.messages.create({
      model: models.sonnet,
      max_tokens: 700,
      system: promptDef.system_prompt ?? "",
      messages: [{ role: "user", content: rendered }],
    });
    let score: ScoreResult;
    try {
      score = parseScore(messageText(msg));
    } catch {
      score = { match_score: 0, match_reason: "unparseable_score" };
    }
    if (score.match_score >= MATCH_THRESHOLD) {
      await supabase.from("leads").update({
        status: "verified",
        match_score: score.match_score,
        match_reason: score.match_reason,
        snippet: score.quote && lead.snippet && lead.snippet.includes(score.quote) ? score.quote : lead.snippet,
      }).eq("id", lead.id);
      verified++;
    } else {
      await supabase.from("leads").update({
        status: "rejected",
        match_score: score.match_score,
        match_reason: score.match_reason,
      }).eq("id", lead.id);
      rejected++;
    }
  }

  await emit({
    type: "cmd",
    text: `Verified ${verified} lead(s), rejected ${rejected}, dropped ${dropped} dead link(s)`,
    ts: Date.now(),
  });

  return { output_data: { checked: leads.length, verified, rejected, dropped } };
}

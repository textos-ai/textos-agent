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

// Defaults if the DB config is missing (migration 088 adds tasks.config, seeded
// {freshness_days:180, match_threshold:60}). The transparency panel reads the
// same config so the stated rules never drift from the real gate.
const DEFAULT_FRESHNESS_DAYS = 180;
const DEFAULT_MATCH_THRESHOLD = 60;
// Dual gate: a lead is kept only if it clears BOTH bars — real PAIN and real
// HIRE-intent (an owner/operator who'd pay, not a peer/no-budget DIY-er). This
// replaced a pain×hire product that was too harsh (a clear owner asking for
// help collapsed below the bar). A high-pain/no-budget lead now fails on hire
// alone and its stored sub-scores show exactly why.
const DEFAULT_PAIN_MIN = 55;
const DEFAULT_HIRE_MIN = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LeadRow {
  id: string;
  url: string | null;
  title: string | null;
  snippet: string | null;
  published_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface ScoreResult {
  match_score: number;
  pain_score: number;
  hire_score: number;
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
  const clamp = (v: unknown): number => {
    const x = Number(v);
    return isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 0;
  };
  // Two independent judgments: pain (do they have the problem we solve) and
  // hire (are they an owner/operator who would actually hire AND pay, vs a
  // peer/practitioner or a no-budget DIY-er). Overall = pain × hire, so a
  // high-pain / no-budget or peer lead collapses to a low score and reads as
  // what it is — not a buyer. Product is intentionally strict, for precision.
  // Back-compat: if a prompt still returns a flat match_score, use it as both.
  const flat = parsed.match_score !== undefined ? clamp(parsed.match_score) : null;
  const pain = parsed.pain_score !== undefined ? clamp(parsed.pain_score) : (flat ?? 0);
  const hire = parsed.hire_score !== undefined ? clamp(parsed.hire_score) : (flat ?? 0);
  return {
    // Combined score is the average — used only for ranking/display. The KEEP
    // decision is the dual gate (pain AND hire each clear their bar), applied
    // in the caller, so a high-pain/low-hire lead reads as what it is.
    match_score: Math.round((pain + hire) / 2),
    pain_score: pain,
    hire_score: hire,
    match_reason: typeof parsed.match_reason === "string" ? parsed.match_reason : "",
    quote: typeof parsed.quote === "string" ? parsed.quote : undefined,
  };
}

export async function runMatchVerifyLeads(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit } = tc;

  // Tunable gates live in the DB (tasks.config), not in code — so tuning is a
  // config change, not a deploy. Fall back to sane defaults if unseeded.
  const { data: cfgRow } = await supabase
    .from("tasks").select("config").eq("slug", "match-verify-leads").maybeSingle();
  const cfg = ((cfgRow as { config?: { freshness_days?: number; match_threshold?: number; pain_min?: number; hire_min?: number } } | null)?.config) ?? {};
  const freshnessDays = typeof cfg.freshness_days === "number" ? cfg.freshness_days : DEFAULT_FRESHNESS_DAYS;
  const matchThreshold = typeof cfg.match_threshold === "number" ? cfg.match_threshold : DEFAULT_MATCH_THRESHOLD;
  const painMin = typeof cfg.pain_min === "number" ? cfg.pain_min : DEFAULT_PAIN_MIN;
  const hireMin = typeof cfg.hire_min === "number" ? cfg.hire_min : DEFAULT_HIRE_MIN;
  const maxAgeMs = freshnessDays * DAY_MS;

  const { data: leads, error } = await supabase
    .from("connection_leads")
    .select("id, url, title, snippet, published_at, metadata")
    .eq("business_id", business.id)
    .eq("status", "found");
  if (error) throw new Error(`match_verify_leads_load_failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    return { output_data: { checked: 0, verified: 0, rejected: 0, dropped: 0 } };
  }

  const promptDef = await resolvePrompt(supabase, "match-verify-leads");
  const now = Date.now();
  let verified = 0, rejected = 0, dropped = 0, skipped = 0;

  for (const lead of leads as LeadRow[]) {
    // (1) freshness gate — exact, from published_at, window from config
    const pub = lead.published_at ? Date.parse(lead.published_at) : NaN;
    if (!isFinite(pub) || now - pub > maxAgeMs) {
      await supabase.from("connection_leads").update({ status: "rejected", match_reason: `stale (>${freshnessDays}d)` }).eq("id", lead.id);
      rejected++;
      continue;
    }
    // (2) link-resolves verify — drop only GENUINELY-dead links.
    // A response that ARRIVES (even 403/429/405) proves the host is serving that
    // path: big platforms (Reddit, LinkedIn, X) hard-block datacenter/bot fetches
    // with 403/429 even behind a browser UA, so treating those as "dead" wrongly
    // drops live leads the source API already vouched for. Only 404/410 (gone) or
    // a network-level failure (host unreachable) is real evidence of a dead link;
    // relevance is then judged by the match stage on the crawled snippet.
    let deadLink = !lead.url;
    if (lead.url) {
      try {
        const r = await fetch(lead.url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TextOS-LeadVerify/1.0)" },
        });
        deadLink = r.status === 404 || r.status === 410;
      } catch { deadLink = true; }
    }
    if (deadLink) {
      await supabase.from("connection_leads").update({ status: "rejected", match_reason: "dead_link" }).eq("id", lead.id);
      dropped++;
      continue;
    }
    // (3) relevance score vs target_customer (config prompt)
    const rendered = renderPrompt(promptDef.user_prompt_template, { business, ctx, user, lead });
    let score: ScoreResult;
    try {
      // Resilience: a per-lead LLM error (e.g. the 90s client timeout) skips this
      // lead — leave it 'found' so the next run retries it — rather than throwing
      // and failing the whole run (which provoked queue redelivery). Parse errors
      // still resolve to a 0-score reject below (a real answer, just unusable).
      const msg = await anthropic.messages.create({
        model: models.sonnet,
        max_tokens: 700,
        system: promptDef.system_prompt ?? "",
        messages: [{ role: "user", content: rendered }],
      });
      try {
        score = parseScore(messageText(msg));
      } catch {
        score = { match_score: 0, pain_score: 0, hire_score: 0, match_reason: "unparseable_score" };
      }
    } catch {
      skipped++;   // transient LLM error — stays 'found' for the next run to retry
      continue;
    }
    if (score.pain_score >= painMin && score.hire_score >= hireMin) {
      // Record the lead's age at keep-time (metadata.age_days) so we can later
      // analyse whether older leads produce anything or just add noise. Merge —
      // never clobber the finder's author/handle already in metadata.
      const ageDays = Math.floor((now - pub) / DAY_MS);
      await supabase.from("connection_leads").update({
        status: "verified",
        match_score: score.match_score,
        match_reason: score.match_reason,
        snippet: score.quote && lead.snippet && lead.snippet.includes(score.quote) ? score.quote : lead.snippet,
        // Keep the pain/hire sub-scores so the funnel can show WHY (strong pain
        // vs strong hire-intent), not just the combined number.
        metadata: { ...(lead.metadata ?? {}), age_days: ageDays, pain_score: score.pain_score, hire_score: score.hire_score },
      }).eq("id", lead.id);
      verified++;
    } else {
      await supabase.from("connection_leads").update({
        status: "rejected",
        match_score: score.match_score,
        match_reason: score.match_reason,
        metadata: { ...(lead.metadata ?? {}), pain_score: score.pain_score, hire_score: score.hire_score },
      }).eq("id", lead.id);
      rejected++;
    }
  }

  await emit({
    type: "cmd",
    text: `Verified ${verified} lead(s), rejected ${rejected}, dropped ${dropped} dead link(s)`,
    ts: Date.now(),
  });

  return { output_data: { checked: leads.length, verified, rejected, dropped, skipped } };
}

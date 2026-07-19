// run-lead-search — the automatic, config-driven lead search. It reads the
// business's persisted ICP-derived phrases (lead_search_queries) and runs the
// retrieval finder ONCE PER PHRASE. No human composes a query, ever: the config
// each finder call receives originates from stored customer context.
//
// If no phrases are persisted yet, it derives them first (which itself fails
// loud on a thin profile), so a single call is fully automatic for any business.
// It refuses to run the finder with an empty phrase set — no silent found:0.

import type { TaskCtx, TaskResult } from "./types";
import { getTaskBySlug, type TaskRow } from "../../services/supabase";
import { runExternalRetrieval } from "./external-retrieval-runner";
import { runDeriveSearchQueries } from "./derive-search-queries";
import { LEAD_FINDER_SLUGS } from "./lead-finders";

interface Phrase { text: string; rationale?: string }

// Per-phrase result cap (SocialCrawl `limit`) and the per-platform lead target.
// We stop searching more phrases for a platform once ~LEADS_PER_PLATFORM results
// are in — keeps each run small (~2 calls/platform instead of 14), which is
// faster, cheaper, and far gentler on upstream rate limits.
const DEFAULT_LIMIT = 5;
const LEADS_PER_PLATFORM = 10;

async function latestPhrases(
  supabase: TaskCtx["supabase"],
  businessId: string,
): Promise<Phrase[]> {
  const { data } = await supabase
    .from("lead_search_queries")
    .select("phrases")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const arr = (data as { phrases?: unknown } | null)?.phrases;
  return Array.isArray(arr) ? (arr as Phrase[]).filter((p) => p && typeof p.text === "string" && p.text.trim()) : [];
}

export async function runLeadSearch(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, emit } = tc;

  // 1. Ensure derived phrases exist. Auto-derive if none — derive fails loud on
  //    a thin profile, so the loud failure propagates here (never a silent run).
  let phrases = await latestPhrases(supabase, business.id);
  let derived_now = false;
  if (phrases.length === 0) {
    await runDeriveSearchQueries(tc); // throws customer_profile_too_thin on thin context
    phrases = await latestPhrases(supabase, business.id);
    derived_now = true;
  }
  if (phrases.length === 0) {
    throw new Error(
      "lead_search_no_phrases: no ICP-derived search phrases available after derivation — " +
      "refusing to run the finder with an empty query set.",
    );
  }

  // 2. Load the pipeline's retrieval finders (LEAD_FINDER_SLUGS — one source of
  //    truth shared with the leads UI). One today (Reddit); loops for many.
  // Per-ICP finder selection: LEAD_FINDER_SLUGS is the GLOBAL default (every
  // platform we've vetted). A business can NARROW it — e.g. a non-technical ICP
  // (a marketing consultant's small-biz customers) drops Hacker News, which is
  // the wrong pond for them, while HN stays on globally for technical/founder
  // ICPs. The override lives in business_context.customer_signals.lead_finders
  // (a list of finder slugs); it can only subset the global set, never add an
  // unvetted finder. Unset / empty intersection → the full global set.
  let finderSlugs: string[] = LEAD_FINDER_SLUGS;
  const { data: bctx } = await supabase
    .from("business_context")
    .select("customer_signals")
    .eq("business_id", business.id)
    .maybeSingle();
  const override = (bctx as { customer_signals?: { lead_finders?: unknown } } | null)?.customer_signals?.lead_finders;
  if (Array.isArray(override) && override.length) {
    const want = new Set(override.filter((x): x is string => typeof x === "string"));
    const narrowed = LEAD_FINDER_SLUGS.filter((s) => want.has(s));
    if (narrowed.length) finderSlugs = narrowed;
  }

  const finders: TaskRow[] = [];
  for (const slug of finderSlugs) {
    const t = (await getTaskBySlug(supabase, slug)) as TaskRow | null;
    if (t) finders.push(t);
  }
  if (finders.length === 0) throw new Error("lead_search_finder_missing: no LEAD_FINDER_SLUGS tasks found");

  // 3. Search each platform, phrase by phrase, but STOP once ~LEADS_PER_PLATFORM
  //    results are in — small, fast runs. A platform that soft-skips (429/internal
  //    rate limit) is recorded so the UI can say it was busy.
  let inserted = 0;
  const per: Array<{ finder: string; phrase: string; found: number; inserted: number }> = [];
  const rate_limited = new Set<string>();
  const credits_exhausted = new Set<string>();
  let credits_remaining: number | null = null;
  let credits_used = 0;
  let outOfCredits = false;
  for (const finder of finders) {
    if (outOfCredits) break;                            // credits are gone → stop entirely
    let platformFound = 0;
    for (const p of phrases) {
      if (platformFound >= LEADS_PER_PLATFORM) break;   // ~10 per platform, then stop
      const subTc: TaskCtx = { ...tc, config: { query: p.text, limit: DEFAULT_LIMIT } };
      const r = await runExternalRetrieval(subTc, finder);
      const od = (r.output_data ?? {}) as { found?: number; inserted?: number; source?: string; skipped?: string; credits_remaining?: number | null; credits_used?: number };
      if (typeof od.credits_remaining === "number") credits_remaining = od.credits_remaining;
      credits_used += od.credits_used ?? 0;
      // Credit exhaustion is a HARD stop — every further call will 402 too. Bail.
      if (od.skipped === "no_credits") { credits_exhausted.add(od.source ?? finder.slug); outOfCredits = true; break; }
      if (od.skipped === "rate_limited") rate_limited.add(od.source ?? finder.slug);
      // A search timeout (dead/hanging upstream) is a soft-skip too — and we stop
      // trying more phrases for this platform, since each would just hang out to
      // the 25s ceiling. Surfaced as "busy" in the UI.
      if (od.skipped === "search_timeout") { rate_limited.add(od.source ?? finder.slug); break; }
      platformFound += od.found ?? 0;
      inserted += od.inserted ?? 0;
      per.push({ finder: finder.slug, phrase: p.text, found: od.found ?? 0, inserted: od.inserted ?? 0 });
    }
  }

  await emit({
    type: "cmd",
    text: `Stored ${inserted} lead(s)`
      + (credits_exhausted.size ? `; ${[...credits_exhausted].join(", ")} out of credits` : "")
      + (rate_limited.size ? `; ${[...rate_limited].join(", ")} was busy` : ""),
    ts: Date.now(),
  });

  return {
    output_data: {
      phrases: phrases.length, derived_now, inserted, per,
      rate_limited: [...rate_limited],
      credits_exhausted: [...credits_exhausted],
      credits_remaining,
      credits_used,
    },
  };
}

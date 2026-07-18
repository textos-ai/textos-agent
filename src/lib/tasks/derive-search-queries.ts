// derive-search-queries — turns the business's OWN authoritative customer
// profile into buyer-voice search phrases. NOTHING here is hand-authored or
// hardcoded.
//
// Source hierarchy (first match wins for the narrative profile; target_customer
// is ALWAYS merged as the structured layer):
//   1. locked_cu     — the Customer Understanding profile the CU page currently
//                      shows, IF it is locked (a lock counts only when it is the
//                      current profile; a newer draft supersedes an old lock).
//   2. current_cu    — the current CU profile, even if unlocked.
//   3. locked_icp    — a locked ICP document (newest), if no CU profile exists.
//   4. icp_fallback  — the newest ICP document (last resort).
// The buyer-language section is pulled per source: CU "Voice & Language", or
// ICP "Where They Gather & Words They Use".
//
// FAIL LOUD: if the profile is too thin to derive real phrases, this THROWS
// (run → failed with a clear reason) rather than persisting an empty set.

import type { TaskCtx, TaskResult } from "./types";
import { renderPrompt } from "./generic-document-runner";
import { resolvePrompt } from "./prompt-resolver";
import { getTaskBySlug } from "../../services/supabase";

interface Phrase { text: string; rationale?: string }

interface DocData { title?: string; sections?: Array<{ heading?: string; body?: string }> }

interface SourceProfile {
  tier: "locked_cu" | "current_cu" | "locked_icp" | "icp_fallback" | "target_customer_only";
  asset_id: string | null;
  title: string | null;
  profile_text: string;
  language: string;
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

function flattenSections(ad: DocData | null): string {
  const secs = ad?.sections ?? [];
  return secs
    .map((s) => `## ${(s.heading ?? "").trim()}\n${(s.body ?? "").trim()}`)
    .filter((t) => t.trim())
    .join("\n\n")
    .trim();
}

function sectionBody(ad: DocData | null, re: RegExp): string {
  const hit = (ad?.sections ?? []).find((s) => re.test(s.heading ?? ""));
  return (hit?.body ?? "").trim();
}

/**
 * Resolve the single authoritative customer profile per the hierarchy above.
 * The CU "current" profile is the exact doc the page shows: the latest
 * customer-understanding run's asset (started_at DESC) — matching
 * routes/customer-understanding.ts. A lock counts only if it is on THAT doc.
 */
async function resolveSourceProfile(
  supabase: TaskCtx["supabase"],
  businessId: string,
): Promise<SourceProfile> {
  // 1/2. The CU page's CURRENT doc (latest CU run's asset).
  const cuTask = await getTaskBySlug(supabase, "customer-understanding");
  if (cuTask) {
    const { data: run } = await supabase
      .from("task_runs")
      .select("id")
      .eq("business_id", businessId)
      .eq("task_id", cuTask.id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run?.id) {
      const { data: asset } = await supabase
        .from("business_assets")
        .select("id, asset_data, metadata")
        .eq("business_id", businessId)
        .eq("task_run_id", (run as { id: string }).id)
        .eq("asset_type", "document")
        .maybeSingle();
      const ad = (asset?.asset_data as DocData | null) ?? null;
      if (asset && ad) {
        const locked = ((asset.metadata as Record<string, unknown> | null)?.is_locked) === true;
        return {
          tier: locked ? "locked_cu" : "current_cu",
          asset_id: asset.id as string,
          title: ad.title ?? null,
          profile_text: flattenSections(ad),
          language: sectionBody(ad, /voice\s*(&|and)?\s*language/i),
        };
      }
    }
  }

  // 3/4. ICP fallback — a locked ICP (newest) wins over a newer unlocked ICP.
  const { data: icps } = await supabase
    .from("business_assets")
    .select("id, asset_data, metadata, created_at")
    .eq("business_id", businessId)
    .eq("asset_type", "document")
    .eq("asset_subtype", "ideal-customer-profile-generator")
    .order("created_at", { ascending: false });
  const list = (icps ?? []) as Array<{ id: string; asset_data: DocData | null; metadata: Record<string, unknown> | null }>;
  const lockedIcp = list.find((a) => a.metadata?.is_locked === true);
  const chosen = lockedIcp ?? list[0] ?? null;
  if (chosen && chosen.asset_data) {
    return {
      tier: lockedIcp ? "locked_icp" : "icp_fallback",
      asset_id: chosen.id,
      title: chosen.asset_data.title ?? null,
      profile_text: flattenSections(chosen.asset_data),
      language: sectionBody(chosen.asset_data, /where they gather/i),
    };
  }

  // 5. No narrative profile — target_customer only.
  return { tier: "target_customer_only", asset_id: null, title: null, profile_text: "", language: "" };
}

const TIER_LABEL: Record<SourceProfile["tier"], string> = {
  locked_cu: "Customer Understanding profile (LOCKED — user-approved)",
  current_cu: "Customer Understanding profile (current)",
  locked_icp: "Ideal Customer Profile document (locked)",
  icp_fallback: "Ideal Customer Profile document (fallback)",
  target_customer_only: "structured target_customer only",
};

export async function runDeriveSearchQueries(tc: TaskCtx): Promise<TaskResult> {
  const { supabase, business, ctx, user, anthropic, models, emit, taskRunId } = tc;

  // Structured layer — always merged.
  const tcust = (ctx.target_customer as { description?: string } | null) ?? null;
  const description = (tcust?.description ?? "").trim();
  const hasDescription = description.length >= 20;

  // Narrative layer — the authoritative profile per the hierarchy.
  const src = await resolveSourceProfile(supabase, business.id);

  // FAIL LOUD on a thin profile — no silent empty set.
  if (!hasDescription && !src.profile_text) {
    throw new Error(
      "customer_profile_too_thin: cannot derive search phrases — needs a populated Customer " +
      "Understanding / ICP profile or a business_context.target_customer.description (>=20 chars). " +
      "Run the Customer Understanding step first.",
    );
  }

  const promptDef = await resolvePrompt(supabase, "derive-search-queries");
  const rendered = renderPrompt(promptDef.user_prompt_template, {
    business, ctx, user,
    profile_source: `${TIER_LABEL[src.tier]}${src.title ? ` — "${src.title}"` : ""}`,
    profile_text: src.profile_text || "(no narrative profile available)",
    language_section: src.language || "(no explicit voice/language section provided)",
  });
  const msg = await anthropic.messages.create({
    model: models.sonnet,
    max_tokens: 1000,
    system: promptDef.system_prompt ?? "",
    messages: [{ role: "user", content: rendered }],
  });

  let phrases: Phrase[] = [];
  try {
    const parsed = parseJson(messageText(msg));
    const arr = Array.isArray(parsed.phrases) ? parsed.phrases : [];
    phrases = arr
      .map((p) => {
        if (typeof p === "string") return { text: p.trim() };
        const o = p as { text?: unknown; rationale?: unknown };
        return { text: String(o.text ?? "").trim(), rationale: o.rationale ? String(o.rationale) : undefined };
      })
      .filter((p) => p.text.length > 0);
  } catch {
    phrases = [];
  }

  if (phrases.length === 0) {
    throw new Error(
      "derive_search_queries_empty: the model returned no usable search phrases from the " +
      "authoritative customer profile — refusing to persist an empty set.",
    );
  }

  const { error: insErr } = await supabase.from("lead_search_queries").insert({
    business_id: business.id,
    phrases,
    sources: {
      source_tier: src.tier,
      source_asset_id: src.asset_id,
      source_title: src.title,
      used_target_customer: hasDescription,
      used_language_section: src.language.length > 0,
    },
    task_run_id: taskRunId,
  });
  if (insErr) throw new Error(`lead_search_queries_insert_failed: ${insErr.message}`);

  await emit({
    type: "cmd",
    text: `Derived ${phrases.length} search phrase(s) from ${TIER_LABEL[src.tier]}`,
    ts: Date.now(),
  });

  return {
    output_data: {
      phrases_count: phrases.length,
      persisted: true,
      source_tier: src.tier,
      source_asset_id: src.asset_id,
      source_title: src.title,
      used_target_customer: hasDescription,
      used_language_section: src.language.length > 0,
    },
  };
}

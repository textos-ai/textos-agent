// find-my-customers — the one-click lead pipeline behind the Leads page's empty
// state. Runs the full chain IN-PROCESS on the queue's ~15-min budget:
//   derive → search → verify → understand → prepare outreach (draft + package)
//
// It writes a `current_stage` marker to task_runs.output_data (UNGATED) as it
// advances, so the Leads page can light up a real stage checklist — the marker
// survives the cosmetic 60s watchdog-fail (which no-ops the gated completion
// write). The final write sets current_stage='done' + pipeline_done=true.
//
// A thin profile fails LOUD at the derive step (customer_profile_too_thin
// bubbles up) — the page turns that into guidance, never a blank error.
//
// Scale note: a very large pool's enrichment tail can exceed one 15-min consumer
// window; per-lead commits persist and re-running continues. Fan-out is the
// scale fix.

import type { TaskCtx, TaskResult } from "./types";
import { runDeriveSearchQueries } from "./derive-search-queries";
import { runLeadSearch } from "./run-lead-search";
import { runMatchVerifyLeads } from "./match-verify-leads";
import { runDraftReply } from "./draft-reply";
import { runUnderstandLead } from "./understand-lead";
import { runReachPackageLead } from "./reach-package-lead";

/** Durable, ungated stage marker so the page checklist reflects the REAL stage. */
async function markStage(tc: TaskCtx, stage: string): Promise<void> {
  await tc.supabase
    .from("task_runs")
    .update({ output_data: { current_stage: stage, pipeline_done: false } })
    .eq("id", tc.taskRunId);
}

export async function runFindMyCustomers(tc: TaskCtx): Promise<TaskResult> {
  const { emit } = tc;

  // 1. Derive search phrases from the customer profile (loud on thin).
  await markStage(tc, "deriving");
  await runDeriveSearchQueries(tc);

  // 2. Search each platform for those phrases.
  await markStage(tc, "searching");
  const find = await runLeadSearch(tc);
  await emit({ type: "cmd", text: "Search complete — verifying matches", ts: Date.now() });

  // 3. Verify/score the found conversations.
  await markStage(tc, "verifying");
  const verify = await runMatchVerifyLeads(tc);

  // 4. Understand each person (alignment read) — before drafting, so the outreach
  //    is prepared with the alignment already in hand.
  await markStage(tc, "understanding");
  const understand = await runUnderstandLead(tc);

  // 5. Prepare outreach: draft the reply, then assemble the reach package.
  await markStage(tc, "preparing");
  const draft = await runDraftReply(tc);
  const reach = await runReachPackageLead(tc);

  await emit({ type: "cmd", text: "Leads ready", ts: Date.now() });

  const out = {
    current_stage: "done",
    pipeline_done: true,
    rate_limited: (find.output_data as { rate_limited?: string[] })?.rate_limited ?? [],
    credits_exhausted: (find.output_data as { credits_exhausted?: string[] })?.credits_exhausted ?? [],
    credits_remaining: (find.output_data as { credits_remaining?: number | null })?.credits_remaining ?? null,
    credits_used: (find.output_data as { credits_used?: number })?.credits_used ?? null,
    searched: (find.output_data as { phrases?: number })?.phrases ?? null,
    found: (find.output_data as { inserted?: number })?.inserted ?? null,
    verified: (verify.output_data as { verified?: number })?.verified ?? null,
    drafted: (draft.output_data as { drafted?: number })?.drafted ?? null,
    alignment_read: (understand.output_data as { enriched?: number })?.enriched ?? null,
    reach_packaged: (reach.output_data as { packaged?: number })?.packaged ?? null,
  };

  // Durable done-marker (ungated) — see header.
  await tc.supabase.from("task_runs").update({ output_data: out }).eq("id", tc.taskRunId);

  return { output_data: out };
}

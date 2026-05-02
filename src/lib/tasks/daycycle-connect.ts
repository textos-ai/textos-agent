import type { TaskCtx, TaskResult } from "./types";

// V1 stub: DayCycle location discovery.
// Full Google Places integration ships Sprint 8 (requires geolocation from frontend).
// This task runs as part of the free build to reserve the daycycle_locations asset slot.
export async function runDaycycleConnect(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, supabase, emit, taskRunId } = tc;

  await emit({
    type: "narrative",
    text: "Setting up DayCycle — your daily concierge for work, health, and life.",
    ts: Date.now(),
  });

  await emit({
    type: "cmd",
    text: "Staging DayCycle profile (location discovery available in Sprint 8)",
    ts: Date.now(),
  });

  const outputData = {
    status: "staged",
    note: "DayCycle location discovery activates in Sprint 8. Your profile is ready.",
    business_name: business.name,
    industry: ctx.industry ?? null,
  };

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "daycycle_locations",
      asset_subtype: "setup_stub",
      asset_data: outputData,
      metadata: {
        version: "v1_stub",
        google_places_ready: false,
        sprint: 8,
      },
    });
  } catch {
    // Non-fatal
  }

  return { output_data: outputData };
}

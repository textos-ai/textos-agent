import type { TaskCtx, TaskResult } from "./types";

export async function runTaskQueueBuilt(tc: TaskCtx): Promise<TaskResult> {
  const { business, supabase, emit, taskRunId } = tc;

  await emit({ type: "cmd", text: "Proposing tasks from strategy", ts: Date.now() });

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, slug, plan_required, is_default")
    .eq("status", "active");

  const defaultTasks = (tasks ?? []).filter((t) => t.is_default);
  const paidTasks = (tasks ?? []).filter(
    (t) => !t.is_default && (t.plan_required === "core_paid" || t.plan_required === "premium_only"),
  );

  await emit({
    type: "cmd",
    text: `Staging ${paidTasks.length} paid-bundle tasks for subscription`,
    ts: Date.now(),
  });

  const message = `${defaultTasks.length} free tasks complete. ${paidTasks.length} paid tasks staged — unlock with a subscription.`;

  const outputData = {
    free_tasks: defaultTasks.length,
    paid_tasks: paidTasks.length,
    total: (tasks ?? []).length,
    message,
  };

  // ── Write to business_assets ────────────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "task_queue_summary",
      asset_data: outputData,
      metadata: { free_tasks: defaultTasks.length, paid_tasks: paidTasks.length },
    });
  } catch {
    // Non-fatal
  }

  return { output_data: outputData };
}

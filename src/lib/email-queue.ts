import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Determines if cold emails should auto-send or queue for admin approval.
 *
 * During alpha (Sprint 5): threshold is 100 paying users. Until that count is
 * reached every cold email is queued for Rob's manual review at /admin/email-queue.
 * Auto-approval activates in production once the business has traction.
 *
 * Fails safe: any DB error → return false (queue for approval, never auto-send).
 */
export async function shouldAutoApprove(
  supabase: SupabaseClient,
  threshold: number = 100,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("user_subscriptions")
    .select("user_id", { count: "exact", head: true })
    .eq("status", "active");

  if (error) {
    console.error("[email-queue] Error counting paying users:", error.message);
    return false;
  }

  return (count ?? 0) >= threshold;
}

/**
 * Queues a cold email for admin approval (or marks approved if threshold reached).
 * Returns the queue entry ID and whether it was auto-approved.
 */
export async function queueColdEmail(
  supabase: SupabaseClient,
  threshold: number,
  email: {
    business_id: string;
    user_id: string;
    task_run_id?: string;
    to_email: string;
    to_name?: string;
    to_company?: string;
    to_role?: string;
    from_email?: string;
    subject: string;
    body: string;
  },
): Promise<{ id: string; auto_approved: boolean }> {
  const autoApprove = await shouldAutoApprove(supabase, threshold);

  const { data, error } = await supabase
    .from("email_queue")
    .insert({
      ...email,
      status: autoApprove ? "approved" : "pending",
      approved_at: autoApprove ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to queue cold email: ${error?.message ?? "unknown"}`);
  }

  return { id: data.id, auto_approved: autoApprove };
}

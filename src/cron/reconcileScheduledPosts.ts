// =============================================================
// Scheduled-post reconciler.
//
// Immediate publishing self-reconciles (publishPost polls Zernio within the
// live request). SCHEDULED posts fire later on Zernio's clock with no request
// from us — so without this, our DB never learns they published and they sit
// stale as status='scheduled' forever.
//
// This polls Zernio for every PAST-DUE still-'scheduled' content_asset and
// moves our row to its real terminal state. Idempotent: it only ever reads
// status='scheduled' past-due rows and guards every UPDATE with
// .eq('status','scheduled'), so a row already moved to published is never
// reprocessed and concurrent runs can't double-write.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPost } from "../services/zernio";
import { log } from "../lib/logger";

export interface ReconcileStats {
  checked: number;
  published: number;
  failed: number;
  pending: number;
  errors: number;
}

export async function runScheduledReconcile(
  supabase: SupabaseClient,
  apiKey: string | undefined,
): Promise<ReconcileStats> {
  const stats: ReconcileStats = { checked: 0, published: 0, failed: 0, pending: 0, errors: 0 };
  if (!apiKey) {
    log.error("[reconcile] no ZERNIO_API_KEY — skipping scheduled reconcile", {});
    return stats;
  }

  const nowIso = new Date().toISOString();
  // Due set = scheduled rows whose fire time has passed and that we handed to
  // Zernio (have a zernio_scheduled_id). Small by nature; cap defensively.
  const { data: due, error } = await supabase
    .from("content_assets")
    .select("id, scheduled_for, zernio_scheduled_id")
    .eq("status", "scheduled")
    .lt("scheduled_for", nowIso)
    .not("zernio_scheduled_id", "is", null)
    .order("scheduled_for", { ascending: true })
    .limit(200);

  if (error) {
    log.error("[reconcile] due_query_failed", { err: error.message });
    return stats;
  }
  const rows = (due ?? []) as Array<{ id: string; scheduled_for: string; zernio_scheduled_id: string }>;
  if (rows.length === 0) return stats;

  for (const row of rows) {
    stats.checked++;
    const res = await getPost(apiKey, row.zernio_scheduled_id);

    // ── Transport / lookup failures ──────────────────────────────────────
    if (!res.ok) {
      // 404 = the post no longer exists on Zernio (cancelled/expired). Surface
      // it as failed so it doesn't sit stale; everything else is a transient
      // error — leave the row scheduled and recheck next run.
      if ((res as { status?: number }).status === 404) {
        await supabase.from("content_assets")
          .update({ status: "failed" })
          .eq("id", row.id).eq("status", "scheduled");
        stats.failed++;
        log.error("[reconcile] zernio_post_not_found -> failed", { asset_id: row.id, zid: row.zernio_scheduled_id });
      } else {
        stats.errors++;
        log.error("[reconcile] getPost_error (left scheduled)", { asset_id: row.id, zid: row.zernio_scheduled_id, err: res.error });
      }
      continue;
    }

    // ── Zernio terminal/interim status ───────────────────────────────────
    const z = res.status; // Zernio post status on success
    if (z === "published") {
      // Zernio leaves publishedAt blank → use scheduled_for (the real fire
      // time, and it's ours). Carry the Zernio id as the published-post id.
      await supabase.from("content_assets")
        .update({ status: "published", published_at: row.scheduled_for, zernio_post_id: row.zernio_scheduled_id })
        .eq("id", row.id).eq("status", "scheduled");
      stats.published++;
    } else if (z === "failed" || z === "cancelled") {
      await supabase.from("content_assets")
        .update({ status: "failed" })
        .eq("id", row.id).eq("status", "scheduled");
      stats.failed++;
      log.error("[reconcile] zernio_status_terminal -> failed", { asset_id: row.id, zid: row.zernio_scheduled_id, z_status: z, msg: res.errorMessage });
    } else {
      // scheduled / pending / processing — not yet fired on Zernio's side.
      // Leave it; the next run rechecks.
      stats.pending++;
    }
  }

  log.info("[reconcile] scheduled_reconcile_done", stats as unknown as Record<string, unknown>);
  return stats;
}

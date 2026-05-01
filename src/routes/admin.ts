import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireAdmin } from "../lib/admin";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const admin = new Hono<{ Bindings: Env }>();

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

// ── GET /admin/email-queue ─────────────────────────────────────────────────
// Returns pending and recent emails in the queue (latest 100).
admin.get("/email-queue", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data: emails, error } = await supabase
    .from("email_queue")
    .select(
      "id, business_id, user_id, to_email, to_name, to_company, to_role, " +
      "subject, body, status, created_at, approved_at, sent_at, rejection_reason, " +
      "edited, edited_subject, edited_body",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    log.error("admin_email_queue_fetch_failed", { err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  return c.json({ emails: emails ?? [] });
});

// ── POST /admin/email-queue/:id/approve ───────────────────────────────────
admin.post("/email-queue/:id/approve", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user_id,
    })
    .eq("id", id)
    .eq("status", "pending");

  if (error) {
    log.error("admin_email_approve_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  // TODO Phase 3: enqueue SendGrid send job via Cloudflare Queue
  log.info("admin_email_approved", { id, approved_by: auth.user_id });
  return c.json({ ok: true });
});

// ── POST /admin/email-queue/:id/reject ────────────────────────────────────
admin.post("/email-queue/:id/reject", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");
  let reason: string | undefined;

  try {
    const body = await c.req.json<{ reason?: string }>();
    reason = body.reason;
  } catch {
    // reason is optional — ignore parse failures
  }

  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      status: "rejected",
      rejection_reason: reason ?? null,
      approved_by: auth.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending");

  if (error) {
    log.error("admin_email_reject_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  log.info("admin_email_rejected", { id, reason });
  return c.json({ ok: true });
});

// ── POST /admin/email-queue/:id/edit ──────────────────────────────────────
// Edit subject/body and immediately approve.
admin.post("/email-queue/:id/edit", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");

  let subject: string, body: string;
  try {
    const parsed = await c.req.json<{ subject: string; body: string }>();
    subject = parsed.subject;
    body = parsed.body;
    if (!subject || !body) throw new Error("subject and body required");
  } catch (err) {
    return c.json(
      errBody("bad_request", "body must include subject and body strings"),
      400,
    );
  }

  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      edited: true,
      edited_subject: subject,
      edited_body: body,
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user_id,
    })
    .eq("id", id);

  if (error) {
    log.error("admin_email_edit_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  log.info("admin_email_edited_approved", { id, approved_by: auth.user_id });
  return c.json({ ok: true });
});

export default admin;

// =============================================================
// TrustLight vetting admin API — the queue and the verification detail view.
// Mounted at /api/admin. Gated by requireAuth + requireAdmin.
//
//   GET   /api/admin/vetting-queue          filterable queue
//   GET   /api/admin/vetting/:id            one business, all nine checks
//   PATCH /api/admin/vetting/:id/checks     set check results + internal notes
//   POST  /api/admin/vetting/:id/status     change vetting_status (GATED)
//   POST  /api/admin/vetting/:id/publish    the separate publish toggle
//   POST  /api/admin/vetting/:id/enter      manual "Send for verification"
//   PATCH /api/admin/vetting/:id/profile    edit the published profile fields
//   GET   /api/admin/vetting/:id/preview    exactly what the public API returns
//
// Separate file from admin-coldcall.ts (already 1,185 lines) so the vetting
// surface stays grep-able as one unit. The rules themselves live in
// lib/trustlight-vetting.ts so no route can route around them.
//
// INTERNAL ONLY. Check notes, phone numbers and call history are readable
// here; none of it may reach routes/trustlight.ts. The two files share no
// column list on purpose.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireAdmin } from "../lib/admin";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";
import {
  VETTING_STATUSES, CHECK_KEYS, CHECK_LABELS, CHECK_RESULTS,
  VETTING_DETAIL_COLS, VETTING_QUEUE_COLS,
  countPasses, allNinePass, failingChecks, buildUniqueSlug, writeAudit, verificationStamps,
  enterVetting, VETTING_ENTRY_STATUS,
  type VettingStatus, type CheckKey,
} from "../lib/trustlight-vetting";
// The SAME shaping the public API uses. Importing it is what makes the preview
// below trustworthy — it is not a description of the public shape, it IS the
// public shape.
import {
  PROFILE_COLS, shapeVerified, shapeProfile, shapeUnvetted, visibilityOf,
  type VerifiedRow, type ProfileRow,
} from "../lib/trustlight-public";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);
app.use("*", requireAdmin);

const QUEUE_PAGE = 100;
const QUEUE_PAGE_MAX = 200;

// ── GET /api/admin/vetting-queue ───────────────────────────────────────────
// Filter by vetting_status. The working queue is status=in_verification,
// oldest first — that ordering is the point of the view, so it is the default
// sort for every status rather than something the caller has to remember.
//
// "Days in current status" is derived from the AUDIT LOG, not from updated_at:
// updated_at moves on any edit (a note, a price), so it would report the wrong
// number the moment an operator typed anything. The audit log records exactly
// when vetting_status last changed. A lead that has never moved has no audit
// row and reports null rather than a fabricated number.
app.get("/vetting-queue", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const status = c.req.query("status");
  if (status && !VETTING_STATUSES.includes(status as VettingStatus)) {
    return c.json(errBody("bad_request", `unknown vetting_status '${status}'`), 400);
  }

  const pageRaw = parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const sizeRaw = parseInt(c.req.query("page_size") ?? String(QUEUE_PAGE), 10);
  const pageSize = Math.min(QUEUE_PAGE_MAX, Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : QUEUE_PAGE);
  const from = (page - 1) * pageSize;

  const q = (c.req.query("q") ?? "").trim().replace(/[%,()]/g, "");

  let query = supabase
    .from("coldcall_leads")
    .select(VETTING_QUEUE_COLS, { count: "exact" })
    .order("updated_at", { ascending: true })   // oldest first
    .range(from, from + pageSize - 1);
  if (status) query = query.eq("vetting_status", status);
  if (q) query = query.ilike("name", `%${q}%`);

  const { data, count, error } = await query;
  if (error) {
    log.error("[vetting] queue_failed", { err: error.message });
    return c.json(errBody("internal", "queue_failed"), 500);
  }

  type Row = Record<string, unknown> & { id: string; vetting_status: string };
  const rows = (data ?? []) as unknown as Row[];

  // Most recent vetting_status change per lead, in ONE query for the page.
  const sinceByLead: Record<string, string> = {};
  if (rows.length) {
    const { data: audit, error: aErr } = await supabase
      .from("coldcall_vetting_audit")
      .select("lead_id, created_at")
      .eq("field", "vetting_status")
      .in("lead_id", rows.map((r) => r.id))
      .order("created_at", { ascending: false });
    if (aErr) {
      // Non-fatal: the queue is still usable without the age column.
      log.warn("[vetting] queue_audit_read_failed", { err: aErr.message });
    } else {
      for (const a of (audit ?? []) as Array<{ lead_id: string; created_at: string }>) {
        if (!sinceByLead[a.lead_id]) sinceByLead[a.lead_id] = a.created_at;
      }
    }
  }

  const now = Date.now();
  const leads = rows.map((r) => {
    const since = sinceByLead[r.id] ?? null;
    return {
      id: r.id,
      name: r.name,
      // The curated trade once it exists, else the scraped category.
      trade: (r.trade as string | null) || (r.category as string | null) || null,
      city: r.city,
      state: r.state,
      parish: r.parish,
      vetting_status: r.vetting_status,
      slug: r.slug,
      is_published: r.is_published,
      checks_passed: countPasses(r as unknown as Record<CheckKey, string | null>),
      checks_total: CHECK_KEYS.length,
      status_since: since,
      days_in_status: since ? Math.floor((now - new Date(since).getTime()) / 86400000) : null,
      verified_at: r.verified_at,
      expires_at: r.expires_at,
    };
  });

  return c.json({
    leads,
    total: count ?? 0,
    page,
    page_size: pageSize,
    has_more: from + leads.length < (count ?? 0),
    statuses: VETTING_STATUSES,
  });
});

// ── GET /api/admin/vetting/:id ─────────────────────────────────────────────
// One business: every check with its internal note, the published-profile
// fields, and the audit trail.
app.get("/vetting/:id", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("coldcall_leads").select(VETTING_DETAIL_COLS).eq("id", id).maybeSingle();
  if (error) {
    log.error("[vetting] detail_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "detail_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  const lead = data as unknown as Record<string, unknown>;

  const { data: audit, error: aErr } = await supabase
    .from("coldcall_vetting_audit")
    .select("id, field, old_value, new_value, reason, actor_email, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (aErr) log.warn("[vetting] detail_audit_failed", { lead_id: id, err: aErr.message });

  const passes = countPasses(lead as Record<CheckKey, string | null>);
  return c.json({
    lead,
    checks: CHECK_KEYS.map((k) => ({
      key: k,
      label: CHECK_LABELS[k],
      result: (lead[k] as string | null) ?? null,
      note: (lead[`${k}_note`] as string | null) ?? null,
    })),
    checks_passed: passes,
    checks_total: CHECK_KEYS.length,
    can_verify: allNinePass(lead as Record<CheckKey, string | null>),
    blocking: failingChecks(lead as Record<CheckKey, string | null>),
    audit: audit ?? [],
    statuses: VETTING_STATUSES,
    results: CHECK_RESULTS,
  });
});

// ── PATCH /api/admin/vetting/:id/checks ────────────────────────────────────
// Set one or more check results and/or their internal notes.
//
// Setting a check does NOT change vetting_status — promoting to verified is a
// separate, deliberate call. Clearing a check back to null is allowed (an
// operator can undo a misclick); passing an unknown key or result is a 400
// rather than a silent no-op.
app.patch("/vetting/:id/checks", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const patch: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(body)) {
    const isResult = (CHECK_KEYS as readonly string[]).includes(k);
    const isNote = k.endsWith("_note") && (CHECK_KEYS as readonly string[]).includes(k.slice(0, -5));
    if (!isResult && !isNote) {
      return c.json(errBody("bad_request", `unknown field '${k}'`), 400);
    }
    if (isResult) {
      if (v !== null && !(CHECK_RESULTS as readonly string[]).includes(String(v))) {
        return c.json(errBody("bad_request", `${k} must be one of pass|fail|na|null`), 400);
      }
      patch[k] = v === null ? null : String(v);
    } else {
      // Notes are INTERNAL. They are never read by routes/trustlight.ts.
      patch[k] = v === null || String(v).trim() === "" ? null : String(v).trim();
    }
  }
  if (!Object.keys(patch).length) {
    return c.json(errBody("bad_request", "no check fields supplied"), 400);
  }
  patch.chk_last_run = new Date().toISOString();

  const { data, error } = await supabase
    .from("coldcall_leads").update(patch).eq("id", id)
    .select(VETTING_DETAIL_COLS).maybeSingle();
  if (error) {
    log.error("[vetting] checks_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "checks_update_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  const lead = data as unknown as Record<string, unknown>;
  return c.json({
    lead,
    checks_passed: countPasses(lead as Record<CheckKey, string | null>),
    checks_total: CHECK_KEYS.length,
    can_verify: allNinePass(lead as Record<CheckKey, string | null>),
    blocking: failingChecks(lead as Record<CheckKey, string | null>),
  });
});

// ── POST /api/admin/vetting/:id/status ─────────────────────────────────────
// Change vetting_status. THE GATE LIVES HERE.
//
// Promoting to 'verified' re-reads the row and re-tests all nine inside this
// request — it never trusts a flag the client sent, and never trusts a value
// the UI computed. Every change is written to the append-only audit log.
app.post("/vetting/:id/status", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { vetting_status?: unknown; reason?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const next = String(body.vetting_status ?? "");
  if (!VETTING_STATUSES.includes(next as VettingStatus)) {
    return c.json(errBody("bad_request", `vetting_status must be one of ${VETTING_STATUSES.join("|")}`), 400);
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  const { data: current, error: cErr } = await supabase
    .from("coldcall_leads").select(VETTING_DETAIL_COLS).eq("id", id).maybeSingle();
  if (cErr) {
    log.error("[vetting] status_read_failed", { lead_id: id, err: cErr.message });
    return c.json(errBody("internal", "status_read_failed"), 500);
  }
  if (!current) return c.json(errBody("not_found", "lead not found"), 404);

  const lead = current as unknown as Record<string, unknown>;
  const prev = String(lead.vetting_status ?? "");
  const patch: Record<string, unknown> = { vetting_status: next };

  if (next === "verified") {
    // THE GATE. Re-tested server-side against the row as it is right now.
    if (!allNinePass(lead as Record<CheckKey, string | null>)) {
      const blocking = failingChecks(lead as Record<CheckKey, string | null>);
      log.warn("[vetting] verify_blocked", { lead_id: id, blocking });
      return c.json(errBody(
        "conflict",
        `cannot verify: ${blocking.length} of ${CHECK_KEYS.length} checks are not 'pass'`,
        { blocking, checks_passed: countPasses(lead as Record<CheckKey, string | null>) },
      ), 409);
    }
    const name = String(lead.trading_name || lead.legal_name || lead.name || "").trim();
    if (!name) {
      return c.json(errBody("bad_request", "cannot verify: the business has no name to publish"), 400);
    }
    Object.assign(patch, verificationStamps());
    if (!lead.slug) {
      try {
        patch.slug = await buildUniqueSlug(supabase, name, id);
      } catch (err) {
        log.error("[vetting] slug_failed", { lead_id: id, err: err instanceof Error ? err.message : String(err) });
        return c.json(errBody("internal", "slug_generation_failed"), 500);
      }
    }
  }

  // Leaving 'verified' must not leave a live public listing behind. Anything
  // that is not 'verified' is invisible to the public API anyway; unpublishing
  // makes the admin view agree with what the world can see.
  if (prev === "verified" && next !== "verified") patch.is_published = false;

  const { data: updated, error: uErr } = await supabase
    .from("coldcall_leads").update(patch).eq("id", id)
    .select(VETTING_DETAIL_COLS).maybeSingle();
  if (uErr) {
    log.error("[vetting] status_update_failed", { lead_id: id, err: uErr.message });
    return c.json(errBody("internal", "status_update_failed"), 500);
  }

  const audit = await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "vetting_status", old_value: prev, new_value: next, reason,
  });
  if (!audit.ok) {
    // Surfaced, never swallowed: an unrecorded verification decision defeats
    // the purpose of the paper trail.
    log.error("[vetting] audit_write_failed", { lead_id: id, err: audit.message });
  }

  log.info("[vetting] status_changed", { lead_id: id, from: prev, to: next, by: auth.email });
  const l = updated as unknown as Record<string, unknown>;
  return c.json({
    lead: l,
    checks_passed: countPasses(l as Record<CheckKey, string | null>),
    checks_total: CHECK_KEYS.length,
    can_verify: allNinePass(l as Record<CheckKey, string | null>),
    audit_recorded: audit.ok,
  });
});

// ── POST /api/admin/vetting/:id/publish ────────────────────────────────────
// The publish toggle, deliberately separate from verification: an operator can
// finish the checks and still choose when the profile goes live. Publishing is
// what the public read honours, so it is gated on being verified — publishing
// an unverified business is the one thing this product must never do.
app.post("/vetting/:id/publish", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { is_published?: unknown; reason?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  if (typeof body.is_published !== "boolean") {
    return c.json(errBody("bad_request", "is_published must be a boolean"), 400);
  }
  const wanted = body.is_published;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  const { data: current, error: cErr } = await supabase
    .from("coldcall_leads")
    .select("id, vetting_status, is_published, slug, expires_at")
    .eq("id", id).maybeSingle();
  if (cErr) {
    log.error("[vetting] publish_read_failed", { lead_id: id, err: cErr.message });
    return c.json(errBody("internal", "publish_read_failed"), 500);
  }
  if (!current) return c.json(errBody("not_found", "lead not found"), 404);
  const row = current as unknown as { vetting_status: string; is_published: boolean; slug: string | null; expires_at: string | null };

  if (wanted) {
    if (row.vetting_status !== "verified") {
      return c.json(errBody("conflict", "cannot publish: the business is not verified"), 409);
    }
    if (!row.slug) {
      return c.json(errBody("conflict", "cannot publish: no slug — re-run verification"), 409);
    }
    if (!row.expires_at || new Date(row.expires_at) <= new Date()) {
      return c.json(errBody("conflict", "cannot publish: verification has expired"), 409);
    }
  }

  const { error: uErr } = await supabase
    .from("coldcall_leads").update({ is_published: wanted }).eq("id", id);
  if (uErr) {
    log.error("[vetting] publish_update_failed", { lead_id: id, err: uErr.message });
    return c.json(errBody("internal", "publish_update_failed"), 500);
  }

  const audit = await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "is_published", old_value: String(row.is_published), new_value: String(wanted), reason,
  });
  if (!audit.ok) log.error("[vetting] audit_write_failed", { lead_id: id, err: audit.message });

  log.info("[vetting] publish_changed", { lead_id: id, to: wanted, by: auth.email });
  return c.json({
    id, is_published: wanted, slug: row.slug,
    public_url: wanted && row.slug ? `/contractor/${row.slug}` : null,
    audit_recorded: audit.ok,
  });
});

// ── POST /api/admin/vetting/:id/enter ──────────────────────────────────────
// The MANUAL entry point — the "Send for verification" button on the lead.
//
// Exists alongside the automatic trustlight-signup hook because verification
// often starts without a billing event: a business asks about it on a call, or
// it is a comped listing in the free-vetting campaign that never "signs up" in
// the billing sense at all.
//
// A dedicated endpoint rather than a plain status change, so the
// "only from 'lead'" precondition is enforced here and not merely by a hidden
// button. Clicking twice, or on a business already being worked, is a 409.
app.post("/vetting/:id/enter", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { reason?: unknown } = {};
  try { body = await c.req.json(); } catch { /* body is optional here */ }
  const extra = typeof body.reason === "string" && body.reason.trim() ? ` — ${body.reason.trim()}` : "";

  const entered = await enterVetting(
    supabase, id, `manual: ${auth.email ?? auth.user_id}${extra}`,
    { user_id: auth.user_id, email: auth.email },
  );

  if (!entered.ok) {
    log.error("[vetting] manual_entry_failed", { lead_id: id, err: entered.message });
    if (entered.message === "lead not found") return c.json(errBody("not_found", "lead not found"), 404);
    return c.json(errBody("internal", "vetting_entry_failed"), 500);
  }
  if (!entered.moved) {
    return c.json(errBody(
      "conflict",
      `already in vetting (status: ${entered.current}) — nothing to send`,
      { current: entered.current },
    ), 409);
  }

  log.info("[vetting] manual_entry", { lead_id: id, to: entered.to, by: auth.email });
  return c.json({
    id, vetting_status: entered.to, moved: true,
    audit_recorded: entered.audit_recorded,
  });
});

// ── The published profile ──────────────────────────────────────────────────
// Editable fields, with their validators. Anything not on this list cannot be
// written here — an unknown field is a 400, not a silent no-op, so a typo in
// the editor surfaces instead of quietly failing to save.
//
// These are PUBLISHED CLAIMS about a real business. The validators are
// deliberately strict about shape (a rating outside 0-5, a DTI outside 0-100,
// a 3-letter state) because a malformed claim on a trust badge is worse than
// a rejected edit.
const PROFILE_FIELDS = {
  legal_name:         { type: "text",  max: 200 },
  trading_name:       { type: "text",  max: 200 },
  trade:              { type: "text",  max: 80 },
  city:               { type: "text",  max: 120 },
  state:              { type: "state" },
  parish:             { type: "text",  max: 120 },   // the brief's county_parish
  license_number:     { type: "text",  max: 80 },
  license_state:      { type: "state" },
  gl_carrier:         { type: "text",  max: 160 },
  years_in_business:  { type: "int",   min: 0, max: 200 },
  blurb:              { type: "text",  max: 400 },
  services:           { type: "array", max: 25, itemMax: 80 },
  rating:             { type: "num",   min: 0, max: 5 },
  review_count:       { type: "int",   min: 0, max: 1000000 },
  dti_score:          { type: "int",   min: 0, max: 100 },
  dti_findability:    { type: "int",   min: 0, max: 100 },
  dti_answerability:  { type: "int",   min: 0, max: 100 },
  dti_responsiveness: { type: "int",   min: 0, max: 100 },
  dti_completeness:   { type: "int",   min: 0, max: 100 },
  dti_compliance:     { type: "int",   min: 0, max: 100 },
} as const;

type FieldSpec = { type: string; max?: number; min?: number; itemMax?: number };

function coerceProfileField(key: string, raw: unknown, spec: FieldSpec):
  { ok: true; value: unknown } | { ok: false; message: string } {
  // null or "" clears a field — an operator must be able to remove a claim.
  if (raw === null || raw === "") return { ok: true, value: null };

  if (spec.type === "text") {
    const v = String(raw).trim();
    if (spec.max && v.length > spec.max) return { ok: false, message: `${key} must be ${spec.max} characters or fewer` };
    return { ok: true, value: v || null };
  }
  if (spec.type === "state") {
    const v = String(raw).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(v)) return { ok: false, message: `${key} must be a 2-letter state code` };
    return { ok: true, value: v };
  }
  if (spec.type === "int" || spec.type === "num") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { ok: false, message: `${key} must be a number` };
    if (spec.type === "int" && !Number.isInteger(n)) return { ok: false, message: `${key} must be a whole number` };
    if (spec.min !== undefined && n < spec.min) return { ok: false, message: `${key} must be at least ${spec.min}` };
    if (spec.max !== undefined && n > spec.max) return { ok: false, message: `${key} must be at most ${spec.max}` };
    return { ok: true, value: spec.type === "num" ? Math.round(n * 10) / 10 : n };
  }
  if (spec.type === "array") {
    const arr = Array.isArray(raw) ? raw : String(raw).split("\n").map((x) => x.trim()).filter(Boolean);
    if (spec.max && arr.length > spec.max) return { ok: false, message: `${key} may have at most ${spec.max} entries` };
    const out: string[] = [];
    for (const item of arr) {
      const v = String(item).trim();
      if (!v) continue;
      if (spec.itemMax && v.length > spec.itemMax) {
        return { ok: false, message: `each ${key} entry must be ${spec.itemMax} characters or fewer` };
      }
      out.push(v);
    }
    return { ok: true, value: out.length ? out : null };
  }
  return { ok: false, message: `${key} has no validator` };
}

// ── PATCH /api/admin/vetting/:id/profile ───────────────────────────────────
// Edit the published profile. Editable at ANY vetting_status by design — the
// profile is usually written while the checks are still being worked, and
// nothing here is public until verified + published anyway.
app.patch("/vetting/:id/profile", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const patch: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(body)) {
    const spec = (PROFILE_FIELDS as Record<string, FieldSpec>)[k];
    if (!spec) return c.json(errBody("bad_request", `'${k}' is not an editable profile field`), 400);
    const r = coerceProfileField(k, raw, spec);
    if (!r.ok) return c.json(errBody("bad_request", r.message), 400);
    patch[k] = r.value;
  }
  if (!Object.keys(patch).length) {
    return c.json(errBody("bad_request", "no profile fields supplied"), 400);
  }

  const { data, error } = await supabase
    .from("coldcall_leads").update(patch).eq("id", id)
    .select(VETTING_DETAIL_COLS).maybeSingle();
  if (error) {
    log.error("[vetting] profile_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "profile_update_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  log.info("[vetting] profile_updated", { lead_id: id, fields: Object.keys(patch), by: auth.email });
  return c.json({ lead: data as unknown as Record<string, unknown>, updated: Object.keys(patch) });
});

// ── GET /api/admin/vetting/:id/preview ─────────────────────────────────────
// EXACTLY what the public API would return for this record, produced by the
// same functions routes/trustlight.ts calls — not a description of them.
//
// It renders the shape even when the record is NOT publicly visible, and says
// why, so an operator can write the profile before verification and see what
// it will look like. `visible: false` plus the list of blockers is the signal
// that these edits are not live yet.
app.get("/vetting/:id/preview", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select(`${PROFILE_COLS}, id, vetting_status, is_published, category`)
    .eq("id", id).maybeSingle();
  if (error) {
    log.error("[vetting] preview_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "preview_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  const row = data as unknown as ProfileRow & {
    vetting_status?: unknown; is_published?: unknown; category: string | null; name: string | null;
  };
  const vis = visibilityOf(row);

  return c.json({
    visibility: {
      visible: vis.visible,
      blockers: vis.blockers,
      // Where it WOULD appear once visible. featured is additionally subject
      // to the one-per-trade pass, so it is "eligible", not "guaranteed".
      appears_in: vis.visible
        ? { featured: "eligible (one per trade)", search: "yes", profile: `/contractor/${String(row.slug)}` }
        : { featured: "no", search: "no", profile: "404" },
    },
    // The 12-field card, as /featured and /search would emit it.
    card: shapeVerified(row as VerifiedRow),
    // The full profile, as /contractor/:slug would emit it.
    profile: shapeProfile(row),
    // How this business reads in the unvetted list — which is what the public
    // sees TODAY while it is not verified.
    unvetted_entry: shapeUnvetted({
      name: row.name, category: row.category, city: row.city, state: row.state,
    }),
    editable_fields: Object.keys(PROFILE_FIELDS),
  });
});

export default app;


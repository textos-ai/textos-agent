// =============================================================
// Coldcall admin API — caller management + bulk lead assignment.
// Mounted at /api/admin. Gated by requireAuth + requireAdmin (users.is_admin).
//
//   GET  /api/admin/coldcall-callers                   list the access list
//   POST /api/admin/users/:id/coldcall-access          grant/revoke for one user
//   GET  /api/admin/coldcall-leads                     browse/filter leads
//   POST /api/admin/coldcall-leads/assign              hand-pick assign/reassign/unassign
//   POST /api/admin/coldcall-leads/assign-split        even split across callers
//
// Access is granted from ONE place: the checkbox on /admin/users, which calls
// the per-user route above. There is deliberately no grant-by-email endpoint —
// a second grant path is a second thing to keep in sync.
//
// Callers never see these routes — the caller-facing surface is
// /api/coldcall/* (see routes/coldcall.ts), which is gated on
// coldcall_callers membership and exposes no management controls.
//
// Separate file from routes/admin.ts on purpose: the coldcall module stays
// grep-able as one unit and imports nothing from business route or task code.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireAdmin } from "../lib/admin";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);
app.use("*", requireAdmin);

// Supabase caps a single select at 1000 rows; page through in these chunks.
const PAGE_SIZE = 1000;
// Chunk size for `.in()` filters so the PATCH query string stays sane.
const UPDATE_CHUNK = 100;

// A conservative shape check — the DB's UNIQUE + lowercase CHECK is the real
// guard, this just returns a clean 400 instead of a 502 on obvious garbage.
function isEmailish(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// Lead-browser page size, and the ceiling on one hand-pick assignment.
const BROWSE_PAGE = 100;
const BROWSE_PAGE_MAX = 200;
const ASSIGN_MAX = 5000;

const LEAD_STATUSES = [
  "new", "contacted", "callback", "meeting", "not_interested", "bad_number",
] as const;

// Columns the admin lead browser renders. Includes the enrichment signals that
// are the actual reason to hand-pick — a hijacked domain or a missing website
// is a "call this one now" flag independent of call_score.
const BROWSE_COLS =
  "id, name, phone, category, parish, market, rating, review_count, call_score, " +
  "status, callable, assigned_to, hijack_flag, has_website, site_state, ai_voice_agent";

// ── GET /api/admin/coldcall-callers ────────────────────────────────────────
// The full access list. `signed_in` reports whether user_id has been
// backfilled yet — INFORMATIONAL ONLY, never a gate on access.
app.get("/coldcall-callers", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("coldcall_callers")
    .select("id, email, name, user_id, active, created_at, updated_at")
    .order("created_at", { ascending: true });

  if (error) {
    log.error("[coldcall-admin] callers_list_failed", { err: error.message });
    return c.json(errBody("internal", "callers_list_failed"), 500);
  }

  type CallerRow = {
    id: string;
    email: string;
    name: string | null;
    user_id: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
  };
  const callers = ((data ?? []) as CallerRow[]).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    active: r.active,
    signed_in: r.user_id !== null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  // Assigned-lead counts per caller, so the admin page can show the split
  // without a second call. Paged: the book can exceed 1000 rows.
  const assigned: Record<string, number> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageErr } = await supabase
      .from("coldcall_leads")
      .select("assigned_to")
      .not("assigned_to", "is", null)
      .range(from, from + PAGE_SIZE - 1);
    if (pageErr) {
      log.error("[coldcall-admin] assigned_counts_failed", { err: pageErr.message });
      return c.json(errBody("internal", "assigned_counts_failed"), 500);
    }
    const rows = (page ?? []) as Array<{ assigned_to: string }>;
    for (const r of rows) assigned[r.assigned_to] = (assigned[r.assigned_to] ?? 0) + 1;
    if (rows.length < PAGE_SIZE) break;
  }

  // The pool available to split right now.
  const { count: unassignedCount, error: unErr } = await supabase
    .from("coldcall_leads")
    .select("id", { count: "exact", head: true })
    .is("assigned_to", null)
    .eq("callable", true);
  if (unErr) {
    log.error("[coldcall-admin] unassigned_count_failed", { err: unErr.message });
    return c.json(errBody("internal", "unassigned_count_failed"), 500);
  }

  return c.json({
    callers: callers.map((r) => ({ ...r, assigned_leads: assigned[r.id] ?? 0 })),
    unassigned_callable: unassignedCount ?? 0,
  });
});

// ── POST /api/admin/users/:id/coldcall-access ───────────────────────
// The ONE place cold-call access is granted or revoked — the checkbox on
// /admin/users. Body: { active: boolean }, keyed on the Victora user id.
//
// Upserts rather than inserts: the row is matched on user_id first, then on
// email, so re-checking a box for someone who already has a row updates it
// instead of colliding with the unique email index.
//
// On REVOKE, that caller's status='new' leads go back to the unassigned pool
// so they can be re-split. Leads in any other status stay attached, so worked
// history still reads correctly.
app.post("/users/:id/coldcall-access", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const userId = c.req.param("id");

  let body: { active?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  if (typeof body.active !== "boolean") {
    return c.json(errBody("bad_request", "active must be a boolean"), 400);
  }
  const active = body.active;

  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("id, email, name")
    .eq("id", userId)
    .maybeSingle();
  if (userErr) {
    log.error("[coldcall-admin] user_lookup_failed", { user_id: userId, err: userErr.message });
    return c.json(errBody("internal", "user_lookup_failed"), 500);
  }
  if (!userRow) return c.json(errBody("not_found", "user not found"), 404);

  const user = userRow as { id: string; email: string | null; name: string | null };

  // No-fallbacks: coldcall_callers.email is NOT NULL and the gate matches on
  // it. Anonymous pre-signup rows (migration 078) have no email and cannot be
  // granted access — the UI disables their checkbox, this is the backstop.
  const email = user.email?.trim().toLowerCase() || null;
  if (!email) {
    return c.json(
      errBody("bad_request", "user has no email address and cannot be granted cold-call access"),
      400,
    );
  }
  if (!isEmailish(email)) {
    return c.json(errBody("bad_request", `stored email '${email}' is not usable`), 400);
  }

  // Find any existing row for this person — by link first, then by email.
  const byId = await supabase
    .from("coldcall_callers").select("id").eq("user_id", userId).maybeSingle();
  if (byId.error) {
    log.error("[coldcall-admin] caller_lookup_failed", { user_id: userId, err: byId.error.message });
    return c.json(errBody("internal", "caller_lookup_failed"), 500);
  }
  let existingId = (byId.data as { id: string } | null)?.id ?? null;

  if (!existingId) {
    const byEmail = await supabase
      .from("coldcall_callers").select("id").eq("email", email).maybeSingle();
    if (byEmail.error) {
      log.error("[coldcall-admin] caller_lookup_failed", { email, err: byEmail.error.message });
      return c.json(errBody("internal", "caller_lookup_failed"), 500);
    }
    existingId = (byEmail.data as { id: string } | null)?.id ?? null;
  }

  let callerId: string;
  if (existingId) {
    const { data: upd, error: updErr } = await supabase
      .from("coldcall_callers")
      .update({ active, user_id: userId, email, name: user.name })
      .eq("id", existingId)
      .select("id")
      .single();
    if (updErr || !upd) {
      log.error("[coldcall-admin] caller_update_failed", { caller_id: existingId, err: updErr?.message });
      return c.json(errBody("internal", "caller_update_failed"), 500);
    }
    callerId = (upd as { id: string }).id;
  } else {
    const { data: ins, error: insErr } = await supabase
      .from("coldcall_callers")
      .insert({ email, name: user.name, user_id: userId, active })
      .select("id")
      .single();
    if (insErr || !ins) {
      log.error("[coldcall-admin] caller_insert_failed", { email, err: insErr?.message });
      return c.json(errBody("internal", "caller_insert_failed"), 500);
    }
    callerId = (ins as { id: string }).id;
  }

  let released = 0;
  if (!active) {
    const { data: rel, error: relErr } = await supabase
      .from("coldcall_leads")
      .update({ assigned_to: null })
      .eq("assigned_to", callerId)
      .eq("status", "new")
      .select("id");
    if (relErr) {
      log.error("[coldcall-admin] release_failed", { caller_id: callerId, err: relErr.message });
      return c.json(errBody("internal", "release_failed"), 500);
    }
    released = (rel ?? []).length;
  }

  log.info("[coldcall-admin] access_toggled", { user_id: userId, caller_id: callerId, active, released });
  return c.json({ caller_id: callerId, email, active, released_leads: released });
});

// ── GET /api/admin/coldcall-leads ──────────────────────────────────────────
// The hand-pick browser. Filters: q (name), market, parish, category, status,
// assigned (unassigned | any | <caller_id>), callable (all | only | not), and
// the enrichment chips: hijack, no_website, dead_site, no_voice.
//
// Non-callable leads are RETURNED, not hidden — the point is to be able to see
// why a lead is in nobody's book. The assign endpoint refuses them, and the UI
// renders their checkbox disabled.
app.get("/coldcall-leads", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const pageRaw = parseInt(c.req.query("page") ?? "1", 10);
  const sizeRaw = parseInt(c.req.query("page_size") ?? String(BROWSE_PAGE), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Math.min(
    BROWSE_PAGE_MAX,
    Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : BROWSE_PAGE,
  );

  const status = c.req.query("status");
  if (status && !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
    return c.json(errBody("bad_request", `unknown status '${status}'`), 400);
  }

  // Free-text name match. Strip the characters that would break PostgREST's
  // filter grammar rather than interpolating them into the query.
  const search = (c.req.query("q") ?? "").trim().replace(/[%,()]/g, "");
  const assigned = c.req.query("assigned");
  const callable = c.req.query("callable");

  // Every filter lives here so the row query and the ids_only query can never
  // drift apart — "select all N matching" must mean the same N the table shows.
  const withFilters = <T extends { ilike: Function; eq: Function; is: Function }>(qq: T): T => {
    let x = qq as T & Record<string, Function>;
    if (search) x = x.ilike("name", `%${search}%`);
    for (const [param, col] of [
      ["market", "market"], ["parish", "parish"],
      ["category", "category"], ["status", "status"],
    ] as const) {
      const v = c.req.query(param);
      if (v) x = x.eq(col, v);
    }
    // assigned: 'unassigned' | 'any' | a caller id
    if (assigned === "unassigned") x = x.is("assigned_to", null);
    else if (assigned && assigned !== "any") x = x.eq("assigned_to", assigned);

    if (callable === "only") x = x.eq("callable", true);
    else if (callable === "not") x = x.eq("callable", false);

    // Enrichment chips. Each tests for a VERIFIED value, never NULL — NULL
    // means the lead was never probed, which is not evidence of anything.
    if (c.req.query("hijack") === "1") x = x.eq("hijack_flag", true);
    if (c.req.query("no_website") === "1") x = x.eq("has_website", false);
    if (c.req.query("dead_site") === "1") x = x.eq("site_state", "dead_http_error");
    if (c.req.query("no_voice") === "1") x = x.eq("ai_voice_agent", false);
    return x as T;
  };

  // facets=1 returns the distinct market / parish / category values so the UI
  // can build real dropdowns. PostgREST has no DISTINCT, so this pages the
  // three columns and dedupes here. Deliberately IGNORES the current filters —
  // the option lists must not shrink as you narrow the search — and the UI
  // requests it once per page load, not on every filter change.
  if (c.req.query("facets") === "1") {
    const markets = new Set<string>();
    const parishes = new Set<string>();
    const categories = new Set<string>();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("coldcall_leads")
        .select("market, parish, category")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        log.error("[coldcall-admin] facets_failed", { err: error.message });
        return c.json(errBody("internal", "facets_failed"), 500);
      }
      const rows = (data ?? []) as Array<{ market: string | null; parish: string | null; category: string | null }>;
      for (const r of rows) {
        if (r.market) markets.add(r.market);
        if (r.parish) parishes.add(r.parish);
        if (r.category) categories.add(r.category);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    const sorted = (s: Set<string>) => [...s].sort();
    return c.json({
      markets: sorted(markets),
      parishes: sorted(parishes),
      categories: sorted(categories),
      statuses: LEAD_STATUSES,
    });
  }

  // ids_only powers "select all N matching": same filters, ids only, paged
  // server-side up to ASSIGN_MAX (which is also the assign ceiling).
  if (c.req.query("ids_only") === "1") {
    const ids: string[] = [];
    let total = 0;
    for (let from = 0; from < ASSIGN_MAX; from += PAGE_SIZE) {
      const base = supabase
        .from("coldcall_leads")
        .select("id", { count: "exact" })
        .order("call_score", { ascending: false })
        .order("id", { ascending: true })
        .range(from, Math.min(from + PAGE_SIZE, ASSIGN_MAX) - 1);
      const { data, count, error } = await withFilters(base);
      if (error) {
        log.error("[coldcall-admin] browse_ids_failed", { err: error.message });
        return c.json(errBody("internal", "browse_ids_failed"), 500);
      }
      total = count ?? 0;
      const rows = (data ?? []) as Array<{ id: string }>;
      ids.push(...rows.map((r) => r.id));
      if (rows.length < PAGE_SIZE) break;
    }
    return c.json({ ids, total, capped: total > ids.length });
  }

  const from = (page - 1) * pageSize;
  const base = supabase
    .from("coldcall_leads")
    .select(BROWSE_COLS, { count: "exact" })
    .order("call_score", { ascending: false })
    .order("id", { ascending: true }) // stable across pages
    .range(from, from + pageSize - 1);

  const { data, count, error } = await withFilters(base);
  if (error) {
    log.error("[coldcall-admin] browse_failed", { err: error.message });
    return c.json(errBody("internal", "browse_failed"), 500);
  }

  const total = count ?? 0;
  return c.json({
    leads: data ?? [],
    total,
    page,
    page_size: pageSize,
    has_more: from + (data ?? []).length < total,
  });
});

// ── GET /api/admin/coldcall-leads/:id ──────────────────────────────────────
// Everything on one lead, for the admin detail modal. Returns the FULL row
// (select *) rather than a column list, so a future migration's columns show
// up in the modal without a code change here.
//
// Read-only. The modal never writes; assignment stays with the assign endpoint.
app.get("/coldcall-leads/:id", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  const { data: lead, error } = await supabase
    .from("coldcall_leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    log.error("[coldcall-admin] lead_detail_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "lead_detail_failed"), 500);
  }
  if (!lead) return c.json(errBody("not_found", "lead not found"), 404);

  // Call history, newest first, with the caller resolved so the modal reads
  // "who called this" rather than showing a bare uuid.
  const { data: activity, error: actErr } = await supabase
    .from("coldcall_call_activity")
    .select("id, outcome, note, created_at, caller_id, coldcall_callers(name, email)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  if (actErr) {
    log.error("[coldcall-admin] lead_activity_failed", { lead_id: id, err: actErr.message });
    return c.json(errBody("internal", "lead_activity_failed"), 500);
  }

  // Who currently holds it, if anyone.
  let assignee: { id: string; name: string | null; email: string; active: boolean } | null = null;
  const assignedTo = (lead as { assigned_to: string | null }).assigned_to;
  if (assignedTo) {
    const { data: a } = await supabase
      .from("coldcall_callers")
      .select("id, name, email, active")
      .eq("id", assignedTo)
      .maybeSingle();
    assignee = (a as typeof assignee) ?? null;
  }

  return c.json({ lead, activity: activity ?? [], assignee });
});

// ── PATCH /api/admin/coldcall-leads/:id/settings ───────────────────────────
// Per-lead script settings: the monthly price and which of the three services
// the pitch mentions. The script is generated from these, so changing them
// here changes what the caller reads — no script text is ever edited.
//
// Partial update: only the keys present in the body are written, so toggling
// one service cannot silently reset the price.
app.patch("/coldcall-leads/:id/settings", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const patch: Record<string, unknown> = {};

  if ("script_price_monthly" in body) {
    const raw = body.script_price_monthly;
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    // No-fallbacks: a price a caller reads out loud must never be guessed.
    // Anything unparseable, zero or negative halts rather than defaulting.
    if (!Number.isFinite(n) || n <= 0) {
      return c.json(errBody("bad_request", "script_price_monthly must be a number greater than 0"), 400);
    }
    patch.script_price_monthly = Math.round(n * 100) / 100;
  }

  for (const key of ["svc_website", "svc_ai_automation", "svc_fb_ads"] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") {
        return c.json(errBody("bad_request", `${key} must be a boolean`), 400);
      }
      patch[key] = body[key];
    }
  }

  if (Object.keys(patch).length === 0) {
    return c.json(errBody("bad_request", "nothing to update"), 400);
  }

  const { data, error } = await supabase
    .from("coldcall_leads")
    .update(patch)
    .eq("id", id)
    .select("id, script_price_monthly, svc_website, svc_ai_automation, svc_fb_ads")
    .maybeSingle();
  if (error) {
    log.error("[coldcall-admin] settings_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "settings_update_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  log.info("[coldcall-admin] script_settings_saved", { lead_id: id, fields: Object.keys(patch) });
  return c.json({ settings: data });
});

// ── POST /api/admin/coldcall-leads/assign ──────────────────────────────────
// Hand-pick assignment. One endpoint covers all three moves:
//   caller_id: "<uuid>"  → assign / reassign
//   caller_id: null      → unassign
//
// Unlike assign-split this does NOT re-assert `assigned_to IS NULL`, because
// moving a lead off another caller is the whole point. It reports what it
// moved instead, so taking work off someone is visible rather than silent.
//
// Pass dry_run: true to get the same report WITHOUT writing — that is how the
// UI warns "3 of these have logged calls" before the admin commits.
app.post("/coldcall-leads/assign", async (c) => {
  const supabase = createSupabaseClient(c.env);

  let body: { lead_ids?: unknown; caller_id?: unknown; dry_run?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  if (
    !Array.isArray(body.lead_ids) ||
    body.lead_ids.length === 0 ||
    !body.lead_ids.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return c.json(errBody("bad_request", "lead_ids must be a non-empty array of ids"), 400);
  }
  const leadIds = [...new Set(body.lead_ids as string[])];
  if (leadIds.length > ASSIGN_MAX) {
    return c.json(
      errBody("bad_request", `too many leads in one call (${leadIds.length} > ${ASSIGN_MAX})`),
      400,
    );
  }

  if (body.caller_id !== null && typeof body.caller_id !== "string") {
    return c.json(errBody("bad_request", "caller_id must be a caller id, or null to unassign"), 400);
  }
  const callerId = (body.caller_id as string | null) || null;
  const dryRun = body.dry_run === true;

  // Target caller must exist AND be active — same rule assign-split enforces.
  let caller: { id: string; email: string; name: string | null } | null = null;
  if (callerId) {
    const { data: cr, error: cErr } = await supabase
      .from("coldcall_callers")
      .select("id, email, name, active")
      .eq("id", callerId)
      .maybeSingle();
    if (cErr) {
      log.error("[coldcall-admin] assign_caller_failed", { err: cErr.message });
      return c.json(errBody("internal", "assign_caller_failed"), 500);
    }
    const row = cr as { id: string; email: string; name: string | null; active: boolean } | null;
    if (!row) return c.json(errBody("bad_request", `unknown caller id: ${callerId}`), 400);
    if (!row.active) {
      return c.json(errBody("bad_request", `inactive callers cannot be assigned: ${row.email}`), 400);
    }
    caller = { id: row.id, email: row.email, name: row.name };
  }

  // Load the leads so the report is built from real state, not assumptions.
  const leads: Array<{ id: string; callable: boolean; assigned_to: string | null; status: string; name: string }> = [];
  for (let i = 0; i < leadIds.length; i += UPDATE_CHUNK) {
    const chunk = leadIds.slice(i, i + UPDATE_CHUNK);
    const { data, error } = await supabase
      .from("coldcall_leads")
      .select("id, callable, assigned_to, status, name")
      .in("id", chunk);
    if (error) {
      log.error("[coldcall-admin] assign_lookup_failed", { err: error.message });
      return c.json(errBody("internal", "assign_lookup_failed"), 500);
    }
    leads.push(...((data ?? []) as typeof leads));
  }

  const missing = leadIds.filter((id) => !leads.some((l) => l.id === id));
  if (missing.length) {
    return c.json(errBody("bad_request", `unknown lead ids: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`), 400);
  }

  // Callable-only, consistent with assign-split. Checked ONLY when assigning —
  // pulling a non-callable lead back out of a book is always allowed.
  if (callerId) {
    const notCallable = leads.filter((l) => !l.callable);
    if (notCallable.length) {
      return c.json(
        errBody(
          "bad_request",
          `${notCallable.length} of these are not callable and cannot be assigned: ` +
            notCallable.slice(0, 3).map((l) => l.name).join(", ") +
            (notCallable.length > 3 ? `, +${notCallable.length - 3} more` : ""),
        ),
        400,
      );
    }
  }

  // How many carry logged calls — surfaced before an unassign/reassign so the
  // admin knows they are moving worked leads, not just fresh ones.
  const withHistory = new Set<string>();
  for (let i = 0; i < leadIds.length; i += UPDATE_CHUNK) {
    const chunk = leadIds.slice(i, i + UPDATE_CHUNK);
    const { data, error } = await supabase
      .from("coldcall_call_activity")
      .select("lead_id")
      .in("lead_id", chunk);
    if (error) {
      log.error("[coldcall-admin] assign_history_failed", { err: error.message });
      return c.json(errBody("internal", "assign_history_failed"), 500);
    }
    for (const r of (data ?? []) as Array<{ lead_id: string }>) withHistory.add(r.lead_id);
  }

  const report = {
    caller: caller ? { id: caller.id, email: caller.email, name: caller.name } : null,
    requested: leadIds.length,
    from_unassigned: leads.filter((l) => l.assigned_to === null).length,
    reassigned_from_other: leads.filter((l) => l.assigned_to !== null && l.assigned_to !== callerId).length,
    already_on_target: callerId ? leads.filter((l) => l.assigned_to === callerId).length : 0,
    with_call_history: withHistory.size,
    dry_run: dryRun,
    assigned: 0,
  };

  if (dryRun) return c.json(report);

  let done = 0;
  for (let i = 0; i < leadIds.length; i += UPDATE_CHUNK) {
    const chunk = leadIds.slice(i, i + UPDATE_CHUNK);
    const { data, error } = await supabase
      .from("coldcall_leads")
      .update({ assigned_to: callerId })
      .in("id", chunk)
      .select("id");
    if (error) {
      log.error("[coldcall-admin] assign_update_failed", {
        caller_id: callerId, assigned_so_far: done, err: error.message,
      });
      return c.json(
        errBody("internal", "assign_update_failed", { partial: true, assigned_before_failure: done }),
        500,
      );
    }
    done += (data ?? []).length;
  }
  report.assigned = done;

  log.info("[coldcall-admin] hand_assign", {
    caller_id: callerId,
    assigned: done,
    reassigned_from_other: report.reassigned_from_other,
    with_call_history: report.with_call_history,
  });

  return c.json(report);
});

// ── POST /api/admin/coldcall-leads/assign-split ────────────────────────────
// Evenly distribute currently-unassigned callable leads across the given
// active callers. Works for any number of callers.
app.post("/coldcall-leads/assign-split", async (c) => {
  const supabase = createSupabaseClient(c.env);

  let body: { caller_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  if (
    !Array.isArray(body.caller_ids) ||
    body.caller_ids.length === 0 ||
    !body.caller_ids.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return c.json(errBody("bad_request", "caller_ids must be a non-empty array of ids"), 400);
  }
  const requested = [...new Set(body.caller_ids as string[])];

  // No-fallbacks: every requested caller must exist AND be active. Silently
  // dropping an inactive id would produce a split that looks even but isn't.
  const { data: callerRows, error: callerErr } = await supabase
    .from("coldcall_callers")
    .select("id, email, name, active")
    .in("id", requested);
  if (callerErr) {
    log.error("[coldcall-admin] split_callers_failed", { err: callerErr.message });
    return c.json(errBody("internal", "split_callers_failed"), 500);
  }
  const found = (callerRows ?? []) as Array<{ id: string; email: string; name: string | null; active: boolean }>;

  const missing = requested.filter((id) => !found.some((r) => r.id === id));
  if (missing.length) {
    return c.json(errBody("bad_request", `unknown caller ids: ${missing.join(", ")}`), 400);
  }
  const inactive = found.filter((r) => !r.active).map((r) => r.email);
  if (inactive.length) {
    return c.json(errBody("bad_request", `inactive callers cannot be assigned: ${inactive.join(", ")}`), 400);
  }

  // Keep the caller order the admin sent, so the split is predictable.
  const callers = requested.map((id) => found.find((r) => r.id === id)!);

  // Pull the whole unassigned callable pool, best score first. Paged — the
  // pool routinely exceeds Supabase's 1000-row cap.
  const pool: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: poolErr } = await supabase
      .from("coldcall_leads")
      .select("id")
      .is("assigned_to", null)
      .eq("callable", true)
      .order("call_score", { ascending: false })
      .order("id", { ascending: true }) // stable tiebreak across pages
      .range(from, from + PAGE_SIZE - 1);
    if (poolErr) {
      log.error("[coldcall-admin] split_pool_failed", { err: poolErr.message });
      return c.json(errBody("internal", "split_pool_failed"), 500);
    }
    const rows = (page ?? []) as Array<{ id: string }>;
    pool.push(...rows.map((r) => r.id));
    if (rows.length < PAGE_SIZE) break;
  }

  if (pool.length === 0) {
    return c.json({
      assigned: 0,
      pool_size: 0,
      per_caller: callers.map((r) => ({ caller_id: r.id, email: r.email, name: r.name, count: 0 })),
    });
  }

  // Round-robin over the score-sorted pool, NOT contiguous chunks. Chunking
  // would hand caller #1 every top-scored lead and caller #N the dregs; this
  // gives everyone the same score mix. Remainder falls to the earliest
  // callers, so counts differ by at most 1.
  const buckets: string[][] = callers.map(() => []);
  for (let i = 0; i < pool.length; i++) buckets[i % callers.length].push(pool[i]);

  const perCaller: Array<{ caller_id: string; email: string; name: string | null; count: number }> = [];
  let assignedTotal = 0;

  for (let i = 0; i < callers.length; i++) {
    const caller = callers[i];
    const ids = buckets[i];
    let done = 0;
    for (let j = 0; j < ids.length; j += UPDATE_CHUNK) {
      const chunk = ids.slice(j, j + UPDATE_CHUNK);
      const { data: upd, error: updErr } = await supabase
        .from("coldcall_leads")
        .update({ assigned_to: caller.id })
        .in("id", chunk)
        // Re-assert the precondition: another admin splitting concurrently
        // must not have these rows reassigned out from under them.
        .is("assigned_to", null)
        .select("id");
      if (updErr) {
        log.error("[coldcall-admin] split_update_failed", {
          caller_id: caller.id,
          assigned_so_far: assignedTotal + done,
          err: updErr.message,
        });
        return c.json(
          errBody("internal", "split_update_failed", {
            partial: true,
            assigned_before_failure: assignedTotal + done,
          }),
          500,
        );
      }
      done += (upd ?? []).length;
    }
    assignedTotal += done;
    perCaller.push({ caller_id: caller.id, email: caller.email, name: caller.name, count: done });
  }

  log.info("[coldcall-admin] split_done", {
    pool_size: pool.length,
    assigned: assignedTotal,
    callers: callers.length,
  });

  return c.json({ assigned: assignedTotal, pool_size: pool.length, per_caller: perCaller });
});

export default app;

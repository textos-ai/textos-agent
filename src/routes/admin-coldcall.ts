// =============================================================
// Coldcall admin API — caller management + bulk lead assignment.
// Mounted at /api/admin. Gated by requireAuth + requireAdmin (users.is_admin).
//
//   GET  /api/admin/coldcall-callers                   list the access list
//   POST /api/admin/users/:id/coldcall-access          grant/revoke for one user
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

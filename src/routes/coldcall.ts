// =============================================================
// Coldcall — the internal cold-calling tool's caller-facing API.
// Mounted at /api/coldcall. Every route is gated by requireAuth +
// requireColdcaller (membership in coldcall_callers IS the role).
//
//   GET  /api/coldcall/me                caller identity for the page header
//   GET  /api/coldcall/worklist          assigned leads, call_score desc
//   GET  /api/coldcall/followups         assigned leads with followup_at <= now
//   GET  /api/coldcall/leads/:id         full detail + call_activity history
//   POST /api/coldcall/leads/:id/log     append an attempt, advance the lead
//
// INTERNAL ONLY. This module imports nothing from business route or task code
// — only shared low-level utils (jwt, coldcall-auth, supabase, errors,
// logger). It must stay that way: it is walled off from all client-facing
// query paths on purpose. No LLM calls anywhere in this module.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireColdcaller } from "../lib/coldcall-auth";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";
import { parseSettingsPatch, SETTINGS_COLS } from "../lib/coldcall-settings";
import {
  generateDemoContent, slugifyName, hex6, type DemoLead,
} from "../lib/coldcall-demo";
// Vocabularies and the insert-then-patch sequence are shared with the admin
// modal so the two surfaces can never disagree about what a valid outcome is.
import {
  logCallAttempt, CALL_OUTCOMES, LEAD_STATUSES,
  type CallOutcome, type LeadStatus,
} from "../lib/coldcall-log";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);
app.use("*", requireColdcaller);

// Columns the worklist table renders. rating stays NULL when there are no
// reviews — the frontend renders that as "no reviews", never as 0.
const LEAD_LIST_COLS =
  "id, name, phone, category, parish, market, rating, review_count, " +
  "call_score, status, followup_at, last_touched_at";

// The caller lead page renders the generated script, which reads the
// enrichment signals and the per-lead script settings — so it needs the whole
// row, not the hand-picked subset this used to return. "*" also means a later
// migration's columns reach the script without a change here.
const LEAD_DETAIL_COLS = "*";


// ── GET /api/coldcall/me ───────────────────────────────────────────────────
// Identity for the page header. Reaching this at all proves the gate passed.
app.get("/me", (c) => {
  const caller = c.get("coldcaller");
  return c.json({ caller });
});

// ── GET /api/coldcall/worklist ─────────────────────────────────────────────
// The caller's own assigned leads, best call_score first. Callable-only by
// default. Filters: parish, market, category, status.
app.get("/worklist", async (c) => {
  const caller = c.get("coldcaller");
  const supabase = createSupabaseClient(c.env);

  const parish = c.req.query("parish");
  const market = c.req.query("market");
  const category = c.req.query("category");
  const status = c.req.query("status");
  // Escape hatch for reviewing leads that were marked un-callable.
  const includeUncallable = c.req.query("callable") === "all";

  if (status && !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
    return c.json(errBody("bad_request", `unknown status '${status}'`), 400);
  }

  let q = supabase
    .from("coldcall_leads")
    .select(LEAD_LIST_COLS)
    .eq("assigned_to", caller.id)
    .order("call_score", { ascending: false })
    .limit(500);

  if (!includeUncallable) q = q.eq("callable", true);
  if (parish) q = q.eq("parish", parish);
  if (market) q = q.eq("market", market);
  if (category) q = q.eq("category", category);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    log.error("[coldcall] worklist_failed", { caller_id: caller.id, err: error.message });
    return c.json(errBody("internal", "worklist_failed"), 500);
  }

  // Status counts across the caller's whole callable book — powers the header
  // chips without a second round trip from the page.
  const { data: allRows, error: countErr } = await supabase
    .from("coldcall_leads")
    .select("status")
    .eq("assigned_to", caller.id)
    .eq("callable", true);
  if (countErr) {
    log.error("[coldcall] worklist_counts_failed", { caller_id: caller.id, err: countErr.message });
    return c.json(errBody("internal", "worklist_counts_failed"), 500);
  }
  const counts: Record<string, number> = {};
  for (const r of (allRows ?? []) as Array<{ status: string }>) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  return c.json({ leads: data ?? [], counts, total: (allRows ?? []).length });
});

// ── GET /api/coldcall/followups ────────────────────────────────────────────
// The caller's leads that are due for a callback now (followup_at <= now).
app.get("/followups", async (c) => {
  const caller = c.get("coldcaller");
  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select(LEAD_LIST_COLS)
    .eq("assigned_to", caller.id)
    .not("followup_at", "is", null)
    .lte("followup_at", new Date().toISOString())
    .order("followup_at", { ascending: true })
    .limit(500);

  if (error) {
    log.error("[coldcall] followups_failed", { caller_id: caller.id, err: error.message });
    return c.json(errBody("internal", "followups_failed"), 500);
  }
  return c.json({ leads: data ?? [] });
});

// ── GET /api/coldcall/leads/:id ────────────────────────────────────────────
// Full lead detail plus its complete attempt history.
app.get("/leads/:id", async (c) => {
  const caller = c.get("coldcaller");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const { data: lead, error } = await supabase
    .from("coldcall_leads")
    .select(LEAD_DETAIL_COLS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    log.error("[coldcall] lead_detail_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "lead_detail_failed"), 500);
  }
  if (!lead) return c.json(errBody("not_found", "lead not found"), 404);

  // History is shown with the caller's name resolved, so a shared lead reads
  // as "who called this before me" rather than a bare uuid.
  const { data: activity, error: actErr } = await supabase
    .from("coldcall_call_activity")
    .select("id, outcome, note, created_at, caller_id, coldcall_callers(name, email)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (actErr) {
    log.error("[coldcall] lead_activity_failed", { lead_id: id, err: actErr.message });
    return c.json(errBody("internal", "lead_activity_failed"), 500);
  }

  return c.json({
    lead,
    // Informational only — the caller can still open and log against a lead
    // that is not theirs (a small team shares one book); the page uses this
    // to show a "assigned to someone else" note.
    is_mine:
      (lead as unknown as { assigned_to: string | null }).assigned_to === caller.id,
    activity: activity ?? [],
    // Vocabularies come from here so the page never hardcodes them.
    outcomes: CALL_OUTCOMES,
    statuses: LEAD_STATUSES,
  });
});

// ── POST /api/coldcall/leads/:id/log ───────────────────────────────────────
// Append one attempt to the append-only history AND advance the lead.
// Activity rows are never updated or overwritten.
app.post("/leads/:id/log", async (c) => {
  const caller = c.get("coldcaller");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: {
    outcome?: unknown;
    note?: unknown;
    status?: unknown;
    followup_at?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  // No-fallbacks: outcome is load-bearing (it IS the history record). A
  // missing or unknown value halts loudly rather than defaulting.
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !CALL_OUTCOMES.includes(outcome as (typeof CALL_OUTCOMES)[number])) {
    return c.json(
      errBody("bad_request", `outcome must be one of: ${CALL_OUTCOMES.join(", ")}`),
      400,
    );
  }

  const status = body.status;
  if (status !== undefined && status !== null) {
    if (typeof status !== "string" || !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
      return c.json(
        errBody("bad_request", `status must be one of: ${LEAD_STATUSES.join(", ")}`),
        400,
      );
    }
  }

  const followupAt = body.followup_at;
  if (followupAt !== undefined && followupAt !== null) {
    if (typeof followupAt !== "string" || Number.isNaN(Date.parse(followupAt))) {
      return c.json(errBody("bad_request", "followup_at must be an ISO timestamp or null"), 400);
    }
  }

  const note = body.note;
  if (note !== undefined && note !== null && typeof note !== "string") {
    return c.json(errBody("bad_request", "note must be a string"), 400);
  }

  // The lead must exist before we write history against it.
  const { data: lead, error: leadErr } = await supabase
    .from("coldcall_leads")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    log.error("[coldcall] log_lead_lookup_failed", { lead_id: id, err: leadErr.message });
    return c.json(errBody("internal", "log_lead_lookup_failed"), 500);
  }
  if (!lead) return c.json(errBody("not_found", "lead not found"), 404);

  // Insert-then-patch lives in ONE place for both surfaces (lib/coldcall-log).
  // The ordering guarantee — activity first, lead second — is the part that
  // must never drift between the caller worklist and the admin modal.
  //
  // status is passed through exactly as supplied: this surface leaves the
  // lead's status alone unless the caller explicitly picks one. The admin
  // modal derives a default from the outcome; that difference is deliberate
  // and belongs in the caller, not in the shared helper.
  const res = await logCallAttempt(supabase, {
    leadId: id,
    callerId: caller.id,
    outcome: outcome as CallOutcome,
    note: typeof note === "string" ? note : null,
    status: typeof status === "string" ? (status as LeadStatus) : undefined,
    followupAt: followupAt as string | null | undefined,
    leadCols: LEAD_DETAIL_COLS,
  });

  if (!res.ok) {
    if (res.stage === "activity") {
      log.error("[coldcall] activity_insert_failed", { lead_id: id, err: res.message });
      return c.json(errBody("internal", "activity_insert_failed"), 500);
    }
    log.error("[coldcall] lead_update_failed", {
      lead_id: id, activity_id: res.activityId, err: res.message,
    });
    return c.json(errBody("internal", "lead_update_failed"), 500);
  }

  log.info("[coldcall] attempt_logged", {
    lead_id: id,
    caller_id: caller.id,
    outcome,
    status: typeof status === "string" ? status : null,
  });

  return c.json({ activity: res.activity, lead: res.lead }, 201);
});

// ── PATCH /api/coldcall/leads/:id/settings ─────────────────────────────────
// Per-lead script settings from the caller page. Same validation as the admin
// modal (lib/coldcall-settings), so the two surfaces cannot disagree.
//
// Callers may adjust these: the price and service mix are per-client sales
// decisions made on the call, and the script reads straight off them.
app.patch("/leads/:id/settings", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) return c.json(errBody("bad_request", parsed.message), 400);

  const { data, error } = await supabase
    .from("coldcall_leads")
    .update(parsed.patch)
    .eq("id", id)
    .select(SETTINGS_COLS)
    .maybeSingle();
  if (error) {
    log.error("[coldcall] settings_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "settings_update_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);

  return c.json({ settings: data });
});

// ── demo landing page ──────────────────────────────────────────────────────
// A sales prop generated from the lead and shown to the prospect on the call.
// Fully isolated from the client business system — see lib/coldcall-demo.ts.
//
// The coldcall_demo_sites row (UNIQUE on lead_id) IS the link record. There is
// deliberately no url column on coldcall_leads, so there is no second place to
// keep in sync.

const DEMO_COLS = "id, slug, status, error, hero_folder, created_at";
const demoUrl = (slug: string) => `/demo/${slug}`;

// ── GET /api/coldcall/leads/:id/demo-site ──────────────────────────────────
// Tells the modal whether to show "Open demo" or "Generate".
app.get("/leads/:id/demo-site", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("coldcall_demo_sites").select(DEMO_COLS).eq("lead_id", id).maybeSingle();
  if (error) {
    log.error("[coldcall] demo_lookup_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "demo_lookup_failed"), 500);
  }
  if (!data) return c.json({ exists: false });

  const row = data as { slug: string; status: string; error: string | null; hero_folder: string | null };
  return c.json({
    exists: true,
    status: row.status,
    slug: row.slug,
    url: demoUrl(row.slug),
    error: row.error,
    hero_folder: row.hero_folder,
  });
});

// ── POST /api/coldcall/leads/:id/demo-site ─────────────────────────────────
// Idempotent BY DEFAULT: an existing row is RETURNED, never regenerated. A
// second Generate click mid-call must open the same page the prospect is
// already looking at.
//
// `{ force: true }` (the Regenerate action) is the ONLY way to rebuild. It
// reuses the existing slug, so the link already sent to the prospect keeps
// working and simply serves the new content.
app.post("/leads/:id/demo-site", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  // { force: true } rebuilds an existing demo instead of returning it. Used by
  // the Regenerate action so a demo made before a content change (new hero
  // video, new subtext, a reworded prompt) can pick it up.
  let force = false;
  try {
    const body = await c.req.json<{ force?: unknown }>();
    force = body?.force === true;
  } catch { /* no body is the normal Generate case */ }

  const existing = await supabase
    .from("coldcall_demo_sites").select(DEMO_COLS).eq("lead_id", id).maybeSingle();
  if (existing.error) {
    log.error("[coldcall] demo_lookup_failed", { lead_id: id, err: existing.error.message });
    return c.json(errBody("internal", "demo_lookup_failed"), 500);
  }
  if (existing.data && !force) {
    const row = existing.data as { slug: string; status: string; error: string | null };
    return c.json({
      status: row.status, slug: row.slug, url: demoUrl(row.slug),
      error: row.error, reused: true,
    });
  }

  const { data: leadRow, error: leadErr } = await supabase
    .from("coldcall_leads")
    .select("id, name, category, phone, address, city, state, zip, parish, rating, review_count, website_url")
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    log.error("[coldcall] demo_lead_lookup_failed", { lead_id: id, err: leadErr.message });
    return c.json(errBody("internal", "demo_lead_lookup_failed"), 500);
  }
  if (!leadRow) return c.json(errBody("not_found", "lead not found"), 404);
  const lead = leadRow as unknown as DemoLead;

  // No-fallbacks, checked BEFORE a row is created so a lead that cannot produce
  // a demo never leaves a 'generating' shell behind.
  if (!lead.name?.trim()) {
    return c.json(errBody("bad_request", "lead has no business name — cannot build a demo"), 400);
  }
  if (!lead.category?.trim()) {
    return c.json(errBody("bad_request", "lead has no category — cannot build a demo"), 400);
  }

  // REGENERATE keeps the existing row and its SLUG. The caller may already
  // have texted the link to the prospect mid-call — changing the URL under
  // them would be worse than the stale content we are replacing.
  if (existing.data && force) {
    const row = existing.data as { slug: string };
    const { error: markErr } = await supabase
      .from("coldcall_demo_sites")
      .update({ status: "generating", error: null })
      .eq("lead_id", id);
    if (markErr) {
      log.error("[coldcall] demo_regen_mark_failed", { lead_id: id, err: markErr.message });
      return c.json(errBody("internal", "demo_regen_mark_failed"), 500);
    }
    try {
      const { content, heroFolder, ms, perSectionMs } = await generateDemoContent(supabase, c.env, lead);
      const { error: updErr } = await supabase
        .from("coldcall_demo_sites")
        .update({ content, hero_folder: heroFolder, status: "ready", error: null })
        .eq("lead_id", id);
      if (updErr) throw new Error(`demo_write_failed: ${updErr.message}`);
      log.info("[coldcall] demo_regenerated", {
        lead_id: id, slug: row.slug, total_ms: ms, per_section_ms: perSectionMs,
      });
      return c.json({
        status: "ready", slug: row.slug, url: demoUrl(row.slug),
        generation_ms: ms, reused: false, regenerated: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from("coldcall_demo_sites")
        .update({ status: "failed", error: message.slice(0, 800) })
        .eq("lead_id", id);
      log.error("[coldcall] demo_regen_failed", { lead_id: id, slug: row.slug, err: message });
      return c.json(errBody("internal", "demo_generation_failed", { slug: row.slug, message }), 500);
    }
  }

  // Claim the slug first. UNIQUE(slug) is the collision guard; retry with a
  // fresh hex rather than failing the caller's click.
  let slug = "";
  let lastErr = "";
  for (let attempt = 0; attempt < 5 && !slug; attempt++) {
    const candidate = `${slugifyName(lead.name)}-${hex6()}`;
    const ins = await supabase
      .from("coldcall_demo_sites")
      .insert({ lead_id: lead.id, slug: candidate, status: "generating" })
      .select("slug")
      .single();
    if (!ins.error) { slug = candidate; break; }
    lastErr = ins.error.message;
    // A lead_id clash means a concurrent click won — return that row.
    if (ins.error.code === "23505" && /lead_id/.test(ins.error.message)) {
      const again = await supabase
        .from("coldcall_demo_sites").select(DEMO_COLS).eq("lead_id", id).maybeSingle();
      const row = again.data as { slug: string; status: string; error: string | null } | null;
      if (row) {
        return c.json({ status: row.status, slug: row.slug, url: demoUrl(row.slug), error: row.error, reused: true });
      }
    }
    if (ins.error.code !== "23505") break;   // anything else is fatal
  }
  if (!slug) {
    log.error("[coldcall] demo_insert_failed", { lead_id: id, err: lastErr });
    return c.json(errBody("internal", `demo_insert_failed: ${lastErr}`), 500);
  }

  // Generation is SYNCHRONOUS on purpose: the four section prompts run in
  // parallel and the measured total sits inside the request budget. If that
  // stops holding, the fix is a DEDICATED coldcall queue — never the shared
  // TASK_QUEUE, whose consumer hard-requires a business row.
  try {
    const { content, heroFolder, ms, perSectionMs } = await generateDemoContent(supabase, c.env, lead);
    const { error: updErr } = await supabase
      .from("coldcall_demo_sites")
      .update({ content, hero_folder: heroFolder, status: "ready", error: null })
      .eq("slug", slug);
    if (updErr) throw new Error(`demo_write_failed: ${updErr.message}`);

    log.info("[coldcall] demo_ready", { lead_id: id, slug, total_ms: ms, per_section_ms: perSectionMs });
    return c.json({ status: "ready", slug, url: demoUrl(slug), generation_ms: ms, reused: false }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the failure ON the row so the caller sees why. The prospect still
    // gets a 404 rather than a broken page.
    await supabase
      .from("coldcall_demo_sites")
      .update({ status: "failed", error: message.slice(0, 800) })
      .eq("slug", slug);
    log.error("[coldcall] demo_failed", { lead_id: id, slug, err: message });
    return c.json(errBody("internal", "demo_generation_failed", { slug, message }), 500);
  }
});

export default app;

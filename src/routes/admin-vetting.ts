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
//   POST  /api/admin/vetting/:id/plan       set the commercial plan (auto-enters)
//   PATCH /api/admin/vetting/:id/profile    edit the published profile fields
//   GET   /api/admin/vetting/:id/preview    exactly what the public API returns
//   GET   /api/admin/vetting/campaign       the free-vetting campaign board
//   POST  /api/admin/vetting/:id/comp       mark comped / un-comp
//   POST  /api/admin/vetting/:id/comp-offer record conversion progress
//   POST  /api/admin/vetting/:id/notified   MANUAL notified + consent (hand-sent email)
//   POST  /api/admin/vetting/:id/removal-link  mint/return the opt-out link
//   POST  /api/admin/vetting/:id/notify     notify-before-publish (DRY RUN by default)
//   POST  /api/admin/vetting/comp-sweep     drop comps past their grace period
//   GET   /api/admin/vetting/exclusivity    the area board: claimed, expired, open
//   POST  /api/admin/vetting/:id/exclusivity         claim an area (GATED)
//   POST  /api/admin/vetting/:id/exclusivity/release release an area
//   POST  /api/admin/vetting/exclusivity-sweep       free areas past their end date
//   GET   /api/admin/email-approvals        the per-email approval queue
//   POST  /api/admin/email-approvals/:id/approve   approve AND send (only send path)
//   POST  /api/admin/email-approvals/:id/reject
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
  AREA_FIELDS, areaKey, areaLabel, blocksClaim, claimState, daysUntil,
  holderName, isAreaConflict, normalizeArea, parseUntil, rowArea,
  type Area, type ExclusiveRow,
} from "../lib/trustlight-exclusivity";
import {
  VETTING_STATUSES, CHECK_KEYS, CHECK_LABELS, CHECK_RESULTS,
  VETTING_DETAIL_COLS, VETTING_QUEUE_COLS,
  countPasses, allNinePass, failingChecks, buildUniqueSlug, writeAudit, verificationStamps,
  QUEUE_SORTS, CAMPAIGN_SORTS, applyQueueSort, isDaysSort,
  latestStatusChanges, sortByDaysInStatus, type QueueSort,
  enterVetting, VETTING_ENTRY_STATUS, setPlan, PLANS, type Plan,
  type VettingStatus, type CheckKey,
} from "../lib/trustlight-vetting";
// The SAME shaping the public API uses. Importing it is what makes the preview
// below trustworthy — it is not a description of the public shape, it IS the
// public shape.
import {
  PROFILE_COLS, shapeVerified, shapeProfile, shapeUnvetted, visibilityOf,
  type VerifiedRow, type ProfileRow,
} from "../lib/trustlight-public";
import {
  COMP_OFFER_STATUSES, CONFIG_KEYS, readConfig, removalToken,
  renderNotifyEmail, sendEmail, compGraceDeadline, senderAllowed,
  type CompOfferStatus, type NotifyLead,
} from "../lib/trustlight-campaign";

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

  const sort = (c.req.query("sort") ?? "oldest") as QueueSort;
  if (!QUEUE_SORTS.includes(sort)) {
    return c.json(errBody("bad_request", `sort must be one of ${QUEUE_SORTS.join("|")}`), 400);
  }

  type Row = Record<string, unknown> & { id: string; vetting_status: string };
  const withFilters = <T extends { eq: Function; ilike: Function }>(qq: T): T => {
    let x = qq as T & Record<string, Function>;
    if (status) x = x.eq("vetting_status", status);
    if (q) x = x.ilike("name", `%${q}%`);
    return x as T;
  };

  let rows: Row[] = [];
  let count = 0;
  const sinceByLead: Record<string, string> = {};

  if (isDaysSort(sort)) {
    // DAYS IN STATUS CANNOT BE ORDERED IN SQL — it comes from the audit log.
    // Only leads that have actually MOVED have a row there, so the ordered
    // set is small by construction; everything else has null days and sorts
    // to the bottom regardless of direction.
    const latest = await latestStatusChanges(supabase);
    for (const [k, v] of latest) sinceByLead[k] = v;

    const ids = [...latest.keys()];
    let known: Row[] = [];
    if (ids.length) {
      // Chunked: an `in` list of every moved lead could outgrow a URL.
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await withFilters(
          supabase.from("coldcall_leads").select(VETTING_QUEUE_COLS).in("id", ids.slice(i, i + 200)),
        );
        if (error) {
          log.error("[vetting] queue_days_known_failed", { err: error.message });
          return c.json(errBody("internal", "queue_failed"), 500);
        }
        known.push(...((data ?? []) as unknown as Row[]));
      }
    }
    known = sortByDaysInStatus(known, latest, sort);

    // The tail: matching leads with no recorded change. Counted, and paged
    // into only once the known ones run out.
    const { count: totalCount, error: cErr } = await withFilters(
      supabase.from("coldcall_leads").select("id", { count: "exact", head: true }),
    );
    if (cErr) {
      log.error("[vetting] queue_days_count_failed", { err: cErr.message });
      return c.json(errBody("internal", "queue_failed"), 500);
    }
    count = totalCount ?? 0;

    const knownSlice = known.slice(from, from + pageSize);
    rows = knownSlice;
    if (rows.length < pageSize) {
      const tailFrom = Math.max(0, from - known.length);
      const tailTake = pageSize - rows.length;
      let tail = withFilters(
        supabase.from("coldcall_leads").select(VETTING_QUEUE_COLS),
      ).order("id", { ascending: true }).range(tailFrom, tailFrom + tailTake + ids.length);
      const { data: tailData, error: tErr } = await tail;
      if (tErr) {
        log.error("[vetting] queue_days_tail_failed", { err: tErr.message });
        return c.json(errBody("internal", "queue_failed"), 500);
      }
      const knownIds = new Set(ids);
      rows = rows.concat(
        ((tailData ?? []) as unknown as Row[]).filter((r) => !knownIds.has(r.id)).slice(0, tailTake),
      );
    }
  } else {
    let query = applyQueueSort(
      supabase
        .from("coldcall_leads")
        .select(VETTING_QUEUE_COLS, { count: "exact" }),
      sort,
    ).range(from, from + pageSize - 1);
    query = withFilters(query);

    const { data, count: c2, error } = await query;
    if (error) {
      log.error("[vetting] queue_failed", { err: error.message });
      return c.json(errBody("internal", "queue_failed"), 500);
    }
    rows = (data ?? []) as unknown as Row[];
    count = c2 ?? 0;

    // Most recent vetting_status change per lead, in ONE query for the page.
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
      // Sales-Ready score, read not computed. Admin-only.
      call_score: r.call_score ?? null,
      rank: r.rank ?? null,
    };
  });

  return c.json({
    leads,
    total: count,
    page,
    page_size: pageSize,
    has_more: from + leads.length < count,
    statuses: VETTING_STATUSES,
    sort,
    sorts: QUEUE_SORTS,
  });
});

// NOTE: registered BEFORE /vetting/:id. Hono matches routes in
// registration order, so a literal path segment has to come first or the
// parameterised route swallows it and 'campaign' arrives as a lead id.
// ── GET /api/admin/vetting/campaign ────────────────────────────────────────
// The free-vetting campaign board: every comped record, how far through the
// nine checks it is, and where it stands on converting to paid.
app.get("/vetting/campaign", async (c) => {
  const supabase = createSupabaseClient(c.env);

  // The campaign board has no Days in status column, so its vocabulary omits
  // those values rather than accepting a sort it cannot honour.
  const sort = (c.req.query("sort") ?? "oldest") as QueueSort;
  if (!CAMPAIGN_SORTS.includes(sort)) {
    return c.json(errBody("bad_request", `sort must be one of ${CAMPAIGN_SORTS.join("|")}`), 400);
  }

  const { data, error } = await applyQueueSort(supabase
    .from("coldcall_leads")
    .select(VETTING_DETAIL_COLS + ", comp_offer_status, comp_offered_at, comp_decided_at, removal_requested_at"), sort)
    .eq("is_comped", true);
  if (error) {
    log.error("[campaign] list_failed", { err: error.message });
    return c.json(errBody("internal", "campaign_list_failed"), 500);
  }

  const cfg = await readConfig(supabase, [CONFIG_KEYS.graceDays]);
  const graceDays = cfg.ok ? parseInt(cfg.values[CONFIG_KEYS.graceDays], 10) : 30;
  const now = new Date();

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const leads = rows.map((r) => {
    const deadline = compGraceDeadline(r as { comp_offered_at: string | null }, graceDays);
    return {
      id: r.id,
      name: r.trading_name || r.legal_name || r.name,
      trade: r.trade || r.category,
      city: r.city, state: r.state,
      vetting_status: r.vetting_status,
      is_published: r.is_published,
      slug: r.slug,
      comp_reason: r.comp_reason,
      checks_passed: countPasses(r as Record<CheckKey, string | null>),
      checks_total: CHECK_KEYS.length,
      // Consent pipeline
      notified_at: r.notified_at,
      listing_consent: r.listing_consent,
      removal_requested_at: r.removal_requested_at,
      // Conversion pipeline: comped -> offered -> accepted/declined
      comp_offer_status: r.comp_offer_status ?? null,
      comp_offered_at: r.comp_offered_at ?? null,
      comp_decided_at: r.comp_decided_at ?? null,
      plan: r.plan,
      grace_deadline: deadline ? deadline.toISOString() : null,
      grace_days_left: deadline ? Math.ceil((deadline.getTime() - now.getTime()) / 86400000) : null,
      grace_expired: !!deadline && deadline <= now && r.comp_offer_status === "offered",
      // Who to pre-approve and call first. Admin-only.
      call_score: r.call_score ?? null,
      rank: r.rank ?? null,
    };
  });

  return c.json({
    leads,
    total: leads.length,
    grace_days: graceDays,
    offer_statuses: COMP_OFFER_STATUSES,
    sort,
    sorts: CAMPAIGN_SORTS,
  });
});

// ── GET /api/admin/vetting/:id ─────────────────────────────────────────────
// One business: every check with its internal note, the published-profile
// fields, and the audit trail.
// ── Parish Exclusive ───────────────────────────────────────────────────────
// One verified business per (trade, county, state). The database enforces the
// race with a partial unique index (126); these routes exist to make it
// legible — to say WHO holds an area, whether that hold is still good, and
// which areas are open — and to turn a raw 23505 into a sentence.
//
// The index cannot test expiry (an index predicate must be IMMUTABLE and
// now() is not), so an expired claim still physically occupies its slot. That
// is why "expired" is a first-class state here and why the sweep exists.

/** Every row that currently occupies a slot in the unique index. Small by
 *  construction: verified + plan='exclusive' only. */
async function loadClaims(supabase: ReturnType<typeof createSupabaseClient>) {
  const { data, error } = await supabase
    .from("coldcall_leads")
    .select("id, name, trading_name, legal_name, plan, vetting_status, slug, " +
            "exclusive_trade, exclusive_county, exclusive_state, exclusive_until")
    .eq("plan", "exclusive").eq("vetting_status", "verified")
    .not("exclusive_trade", "is", null)
    .not("exclusive_county", "is", null)
    .not("exclusive_state", "is", null);
  if (error) return { ok: false as const, message: error.message };
  return { ok: true as const, rows: (data ?? []) as unknown as ExclusiveRow[] };
}

/** The holder of an area, if any. Compares normalised values because that is
 *  what every write stores. */
function findHolder(rows: ExclusiveRow[], area: Area): ExclusiveRow | null {
  return rows.find((r) => {
    const a = rowArea(r);
    return a && areaKey({
      trade: a.trade.toLowerCase(),
      county: a.county.toLowerCase(),
      state: a.state.toUpperCase(),
    }) === areaKey(area);
  }) ?? null;
}

// ── GET /api/admin/vetting/exclusivity ─────────────────────────────────────
// The board. Claimed areas (with active/expired called out) and, when the
// area list from migration 129 is available, the areas nobody holds.
app.get("/vetting/exclusivity", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();
  const trade = String(c.req.query("trade") ?? "").trim().toLowerCase();

  const claims = await loadClaims(supabase);
  if (!claims.ok) {
    log.error("[exclusivity] claims_read_failed", { err: claims.message });
    return c.json(errBody("internal", "claims_read_failed"), 500);
  }

  const held = claims.rows.map((r) => {
    const a = rowArea(r) as Area;
    const state = claimState(r, nowIso);
    return {
      id: r.id,
      holder: holderName(r),
      trade: a.trade, county: a.county, state: a.state,
      label: areaLabel(a),
      exclusive_until: r.exclusive_until ?? null,
      claim_state: state,
      days_left: daysUntil(r.exclusive_until, new Date()),
    };
  });

  // The sellable-area universe. Its absence is reported, never papered over:
  // an empty "open" list and a missing one mean very different things to
  // somebody about to promise a parish to a customer.
  let areas: Array<{ county: string; state: string; lead_count: number }> = [];
  let areasError: string | null = null;
  const av = await supabase
    .from("coldcall_areas").select("county, state, lead_count").order("lead_count", { ascending: false });
  if (av.error) {
    areasError = "the area list is unavailable — migration 129 (coldcall_areas) is not applied";
    log.warn("[exclusivity] areas_view_missing", { err: av.error.message });
  } else {
    areas = (av.data ?? []) as unknown as Array<{ county: string; state: string; lead_count: number }>;
  }

  // "Open" only means anything once a trade is named — an area is sold per
  // trade, so st_tammany is simultaneously taken for roofing and open for
  // plumbing. Without a trade we return the areas and let the UI ask.
  const takenForTrade = new Set(
    held.filter((h) => h.claim_state === "active" && (!trade || h.trade === trade))
        .map((h) => `${h.county}|${h.state}`),
  );
  const open = trade
    ? areas.filter((a) => !takenForTrade.has(`${a.county}|${a.state}`))
    : [];

  return c.json({
    trade: trade || null,
    claimed: held.sort((a, b) => a.label.localeCompare(b.label)),
    active_count: held.filter((h) => h.claim_state === "active").length,
    expired_count: held.filter((h) => h.claim_state === "expired").length,
    areas,
    areas_error: areasError,
    open,
    // Stated so the UI never has to encode this rule itself.
    note: "An expired claim still occupies its slot until it is released or swept.",
  });
});

// ── POST /api/admin/vetting/exclusivity-sweep ──────────────────────────────
// Free every area whose end date has passed. This is the mechanism migration
// 126 names for expiry, because the unique index cannot test a date itself.
// Dry run unless confirmed, matching comp-sweep.
app.post("/vetting/exclusivity-sweep", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  let body: { confirm?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const confirm = body.confirm === true;
  const nowIso = new Date().toISOString();

  const claims = await loadClaims(supabase);
  if (!claims.ok) {
    log.error("[exclusivity] sweep_read_failed", { err: claims.message });
    return c.json(errBody("internal", "sweep_read_failed"), 500);
  }
  const due = claims.rows.filter((r) => claimState(r, nowIso) === "expired");

  if (!confirm) {
    return c.json({
      dry_run: true, would_free: due.length,
      areas: due.map((r) => ({
        id: r.id, holder: holderName(r),
        label: areaLabel(rowArea(r) as Area), exclusive_until: r.exclusive_until ?? null,
      })),
    });
  }

  const freed: string[] = [];
  for (const r of due) {
    const area = rowArea(r) as Area;
    const { error } = await supabase.from("coldcall_leads").update(AREA_FIELDS).eq("id", r.id);
    if (error) { log.error("[exclusivity] sweep_free_failed", { lead_id: r.id, err: error.message }); continue; }
    await writeAudit(supabase, {
      lead_id: r.id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "exclusive_area", old_value: areaKey(area), new_value: null,
      reason: `auto: exclusivity ended ${r.exclusive_until ?? "(no end date)"} — area released`,
    });
    freed.push(r.id);
  }
  log.info("[exclusivity] sweep_done", { freed: freed.length, by: auth.email });
  return c.json({ dry_run: false, freed: freed.length, ids: freed });
});

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

// ── POST /api/admin/vetting/:id/plan ───────────────────────────────────────
// Set the commercial plan. THE AUTOMATIC ENTRY TRIGGER.
//
// Decision 1a made coldcall_leads.plan the single source of truth for a paid
// vetting subscription, so becoming 'verification' or 'exclusive' is what puts
// a business into the queue — audited as "auto: plan set to <plan>".
//
// This endpoint exists now, ahead of the full commercial UI, so the trigger
// has a real call site and is reachable and tested rather than dormant code
// waiting to be wired. The write goes through setPlan() precisely so a later
// UI cannot add a path that sets `plan` and skips the queue entry.
app.post("/vetting/:id/plan", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { plan?: unknown; reason?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  const plan = String(body.plan ?? "");
  if (!PLANS.includes(plan as Plan)) {
    return c.json(errBody("bad_request", `plan must be one of ${PLANS.join("|")}`), 400);
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  const res = await setPlan(supabase, id, plan as Plan, { user_id: auth.user_id, email: auth.email }, reason);
  if (!res.ok) {
    if (res.message === "lead not found") return c.json(errBody("not_found", "lead not found"), 404);
    log.error("[vetting] plan_set_failed", { lead_id: id, err: res.message });
    return c.json(errBody("internal", "plan_set_failed"), 500);
  }

  log.info("[vetting] plan_set", {
    lead_id: id, from: res.previous, to: res.plan,
    entered_vetting: res.vetting?.ok === true && res.vetting.moved === true, by: auth.email,
  });
  return c.json({ id, plan: res.plan, previous: res.previous, vetting: res.vetting });
});

// ── POST /api/admin/vetting/:id/comp ───────────────────────────────────────
// Mark a business as comped (or un-comp it). A comp reason is REQUIRED when
// switching it on: "why is this one free" is exactly the question an audit of
// the campaign has to answer later.
//
// This changes nothing about verification. The nine checks still have to pass
// the same gate; comping only records that no money changed hands.
app.post("/vetting/:id/comp", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { is_comped?: unknown; comp_reason?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  if (typeof body.is_comped !== "boolean") {
    return c.json(errBody("bad_request", "is_comped must be a boolean"), 400);
  }
  const reason = typeof body.comp_reason === "string" ? body.comp_reason.trim() : "";
  if (body.is_comped && !reason) {
    return c.json(errBody("bad_request", "comp_reason is required when comping a business"), 400);
  }

  const { data: current } = await supabase
    .from("coldcall_leads").select("id, is_comped").eq("id", id).maybeSingle();
  if (!current) return c.json(errBody("not_found", "lead not found"), 404);
  const was = (current as { is_comped: boolean }).is_comped;

  const { error } = await supabase.from("coldcall_leads")
    .update({ is_comped: body.is_comped, comp_reason: body.is_comped ? reason : null })
    .eq("id", id);
  if (error) {
    log.error("[campaign] comp_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "comp_update_failed"), 500);
  }

  await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "is_comped", old_value: String(was), new_value: String(body.is_comped),
    reason: body.is_comped ? reason : "un-comped",
  });

  log.info("[campaign] comp_set", { lead_id: id, is_comped: body.is_comped, by: auth.email });
  return c.json({ id, is_comped: body.is_comped, comp_reason: body.is_comped ? reason : null });
});

// ── POST /api/admin/vetting/:id/comp-offer ─────────────────────────────────
// Record where a comped business stands on converting to paid, so the call
// team knows who to work: offered -> accepted | declined, with dates.
app.post("/vetting/:id/comp-offer", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { status?: unknown; reason?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }
  const status = String(body.status ?? "");
  if (!COMP_OFFER_STATUSES.includes(status as CompOfferStatus)) {
    return c.json(errBody("bad_request", `status must be one of ${COMP_OFFER_STATUSES.join("|")}`), 400);
  }

  const { data: current } = await supabase
    .from("coldcall_leads").select("id, comp_offer_status, is_comped").eq("id", id).maybeSingle();
  if (!current) return c.json(errBody("not_found", "lead not found"), 404);
  const row = current as { comp_offer_status: string | null; is_comped: boolean };
  if (!row.is_comped) {
    return c.json(errBody("conflict", "this business is not comped — there is no comp offer to track"), 409);
  }

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { comp_offer_status: status };
  if (status === "offered") patch.comp_offered_at = nowIso;
  else patch.comp_decided_at = nowIso;

  const { error } = await supabase.from("coldcall_leads").update(patch).eq("id", id);
  if (error) {
    log.error("[campaign] offer_update_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "offer_update_failed"), 500);
  }

  await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "comp_offer_status", old_value: row.comp_offer_status ?? "none", new_value: status,
    reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null,
  });

  log.info("[campaign] offer_recorded", { lead_id: id, status, by: auth.email });
  return c.json({ id, comp_offer_status: status, ...patch });
});

// ── POST /api/admin/vetting/:id/notify ─────────────────────────────────────
// Queue the notify-before-publish email FOR APPROVAL. This never sends.
//
// The rendered message is FROZEN into coldcall_email_approvals as 'pending'.
// Sending happens in exactly one place — the approve endpoint below, acting on
// a specific approved row — so "nothing sends without approval" is a property
// of the API, not a discipline the UI is trusted to keep.
//
// `preview: true` renders without queueing, for looking at the wording.
app.post("/vetting/:id/notify", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { preview?: unknown; to?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const previewOnly = body.preview === true;

  const cfg = await readConfig(supabase, [
    CONFIG_KEYS.siteUrl, CONFIG_KEYS.fromEmail, CONFIG_KEYS.fromName,
  ]);
  if (!cfg.ok) {
    return c.json(errBody(
      "not_configured",
      `missing config: ${cfg.missing.join(", ")} — apply migrations 127 and 128`,
      { missing: cfg.missing },
    ), 500);
  }

  const from = cfg.values[CONFIG_KEYS.fromEmail];
  const allowed = senderAllowed(from);
  if (!allowed.ok) {
    // Refused here too, not only at send: an operator must never be shown a
    // queued email that could never legitimately go out.
    return c.json(errBody("not_configured", allowed.reason), 500);
  }

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select("id, name, legal_name, trading_name, trade, city, state, rating, review_count, " +
            "dti_score, blurb, verified_year, slug, expires_at, is_comped, vetting_status, " +
            "notified_at, listing_consent, removal_token")
    .eq("id", id).maybeSingle();
  if (error) {
    log.error("[campaign] notify_read_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "notify_read_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);
  const lead = data as unknown as Record<string, unknown>;

  const token = (lead.removal_token as string | null) || removalToken();
  const site = cfg.values[CONFIG_KEYS.siteUrl].replace(/\/+$/, "");
  const urls = {
    siteUrl: site,
    profileUrl: lead.slug ? `${site}/contractor/${lead.slug}` : site,
    removeUrl: `${site}/remove/${token}`,
  };
  const mail = renderNotifyEmail(lead as unknown as NotifyLead, urls);

  let onRecord = "";
  const ce = await supabase.from("coldcall_leads").select("contact_email").eq("id", id).maybeSingle();
  if (!ce.error) onRecord = String((ce.data as { contact_email: string | null } | null)?.contact_email ?? "").trim();
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : onRecord;

  const warnings = [
    ...(to ? [] : ["This lead has no contact_email on record — supply `to`."]),
    ...(lead.vetting_status === "verified" ? [] : ["Not verified yet — the email describes a listing that does not exist."]),
    ...(lead.is_comped ? [] : ["Not marked as comped."]),
    ...(lead.notified_at ? [`Already notified at ${String(lead.notified_at)} — this would be a resend.`] : []),
  ];

  if (previewOnly) {
    return c.json({
      preview: true, queued: false, would_send_to: to || null,
      from: `${cfg.values[CONFIG_KEYS.fromName]} <${from}>`, urls, email: mail, warnings,
    });
  }

  if (!to) return c.json(errBody("bad_request", "no contact_email for this lead — supply `to`"), 400);

  // Mint the token now so the frozen body and the lead agree. The body is
  // stored as sent-ready; re-rendering later would change approved words.
  if (!lead.removal_token) {
    await supabase.from("coldcall_leads").update({ removal_token: token }).eq("id", id);
  }

  const { data: created, error: iErr } = await supabase
    .from("coldcall_email_approvals")
    .insert({
      lead_id: id, to_email: to, from_email: from,
      subject: mail.subject, body_text: mail.text, body_html: mail.html,
      removal_url: urls.removeUrl, profile_url: urls.profileUrl,
      requested_by_user_id: auth.user_id, requested_by_email: auth.email,
    })
    .select("id, status, to_email, subject, created_at")
    .single();
  if (iErr) {
    const e = iErr as { code?: string; message?: string };
    if (e.code === "23505") {
      return c.json(errBody("conflict", "an email for this lead is already awaiting approval"), 409);
    }
    log.error("[campaign] approval_insert_failed", { lead_id: id, err: e.message });
    return c.json(errBody("internal", "approval_insert_failed"), 500);
  }

  log.info("[campaign] notify_queued", { lead_id: id, approval_id: created.id, by: auth.email });
  return c.json({ preview: false, queued: true, approval: created, email: mail, urls, warnings }, 201);
});

// ── GET /api/admin/email-approvals ─────────────────────────────────────────
// The approval queue. Pending first, oldest first — this is a review list, not
// a log, so the thing waiting longest is the thing to look at.
app.get("/email-approvals", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const status = c.req.query("status");
  const ALLOWED = ["pending", "approved", "rejected", "sent", "failed"];
  if (status && !ALLOWED.includes(status)) {
    return c.json(errBody("bad_request", `unknown status '${status}'`), 400);
  }

  let q = supabase
    .from("coldcall_email_approvals")
    .select("id, lead_id, to_email, from_email, subject, body_text, removal_url, profile_url, " +
            "status, requested_by_email, created_at, approved_by_email, approved_at, " +
            "rejected_at, reject_reason, sent_at, send_error")
    .order("created_at", { ascending: true })
    .limit(200);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    log.error("[campaign] approvals_list_failed", { err: error.message });
    return c.json(errBody("internal", "approvals_list_failed"), 500);
  }

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  // Business names for the queue, in one query.
  const names: Record<string, string> = {};
  if (rows.length) {
    const { data: leads } = await supabase
      .from("coldcall_leads").select("id, name, trading_name, legal_name")
      .in("id", [...new Set(rows.map((r) => String(r.lead_id)))]);
    for (const l of (leads ?? []) as Array<Record<string, string | null>>) {
      names[String(l.id)] = l.trading_name || l.legal_name || l.name || "";
    }
  }

  return c.json({
    approvals: rows.map((r) => ({ ...r, business: names[String(r.lead_id)] ?? null })),
    total: rows.length,
    statuses: ALLOWED,
  });
});

// ── POST /api/admin/email-approvals/:id/approve ────────────────────────────
// THE ONLY PLACE ANYTHING IS SENT.
//
// Approval and send are one action on one specific row, so an approval can
// never be recorded for a message that was not then the message sent. The row
// must be 'pending'; anything else is a 409, which is what makes a double
// click safe.
app.post("/email-approvals/:id/approve", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("coldcall_email_approvals")
    .select("*").eq("id", id).maybeSingle();
  if (error) {
    log.error("[campaign] approve_read_failed", { approval_id: id, err: error.message });
    return c.json(errBody("internal", "approve_read_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "approval not found"), 404);
  const row = data as unknown as Record<string, unknown>;
  if (row.status !== "pending") {
    return c.json(errBody("conflict", `this email is '${String(row.status)}', not pending`, { status: row.status }), 409);
  }

  const allowed = senderAllowed(String(row.from_email));
  if (!allowed.ok) return c.json(errBody("not_configured", allowed.reason), 500);

  const gate = await readConfig(supabase, [CONFIG_KEYS.emailEnabled]);
  const emailEnabled = gate.ok ? gate.values[CONFIG_KEYS.emailEnabled] : undefined;
  const cfgName = await readConfig(supabase, [CONFIG_KEYS.fromName]);
  const fromName = cfgName.ok ? cfgName.values[CONFIG_KEYS.fromName] : "TrustLight";

  // Record the approval BEFORE attempting the send. If the send then fails,
  // the paper trail still shows who authorised it and when — which is the
  // question the log exists to answer.
  const approvedAt = new Date().toISOString();
  const { error: aErr } = await supabase
    .from("coldcall_email_approvals")
    .update({
      status: "approved", approved_at: approvedAt,
      approved_by_user_id: auth.user_id, approved_by_email: auth.email,
    })
    .eq("id", id).eq("status", "pending");
  if (aErr) {
    log.error("[campaign] approve_write_failed", { approval_id: id, err: aErr.message });
    return c.json(errBody("internal", "approve_write_failed"), 500);
  }

  // The FROZEN body is sent, never a re-render.
  const sent = await sendEmail(c.env, {
    to: String(row.to_email), subject: String(row.subject),
    text: String(row.body_text), html: String(row.body_html),
    from: String(row.from_email), fromName, replyTo: String(row.from_email),
  }, emailEnabled);

  if (!sent.ok) {
    await supabase.from("coldcall_email_approvals")
      .update({ status: "failed", send_error: sent.reason.slice(0, 500) }).eq("id", id);
    log.warn("[campaign] approved_but_not_sent", { approval_id: id, reason: sent.reason, by: auth.email });
    return c.json(errBody("upstream_error", `approved, but not sent: ${sent.reason}`, {
      approval_id: id, approved_by: auth.email, approved_at: approvedAt, status: "failed",
    }), 502);
  }

  const sentAt = new Date().toISOString();
  await supabase.from("coldcall_email_approvals")
    .update({ status: "sent", sent_at: sentAt }).eq("id", id);

  // Only a genuinely sent email stamps the lead. notified_at must mean "they
  // were told", not "we approved telling them".
  await supabase.from("coldcall_leads")
    .update({ notified_at: sentAt, listing_consent: "pending" })
    .eq("id", String(row.lead_id));

  await writeAudit(supabase, {
    lead_id: String(row.lead_id), actor_user_id: auth.user_id, actor_email: auth.email,
    field: "notified_at", old_value: null, new_value: sentAt,
    reason: `notify email approved and sent to ${String(row.to_email)}`,
  });

  log.info("[campaign] approved_and_sent", { approval_id: id, to: row.to_email, by: auth.email });
  return c.json({ approval_id: id, status: "sent", approved_by: auth.email, approved_at: approvedAt, sent_at: sentAt });
});

// ── POST /api/admin/email-approvals/:id/reject ─────────────────────────────
app.post("/email-approvals/:id/reject", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { reason?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  const { data, error } = await supabase
    .from("coldcall_email_approvals")
    .update({ status: "rejected", rejected_at: new Date().toISOString(), reject_reason: reason })
    .eq("id", id).eq("status", "pending")
    .select("id, status, lead_id, to_email").maybeSingle();
  if (error) {
    log.error("[campaign] reject_failed", { approval_id: id, err: error.message });
    return c.json(errBody("internal", "reject_failed"), 500);
  }
  if (!data) return c.json(errBody("conflict", "no pending email with that id"), 409);

  log.info("[campaign] approval_rejected", { approval_id: id, by: auth.email });
  return c.json({ approval_id: id, status: "rejected", rejected_by: auth.email, reason });
});

// ── POST /api/admin/vetting/:id/notified ───────────────────────────────────
// MANUAL consent tracking, for email sent by hand.
//
// The approval-queue send path is built but has no screens yet (parked), so
// the first 50 are being emailed personally. This records that: it stamps
// notified_at and sets listing_consent to what the business actually said.
//
// Deliberately SEPARATE from the automated notify endpoint. That one stamps
// notified_at only on a genuinely sent email; this one is an operator saying
// "I emailed them myself". Both write the audit log, and the audit reason
// distinguishes them — otherwise a hand-sent email and a system-sent one
// would be indistinguishable later, and "were they told?" is the question
// this whole record exists to answer.
app.post("/vetting/:id/notified", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  let body: { listing_consent?: unknown; notified_at?: unknown; note?: unknown; clear_notified?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const CONSENTS = ["pending", "granted", "declined"];
  const consent = body.listing_consent === null ? null : String(body.listing_consent ?? "");
  if (consent !== null && !CONSENTS.includes(consent)) {
    return c.json(errBody("bad_request", `listing_consent must be one of ${CONSENTS.join("|")} or null`), 400);
  }

  // A supplied date lets an operator record an email sent last week rather
  // than being forced to claim it went out just now.
  let notifiedAt: string | null = new Date().toISOString();
  if (body.clear_notified === true) {
    notifiedAt = null;
  } else if (typeof body.notified_at === "string" && body.notified_at.trim()) {
    const d = new Date(body.notified_at);
    if (Number.isNaN(d.getTime())) {
      return c.json(errBody("bad_request", "notified_at is not a valid date"), 400);
    }
    if (d.getTime() > Date.now() + 60_000) {
      return c.json(errBody("bad_request", "notified_at cannot be in the future"), 400);
    }
    notifiedAt = d.toISOString();
  }

  const { data: current, error: rErr } = await supabase
    .from("coldcall_leads")
    .select("id, notified_at, listing_consent, is_comped, vetting_status")
    .eq("id", id).maybeSingle();
  if (rErr) {
    log.error("[campaign] notified_read_failed", { lead_id: id, err: rErr.message });
    return c.json(errBody("internal", "notified_read_failed"), 500);
  }
  if (!current) return c.json(errBody("not_found", "lead not found"), 404);
  const row = current as { notified_at: string | null; listing_consent: string | null };

  const patch: Record<string, unknown> = { notified_at: notifiedAt, listing_consent: consent };
  // A business that declines is not listed. Recording the decline and leaving
  // the listing up would make the record a lie.
  if (consent === "declined") {
    patch.is_published = false;
    patch.vetting_status = "removed";
    patch.removal_requested_at = new Date().toISOString();
  }

  const { data: updated, error: uErr } = await supabase
    .from("coldcall_leads").update(patch).eq("id", id)
    .select("id, notified_at, listing_consent, is_published, vetting_status").maybeSingle();
  if (uErr) {
    log.error("[campaign] notified_update_failed", { lead_id: id, err: uErr.message });
    return c.json(errBody("internal", "notified_update_failed"), 500);
  }

  const note = typeof body.note === "string" && body.note.trim() ? ` — ${body.note.trim()}` : "";
  if (String(row.notified_at ?? "") !== String(notifiedAt ?? "")) {
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "notified_at", old_value: row.notified_at, new_value: notifiedAt,
      reason: `manual: emailed by hand${note}`,
    });
  }
  if (String(row.listing_consent ?? "") !== String(consent ?? "")) {
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "listing_consent", old_value: row.listing_consent, new_value: consent,
      reason: `manual: recorded by ${auth.email}${note}`,
    });
  }
  if (consent === "declined") {
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "vetting_status", old_value: String((current as { vetting_status: string }).vetting_status),
      new_value: "removed", reason: `manual: business declined the listing${note}`,
    });
  }

  log.info("[campaign] notified_manual", { lead_id: id, consent, by: auth.email });
  return c.json({ lead: updated, consents: CONSENTS });
});

// ── POST /api/admin/vetting/:id/removal-link ───────────────────────────────
// Mint (or return) the one-click removal link for a record, so it can be
// pasted into a hand-written email.
//
// IDEMPOTENT: a lead keeps the same token once minted, so a link already sent
// to a business never stops working because someone opened this again.
app.post("/vetting/:id/removal-link", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");

  const cfg = await readConfig(supabase, [CONFIG_KEYS.siteUrl]);
  if (!cfg.ok) {
    // Load-bearing: a wrong base URL means handing a business an opt-out link
    // that does not work.
    return c.json(errBody("not_configured", `missing config: ${cfg.missing.join(", ")}`), 500);
  }

  const { data, error } = await supabase
    .from("coldcall_leads").select("id, name, trading_name, legal_name, removal_token")
    .eq("id", id).maybeSingle();
  if (error) {
    log.error("[campaign] removal_link_read_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "removal_link_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "lead not found"), 404);
  const row = data as unknown as Record<string, string | null>;

  let token = row.removal_token;
  let minted = false;
  if (!token) {
    token = removalToken();
    const { error: uErr } = await supabase
      .from("coldcall_leads").update({ removal_token: token }).eq("id", id);
    if (uErr) {
      log.error("[campaign] removal_token_mint_failed", { lead_id: id, err: uErr.message });
      return c.json(errBody("internal", "removal_link_failed"), 500);
    }
    minted = true;
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "removal_token", old_value: null, new_value: "(minted)",
      reason: "removal link generated for a hand-written email",
    });
  }

  const site = cfg.values[CONFIG_KEYS.siteUrl].replace(/\/+$/, "");
  return c.json({
    id,
    business: row.trading_name || row.legal_name || row.name,
    removal_url: `${site}/remove/${token}`,
    // The test-side page, so the flow is clickable before trustlight.com has one.
    test_removal_url: `https://textos-web-test.pages.dev/remove/${token}`,
    minted,
  });
});

// ── POST /api/admin/vetting/comp-sweep ─────────────────────────────────────
// Drop comped listings whose grace period has run out, so a free listing ends
// deliberately rather than persisting silently.
//
// Clock starts at the OFFER, not at verification — see compGraceDeadline().
// A comped business we have never made an offer to is never swept.
//
// Exposed as an endpoint rather than only a cron so it is runnable and
// testable on demand; `dry_run` reports what it would drop without touching
// anything.
app.post("/vetting/comp-sweep", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");

  let body: { confirm?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const confirm = body.confirm === true;

  const cfg = await readConfig(supabase, [CONFIG_KEYS.graceDays]);
  if (!cfg.ok) return c.json(errBody("not_configured", "comp_grace_days is not set"), 500);
  const graceDays = parseInt(cfg.values[CONFIG_KEYS.graceDays], 10);

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select("id, name, trading_name, comp_offered_at, comp_offer_status, is_published, vetting_status")
    .eq("is_comped", true).eq("comp_offer_status", "offered");
  if (error) {
    log.error("[campaign] sweep_read_failed", { err: error.message });
    return c.json(errBody("internal", "sweep_read_failed"), 500);
  }

  const now = new Date();
  const due = ((data ?? []) as unknown as Array<Record<string, unknown>>).filter((r) => {
    const d = compGraceDeadline(r as { comp_offered_at: string | null }, graceDays);
    return !!d && d <= now && r.vetting_status !== "removed";
  });

  if (!confirm) {
    return c.json({
      dry_run: true, grace_days: graceDays, would_drop: due.length,
      leads: due.map((r) => ({ id: r.id, name: r.trading_name || r.name, offered_at: r.comp_offered_at })),
    });
  }

  const dropped: string[] = [];
  for (const r of due) {
    const id = String(r.id);
    const { error: uErr } = await supabase.from("coldcall_leads")
      .update({ vetting_status: "removed", is_published: false }).eq("id", id);
    if (uErr) { log.error("[campaign] sweep_drop_failed", { lead_id: id, err: uErr.message }); continue; }
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "vetting_status", old_value: String(r.vetting_status), new_value: "removed",
      reason: `auto: comp grace period of ${graceDays} days expired without conversion`,
    });
    dropped.push(id);
  }

  log.info("[campaign] sweep_done", { grace_days: graceDays, dropped: dropped.length, by: auth.email });
  return c.json({ dry_run: false, grace_days: graceDays, dropped: dropped.length, ids: dropped });
});

// ── POST /api/admin/vetting/:id/exclusivity ────────────────────────────────
// Claim an area for one verified business.
//
// Refuses rather than clobbers. An ACTIVE claim held by somebody else is never
// taken away here — that is a commercial decision, not a form submission. An
// EXPIRED claim is released first, because 126 defines expiry as freeing the
// slot and the index cannot do it on its own.
app.post("/vetting/:id/exclusivity", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");
  const nowIso = new Date().toISOString();

  let body: { trade?: unknown; county?: unknown; state?: unknown; exclusive_until?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(errBody("bad_request", "body must be JSON"), 400);
  }

  const area = normalizeArea(body);
  if ("error" in area) return c.json(errBody("bad_request", area.error), 400);
  const until = parseUntil(body.exclusive_until, nowIso);
  if ("error" in until) return c.json(errBody("bad_request", until.error), 400);

  const { data: leadRow } = await supabase
    .from("coldcall_leads")
    .select("id, name, trading_name, legal_name, plan, vetting_status, expires_at, " +
            "exclusive_trade, exclusive_county, exclusive_state, exclusive_until")
    .eq("id", id).maybeSingle();
  if (!leadRow) return c.json(errBody("not_found", "lead not found"), 404);
  const lead = leadRow as unknown as ExclusiveRow & { expires_at?: string | null };

  const blocked = blocksClaim(lead);
  if (blocked) return c.json(errBody("conflict", blocked), 409);

  const claims = await loadClaims(supabase);
  if (!claims.ok) {
    log.error("[exclusivity] claims_read_failed", { err: claims.message });
    return c.json(errBody("internal", "claims_read_failed"), 500);
  }

  const holder = findHolder(claims.rows, area);
  if (holder && holder.id !== id) {
    const state = claimState(holder, nowIso);
    if (state === "active") {
      // The clean message the brief asks for, in place of a raw 23505.
      return c.json(errBody("conflict",
        `${areaLabel(area)} is already held by ${holderName(holder)} until ` +
        `${String(holder.exclusive_until).slice(0, 10)}. Release that claim first, or pick another area.`,
        { held_by: holder.id, holder: holderName(holder), until: holder.exclusive_until, claim_state: state },
      ), 409);
    }
    // Expired: 126 says an ended claim frees the area. Do it explicitly and
    // audit it, so the area does not appear to be taken by a dead claim.
    const prevArea = rowArea(holder) as Area;
    const { error: relErr } = await supabase.from("coldcall_leads").update(AREA_FIELDS).eq("id", holder.id);
    if (relErr) {
      log.error("[exclusivity] expired_release_failed", { lead_id: holder.id, err: relErr.message });
      return c.json(errBody("internal", "could not release the expired claim on this area"), 500);
    }
    await writeAudit(supabase, {
      lead_id: String(holder.id), actor_user_id: auth.user_id, actor_email: auth.email,
      field: "exclusive_area", old_value: areaKey(prevArea), new_value: null,
      reason: `expired ${String(holder.exclusive_until).slice(0, 10)} — released so ${areaLabel(area)} could be reassigned`,
    });
  }

  const previous = rowArea(lead);
  const { error } = await supabase.from("coldcall_leads").update({
    plan: "exclusive",
    exclusive_trade: area.trade,
    exclusive_county: area.county,
    exclusive_state: area.state,
    exclusive_until: until.until,
  }).eq("id", id);

  if (error) {
    // Backstop for the race the index exists to catch: two operators claiming
    // the same area between the check above and this write.
    if (isAreaConflict(error)) {
      return c.json(errBody("conflict",
        `${areaLabel(area)} was claimed by another business a moment ago. Reload the area board and try again.`,
      ), 409);
    }
    log.error("[exclusivity] claim_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "claim_failed"), 500);
  }

  await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "exclusive_area",
    old_value: previous ? areaKey(previous) : null,
    new_value: areaKey(area),
    reason: `exclusivity granted until ${until.until.slice(0, 10)}`,
  });
  if (lead.plan !== "exclusive") {
    await writeAudit(supabase, {
      lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
      field: "plan", old_value: String(lead.plan ?? "none"), new_value: "exclusive",
      reason: `set by an exclusivity claim on ${areaLabel(area)}`,
    });
  }

  // Exclusivity riding past the verification it depends on is not refused —
  // it is a legitimate longer contract — but it is worth saying out loud,
  // because the index drops the claim the moment the record stops being
  // verified.
  const warnings = lead.expires_at && until.until > lead.expires_at
    ? [`This claim runs past the verification expiry (${String(lead.expires_at).slice(0, 10)}). ` +
       "If the record is not re-verified by then it stops being verified and the area frees itself."]
    : [];

  log.info("[exclusivity] claimed", { lead_id: id, area: areaKey(area), by: auth.email });
  return c.json({
    id, plan: "exclusive", trade: area.trade, county: area.county, state: area.state,
    exclusive_until: until.until, claim_state: "active",
    days_left: daysUntil(until.until, new Date()), label: areaLabel(area), warnings,
  });
});

// ── POST /api/admin/vetting/:id/exclusivity/release ────────────────────────
// Give the area back. Clears the four area fields, which is exactly what the
// index predicate needs to stop counting this row as the holder.
//
// plan is deliberately NOT changed. Whether somebody is still paying is a
// billing fact, and silently downgrading it here would also re-fire the
// plan trigger. The UI says so, and the plan control is one row away.
app.post("/vetting/:id/exclusivity/release", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const auth = c.get("auth");
  const id = c.req.param("id");
  let body: { reason?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  const { data: leadRow } = await supabase
    .from("coldcall_leads")
    .select("id, name, trading_name, legal_name, plan, vetting_status, " +
            "exclusive_trade, exclusive_county, exclusive_state, exclusive_until")
    .eq("id", id).maybeSingle();
  if (!leadRow) return c.json(errBody("not_found", "lead not found"), 404);
  const lead = leadRow as unknown as ExclusiveRow;

  const area = rowArea(lead);
  if (!area) return c.json(errBody("conflict", "this business does not hold an area"), 409);
  const wasState = claimState(lead, new Date().toISOString());

  const { error } = await supabase.from("coldcall_leads").update(AREA_FIELDS).eq("id", id);
  if (error) {
    log.error("[exclusivity] release_failed", { lead_id: id, err: error.message });
    return c.json(errBody("internal", "release_failed"), 500);
  }

  await writeAudit(supabase, {
    lead_id: id, actor_user_id: auth.user_id, actor_email: auth.email,
    field: "exclusive_area", old_value: areaKey(area), new_value: null,
    reason: reason || `released by ${auth.email} (was ${wasState})`,
  });

  log.info("[exclusivity] released", { lead_id: id, area: areaKey(area), by: auth.email });
  return c.json({
    id, released: true, label: areaLabel(area), was: wasState, plan: lead.plan ?? "none",
    note: "The area is free. The commercial plan was left as it was — change it on the plan control if this is a downgrade.",
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
  contact_email:      { type: "email", max: 200 },   // INTERNAL — never published
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
  if (spec.type === "email") {
    const v = String(raw).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, message: `${key} must be an email address` };
    if (spec.max && v.length > spec.max) return { ok: false, message: `${key} is too long` };
    return { ok: true, value: v };
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


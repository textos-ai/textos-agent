// =============================================================
// TrustLight — PUBLIC directory API.
// Mounted at /api, so the live paths are:
//   GET /api/directory/featured    homepage teaser, verified only
//   GET /api/directory/search      the search page, paginated
//   GET /api/contractor/:slug      one verified public profile
//   GET /api/removal/:token        who a removal link belongs to (read-only)
//   POST /api/removal/:token       one-click removal, no login
//   POST /api/application          a contractor applies to be verified
// trustlight.com/api/* routes here.
//
// PUBLIC AND UNAUTHENTICATED BY NECESSITY, exactly like routes/sites.ts and
// routes/coldcall-demo.ts: trustlight.com is a static site read by storm-
// affected families. There is no login and there must not be one.
//
// This file deliberately has NO `app.use("*", requireAuth)`. That is why it is
// a separate router from coldcall.ts / admin-coldcall.ts, whose blanket guards
// would otherwise authenticate everything added to them. Do not merge them.
//
// There is deliberately NO plain /api/directory any more. It served the
// homepage teaser and the search page at once, which meant an unfiltered call
// returned a slab of the lead table. The two jobs have different shapes and
// different risks, so they are two endpoints; neither can return the database.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// coldcall_leads holds third-party PII for ~15,822 businesses we scraped and
// cold-called: phone numbers, call notes, enrichment signals, internal scores.
// Almost none of it may ever leave the database.
//
// Every read here therefore uses an EXPLICIT COLUMN WHITELIST and an explicit
// re-projection into the response shape. There is no `select("*")` and no
// spread of a database row into JSON anywhere in this file. Adding a column to
// coldcall_leads must never silently widen a public response — if you want a
// new public field you have to add it in two places on purpose.
//
// Brief non-negotiables enforced here:
//   1. Only vetting_status='verified' is ever presented as verified.
//   2. 'failed' is never publicly identifiable — a failed business is simply
//      absent. There is no "not approved" state in any response.
//   3. The unvetted list carries no implication and returns exactly four
//      neutral fields, stripped server-side.
//   4. Nothing internal crosses this boundary.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";
import {
  APPLICATION_RATE, HONEYPOT_FIELD, MATCH_REASON, applicationPatch,
  licenseKey, newLeadColumns, validateApplication, type MatchKey,
} from "../lib/trustlight-application";
// The public shape lives in one place so the admin preview and this route are
// literally the same code — see lib/trustlight-public.ts.
import {
  VERIFIED_COLS, PROFILE_COLS, UNVETTED_COLS,
  shapeVerified, shapeUnvetted, shapeProfile, publishable,
  HOME_TRADE_CATEGORIES, canonicalTrade, nameSearchOr,
  type VerifiedRow, type ProfileRow,
} from "../lib/trustlight-public";

const app = new Hono<{ Bindings: Env }>();

// Column whitelists, row shaping and the publishability rule all come from
// lib/trustlight-public.ts. They are NOT redefined here: the admin profile
// preview imports the same functions, which is what guarantees the preview
// and the live response cannot disagree.

// Homepage grid: 9 fills a 3x3, and a 4x2 simply renders the first 8.
const FEATURED_COUNT = 9;
// Pool pulled before the one-per-trade pass. Comfortably larger than the grid
// so variety is possible without a second round trip.
const FEATURED_POOL = 100;

const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 75;

// ── Rate limiting ───────────────────────────────────────────────────────────
// Fixed 60s window per IP, in KV. KV is eventually consistent and caps writes
// per key per second, so this is a coarse abuse brake, NOT a precise quota —
// which is the right shape here: these endpoints sit behind a 5-minute CDN
// cache, so genuine traffic mostly never reaches the Worker at all. Fails
// OPEN: a KV outage must not take the public directory down.
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX_PER_WINDOW = 120;

async function rateLimited(env: Env, ip: string, bucket: string): Promise<boolean> {
  if (!env.SNAPSHOT_KV || !ip) return false;
  const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SECONDS);
  const key = `tl_rl:${bucket}:${ip}:${window}`;
  try {
    const current = parseInt((await env.SNAPSHOT_KV.get(key)) ?? "0", 10);
    if (current >= RATE_MAX_PER_WINDOW) return true;
    await env.SNAPSHOT_KV.put(key, String(current + 1), {
      expirationTtl: RATE_WINDOW_SECONDS * 2,
    });
    return false;
  } catch (err) {
    log.warn("[trustlight] rate_limit_unavailable", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}


/**
 * Rate limit for the WRITE endpoint.
 *
 * Same KV mechanism and the same coarse fixed window as rateLimited() above,
 * with one deliberate difference: this one reports failure instead of
 * swallowing it. The reads fail OPEN so a KV outage cannot take the public
 * directory down; an unauthenticated write that fails open during an outage
 * accepts unlimited rows, so the caller turns that into a 503.
 */
async function writeRateLimited(
  env: Env, ip: string, bucket: string, windowSeconds: number, max: number,
): Promise<"ok" | "limited" | "unavailable"> {
  if (!env.SNAPSHOT_KV) return "unavailable";
  // No IP means no way to attribute the request, so it cannot be rate limited.
  if (!ip) return "unavailable";
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `tl_rl:${bucket}:${ip}:${window}`;
  try {
    const current = parseInt((await env.SNAPSHOT_KV.get(key)) ?? "0", 10);
    if (current >= max) return "limited";
    await env.SNAPSHOT_KV.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
    return "ok";
  } catch (err) {
    log.warn("[trustlight] write_rate_limit_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "";

/** Strip characters that would break PostgREST's filter grammar. */
const clean = (v: string | undefined) => (v ?? "").trim().replace(/[%,()*]/g, "").slice(0, 80);

// ── GET /api/directory/featured ─────────────────────────────────────────────
// Homepage only. No parameters, no unvetted, no pagination.
//
// SELECTION STRATEGY: one per trade, best first.
// A pool of the highest-DTI publishable businesses is fetched, then reduced to
// the best single entry per trade, then the grid is topped up from the
// remaining pool if fewer than FEATURED_COUNT distinct trades exist.
//
// Chosen over "most recently verified" (which would make the homepage churn
// and would front-load whichever trade we happened to onboard last) and over
// plain "highest DTI" (which could show nine roofers). A family arriving after
// a flood should see the range of help available, not one trade nine times.
app.get("/directory/featured", async (c) => {
  if (await rateLimited(c.env, clientIp(c), "feat")) {
    return c.json(errBody("rate_limited", "too many requests"), 429);
  }

  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();

  const { data, error } = await publishable(
    supabase.from("coldcall_leads").select(VERIFIED_COLS), nowIso,
  )
    .order("dti_score", { ascending: false, nullsFirst: false })
    .order("rating", { ascending: false, nullsFirst: false })
    .limit(FEATURED_POOL);

  if (error) {
    log.error("[trustlight] featured_failed", { err: error.message });
    return c.json(errBody("internal", "directory_unavailable"), 500);
  }

  const pool = (data ?? []) as unknown as VerifiedRow[];
  const seen = new Set<string>();
  const picked: VerifiedRow[] = [];
  for (const r of pool) {
    const key = (r.trade ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(r);
    if (picked.length === FEATURED_COUNT) break;
  }
  // Top up if there are fewer distinct trades than grid slots, so the homepage
  // is never a half-empty grid.
  if (picked.length < FEATURED_COUNT) {
    for (const r of pool) {
      if (picked.includes(r)) continue;
      picked.push(r);
      if (picked.length === FEATURED_COUNT) break;
    }
  }

  c.header("Cache-Control", "public, max-age=300, s-maxage=600");
  return c.json({
    generated_at: nowIso,
    strategy: "one_per_trade_by_dti",
    featured: picked.map(shapeVerified),
  });
});

// ── GET /api/directory/search ───────────────────────────────────────────────
// The search page. Filters: state, county, trade, city, q. Paginated.
//
// PAGINATION IS OVER ONE ORDERED STREAM: every verified result precedes every
// unvetted one, then that single stream is sliced by page. So page 1 is
// verified until they run out, and unvetted only begin once they do. Verified
// is the featured tier, not just another row — including across page breaks.
//
// A page is ALWAYS capped at per_page. There is no parameter that returns the
// table, filtered or not.
app.get("/directory/search", async (c) => {
  if (await rateLimited(c.env, clientIp(c), "search")) {
    return c.json(errBody("rate_limited", "too many requests"), 429);
  }

  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();

  const state = clean(c.req.query("state"));
  const county = clean(c.req.query("county"));
  // "roofer" is what a family types; "roofing contractor" is what we store.
  // The filter is a case-insensitive EQUALS, so without this the obvious word
  // matches nothing at all. See TRADE_SYNONYMS.
  //
  // BOTH forms are kept. The scraped `category` column uses one vocabulary and
  // the curated `trade` column on a verified record uses whatever an operator
  // typed - "Plumbing" rather than "plumber". Canonicalising alone would make
  // a verified business unfindable by the very word that now finds the
  // unvetted ones, so the verified side matches either form.
  const tradeRaw = clean(c.req.query("trade"));
  const trade = canonicalTrade(tradeRaw);
  const city = clean(c.req.query("city"));
  const q = clean(c.req.query("q"));

  const pageRaw = parseInt(c.req.query("page") ?? "", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const ppRaw = parseInt(c.req.query("per_page") ?? "", 10);
  const perPage = Math.min(PER_PAGE_MAX, Number.isFinite(ppRaw) && ppRaw > 0 ? ppRaw : PER_PAGE_DEFAULT);
  const offset = (page - 1) * perPage;

  // ilike with no wildcards is a case-insensitive equals — forgiving for a
  // dropdown value that may not match the stored casing.
  const applyVerified = <T extends { ilike: Function }>(qq: T): T => {
    let x = qq as T & Record<string, Function>;
    if (state) x = x.ilike("state", state);
    if (county) x = x.ilike("parish", county);
    if (trade) {
      x = trade.toLowerCase() === tradeRaw.toLowerCase()
        ? x.ilike("trade", trade)
        : x.or(`trade.ilike."${trade}",trade.ilike."${tradeRaw}"`);
    }
    if (city) x = x.ilike("city", city);
    // All three name columns, not just trading_name: a business whose card
    // shows a name drawn from legal_name could not previously be found by
    // searching the name it displays.
    if (q) x = x.or(nameSearchOr(q));
    return x as T;
  };
  // Unvetted has no curated trade, so the trade filter matches the scraped
  // category, and the name search matches the scraped name.
  //
  // The category restriction is NOT optional and is applied before any filter:
  // 12,191 of the 15,822 scraped rows are dentists, salons, lawyers and car
  // washes, and surfacing them on a page that calls them contractors is worse
  // than showing nothing. See HOME_TRADE_CATEGORIES.
  const applyUnvetted = <T extends { ilike: Function }>(qq: T): T => {
    let x = qq as T & Record<string, Function>;
    x = x.in("category", HOME_TRADE_CATEGORIES as unknown as string[]);
    if (state) x = x.ilike("state", state);
    if (county) x = x.ilike("parish", county);
    if (trade) x = x.ilike("category", trade);
    if (city) x = x.ilike("city", city);
    if (q) x = x.ilike("name", `%${q}%`);
    return x as T;
  };

  // Counts first: they decide how the page splits between the two tiers.
  const { count: vCount, error: vcErr } = await applyVerified(
    publishable(supabase.from("coldcall_leads").select("id", { count: "exact", head: true }), nowIso),
  );
  if (vcErr) {
    log.error("[trustlight] search_verified_count_failed", { err: vcErr.message });
    return c.json(errBody("internal", "directory_unavailable"), 500);
  }
  const { count: uCount, error: ucErr } = await applyUnvetted(
    supabase.from("coldcall_leads").select("id", { count: "exact", head: true })
      .eq("vetting_status", "lead").not("name", "is", null),
  );
  if (ucErr) {
    log.error("[trustlight] search_unvetted_count_failed", { err: ucErr.message });
    return c.json(errBody("internal", "directory_unavailable"), 500);
  }

  const totalVerified = vCount ?? 0;
  const totalUnvetted = uCount ?? 0;

  // Slice the single stream: verified first, then unvetted.
  const vTake = Math.max(0, Math.min(perPage, totalVerified - offset));
  const vFrom = Math.min(offset, totalVerified);
  const uTake = perPage - vTake;
  const uFrom = Math.max(0, offset - totalVerified);

  let verified: ReturnType<typeof shapeVerified>[] = [];
  if (vTake > 0) {
    const { data, error } = await applyVerified(
      publishable(supabase.from("coldcall_leads").select(VERIFIED_COLS), nowIso),
    )
      .order("dti_score", { ascending: false, nullsFirst: false })
      .order("rating", { ascending: false, nullsFirst: false })
      .order("slug", { ascending: true })          // stable tiebreak across pages
      .range(vFrom, vFrom + vTake - 1);
    if (error) {
      log.error("[trustlight] search_verified_failed", { err: error.message });
      return c.json(errBody("internal", "directory_unavailable"), 500);
    }
    verified = ((data ?? []) as unknown as VerifiedRow[]).map(shapeVerified);
  }

  let unvetted: Array<{ name: string | null; trade: string; city: string | null; state: string | null }> = [];
  if (uTake > 0) {
    const { data, error } = await applyUnvetted(
      supabase.from("coldcall_leads").select(UNVETTED_COLS)
        .eq("vetting_status", "lead").not("name", "is", null),
    )
      .order("name", { ascending: true })
      .range(uFrom, uFrom + uTake - 1);
    if (error) {
      log.error("[trustlight] search_unvetted_failed", { err: error.message });
      return c.json(errBody("internal", "directory_unavailable"), 500);
    }
    // Exactly four fields, built explicitly — not a filtered copy of the row.
    unvetted = ((data ?? []) as unknown as Array<{
      name: string | null; category: string | null; city: string | null; state: string | null;
    }>).map(shapeUnvetted);
  }

  c.header("Cache-Control", "public, max-age=300, s-maxage=600");
  return c.json({
    generated_at: nowIso,
    page,
    per_page: perPage,
    total_verified: totalVerified,
    total_unvetted: totalUnvetted,
    verified,
    unvetted,
  });
});

// ── GET /api/contractor/:slug ───────────────────────────────────────────────
// Full public profile for ONE verified contractor. Anything not verified,
// not published, or expired is a 404 — never a different status, because a
// distinguishable response would make a failed verification identifiable.
app.get("/contractor/:slug", async (c) => {
  if (await rateLimited(c.env, clientIp(c), "prof")) {
    return c.json(errBody("rate_limited", "too many requests"), 429);
  }

  const slug = c.req.param("slug");
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json(errBody("not_found", "not found"), 404);
  }

  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();

  const { data, error } = await publishable(
    supabase.from("coldcall_leads").select(PROFILE_COLS).eq("slug", slug), nowIso,
  ).maybeSingle();

  if (error) {
    log.error("[trustlight] profile_failed", { slug, err: error.message });
    return c.json(errBody("internal", "profile_unavailable"), 500);
  }
  if (!data) return c.json(errBody("not_found", "not found"), 404);

  c.header("Cache-Control", "public, max-age=300, s-maxage=600");
  return c.json({
    generated_at: nowIso,
    contractor: shapeProfile(data as unknown as ProfileRow),
  });
});

// ── One-click removal ───────────────────────────────────────────────────────
// A comped business is listed without ever asking to be, so leaving must be
// trivial: a link in the email, no login, no reply.
//
// SPLIT INTO GET + POST DELIBERATELY. The obvious design — a GET link that
// removes on click — is unsafe in email: Gmail, Outlook and corporate security
// scanners fetch links in messages to check them, which would silently delete
// listings nobody asked to remove. So the GET is read-only and safe to
// prefetch, and the POST behind a single button does the work. It is still one
// click for the recipient.
app.get("/removal/:token", async (c) => {
  const token = c.req.param("token");
  if (!token || !/^[a-f0-9]{48}$/.test(token)) {
    return c.json(errBody("not_found", "not found"), 404);
  }
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("coldcall_leads")
    .select("trading_name, legal_name, name, city, state, vetting_status, removal_requested_at")
    .eq("removal_token", token).maybeSingle();
  if (error) {
    log.error("[trustlight] removal_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "removal_unavailable"), 500);
  }
  if (!data) return c.json(errBody("not_found", "not found"), 404);

  const r = data as unknown as Record<string, unknown>;
  // Only what the page needs to say "Remove <name>?" — no internal fields.
  return c.json({
    name: r.trading_name || r.legal_name || r.name,
    city: r.city, state: r.state,
    already_removed: r.vetting_status === "removed",
    removed_at: r.removal_requested_at ?? null,
  });
});

app.post("/removal/:token", async (c) => {
  const token = c.req.param("token");
  if (!token || !/^[a-f0-9]{48}$/.test(token)) {
    return c.json(errBody("not_found", "not found"), 404);
  }
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("coldcall_leads")
    .select("id, trading_name, legal_name, name, vetting_status")
    .eq("removal_token", token).maybeSingle();
  if (error) {
    log.error("[trustlight] removal_read_failed", { err: error.message });
    return c.json(errBody("internal", "removal_unavailable"), 500);
  }
  if (!data) return c.json(errBody("not_found", "not found"), 404);
  const r = data as unknown as { id: string; vetting_status: string; trading_name: string | null; legal_name: string | null; name: string | null };

  const nowIso = new Date().toISOString();
  const { error: uErr } = await supabase.from("coldcall_leads").update({
    vetting_status: "removed",
    is_published: false,
    listing_consent: "declined",
    removal_requested_at: nowIso,
  }).eq("id", r.id);
  if (uErr) {
    log.error("[trustlight] removal_failed", { lead_id: r.id, err: uErr.message });
    return c.json(errBody("internal", "removal_failed"), 500);
  }

  // Audited like any other status change, with no actor: this was the business
  // itself, not an operator.
  await supabase.from("coldcall_vetting_audit").insert({
    lead_id: r.id, field: "vetting_status",
    old_value: r.vetting_status, new_value: "removed",
    reason: "self-service: removal link in the notify email",
  });

  log.info("[trustlight] self_removed", { lead_id: r.id });
  return c.json({
    removed: true,
    name: r.trading_name || r.legal_name || r.name,
    removed_at: nowIso,
  });
});

export default app;


// ── POST /api/application ──────────────────────────────────────────────────
// A contractor applies to be verified. Replaces the Formspree form on
// trustlight.com/start.
//
// THE ONLY UNAUTHENTICATED WRITE IN THE PRODUCT. Everything below follows
// from that:
//
//   - It sets vetting_status='invited' and fills fields for an operator to
//     CHECK. It never touches a chk_* field, never stamps verified_at, never
//     publishes. Nothing here can make a business verified.
//   - The reply is identical whether the submission matched an existing lead,
//     updated one, or created a new record. Saying "we found you" would turn
//     this into an oracle for probing the lead database one licence at a time.
//   - The rate limiter fails CLOSED, unlike the public reads. For a read,
//     failing open keeps the directory up during a KV outage; for a write,
//     failing open means unlimited row creation. A contractor who sees "try
//     again shortly" is recoverable. A filled lead table is not.
//   - No email. Nothing is notified. Applications are worked by hand in
//     /admin/trustlight-vetting.
app.post("/application", async (c) => {
  const ip = clientIp(c);

  // Two windows, both required. Per-minute stops a burst; per-hour stops a
  // slow drip that would never trip the minute bucket.
  for (const [bucket, seconds, max] of [
    ["app_m", 60, APPLICATION_RATE.perMinute],
    ["app_h", 3600, APPLICATION_RATE.perHour],
  ] as Array<[string, number, number]>) {
    const limited = await writeRateLimited(c.env, ip, bucket, seconds, max);
    if (limited === "limited") {
      return c.json(errBody("rate_limited", "too many applications from this address — please try again later"), 429);
    }
    if (limited === "unavailable") {
      log.error("[trustlight] application_rate_unavailable", { ip_present: !!ip });
      return c.json(errBody("internal",
        "we cannot accept applications right now — please try again shortly"), 503);
    }
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json(errBody("bad_request", "body must be a JSON object"), 400);
  }

  // Honeypot: hidden on the page, so a human never fills it. Answered with the
  // same 202 a real submission gets — telling a bot it was detected only helps
  // it try again differently.
  const honey = body[HONEYPOT_FIELD];
  if (typeof honey === "string" && honey.trim() !== "") {
    log.warn("[trustlight] application_honeypot", { ip_present: !!ip });
    return c.json({ received: true }, 202);
  }

  const validated = validateApplication(body);
  if (!validated.ok) {
    // Field errors ARE returned: the applicant has to be able to fix their own
    // form. This says nothing about the database, only about what they sent.
    return c.json(errBody("bad_request", "some details need fixing", { errors: validated.errors }), 400);
  }
  const v = validated.value;
  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();

  // ── The match ladder ─────────────────────────────────────────────────────
  // Licence first, as specified. Licence numbers are only unique within a
  // state, so the state is part of the key. Compared on a collapsed form
  // because contractors write their own licence a dozen different ways.
  let matched: { id: string; vetting_status: string | null } | null = null;
  let how: MatchKey = "new";

  const { data: licRows, error: licErr } = await supabase
    .from("coldcall_leads")
    .select("id, vetting_status, license_number")
    .eq("license_state", v.fields.license_state)
    .not("license_number", "is", null)
    .limit(500);
  if (licErr) {
    log.error("[trustlight] application_licence_lookup_failed", { err: licErr.message });
    return c.json(errBody("internal", "could not process the application"), 500);
  }
  for (const r of (licRows ?? []) as Array<{ id: string; vetting_status: string | null; license_number: string }>) {
    if (licenseKey(r.license_number) === v.licenseCompare) {
      matched = { id: r.id, vetting_status: r.vetting_status };
      how = "licence";
      break;
    }
  }

  // Then phone. 91% of leads carry normalised digits, which is why this is the
  // key that will actually catch duplicates today — licence numbers are filled
  // in DURING vetting, so almost no lead has one yet.
  if (!matched) {
    const { data: phoneRows, error: phoneErr } = await supabase
      .from("coldcall_leads")
      .select("id, vetting_status")
      .eq("phone_e164_digits", v.phoneDigits)
      .limit(2);
    if (phoneErr) {
      log.error("[trustlight] application_phone_lookup_failed", { err: phoneErr.message });
      return c.json(errBody("internal", "could not process the application"), 500);
    }
    const rows = (phoneRows ?? []) as Array<{ id: string; vetting_status: string | null }>;
    // Exactly one, or it is not a match. Two businesses sharing a phone number
    // is a real thing (shared office, answering service), and picking one at
    // random would attach an application to the wrong company.
    if (rows.length === 1) {
      matched = rows[0];
      how = "phone";
    } else if (rows.length > 1) {
      log.info("[trustlight] application_phone_ambiguous", { digits_len: v.phoneDigits.length });
    }
  }

  const patch = applicationPatch(v, nowIso);
  let leadId: string;
  let previousStatus: string | null = null;

  if (matched) {
    previousStatus = matched.vetting_status ?? null;
    leadId = matched.id;
    // A business already part-way through verification must not be dragged
    // back to 'invited' by re-submitting the form. Their details are still
    // updated; their progress is not discarded.
    const inProgress = previousStatus && previousStatus !== "lead" && previousStatus !== "invited";
    const finalPatch = inProgress
      ? (() => { const { vetting_status, ...rest } = patch; return rest; })()
      : patch;
    const { error } = await supabase.from("coldcall_leads").update(finalPatch).eq("id", leadId);
    if (error) {
      log.error("[trustlight] application_update_failed", { lead_id: leadId, err: error.message });
      return c.json(errBody("internal", "could not process the application"), 500);
    }
  } else {
    const { data: created, error } = await supabase
      .from("coldcall_leads")
      .insert({ ...newLeadColumns(v), ...patch })
      .select("id").single();
    if (error || !created) {
      log.error("[trustlight] application_insert_failed", { err: error?.message });
      return c.json(errBody("internal", "could not process the application"), 500);
    }
    leadId = (created as { id: string }).id;
  }

  // The paper trail. No actor: this was the business itself, not an operator —
  // the same convention the self-service removal link uses.
  const { error: aErr } = await supabase.from("coldcall_vetting_audit").insert({
    lead_id: leadId,
    field: "vetting_status",
    old_value: previousStatus,
    new_value: "invited",
    reason: MATCH_REASON[how],
  });
  if (aErr) {
    // The record is already written; refusing now would lose the application
    // AND the trail. Logged loudly instead so it is visible in wrangler tail.
    log.error("[trustlight] application_audit_failed", { lead_id: leadId, err: aErr.message });
  }

  log.info("[trustlight] application_received", { lead_id: leadId, matched_on: how });

  // Deliberately uniform. No id, no match information, no hint that the
  // business was already known to us.
  return c.json({
    received: true,
    message: "Thank you — your application has been received. We verify by hand, so this is not instant.",
  }, 202);
});

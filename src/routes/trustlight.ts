// =============================================================
// TrustLight — PUBLIC directory API.
// Mounted at /api, so the live paths are:
//   GET /api/directory/featured    homepage teaser, verified only
//   GET /api/directory/search      the search page, paginated
//   GET /api/contractor/:slug      one verified public profile
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

const app = new Hono<{ Bindings: Env }>();

// ── Column whitelists ───────────────────────────────────────────────────────
// The ONLY columns that may be read for a public response. Reviewed as a unit:
// if a column is not on one of these lists it cannot reach the internet.
const VERIFIED_COLS =
  "slug, legal_name, trading_name, name, trade, city, state, parish, " +
  "rating, review_count, dti_score, blurb, verified_year, plan, exclusive_until";

const PROFILE_COLS =
  VERIFIED_COLS + ", services, years_in_business, license_state, verified_at, expires_at, " +
  "dti_findability, dti_answerability, dti_responsiveness, dti_completeness, dti_compliance, " +
  "chk_licensing_board, chk_license, chk_insurance, chk_business_filing, chk_court_records, " +
  "chk_address, chk_years_in_business, chk_contact, chk_reviews";

// Unvetted rows expose FOUR fields and nothing else. Note `category`, not
// `trade`: an unvetted business has no curated trade, so the scraped Google
// category is shown — it is a neutral descriptor, not a judgement.
const UNVETTED_COLS = "name, category, city, state";

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

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "";

// ── Shaping ─────────────────────────────────────────────────────────────────
type VerifiedRow = {
  slug: string | null; legal_name: string | null; trading_name: string | null; name: string | null;
  trade: string | null; city: string | null; state: string | null; parish: string | null;
  rating: number | null; review_count: number | null; dti_score: number | null;
  blurb: string | null; verified_year: number | null;
  plan: string | null; exclusive_until: string | null;
};

/** Public display name: the curated names win; the scraped one is the last resort. */
const displayName = (r: VerifiedRow) => r.trading_name || r.legal_name || r.name || "";

const isExclusive = (r: VerifiedRow) =>
  r.plan === "exclusive" && !!r.exclusive_until && new Date(r.exclusive_until) > new Date();

/**
 * Re-project a verified row into the published shape. EXPLICIT field by field —
 * never a spread — so a new database column cannot leak by accident.
 * Identical 12-field shape on both endpoints, so the site renders one card.
 */
function shapeVerified(r: VerifiedRow) {
  return {
    slug: r.slug,
    name: displayName(r),
    trade: r.trade,
    city: r.city,
    state: r.state,
    county: r.parish,
    rating: r.rating,
    reviews: r.review_count,
    dti: r.dti_score,
    blurb: r.blurb,
    verified_year: r.verified_year,
    exclusive: isExclusive(r),
  };
}

/** Title-case a scraped category ("general contractor" -> "General Contractor"). */
const titleCase = (s: string | null) =>
  (s ?? "").split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

/** Strip characters that would break PostgREST's filter grammar. */
const clean = (v: string | undefined) => (v ?? "").trim().replace(/[%,()*]/g, "").slice(0, 80);

/**
 * The three conditions that make a row publishable, applied identically
 * everywhere. Kept as one function so a future endpoint cannot forget one:
 * verified, published (the separate publish toggle), and unexpired.
 */
function publishable<T extends { eq: Function; gt: Function; not: Function }>(q: T, nowIso: string): T {
  return q.eq("vetting_status", "verified").eq("is_published", true).gt("expires_at", nowIso) as T;
}

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
    .not("slug", "is", null)
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
  const trade = clean(c.req.query("trade"));
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
    if (trade) x = x.ilike("trade", trade);
    if (city) x = x.ilike("city", city);
    if (q) x = x.ilike("trading_name", `%${q}%`);
    return x as T;
  };
  // Unvetted has no curated trade, so the trade filter matches the scraped
  // category, and the name search matches the scraped name.
  const applyUnvetted = <T extends { ilike: Function }>(qq: T): T => {
    let x = qq as T & Record<string, Function>;
    if (state) x = x.ilike("state", state);
    if (county) x = x.ilike("parish", county);
    if (trade) x = x.ilike("category", trade);
    if (city) x = x.ilike("city", city);
    if (q) x = x.ilike("name", `%${q}%`);
    return x as T;
  };

  // Counts first: they decide how the page splits between the two tiers.
  const { count: vCount, error: vcErr } = await applyVerified(
    publishable(supabase.from("coldcall_leads").select("id", { count: "exact", head: true }), nowIso)
      .not("slug", "is", null),
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
      publishable(supabase.from("coldcall_leads").select(VERIFIED_COLS), nowIso).not("slug", "is", null),
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
    }>).map((r) => ({
      name: r.name,
      trade: titleCase(r.category),
      city: r.city,
      state: r.state,
    }));
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

  const r = data as unknown as VerifiedRow & {
    services: string[] | null; years_in_business: number | null; license_state: string | null;
    verified_at: string | null; expires_at: string | null;
    dti_findability: number | null; dti_answerability: number | null;
    dti_responsiveness: number | null; dti_completeness: number | null; dti_compliance: number | null;
    [k: string]: unknown;
  };

  // Verification summary: WHICH checks passed, and the date. Never the notes,
  // and never anything about a check that did not pass — a 'fail' or 'na' is
  // simply absent from `passed`, so the response cannot be read as an accusation.
  const CHECK_LABELS: Record<string, string> = {
    chk_licensing_board: "State licensing board record",
    chk_license: "License verified",
    chk_insurance: "Insurance confirmed with carrier",
    chk_business_filing: "Business filing confirmed",
    chk_court_records: "Court records reviewed",
    chk_address: "Address confirmed",
    chk_years_in_business: "Years in business confirmed",
    chk_contact: "Contact details confirmed",
    chk_reviews: "Review audit completed",
  };
  const passed = Object.keys(CHECK_LABELS)
    .filter((k) => r[k] === "pass")
    .map((k) => CHECK_LABELS[k]);

  c.header("Cache-Control", "public, max-age=300, s-maxage=600");
  return c.json({
    generated_at: nowIso,
    contractor: {
      ...shapeVerified(r),
      services: Array.isArray(r.services) ? r.services : [],
      years_in_business: r.years_in_business,
      license_state: r.license_state,
      dti_pillars: {
        findability: r.dti_findability,
        answerability: r.dti_answerability,
        responsiveness: r.dti_responsiveness,
        completeness: r.dti_completeness,
        compliance: r.dti_compliance,
      },
      verification: {
        verified_at: r.verified_at,
        expires_at: r.expires_at,
        checks_passed: passed,
        checks_total: Object.keys(CHECK_LABELS).length,
      },
    },
  });
});

export default app;

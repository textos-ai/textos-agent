// =============================================================
// TrustLight — PUBLIC directory API.
// Mounted at /api, so the live paths are /api/directory and
// /api/contractor/:slug. trustlight.com/api/* routes here.
//
// PUBLIC AND UNAUTHENTICATED BY NECESSITY, exactly like routes/sites.ts and
// routes/coldcall-demo.ts: trustlight.com is a static site read by storm-
// affected families. There is no login and there must not be one.
//
// This file deliberately has NO `app.use("*", requireAuth)`. That is why it is
// a separate router from coldcall.ts / admin-coldcall.ts, whose blanket guards
// would otherwise authenticate everything added to them. Do not merge them.
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

// Result caps. Unfiltered, `unvetted` would be ~15,800 rows — several MB and
// well past what a Worker should serialise. The site filters by city/trade, so
// these ceilings are generous for real use and are reported in the response.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// ── Rate limiting ───────────────────────────────────────────────────────────
// Fixed 60s window per IP, in KV. KV is eventually consistent and caps writes
// per key per second, so this is a coarse abuse brake, NOT a precise quota —
// which is the right shape here: the endpoint sits behind a 5-minute CDN cache,
// so genuine traffic mostly never reaches the Worker at all. Fails OPEN: a KV
// outage must not take the public directory down.
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

// ── GET /api/directory ──────────────────────────────────────────────────────
app.get("/directory", async (c) => {
  if (await rateLimited(c.env, clientIp(c), "dir")) {
    return c.json(errBody("rate_limited", "too many requests"), 429);
  }

  const supabase = createSupabaseClient(c.env);
  const nowIso = new Date().toISOString();

  // Strip the characters that would break PostgREST's filter grammar rather
  // than interpolating user input into a filter string.
  const clean = (v: string | undefined) => (v ?? "").trim().replace(/[%,()*]/g, "").slice(0, 80);
  const state = clean(c.req.query("state"));
  const county = clean(c.req.query("county"));
  const trade = clean(c.req.query("trade"));
  const q = clean(c.req.query("q"));

  const limRaw = parseInt(c.req.query("limit") ?? "", 10);
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limRaw) && limRaw > 0 ? limRaw : DEFAULT_LIMIT);

  // ── verified ──
  // vetting_status='verified' AND not expired AND published. is_published is a
  // deliberate second gate (brief section 5: "a publish toggle separate from
  // verified status"), and it only means anything if the public read honours
  // it — otherwise completing the checks would publish instantly.
  let vq = supabase
    .from("coldcall_leads")
    .select(VERIFIED_COLS)
    .eq("vetting_status", "verified")
    .eq("is_published", true)
    .gt("expires_at", nowIso)
    .not("slug", "is", null)
    .order("dti_score", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (state) vq = vq.eq("state", state);
  if (county) vq = vq.eq("parish", county);
  if (trade) vq = vq.ilike("trade", trade);
  if (q) vq = vq.ilike("trading_name", `%${q}%`);

  const { data: vData, error: vErr } = await vq;
  if (vErr) {
    log.error("[trustlight] directory_verified_failed", { err: vErr.message });
    return c.json(errBody("internal", "directory_unavailable"), 500);
  }

  // ── unvetted ──
  // ONLY vetting_status='lead'. Every other state — invited, in_verification,
  // failed, suspended, declined, removed — is absent from both lists. A
  // business mid-verification must not be visible, and a business that failed
  // must never be publicly identifiable as having failed.
  let uq = supabase
    .from("coldcall_leads")
    .select(UNVETTED_COLS)
    .eq("vetting_status", "lead")
    .not("name", "is", null)
    .order("name", { ascending: true })
    .limit(limit);
  if (state) uq = uq.eq("state", state);
  if (county) uq = uq.eq("parish", county);
  if (trade) uq = uq.ilike("category", trade);
  if (q) uq = uq.ilike("name", `%${q}%`);

  const { data: uData, error: uErr } = await uq;
  if (uErr) {
    log.error("[trustlight] directory_unvetted_failed", { err: uErr.message });
    return c.json(errBody("internal", "directory_unavailable"), 500);
  }

  const verified = ((vData ?? []) as unknown as VerifiedRow[]).map(shapeVerified);

  // Exactly four fields, built explicitly. Not a filtered copy of the row.
  const unvetted = ((uData ?? []) as unknown as Array<{
    name: string | null; category: string | null; city: string | null; state: string | null;
  }>).map((r) => ({
    name: r.name,
    trade: titleCase(r.category),
    city: r.city,
    state: r.state,
  }));

  c.header("Cache-Control", "public, max-age=300, s-maxage=600");
  return c.json({
    generated_at: nowIso,
    verified,
    unvetted,
    // Honest about truncation rather than silently returning a partial list.
    limit,
    truncated: { verified: verified.length >= limit, unvetted: unvetted.length >= limit },
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

  const { data, error } = await supabase
    .from("coldcall_leads")
    .select(PROFILE_COLS)
    .eq("slug", slug)
    .eq("vetting_status", "verified")
    .eq("is_published", true)
    .gt("expires_at", nowIso)
    .maybeSingle();

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

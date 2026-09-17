// End-to-end verification of the TrustLight public API against the DEPLOYED
// test worker, over real HTTP, with no authentication (as the public site).
//
// Covers the two-endpoint split:
//   GET /api/directory/featured   homepage teaser, verified only, no params
//   GET /api/directory/search     paginated, verified stream before unvetted
//   GET /api/contractor/:slug     one public profile
//
// NOTE: prod and dev share this database. This promotes SEVEN real leads into
// vetting states, asserts, then restores every column it touched and verifies
// the restoration. Nothing is left behind.
//
// The assertions that matter most are negative: that a business mid-verification
// is invisible, that a failed one is not publicly identifiable, and that no PII
// crosses the boundary. Those are checked against the RAW response text, not a
// parsed object, so a leak anywhere in the payload is caught.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const AGENT = "https://textos-agent-test.rgaudet2023.workers.dev";

const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fails = 0;
const ok = (label, pass, extra = "") => {
  if (!pass) fails++;
  console.log(`  ${label.padEnd(60)} ${pass ? "PASS" : "*** FAIL ***"} ${extra}`);
};

const CHECKS = [
  "chk_licensing_board", "chk_license", "chk_insurance", "chk_business_filing",
  "chk_court_records", "chk_address", "chk_years_in_business", "chk_contact", "chk_reviews",
];
const TOUCHED = [
  "vetting_status", "slug", "is_published", "verified_at", "verified_year", "expires_at",
  "legal_name", "trading_name", "trade", "blurb", "services", "years_in_business",
  "license_state", "license_number", "gl_carrier", "dti_score", "dti_findability",
  "dti_answerability", "dti_responsiveness", "dti_completeness", "dti_compliance",
  "plan", "exclusive_until", "exclusive_trade", "exclusive_county", "exclusive_state",
  // Contact fields: published on the profile, so the fixture sets them and the
  // restore has to put them back. `phone` is absent deliberately - the test
  // reads the row's existing phone rather than writing one.
  "website_url", "address", "zip", "google_profile_url", "contact_email", "contact_name",
  ...CHECKS, ...CHECKS.map((c) => `${c}_note`),
];
const SECRET_NOTE = "INTERNAL-NOTE-MUST-NEVER-BE-PUBLIC-8823";
// The owner's personal details. Given to us for verification, never published:
// publishing them would put a private inbox on the open web to be scraped.
const SECRET_EMAIL = "e2e-owner-private-8823@example.invalid";
const SECRET_CONTACT = "E2E Private Owner 8823";
const PROFILE_CONTACT_FIELDS = ["phone", "website", "google_profile", "address"].sort();

// The allow-list as the public sees it (shapeUnvetted title-cases the stored
// lowercase category). Anything outside this set must never reach the public
// directory: 12,191 of 15,822 scraped rows are dentists, salons and car washes.
const HOME_TRADES_STORED = new Set([
  "general contractor", "roofing contractor", "plumber", "electrician",
  "hvac contractor", "painter", "landscaper", "tree service", "gutter service",
  "fence contractor", "foundation repair", "garage door repair", "pest control",
  "pressure washing", "locksmith", "moving company",
]);
const HOME_TRADES_DISPLAY = new Set([
  "General Contractor", "Roofing Contractor", "Plumber", "Electrician",
  "Hvac Contractor", "Painter", "Landscaper", "Tree Service", "Gutter Service",
  "Fence Contractor", "Foundation Repair", "Garage Door Repair", "Pest Control",
  "Pressure Washing", "Locksmith", "Moving Company",
]);
const VERIFIED_FIELDS = ["slug","name","trade","city","state","county","rating","reviews","dti","blurb","verified_year","exclusive"].sort();

// Four verified subjects across DISTINCT trades, so one-per-trade is testable.
const TRADES = ["Roofing", "Plumbing", "Electrical", "Foundation Repair"];

const { data: victims, error: vErr } = await db
  .from("coldcall_leads")
  .select("id, name, phone, city, state, parish, category")
  .eq("vetting_status", "lead").not("phone", "is", null).not("city", "is", null)
  .order("id", { ascending: true }).range(0, 6);   // window 0-6; see the map in patch notes
if (vErr) { console.error("pick failed:", vErr.message); process.exit(1); }
if ((victims ?? []).length < 7) { console.error("need 7 lead-status rows"); process.exit(1); }

const LIVE = victims.slice(0, 4);            // verified + published, 4 trades
const [MIDWAY, FAILED, UNPUB] = victims.slice(4);
console.log("test subjects:");
LIVE.forEach((v, i) => console.log(`  LIVE[${i}] ${TRADES[i].padEnd(18)} ${v.name}`));
console.log(`  MIDWAY  (in_verification)    ${MIDWAY.name}`);
console.log(`  FAILED  (failed)             ${FAILED.name}`);
console.log(`  UNPUB   (verified, unpub'd)  ${UNPUB.name}\n`);

const before = {};
for (const v of victims) {
  const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
  before[v.id] = data;
}

const passAll = Object.fromEntries(CHECKS.map((c) => [c, "pass"]));
const notesAll = Object.fromEntries(CHECKS.map((c) => [`${c}_note`, SECRET_NOTE]));
const yearNow = new Date().getFullYear();
const plusYear = new Date(Date.now() + 365 * 864e5).toISOString();
const SLUGS = LIVE.map((_, i) => `e2e-trustlight-live-${i}-8823`);
const SLUG_UNPUB = "e2e-trustlight-unpub-8823";

const get = async (path) => {
  const r = await fetch(`${AGENT}${path}`);
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: r.status, headers: r.headers, raw, json };
};

try {
  for (let i = 0; i < LIVE.length; i++) {
    await db.from("coldcall_leads").update({
      ...passAll, ...notesAll,
      vetting_status: "verified", is_published: true, slug: SLUGS[i],
      verified_at: new Date().toISOString(), verified_year: yearNow, expires_at: plusYear,
      legal_name: `E2E ${TRADES[i]} LLC`, trading_name: `E2E ${TRADES[i]} Co.`, trade: TRADES[i],
      blurb: "Storm damage and repair.", services: ["Emergency repair", "Full replacement"],
      years_in_business: 12, license_state: "LA", license_number: `LIC-E2E-882${i}`,
      gl_carrier: "Acme Mutual",
      website_url: `https://e2e-${i}-8823.example.invalid`,
      address: `${100 + i} E2E Test Street`, zip: `7000${i}`,
      google_profile_url: `https://maps.example.invalid/e2e-${i}-8823`,
      contact_email: SECRET_EMAIL, contact_name: SECRET_CONTACT,
      dti_score: 95 - i, dti_findability: 90, dti_answerability: 85,
      dti_responsiveness: 88, dti_completeness: 92, dti_compliance: 84,
      plan: i === 0 ? "exclusive" : "verification",
      exclusive_trade: i === 0 ? "Roofing" : null,
      exclusive_county: i === 0 ? LIVE[0].parish : null,
      exclusive_state: i === 0 ? LIVE[0].state : null,
      exclusive_until: i === 0 ? plusYear : null,
    }).eq("id", LIVE[i].id);
  }
  await db.from("coldcall_leads").update({
    vetting_status: "in_verification", chk_license: "pass", chk_license_note: SECRET_NOTE,
  }).eq("id", MIDWAY.id);
  await db.from("coldcall_leads").update({
    vetting_status: "failed", chk_license: "fail", chk_license_note: SECRET_NOTE,
  }).eq("id", FAILED.id);
  await db.from("coldcall_leads").update({
    ...passAll, vetting_status: "verified", is_published: false, slug: SLUG_UNPUB,
    verified_at: new Date().toISOString(), verified_year: yearNow, expires_at: plusYear,
    trading_name: "E2E Unpublished Co.", trade: "Roofing",
  }).eq("id", UNPUB.id);

  // ── 1. the old endpoint is gone ──
  console.log("1. The unfiltered /api/directory is retired");
  const old = await get("/api/directory");
  ok("GET /api/directory -> 404", old.status === 404, `status=${old.status}`);

  // ── 2. featured ──
  console.log("\n2. GET /api/directory/featured");
  const f = await get("/api/directory/featured");
  ok("200", f.status === 200, `status=${f.status}`);
  ok("Cache-Control public/300/600",
    /max-age=300/.test(f.headers.get("cache-control") ?? "") &&
    /s-maxage=600/.test(f.headers.get("cache-control") ?? ""), f.headers.get("cache-control"));
  const feat = f.json?.featured ?? [];
  ok("returns at most 9", feat.length > 0 && feat.length <= 9, `${feat.length}`);
  ok("NO unvetted anywhere on the homepage payload",
    !("unvetted" in (f.json ?? {})) && !/unvetted/.test(f.raw));
  ok("reports its selection strategy", f.json?.strategy === "one_per_trade_by_dti", f.json?.strategy);
  if (feat[0]) {
    ok("featured card has EXACTLY the 12 documented fields",
      JSON.stringify(Object.keys(feat[0]).sort()) === JSON.stringify(VERIFIED_FIELDS),
      JSON.stringify(Object.keys(feat[0]).sort()));
  }
  const featTrades = feat.map((x) => x.trade);
  // The contract is "distinct trades FIRST, then top up". A duplicate may only
  // appear after every distinct trade in the pool has already been used —
  // otherwise the grid would be half empty. Asserting strict uniqueness would
  // be asserting a guarantee the endpoint deliberately does not make.
  const firstDupAt = featTrades.findIndex((t, i) => featTrades.indexOf(t) !== i);
  const distinctCount = new Set(featTrades).size;
  ok("distinct trades come first, duplicates only after they run out",
    firstDupAt === -1 || firstDupAt >= distinctCount,
    `firstDup@${firstDupAt} distinct=${distinctCount} ${JSON.stringify(featTrades)}`);
  ok("all four seeded trades are represented",
    TRADES.every((t) => featTrades.includes(t)), JSON.stringify(featTrades));
  ok("highest DTI leads the grid", feat[0]?.dti === 95, String(feat[0]?.dti));
  ok("exclusive flag resolves", feat.find((x) => x.slug === SLUGS[0])?.exclusive === true);

  // ── 3. search: shape + pagination metadata ──
  console.log("\n3. GET /api/directory/search");
  const s1 = await get("/api/directory/search?per_page=2&page=1");
  ok("200", s1.status === 200, `status=${s1.status}`);
  for (const k of ["generated_at", "page", "per_page", "total_verified", "total_unvetted", "verified", "unvetted"]) {
    ok(`has ${k}`, k in (s1.json ?? {}));
  }
  // Computed live: other verified records may exist from real click-throughs.
  const nowIso = new Date().toISOString();
  const { count: publishable } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true })
    .eq("vetting_status", "verified").eq("is_published", true)
    .gt("expires_at", nowIso)
    // Same required-field rule the public API applies (REQUIRED_PUBLIC_FIELDS).
    .not("slug", "is", null).not("trade", "is", null)
    .not("city", "is", null).not("state", "is", null);
  ok("total_verified counts exactly the publishable rows",
    s1.json?.total_verified === publishable, `${s1.json?.total_verified} vs ${publishable}`);
  ok("the four seeded records are among them", publishable >= 4, String(publishable));
  // Computed live, not hardcoded: seeded vetting fixtures move leads out of
  // the 'lead' pool, so a fixed number goes stale the moment anything enters
  // the queue.
  //
  // Scoped to HOME_TRADE_CATEGORIES, because the unvetted tier is no longer
  // the whole lead table - 12,191 of the 15,822 scraped rows are dentists,
  // salons, lawyers and car washes and are deliberately not surfaced on a page
  // that calls them contractors. Without the .in() this compares against the
  // pre-allow-list world and reports 4,143 vs 15,811.
  const { count: leadPool } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true })
    .eq("vetting_status", "lead").not("name", "is", null)
    .in("category", [...HOME_TRADES_STORED]);
  ok("total_unvetted matches the live home-trade lead pool", s1.json?.total_unvetted === leadPool,
    `${s1.json?.total_unvetted} vs ${leadPool}`);
  ok("page 1 of 2 is verified only", s1.json?.verified.length === 2 && s1.json?.unvetted.length === 0,
    `v=${s1.json?.verified.length} u=${s1.json?.unvetted.length}`);

  const s2 = await get("/api/directory/search?per_page=2&page=2");
  ok("page 2 continues the verified stream", s2.json?.verified.length === 2 && s2.json?.unvetted.length === 0,
    `v=${s2.json?.verified.length} u=${s2.json?.unvetted.length}`);
  const p1 = s1.json.verified.map((x) => x.slug), p2 = s2.json.verified.map((x) => x.slug);
  ok("no overlap between page 1 and page 2", !p1.some((x) => p2.includes(x)), `${p1} vs ${p2}`);
  ok("all four verified seen across pages 1-2",
    SLUGS.every((sl) => [...p1, ...p2].includes(sl)), JSON.stringify([...p1, ...p2]));

  // The first page PAST the verified block must be unvetted-only. Which page
  // that is depends on how many verified records exist, so it is derived.
  // With an ODD number of verified records the boundary page legitimately
  // holds the last verified AND the first unvetted, which is the stream
  // working. Assert on the first page entirely PAST the verified block.
  const firstUnvettedPage = Math.ceil(publishable / 2) + 1;
  const s3 = await get(`/api/directory/search?per_page=2&page=${firstUnvettedPage}`);
  ok("the page past the verified block is unvetted-only — verified came FIRST",
    s3.json?.verified.length === 0 && s3.json?.unvetted.length === 2,
    `page ${firstUnvettedPage}: v=${s3.json?.verified.length} u=${s3.json?.unvetted.length}`);
  // And every page before it is verified-only.
  // The last page that is ENTIRELY inside the verified block — floor, not
  // firstUnvettedPage-1, which with an odd count is the mixed boundary page.
  const lastAllVerifiedPage = Math.max(1, Math.floor(publishable / 2));
  const sMid = await get(`/api/directory/search?per_page=2&page=${lastAllVerifiedPage}`);
  ok("the page before it is verified-only", sMid.json?.unvetted.length === 0,
    `u=${sMid.json?.unvetted.length}`);

  console.log("\n4. Caps and stripping");
  const big = await get("/api/directory/search?per_page=500");
  ok("per_page is capped at 75", big.json?.per_page === 75, String(big.json?.per_page));
  ok("a page never exceeds per_page",
    (big.json?.verified.length ?? 0) + (big.json?.unvetted.length ?? 0) <= 75,
    `${(big.json?.verified.length ?? 0) + (big.json?.unvetted.length ?? 0)}`);
  ok("no unfiltered dump — far below the 15,822 lead table",
    (big.json?.verified.length ?? 0) + (big.json?.unvetted.length ?? 0) < 100);
  const u0 = big.json?.unvetted?.[0];
  ok("unvetted entry has EXACTLY 4 fields",
    u0 && JSON.stringify(Object.keys(u0).sort()) === JSON.stringify(["city","name","state","trade"]),
    JSON.stringify(u0 ? Object.keys(u0) : null));

  // ── 5. the negative assertions, on BOTH endpoints ──
  console.log("\n5. Nothing that must not be public, is");
  for (const [label, resp] of [["featured", f], ["search", big]]) {
    const names = [
      ...((resp.json?.featured ?? resp.json?.verified) ?? []).map((v) => v.name),
      ...((resp.json?.unvetted ?? [])).map((v) => v.name),
    ];
    ok(`${label}: in_verification business absent`, !names.includes(MIDWAY.name));
    ok(`${label}: failed business absent`, !names.includes(FAILED.name));
    ok(`${label}: unpublished verified absent`, !resp.raw.includes(SLUG_UNPUB));
    ok(`${label}: no failed/not-approved wording`, !/not.?approved|"failed"|suspended|declined/i.test(resp.raw));
    ok(`${label}: internal note never appears`, !resp.raw.includes(SECRET_NOTE));
    ok(`${label}: no phone number`, !resp.raw.includes(String(LIVE[0].phone)));
    ok(`${label}: no website`, !resp.raw.includes("e2e-0-8823.example.invalid"));
    ok(`${label}: no street address`, !resp.raw.includes("E2E Test Street"));
    ok(`${label}: no google profile`, !resp.raw.includes("maps.example.invalid"));
    ok(`${label}: no lead UUID`, !resp.raw.includes(LIVE[0].id) && !resp.raw.includes(FAILED.id));
    ok(`${label}: no licence number`, !/LIC-E2E-882/.test(resp.raw));
    ok(`${label}: no carrier`, !resp.raw.includes("Acme Mutual"));
    for (const key of ["phone", "call_score", "hijack_flag", "assigned_to", "chk_", "_note", "legal_name", "gl_carrier", "stripe_"]) {
      ok(`${label}: no "${key}" key`, !resp.raw.includes(`"${key}`));
    }
  }

  // ── 6. filters ──
  console.log("\n6. Filters");
  const fState = await get(`/api/directory/search?state=${encodeURIComponent(LIVE[0].state)}&per_page=75`);
  ok("state filter keeps a seeded verified", fState.json.verified.some((v) => SLUGS.includes(v.slug)));
  const fTrade = await get("/api/directory/search?trade=Plumbing&per_page=75");
  ok("trade filter narrows to that trade",
    fTrade.json.verified.every((v) => v.trade === "Plumbing") && fTrade.json.verified.length >= 1,
    JSON.stringify(fTrade.json.verified.map((v) => v.trade)));
  const fCity = await get(`/api/directory/search?city=${encodeURIComponent(LIVE[0].city)}&per_page=75`);
  ok("city filter works (new param)", fCity.json.total_verified >= 1, String(fCity.json.total_verified));
  const fQ = await get("/api/directory/search?q=E2E%20Electrical&per_page=75");
  ok("q matches on trading name", fQ.json.verified.some((v) => v.trade === "Electrical"));
  // The home-trade allow-list.
  const fAll = await get("/api/directory/search?per_page=75");
  const offList = (fAll.json.unvetted ?? []).filter((u) => !HOME_TRADES_DISPLAY.has(u.trade));
  ok("unvetted tier is restricted to home trades", offList.length === 0,
    JSON.stringify([...new Set(offList.map((u) => u.trade))].slice(0, 8)));
  ok("non-home businesses are excluded from the count",
    fAll.json.total_unvetted > 0 && fAll.json.total_unvetted < 6000,
    `total_unvetted=${fAll.json.total_unvetted}`);

  // Trade synonyms: the stored category is "roofing contractor", and before
  // this mapping the obvious word a family types matched nothing at all.
  const fRoofer = await get("/api/directory/search?trade=roofer&per_page=75");
  ok("trade=roofer resolves to roofing contractor", fRoofer.json.total_unvetted > 0,
    `total_unvetted=${fRoofer.json.total_unvetted}`);
  ok("every roofer result really is one",
    (fRoofer.json.unvetted ?? []).every((u) => u.trade === "Roofing Contractor"),
    JSON.stringify([...new Set((fRoofer.json.unvetted ?? []).map((u) => u.trade))]));
  const fAc = await get("/api/directory/search?trade=ac&per_page=75");
  ok("trade=ac resolves to hvac contractor",
    (fAc.json.unvetted ?? []).every((u) => u.trade === "Hvac Contractor") &&
    fAc.json.total_unvetted > 0, `total_unvetted=${fAc.json.total_unvetted}`);
  const fExact = await get("/api/directory/search?trade=roofing%20contractor&per_page=75");
  ok("an unmapped exact category still matches",
    fExact.json.total_unvetted === fRoofer.json.total_unvetted,
    `exact=${fExact.json.total_unvetted} synonym=${fRoofer.json.total_unvetted}`);

  // q across all three name columns. "LLC" is in the fixture's legal_name
  // only - trading_name ends "Co." - so a hit proves legal_name is searched.
  const fLegal = await get("/api/directory/search?q=LLC&per_page=75");
  ok("q matches on legal_name, not just trading_name",
    (fLegal.json.verified ?? []).some((v) => SLUGS.includes(v.slug)),
    JSON.stringify((fLegal.json.verified ?? []).map((v) => v.slug).slice(0, 4)));

  const fNone = await get("/api/directory/search?state=ZZ&per_page=75");
  ok("bogus state yields nothing in either tier",
    fNone.json.total_verified === 0 && fNone.json.verified.length === 0);

  // ── 7. profile ──
  console.log("\n7. GET /api/contractor/:slug");
  const p = await get(`/api/contractor/${SLUGS[0]}`);
  ok("200 for a live slug", p.status === 200, `status=${p.status}`);
  ok("nine checks reported passed", p.json?.contractor?.verification?.checks_passed?.length === 9);
  ok("checks_total is 9", p.json?.contractor?.verification?.checks_total === 9);
  // The five pillars are GONE from the public shape. Nothing ever populated
  // them and three of the five cannot be computed from anything we collect;
  // publishing empty numbers under a trust badge is worse than publishing
  // none. One measured score replaces them.
  ok("no dti_pillars in the public profile", p.json?.contractor?.dti_pillars === undefined);
  for (const k of ["dti_findability", "dti_answerability", "dti_responsiveness",
                   "dti_completeness", "dti_compliance"]) {
    ok(`profile: no "${k}" key`, !p.raw.includes(`"${k}`));
  }

  // THE DTI MUST NEVER BE THE INTERNAL SALES SCORE.
  // They are computed from overlapping signals. If the published score ever
  // equals call_score, a public card has become a window onto the internal
  // sales ranking - so this is asserted on every verified record, not just
  // the one the fixture seeds.
  const allPub = await get("/api/directory/search?per_page=75");
  for (const v of (allPub.json.verified ?? [])) {
    if (v.dti === null || v.dti === undefined) continue;
    const { data: internal } = await db.from("coldcall_leads")
      .select("call_score").eq("slug", v.slug).maybeSingle();
    ok(`${v.slug}: dti does not equal call_score`,
      internal?.call_score === null || v.dti !== internal?.call_score,
      `dti=${v.dti} call_score=${internal?.call_score}`);
  }
  ok("no call_score key anywhere in the profile", !p.raw.includes('"call_score'));

  // A record we could not probe scores NULL, never 0. A zero under a trust
  // badge reads as a verdict on the business.
  const unscored = (allPub.json.verified ?? []).filter((v) => v.dti === null);
  ok("unprobed records carry dti null, not 0",
    unscored.every((v) => v.dti === null) && !(allPub.json.verified ?? []).some((v) => v.dti === 0),
    `${unscored.length} of ${(allPub.json.verified ?? []).length} unscored`);
  // Contact IS published here - a homeowner has to be able to reach a verified
  // contractor. This is the one endpoint where that is true.
  const contact = p.json?.contractor?.contact;
  ok("profile carries a contact block", !!contact);
  ok("contact has exactly the expected keys",
    JSON.stringify(Object.keys(contact ?? {}).sort()) === JSON.stringify(PROFILE_CONTACT_FIELDS),
    JSON.stringify(Object.keys(contact ?? {}).sort()));
  ok("contact publishes the display phone", contact?.phone === LIVE[0].phone,
    String(contact?.phone));
  ok("contact publishes the website", contact?.website === "https://e2e-0-8823.example.invalid");
  ok("contact publishes the Google profile",
    contact?.google_profile === "https://maps.example.invalid/e2e-0-8823");
  ok("contact publishes the full address",
    contact?.address?.street === "100 E2E Test Street" && contact?.address?.city === LIVE[0].city &&
    contact?.address?.state === LIVE[0].state && contact?.address?.zip === "70000");

  // And these must never appear, here or anywhere.
  ok("profile leaks no internal note", !p.raw.includes(SECRET_NOTE));
  ok("profile leaks no licence number", !/LIC-E2E-882/.test(p.raw));
  ok("profile leaks no carrier", !p.raw.includes("Acme Mutual"));
  ok("profile leaks no owner email", !p.raw.includes(SECRET_EMAIL));
  ok("profile leaks no owner name", !p.raw.includes(SECRET_CONTACT));
  for (const key of ["contact_email", "contact_name", "phone_e164_digits", "license_number",
                     "gl_carrier", "_note", "legal_name"]) {
    ok(`profile: no "${key}" key`, !p.raw.includes(`"${key}`));
  }
  ok("unknown slug -> 404", (await get("/api/contractor/no-such-slug-here")).status === 404);
  ok("unpublished verified slug -> 404", (await get(`/api/contractor/${SLUG_UNPUB}`)).status === 404);

  // expired
  await db.from("coldcall_leads").update({ expires_at: new Date(Date.now() - 10 * 864e5).toISOString() })
    .eq("id", LIVE[0].id);
  const expF = await get("/api/directory/featured");
  ok("EXPIRED drops out of featured", !expF.raw.includes(SLUGS[0]));
  const expS = await get("/api/directory/search?per_page=75");
  ok("EXPIRED drops out of search", !expS.raw.includes(SLUGS[0]));
  ok("EXPIRED profile -> 404", (await get(`/api/contractor/${SLUGS[0]}`)).status === 404);

} finally {
  console.log("\n8. Restore");
  for (const v of victims) await db.from("coldcall_leads").update(before[v.id]).eq("id", v.id);
  let restored = true;
  for (const v of victims) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      const a = JSON.stringify(before[v.id][k] ?? null), b = JSON.stringify(data[k] ?? null);
      if (a !== b) { restored = false; console.log(`     MISMATCH ${v.name}.${k}: ${a} -> ${b}`); }
    }
  }
  ok("all seven leads restored exactly", restored);
  const { count } = await db.from("coldcall_leads").select("id", { count: "exact", head: true })
    .eq("vetting_status", "lead");
  console.log(`     leads back at vetting_status='lead': ${count}`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

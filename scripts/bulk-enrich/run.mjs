// =============================================================
// TrustLight — bulk enrichment + DTI scoring over the whole table.
//
//   node scripts/bulk-enrich/run.mjs --plan     classify only, no writes
//   node scripts/bulk-enrich/run.mjs --run      enrich (resumable)
//   node scripts/bulk-enrich/run.mjs --score    DTI pass (no network)
//
//   --wave <enrichment_wave>   restrict every read to one import batch
//   --trades-only              probe home-trade categories only (see below)
//
// enrich.mjs and dti.mjs are esbuild bundles of src/lib/trustlight-enrich.ts
// and src/lib/trustlight-dti.ts — the SAME code the per-record endpoint runs,
// not a reimplementation of it. That is deliberate: a bulk path that probes
// differently from the on-demand path would produce two vocabularies of truth
// in one column and nobody would know which rows came from which.
//
// ── THE RULES THIS ENFORCES ─────────────────────────────────────────────────
//
// NULL MEANS NOT CHECKED. Enforced in enrichSite(), which returns NULL for
// every signal on every failure path. Nothing here post-processes a failure
// into a false. A timeout is silence, not an absence.
//
// NEVER DOWNGRADE A RESULT. A row that already holds a definitive enrichment
// result is only overwritten when the new probe SUCCEEDED. So a site that is
// merely down today cannot erase what we learned when it was up.
//
// IDENTIFY HONESTLY. The User-Agent is ENRICH_UA from the shared module —
// TrustLightBot, with a URL explaining what it is. Asserted at startup so a
// refactor that drops it fails loudly here instead of probing anonymously.
//
// ROBOTS.TXT IS HONOURED, WITH NO OVERRIDE. The per-record endpoint lets an
// operator override it and say why, because a person is attached to that
// decision. A bulk sweep has nobody attached, so it takes no for an answer.
// =============================================================
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { enrichSite, siteUrlOf, ENRICH_UA } from "./enrich.mjs";
import { scoreDti, DTI_CONFIG_KEYS } from "./dti.mjs";
// The ONE home-trade vocabulary, shared with slugs.mjs, places-run.mjs,
// verify-all.mjs and (via trustlight-public.ts) the worker itself.
import { HOME } from "./home-trades.mjs";

const MODE = process.argv.find((a) => /^--(plan|run|score)$/.test(a))?.slice(2) ?? "plan";

// ── WAVE SCOPING ────────────────────────────────────────────────────────────
// --wave <enrichment_wave> restricts EVERY read, and therefore every write, to
// one import batch. Without it this script reads the whole table, which is
// correct for the original Louisiana sweep and wrong for every later import:
// re-probing 15,827 already-enriched rows costs hours of network, re-opens the
// stale-score clearing path across live published records, and risks
// downgrading a result we already hold.
//
// Standing instruction from Rob, 2026-10-21: a regional import is scoped to its
// own wave and must never touch the existing rows. Applied inside readAll() so
// BOTH the enrich pass and the score pass inherit it — including the stale
// -score sweep, which would otherwise clear scores outside the wave.
const WAVE = (() => {
  const i = process.argv.indexOf("--wave");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ── TRADES-ONLY ─────────────────────────────────────────────────────────────
// --trades-only restricts the PROBE to home-trade categories.
//
// WHY: the AL/FL import loaded 21,374 probeable rows in one wave, of which
// 16,204 are restaurants, dentists and salons. Probing all of them is ~6.5
// hours of network against ~1.6 for the trades. Non-trades get no slug, no
// public listing and no DTI surface, so their enrichment columns would be
// measured and then read by nothing.
//
// It deliberately affects ONLY the classify/probe step, not readAll(). The
// --score pass is meant to run unscoped: scoring is free (no network), and a
// non-trade that was never probed is 'not_enriched', which is not scoreable
// anyway, so it is skipped on its own merits rather than by a flag.
const TRADES_ONLY = process.argv.includes("--trades-only");
const isHomeTrade = (r) => HOME.has(String(r.category ?? "").trim().toLowerCase());
if (process.argv.includes("--wave") && !WAVE) {
  console.error("--wave needs a value, e.g. --wave gulf-coast-2026-10");
  process.exit(1);
}
const CONCURRENCY = Number(process.env.TL_CONC ?? 6);
const SAME_HOST_DELAY_MS = 1500;
const STATE_DIR = path.join(process.env.TEMP ?? ".", "trustlight-bulk-enrich");
const CHECKPOINT = path.join(STATE_DIR, "done.jsonl");

// The UA is a promise to the sites we probe. Check it, do not assume it.
if (!/TrustLightBot/.test(ENRICH_UA)) {
  console.error(`refusing to run: User-Agent does not identify as TrustLightBot (${ENRICH_UA})`);
  process.exit(1);
}

const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// -- WRITE RETRY -------------------------------------------------------------
// Every Supabase write in this file goes through here.
//
// WHY: a full pass is ~1,800 probes at under one per second - half an hour of
// wall clock. A single transient `TypeError: fetch failed` on any one write
// used to call process.exit(1) and kill the whole pass. That happened twice in
// a row on the Gulf Coast import (2026-10-21), at 4 rows and at 60 of 1,829.
// The checkpoint made it resumable, so nothing was lost, but it could not
// finish.
//
// NO BEHAVIOUR CHANGE ON SUCCESS: a write that works first time behaves
// exactly as before. A write that is genuinely REFUSED (constraint violation,
// bad column) still exits non-zero - it is simply retried twice more first.
// The exit is delayed, never skipped, so a real schema error stays loud.
//
// 3 attempts, 500ms then 1500ms. Deliberately short: this guards against a
// blip, not an outage. If the third attempt fails the run stops, which is the
// right answer to a network that is actually down.
const WRITE_ATTEMPTS = 3;
const WRITE_BACKOFF_MS = [500, 1500];

async function writeWithRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      ({ error } = await fn());
    } catch (e) {
      // supabase-js can THROW rather than return {error} when fetch itself
      // fails. Both paths are the same event and both are worth retrying.
      error = { message: e instanceof Error ? e.message : String(e) };
    }
    if (!error) return undefined;
    if (attempt >= WRITE_ATTEMPTS) return error;
    const wait = WRITE_BACKOFF_MS[attempt - 1] ?? WRITE_BACKOFF_MS[WRITE_BACKOFF_MS.length - 1];
    console.error(`  write retry ${attempt}/${WRITE_ATTEMPTS - 1} on ${label}: ${error.message} - waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

// Never write to these, in any mode. Standing instruction, enforced in code
// rather than remembered — a backfill already tripped over the duplicate.
const PROTECTED_NAMES = new Set(["kwik service electric inc", "pat bryant electric",
  "trinity home services", "vinyltech"]);

/** A status that represents a finding we already made about this business. */
const DEFINITIVE = new Set(["fully_enriched", "no_website_found", "skipped_robots_txt", "probe_failed"]);
/** The only outcome allowed to overwrite one. */
const isSuccess = (s) => s === "fully_enriched";

const ENRICH_COLS = ["enrichment_status", "enriched_at", "site_state", "site_http_status",
  "has_website", "has_schema_org", "analytics_pixels", "chat_widget", "booking_tool",
  "call_tracking", "ai_voice_agent", "analytics_pixels_detail", "chat_widget_detail",
  "booking_tool_detail", "call_tracking_detail", "ai_voice_agent_detail", "platform",
  "domain", "domain_age_days", "domain_registered_on", "domain_registrar", "signal_confidence"];

async function readAll(cols) {
  const PAGE = 1000, out = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from("coldcall_leads").select(cols);
    // The scope. Every caller of readAll() goes through here, so there is no
    // path in this script that reads outside the wave once one is set.
    if (WAVE) q = q.eq("enrichment_wave", WAVE);
    const { data, error } = await q
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error("read failed:", error.message); process.exit(1); }
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const hostOf = (r) => {
  const u = siteUrlOf(r.website_url ?? r.domain);
  if (!u) return null;
  try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return null; }
};

// ── Classify ────────────────────────────────────────────────────────────────
const rows = await readAll("id, name, category, website_url, domain, enrichment_status");
const live = rows.filter((r) => !PROTECTED_NAMES.has(String(r.name ?? "").trim().toLowerCase()));
const skippedProtected = rows.length - live.length;

// The trades scope sits between "protected" and the probeable/no-site split,
// so a non-trade is neither probed NOR written a 'no_website_found'. It keeps
// whatever it already has, which for a fresh import is 'not_enriched' - the
// honest value for a site nobody looked at.
const inScope = TRADES_ONLY ? live.filter(isHomeTrade) : live;
const heldNonTrade = live.length - inScope.length;

const probeable = inScope.filter((r) => siteUrlOf(r.website_url ?? r.domain) !== null);
const noSite = inScope.filter((r) => siteUrlOf(r.website_url ?? r.domain) === null);

console.log(`scope:           ${WAVE ? `enrichment_wave = '${WAVE}'` : "WHOLE TABLE (no --wave)"}`);
console.log(`categories:      ${TRADES_ONLY ? "HOME TRADES ONLY (--trades-only)" : "ALL (no --trades-only)"}`);
console.log(`rows:            ${rows.length}`);
console.log(`protected, held: ${skippedProtected}`);
if (TRADES_ONLY) console.log(`non-trades held: ${heldNonTrade}  (left 'not_enriched', nothing written)`);
console.log(`probeable:       ${probeable.length}  (network)`);
console.log(`no website:      ${noSite.length}  (no network — definite 'no_website_found')`);

if (MODE === "plan") { console.log("\nPLAN ONLY — nothing written."); process.exit(0); }

// ── DTI scoring pass ────────────────────────────────────────────────────────
if (MODE === "score") {
  const { data: cfg, error: ce } = await db.from("coldcall_config").select("key, value");
  if (ce) { console.error("config read failed:", ce.message); process.exit(1); }
  // coldcall_config stores values as text. The route converts and refuses a
  // non-number rather than defaulting — the scorer throws on anything that is
  // not a finite number, which is how a missing weight stays loud. Same
  // conversion here, for the same reason.
  const raw = Object.fromEntries((cfg ?? []).map((c) => [c.key, c.value]));
  const weights = {};
  for (const k of Object.values(DTI_CONFIG_KEYS)) {
    if (raw[k] === undefined) { console.error(`refusing to score: '${k}' missing from coldcall_config`); process.exit(1); }
    const n = Number(raw[k]);
    if (!Number.isFinite(n)) { console.error(`refusing to score: config '${k}' is not a number: '${raw[k]}'`); process.exit(1); }
    weights[k] = n;
  }
  const scoreRows = await readAll("id, name, dti_score, call_score, enrichment_status, site_state, has_schema_org, " +
    "domain_age_days, booking_tool, chat_widget, call_tracking, analytics_pixels, has_website, website_url, domain, " +
    "site_state, has_https, has_viewport, phone_listed, has_business_hours, reviews_linked, has_faq_or_blog, service_area_count");
  const SCOREABLE = new Set(["fully_enriched", "no_website_found"]);
  const eligible = scoreRows.filter((r) => SCOREABLE.has(r.enrichment_status) &&
    !PROTECTED_NAMES.has(String(r.name ?? "").trim().toLowerCase()));
  console.log(`\nfully_enriched and scoreable: ${eligible.length}`);

  // ── CLEAR A SCORE THAT IS NO LONGER EARNED ──────────────────────────────
  // A row probed successfully once, scored, then failed a later probe keeps
  // its old number unless something removes it. Three PUBLISHED businesses
  // were showing a score computed from data we no longer hold.
  const stale = scoreRows.filter((r) =>
    !SCOREABLE.has(r.enrichment_status) && r.dti_score !== null &&
    !PROTECTED_NAMES.has(String(r.name ?? "").trim().toLowerCase()));
  let cleared = 0;
  for (const r of stale) {
    const error = await writeWithRetry(`clear ${r.id}`, () =>
      db.from("coldcall_leads").update({ dti_score: null }).eq("id", r.id));
    if (error) { console.error(`  clear failed ${r.id}: ${error.message}`); process.exit(1); }
    cleared++;
  }
  if (cleared) console.log(`cleared ${cleared} stale score(s) on rows no longer scoreable`);

  let wrote = 0, refused = 0, unchanged = 0, collided = 0;
  const reasons = new Map();
  for (const r of eligible) {
    let res;
    try { res = scoreDti(r, weights); }
    catch (e) { console.error(`  scoreDti threw on ${r.id}: ${e.message}`); process.exit(1); }
    if (res.score === null) {
      refused++;
      reasons.set(res.reason, (reasons.get(res.reason) ?? 0) + 1);
      continue;  // a refusal writes NOTHING — it is not a zero
    }
    // The published score must never BE the internal Sales-Ready score. The
    // per-record endpoint refuses with a 409 rather than publish one that
    // coincides; a bulk pass that quietly wrote it would defeat that guard on
    // 600 records at once. Refused rows keep whatever they had.
    const callScore = typeof r.call_score === "number" ? r.call_score : null;
    if (callScore !== null && res.score === callScore) {
      collided++;
      continue;
    }
    if (r.dti_score === res.score) { unchanged++; continue; }
    const error = await writeWithRetry(`score ${r.id}`, () =>
      db.from("coldcall_leads").update({ dti_score: res.score }).eq("id", r.id));
    if (error) { console.error(`  write failed ${r.id}: ${error.message}`); process.exit(1); }
    wrote++;
    if (wrote % 100 === 0) console.log(`  ...${wrote} scored`);
  }
  console.log(`\nscored:    ${wrote}`);
  console.log(`unchanged: ${unchanged}`);
  console.log(`refused:   ${refused}  (left NULL — a refusal is not a zero)`);
  console.log(`collided with call_score, not written: ${collided}`);
  for (const [why, n] of reasons) console.log(`    ${n}  ${why}`);
  process.exit(0);
}

// ── Enrichment run ──────────────────────────────────────────────────────────
fs.mkdirSync(STATE_DIR, { recursive: true });
const done = new Set();
if (fs.existsSync(CHECKPOINT)) {
  for (const line of fs.readFileSync(CHECKPOINT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch { /* a torn final line is not a reason to stop */ }
  }
  console.log(`\nresuming: ${done.size} already done in a previous run`);
}
const checkpoint = fs.createWriteStream(CHECKPOINT, { flags: "a" });
const mark = (id, status) => checkpoint.write(JSON.stringify({ id, status }) + "\n");

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);

// ── 1. The rows with nothing to fetch ───────────────────────────────────────
// enrichSite() returns a fixed blank for a null URL, so the result is known
// without calling it 15,102 times. Written set-based, in id batches.
const noSiteTodo = noSite.filter((r) => !done.has(r.id) && !(DEFINITIVE.has(r.enrichment_status)));
const noSiteHeld = noSite.filter((r) => !done.has(r.id) && DEFINITIVE.has(r.enrichment_status));
console.log(`\n1. No website to fetch: ${noSiteTodo.length} to write, ${noSiteHeld.length} already definitive (held)`);
if (noSiteTodo.length) {
  const sample = await enrichSite(null, { overrideRobots: false });
  if (sample.enrichment_status !== "no_website_found" || sample.has_website !== false) {
    console.error("refusing: enrichSite(null) no longer returns no_website_found/has_website=false");
    process.exit(1);
  }
  const { note, ...patch } = sample;
  const BATCH = 500;
  for (let i = 0; i < noSiteTodo.length; i += BATCH) {
    const ids = noSiteTodo.slice(i, i + BATCH).map((r) => r.id);
    const error = await writeWithRetry(`batch at ${i}`, () =>
      db.from("coldcall_leads")
        .update({ ...patch, enriched_at: new Date().toISOString() }).in("id", ids));
    if (error) { console.error("  batch failed:", error.message); process.exit(1); }
    for (const id of ids) { mark(id, "no_website_found"); bump("no_website_found"); }
    process.stdout.write(`\r   written ${Math.min(i + BATCH, noSiteTodo.length)}/${noSiteTodo.length}`);
  }
  console.log();
}
for (const r of noSiteHeld) bump("held (already definitive, no site)");

// ── 2. The rows with a site ─────────────────────────────────────────────────
const byHost = new Map();
for (const r of probeable) {
  if (done.has(r.id)) { bump("skipped (checkpoint)"); continue; }
  const h = hostOf(r) ?? "(unknown)";
  if (!byHost.has(h)) byHost.set(h, []);
  byHost.get(h).push(r);
}
const hostQueue = [...byHost.entries()];
console.log(`\n2. Probing ${hostQueue.reduce((a, [, v]) => a + v.length, 0)} records across ${hostQueue.length} hosts, concurrency ${CONCURRENCY}`);
console.log(`   UA: ${ENRICH_UA}`);

let cursor = 0, completed = 0, kept = 0;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hostWorker() {
  while (cursor < hostQueue.length) {
    const [, records] = hostQueue[cursor++];
    // Records sharing a host go one at a time, with a gap. 676 hosts for 723
    // records means this is almost always a list of one; it matters for the
    // 25 that share facebook.com.
    for (let k = 0; k < records.length; k++) {
      const r = records[k];
      if (k > 0) await sleep(SAME_HOST_DELAY_MS);
      let res;
      try {
        res = await enrichSite(r.website_url ?? r.domain, { overrideRobots: false });
      } catch (err) {
        // enrichSite is not supposed to throw; if it ever does, that is OUR
        // failure and must not be recorded as a finding about the business.
        bump("runner_error (nothing written)");
        console.log(`\n   runner error on ${r.name}: ${String(err).slice(0, 120)}`);
        completed++;
        continue;
      }
      const had = DEFINITIVE.has(r.enrichment_status);
      if (had && !isSuccess(res.enrichment_status)) {
        kept++;
        bump(`kept existing '${r.enrichment_status}' (new probe: ${res.enrichment_status})`);
        mark(r.id, `kept:${r.enrichment_status}`);
        completed++;
        continue;
      }
      const { note, ...patch } = res;
      const error = await writeWithRetry(`enrich ${r.id}`, () =>
        db.from("coldcall_leads").update(patch).eq("id", r.id));
      if (error) { console.error(`\n  write failed ${r.id}: ${error.message}`); process.exit(1); }
      bump(res.enrichment_status);
      mark(r.id, res.enrichment_status);
      completed++;
      if (completed % 25 === 0) {
        const rate = completed / ((Date.now() - started) / 1000);
        process.stdout.write(`\r   ${completed} probed  (${rate.toFixed(1)}/sec)   `);
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, hostWorker));
checkpoint.end();

console.log(`\n\nprobed ${completed} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`existing results protected from a worse probe: ${kept}`);
console.log("\noutcomes:");
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);

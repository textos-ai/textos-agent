// Google Place Details across every home-trade business we hold no website
// for, through the admin endpoint on the prod worker (the only place the
// Places key lives).
//
//   node places-run.mjs --plan    count and cost, write nothing
//   node places-run.mjs --run     the real thing, resumable
//
// ── WHY THIS IS THE HONEST VERSION OF A WRITE I ONCE HAD TO REVERT ──────────
// Earlier today 14,820 rows were written has_website=false because OUR record
// had no URL. That was a claim about a business made out of our own missing
// data, and it was reverted.
//
// This is different, and the difference is the whole point: we ASK GOOGLE about
// the specific business, by its own place_id. If Google returns no website,
// that is a checked, sourced answer — has_website=false and
// enrichment_status='no_website_found' are then true statements. If the lookup
// fails, nothing is written at all.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { HOME as HOME_TRADES_SET } from "./home-trades.mjs";

const MODE = process.argv.includes("--run") ? "run" : "plan";

// --wave <enrichment_wave> restricts the lookup to one import batch. Without
// it this reads the whole table, which is right for the original Louisiana
// sweep and wrong afterwards: every call costs money, so re-including 15,827
// already-looked-up rows is a bill, not just wasted time.
const WAVE = (() => {
  const i = process.argv.indexOf("--wave");
  return i >= 0 ? process.argv[i + 1] : null;
})();
if (process.argv.includes("--wave") && !WAVE) {
  console.error("--wave needs a value, e.g. --wave gulf-coast-2026-10");
  process.exit(1);
}
const STATE = path.join(process.env.TEMP ?? ".", "trustlight-places");
const CHECKPOINT = path.join(STATE, "done.jsonl");
const AGENT = "https://textos-agent-dev.rgaudet2023.workers.dev";
const CONC = Number(process.env.TL_CONC ?? 8);

// Legacy Place Details SKUs, per 1,000 calls. Used for the ESTIMATE only —
// the real figure comes from the billing console, and this is labelled an
// estimate everywhere it is printed.
const RATE_PER_1000 = { basic: 17, contact: 3, atmosphere: 5 };
const RATE = (RATE_PER_1000.basic + RATE_PER_1000.contact + RATE_PER_1000.atmosphere) / 1000;

const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
for (const l of fs.readFileSync("C:/code/textos-web/.env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*(PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.*)$/); if (m) env.SUPABASE_ANON_KEY = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PROTECTED = new Set(["kwik service electric inc", "pat bryant electric",
  "trinity home services", "vinyltech"]);
// The home-trade allow-list, shared so a stale copy cannot silently exclude
// the Gulf Coast trades from this pass. See home-trades.mjs.
const HOME = HOME_TRADES_SET;

const PAGE = 1000, all = [];
for (let f = 0; ; f += PAGE) {
  let q = db.from("coldcall_leads")
    .select("id,name,category,place_id,website_url,domain,enrichment_status,vetting_status");
  if (WAVE) q = q.eq("enrichment_wave", WAVE);
  const { data, error } = await q
    .order("id", { ascending: true }).range(f, f + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...data); if (data.length < PAGE) break;
}

const target = all.filter((r) =>
  HOME.has(String(r.category ?? "").trim().toLowerCase()) &&
  !PROTECTED.has(String(r.name ?? "").trim().toLowerCase()) &&
  String(r.place_id ?? "").trim() &&
  !String(r.website_url ?? r.domain ?? "").trim());

console.log(`scope:                               ${WAVE ? `enrichment_wave = '${WAVE}'` : "WHOLE TABLE (no --wave)"}`);
console.log(`rows in scope:                       ${all.length}`);
console.log(`home-trade businesses:               ${all.filter(r => HOME.has(String(r.category ?? "").toLowerCase())).length}`);
console.log(`  with a place_id and NO website:    ${target.length}   <- the run`);
console.log(`\nestimated spend: ${target.length} x $${RATE.toFixed(3)} = $${(target.length * RATE).toFixed(2)}`);
console.log(`  (Basic $${RATE_PER_1000.basic} + Contact $${RATE_PER_1000.contact} + Atmosphere $${RATE_PER_1000.atmosphere} per 1,000 — ESTIMATE, confirm in the billing console)`);

if (MODE === "plan") { console.log("\nPLAN ONLY — nothing called, nothing written."); process.exit(0); }

fs.mkdirSync(STATE, { recursive: true });
const done = new Set();
if (fs.existsSync(CHECKPOINT)) {
  for (const line of fs.readFileSync(CHECKPOINT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch { /* torn line */ }
  }
  console.log(`\nresuming: ${done.size} already looked up`);
}
const cp = fs.createWriteStream(CHECKPOINT, { flags: "a" });

// Admin session for the worker endpoint.
const { data: admins } = await db.from("users").select("email").eq("is_admin", true).limit(1);
const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: admins[0].email });
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: sess } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
const JWT = sess.session.access_token;

const todo = target.filter((r) => !done.has(r.id));
console.log(`to look up now: ${todo.length}\n`);

let calls = 0, gotSite = 0, noSite = 0, failed = 0, wrote = 0;
const failReasons = {};
const t0 = Date.now();
let i = 0;
async function worker() {
  while (i < todo.length) {
    const r = todo[i++];
    let res;
    try {
      res = await fetch(`${AGENT}/api/admin/vetting/place/${encodeURIComponent(r.place_id)}`,
        { headers: { Authorization: `Bearer ${JWT}` } });
    } catch (e) { failed++; failReasons.network = (failReasons.network ?? 0) + 1; continue; }
    calls++;
    const body = await res.json().catch(() => null);

    if (res.status !== 200) {
      const why = body?.details?.google_status ?? `http_${res.status}`;
      failReasons[why] = (failReasons[why] ?? 0) + 1;
      failed++;
      // A failed lookup writes NOTHING. We did not learn anything about this
      // business, and "we could not ask" is not "they have no website".
      cp.write(JSON.stringify({ id: r.id, result: "lookup_failed", why }) + "\n");
      continue;
    }

    const p = body.place ?? {};
    const patch = {};
    if (p.rating !== null && p.rating !== undefined) patch.rating = p.rating;
    if (p.review_count !== null && p.review_count !== undefined) patch.review_count = p.review_count;

    if (p.website) {
      gotSite++;
      patch.website_url = p.website;
      try { patch.domain = new URL(p.website).hostname.replace(/^www\./i, "").toLowerCase(); } catch { /* leave null */ }
      patch.has_website = true;
      // Deliberately NOT setting enrichment_status here. A URL is not a probe;
      // the site still has to be fetched before it can be scored.
      patch.enrichment_status = "not_enriched";
    } else {
      noSite++;
      // Google was asked about this exact business and returned no website.
      // That is a checked answer, so a definite false is honest.
      patch.has_website = false;
      patch.enrichment_status = "no_website_found";
      patch.enriched_at = new Date().toISOString();
    }

    const { error } = await db.from("coldcall_leads").update(patch).eq("id", r.id);
    if (error) { console.error(`\nwrite failed ${r.id}: ${error.message}`); process.exit(1); }
    wrote++;
    cp.write(JSON.stringify({ id: r.id, result: p.website ? "website" : "no_website" }) + "\n");
    if (wrote % 200 === 0) {
      const rate = calls / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${wrote} written  (${rate.toFixed(1)} calls/sec)   `);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
cp.end();
const secs = (Date.now() - t0) / 1000;

console.log(`\n\ncalls made:            ${calls}`);
console.log(`  website found:       ${gotSite}   (${(gotSite / Math.max(1, calls) * 100).toFixed(0)}%)`);
console.log(`  no website (checked): ${noSite}`);
console.log(`  lookup failed:       ${failed}   ${JSON.stringify(failReasons)}`);
console.log(`rows written:          ${wrote}`);
console.log(`elapsed:               ${(secs / 60).toFixed(1)} min  (${(calls / secs).toFixed(1)} calls/sec)`);
console.log(`\nESTIMATED spend: ${calls} calls x $${RATE.toFixed(3)} = $${(calls * RATE).toFixed(2)}`);
console.log(`Confirm against Billing -> Reports, Places API SKUs.`);

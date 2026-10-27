// Recover city, state and parish for the unvetted records that carry none.
//
//   node parish-backfill.mjs            validate and report, WRITE NOTHING
//   node parish-backfill.mjs --run      apply
//
// ── WHY THESE ROWS ARE BLANK, AND WHY IT MATTERS ───────────────────────────
// 611 of the 4,106 unvetted records with a slug have no parish — and no city
// or state either. What they DO have is Google's own `address` string and a
// `place_id`. The location was never missing; it was only ever in a column
// nobody read.
//
// It matters because /b/<slug> leads with the Parish Exclusive — "no general
// contractor in Tangipahoa Parish is verified, and for $997 you could be the
// only one". With no parish, that record falls back to a flat "you are not
// verified on TrustLight" and the strongest thing on the page is gone.
//
// ── WHY A GAZETTEER AND NOT AN INFERENCE ───────────────────────────────────
// The obvious move was to learn city -> parish from rows that already have
// both. It does not work: ZERO of these 39 cities appear on any parish-tagged
// row. Those cover New Orleans, the Northshore and the Mississippi coast;
// these are Acadiana and Baton Rouge. There is nothing to learn from, so the
// mapping is written out by hand and checked against the ZIP on every row.
//
// ── THE ZIP IS THE CHECK, NOT DECORATION ───────────────────────────────────
// Every row carries a ZIP inside the same address string. A ZIP that is not on
// the gazetteer entry for its city means the row disagrees with the mapping,
// and the row is SKIPPED rather than written. That is the whole defence
// against a city name that means two different places.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const RUN = process.argv.includes("--run");
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, "");
const GAZ = JSON.parse(fs.readFileSync(path.join(HERE, "parish-gazetteer.json"), "utf8"));

const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// PROTECTED LEADS. Never selected, never written.
const PROTECTED = new Set(["pat bryant electric", "kwik service electric inc",
  "trinity home services", "vinyltech"]);

/**
 * The segment immediately before "ST 12345".
 *
 * Handles both shapes Google returns:
 *   "12727 Airline Hwy, Baton Rouge, LA 70817, USA"   -> Baton Rouge
 *   "Opelousas, LA 70570, USA"                        -> Opelousas
 * The first version required a leading comma and threw away 52 rows that had
 * no street component at all.
 */
function parseAddress(a) {
  const m = String(a || "").match(/(?:^|,)\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5})/);
  if (!m) return null;
  const city = m[1].trim();
  // "Louisiana 70560, USA" parses to a city of "Louisiana"; a leading digit
  // means we caught a street line. Neither is a city.
  if (/^\d/.test(city) || /^(louisiana|mississippi|texas)$/i.test(city)) return null;
  return { city, state: m[2], zip: m[3] };
}

const key = (city, state) => city.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim() + "|" + state;

let rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("coldcall_leads")
    .select("id, name, address, market, parish, city, state")
    .not("slug", "is", null).neq("vetting_status", "verified").is("parish", null)
    .order("id", { ascending: true }).range(from, from + 999);
  if (error) { console.error("read failed:", error.message); process.exit(1); }
  rows = rows.concat(data);
  if (data.length < 1000) break;
}

const plan = [], skipped = { protected: [], unparsed: [], no_gazetteer: [], zip_mismatch: [] };
for (const r of rows) {
  if (PROTECTED.has(String(r.name ?? "").trim().toLowerCase())) { skipped.protected.push(r); continue; }
  const p = parseAddress(r.address);
  if (!p) { skipped.unparsed.push(r); continue; }
  const g = GAZ[key(p.city, p.state)];
  if (!g || !g.parish) { skipped.no_gazetteer.push({ r, p }); continue; }
  if (!g.zips.includes(p.zip)) { skipped.zip_mismatch.push({ r, p, g }); continue; }
  plan.push({ id: r.id, name: r.name, city: p.city, state: p.state, zip: p.zip,
              parish: g.parish, confidence: g.confidence });
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`records with no parish:      ${rows.length}`);
console.log(`  would be filled:           ${plan.length}`);
console.log(`  skipped, protected lead:   ${skipped.protected.length}`);
console.log(`  skipped, address unparsed: ${skipped.unparsed.length}`);
console.log(`  skipped, city not in gaz:  ${skipped.no_gazetteer.length}`);
console.log(`  skipped, ZIP mismatch:     ${skipped.zip_mismatch.length}`);

const byParish = {};
plan.forEach((x) => { byParish[x.parish] = (byParish[x.parish] || 0) + 1; });
console.log("\nparish distribution of the fill:");
Object.entries(byParish).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

const straddle = plan.filter((x) => x.confidence === "straddle");
console.log(`\nrows landing on a STRADDLE city (parish line crosses the town): ${straddle.length}`);
[...new Set(straddle.map((x) => x.city))].forEach((c) => {
  const g = GAZ[key(c, "LA")];
  console.log(`  ${c} -> ${g.parish}  (${straddle.filter((x) => x.city === c).length} rows)  ${g.note}`);
});

// A sample of what WOULD be written, from the plan itself rather than a
// re-derivation, so the values shown are the values that land.
// SAMPLE_N=25 node parish-backfill.mjs to widen it.
const SAMPLE_N = Number(process.env.SAMPLE_N ?? 10);
console.log(`
SAMPLE OF THE FILL (first ${Math.min(SAMPLE_N, plan.length)} of ${plan.length}):`);
console.log(`  ${"business".padEnd(38)} ${"city".padEnd(16)} ${"zip".padEnd(6)} ${"-> parish".padEnd(22)} confidence`);
for (const x of plan.slice(0, SAMPLE_N)) {
  console.log(`  ${String(x.name).slice(0, 37).padEnd(38)} ${String(x.city).padEnd(16)} ${String(x.zip).padEnd(6)} -> ${String(x.parish).padEnd(19)} ${x.confidence}`);
}

for (const [label, list] of [["address unparsed", skipped.unparsed],
                             ["city not in gazetteer", skipped.no_gazetteer],
                             ["ZIP mismatch", skipped.zip_mismatch]]) {
  if (!list.length) continue;
  console.log(`\n${label.toUpperCase()} (${list.length}) — these keep parish = NULL:`);
  list.slice(0, 20).forEach((x) => {
    const r = x.r ?? x;
    console.log(`  ${JSON.stringify(r.address)}  name=${JSON.stringify(r.name)}`);
  });
}

if (!RUN) { console.log("\n-- dry run. Nothing written. Pass --run to apply. --"); process.exit(0); }

// ── Write ───────────────────────────────────────────────────────────────────
// city/state/parish only. Nothing else on the row is touched.
let ok = 0, failed = 0;
for (const x of plan) {
  const { error } = await db.from("coldcall_leads")
    .update({ city: x.city, state: x.state, parish: x.parish }).eq("id", x.id);
  if (error) { failed++; console.log(`  write failed ${x.id}: ${error.message}`); }
  else ok++;
  if ((ok + failed) % 100 === 0) process.stdout.write(`\r  ${ok + failed}/${plan.length}   `);
}
console.log(`\n\nwrote ${ok}, failed ${failed}`);

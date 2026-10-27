// Give every home-trade business a slug, so it has a shareable URL.
//
//   node slugs.mjs --plan   report collisions, write nothing
//   node slugs.mjs --run    fill the blanks
//
// ── ONE SLUG, TWO URLS ──────────────────────────────────────────────────────
// The same slug serves /b/<slug> while a business is unvetted and
// /contractor/<slug> once it is verified. That is deliberate: a link Rob
// texted a contractor in March still resolves after they pay in April, it just
// lands on their real profile instead of the pitch. buildUniqueSlug() already
// returns an existing slug when it belongs to the same lead, so verification
// never renames one.
//
// ── WHY THIS IS SAFE ────────────────────────────────────────────────────────
// A slug does NOT make a row public. publishable() filters on
// vetting_status='verified' AND is_published=true AND expires_at > now, and
// the required-field check is only one of four conditions. Read the query
// builder before trusting this comment; it was read before this was written.
//
// Scoped to the sixteen home trades. The other ~11,600 rows are dentists,
// barber shops and car washes that will never get a share page.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { HOME as HOME_TRADES_SET } from "./home-trades.mjs";

const RUN = process.argv.includes("--run");
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// The home-trade allow-list, shared so a stale copy cannot silently exclude
// the Gulf Coast trades from this pass. See home-trades.mjs.
const HOME = HOME_TRADES_SET;
const PROTECTED = new Set(["kwik service electric inc","pat bryant electric","trinity home services","vinyltech"]);

// Identical to slugifyName() in src/lib/coldcall-demo.ts. Duplicated because
// this is a one-off script, not the runtime path — if the two ever disagree,
// the one in src/ is correct.
const slugify = (n) => String(n ?? "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const PAGE = 1000, all = [];
for (let f = 0; ; f += PAGE) {
  const { data, error } = await db.from("coldcall_leads")
    .select("id,name,slug,category,vetting_status").order("id", { ascending: true }).range(f, f + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...data); if (data.length < PAGE) break;
}

// Every slug already in use, so new ones cannot collide with a verified one.
const taken = new Map();
for (const r of all) if (r.slug) taken.set(r.slug, r.id);

const target = all.filter((r) =>
  HOME.has(String(r.category ?? "").trim().toLowerCase()) &&
  !PROTECTED.has(String(r.name ?? "").trim().toLowerCase()) &&
  !r.slug && String(r.name ?? "").trim());

console.log(`rows:                 ${all.length}`);
console.log(`home trades:          ${all.filter(r => HOME.has(String(r.category ?? "").toLowerCase())).length}`);
console.log(`already have a slug:  ${all.filter(r => r.slug).length}`);
console.log(`need one:             ${target.length}`);

// Assign, resolving collisions the same way buildUniqueSlug does.
const plan = [];
let suffixed = 0;
for (const r of target) {
  const base = slugify(r.name);
  if (!base) { console.log(`  SKIP (name slugifies to nothing): ${r.id}`); continue; }
  let candidate = base, n = 1;
  while (taken.has(candidate)) { n += 1; candidate = `${base}-${n}`; }
  if (n > 1) suffixed++;
  taken.set(candidate, r.id);
  plan.push({ id: r.id, name: r.name, slug: candidate });
}
console.log(`to assign:            ${plan.length}   (of which suffixed for collision: ${suffixed})`);
if (suffixed) {
  console.log("  worst collisions:");
  const byBase = new Map();
  for (const p of plan) { const b = p.slug.replace(/-\d+$/, ""); byBase.set(b, (byBase.get(b) ?? 0) + 1); }
  for (const [b, n] of [...byBase].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${String(n).padStart(3)}x  ${b}`);
  }
}

if (!RUN) { console.log("\nPLAN ONLY — nothing written."); process.exit(0); }

let wrote = 0;
for (const p of plan) {
  const { error } = await db.from("coldcall_leads").update({ slug: p.slug }).eq("id", p.id);
  if (error) {
    // The UNIQUE index is the real guard. If it fires, something raced us;
    // report rather than retry blindly.
    console.error(`\n  FAILED ${p.id} (${p.slug}): ${error.message}`);
    process.exit(1);
  }
  wrote++;
  if (wrote % 250 === 0) process.stdout.write(`\r  ${wrote}/${plan.length}`);
}
console.log(`\n\nwrote ${wrote} slugs`);

// Verify from a fresh read, not from what we think we did.
const check = [];
for (let f = 0; ; f += PAGE) {
  const { data } = await db.from("coldcall_leads").select("id,slug,category,vetting_status")
    .order("id", { ascending: true }).range(f, f + PAGE - 1);
  check.push(...data); if (data.length < PAGE) break;
}
const home = check.filter((r) => HOME.has(String(r.category ?? "").toLowerCase()));
const dupes = new Map();
for (const r of check) if (r.slug) dupes.set(r.slug, (dupes.get(r.slug) ?? 0) + 1);
console.log(`  home trades with a slug: ${home.filter(r => r.slug).length} / ${home.length}`);
console.log(`  duplicate slugs anywhere: ${[...dupes.values()].filter(n => n > 1).length}  (must be 0)`);
console.log(`  verified rows still verified: ${check.filter(r => r.vetting_status === "verified").length}`);

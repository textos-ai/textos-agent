// Whole-directory verification: every rule this build is supposed to enforce,
// checked against the DATABASE and the LIVE public API.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { NOT_A_WEBSITE } from "./dti.mjs";
import { HOME as HOME_TRADES_SET } from "./home-trades.mjs";
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// The home-trade allow-list, shared so a stale copy cannot silently exclude
// the Gulf Coast trades from this pass. See home-trades.mjs.
const HOME = HOME_TRADES_SET;
const PAGE = 1000, all = [];
for (let f = 0; ; f += PAGE) {
  const { data } = await db.from("coldcall_leads")
    .select("id,name,slug,category,vetting_status,is_published,dti_score,enrichment_status,website_url,domain,has_website,site_state,has_https,has_viewport,phone_listed,has_business_hours,reviews_linked,has_faq_or_blog,service_area_count,service_areas")
    .order("id", { ascending: true }).range(f, f + PAGE - 1);
  all.push(...data); if (data.length < PAGE) break;
}
let fails = 0;
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(62)} ${p ? "PASS" : "*** FAIL ***"} ${String(x).slice(0,80)}`); };

console.log(`rows: ${all.length}\n1. THE BLANK-vs-ZERO RULE`);
const notEnrichedScored = all.filter(r => r.enrichment_status === "not_enriched" && r.dti_score !== null);
ok("not_enriched rows are NEVER scored", notEnrichedScored.length === 0, `${notEnrichedScored.length} scored`);
const probeFailScored = all.filter(r => ["probe_failed","skipped_robots_txt"].includes(r.enrichment_status) && r.dti_score !== null);
ok("probe_failed / robots rows are NEVER scored", probeFailScored.length === 0, `${probeFailScored.length} scored`);
// FOUR reasons, not two. The first version of this check only knew about
// no_website and social_only and reported 12 false failures against rows the
// code explains perfectly well - verified against the live API, which returns
// {"reason":"site_unreachable"} for every one of them.
const hasReason = (r) => {
  if (r.dti_score !== 0) return true;
  const h = String(r.website_url ?? r.domain ?? "");
  if (NOT_A_WEBSITE.some((d) => h.includes(d))) return true;          // social_only
  if (r.enrichment_status === "no_website_found") return true;        // no_website
  if (r.site_state === "dead_http_error" || r.site_state === "parked_or_lead_gen") return true; // site_unreachable
  if (r.enrichment_status === "fully_enriched") return true;          // nothing_readable
  return false;
};
const zeroNoReason = all.filter((r) => !hasReason(r));
ok("every 0 has a stateable reason", zeroNoReason.length === 0, `${zeroNoReason.length} unexplained`);

console.log(`\n2. NOTHING WAS FABRICATED`);
const falseNoLookup = all.filter(r => r.has_website === false && r.enrichment_status === "not_enriched");
ok("has_website=false never on an unchecked row", falseNoLookup.length === 0, `${falseNoLookup.length}`);

console.log(`\n3. COVERAGE, home trades`);
const home = all.filter(r => HOME.has(String(r.category ?? "").toLowerCase()));
const scored = home.filter(r => typeof r.dti_score === "number");
console.log(`  home trades: ${home.length}   scored: ${scored.length} (${(scored.length/home.length*100).toFixed(0)}%)`);
ok("at least 85% of home trades carry a score", scored.length / home.length >= 0.85, `${(scored.length/home.length*100).toFixed(0)}%`);

console.log(`\n4. SITE BUILDERS WERE NOT ZEROED`);
const BUILDERS = ["wixsite.com","godaddysites.com","weebly.com","square.site","squarespace.com","wordpress.com","webflow.io","business.site","sites.google.com"];
const builderRows = all.filter(r => BUILDERS.some(d => String(r.website_url ?? r.domain ?? "").includes(d)));
// A builder site may legitimately score 0 if the SITE is dead - AElectric's
// GoDaddy page returns an HTTP error. What must never happen is a builder
// domain being zeroed BECAUSE it is a builder domain, i.e. treated as social.
const builderZeroed = builderRows.filter(r => r.dti_score === 0 &&
  r.site_state !== "dead_http_error" && r.site_state !== "parked_or_lead_gen" &&
  r.enrichment_status !== "no_website_found");
ok(`site-builder domains are never treated as social (${builderRows.length} found)`,
  builderZeroed.length === 0, `${builderZeroed.length} wrongly zeroed`);

console.log(`\n5. PROTECTED RECORDS UNTOUCHED`);
const PROT = ["Kwik Service Electric Inc","Pat Bryant Electric","Trinity Home Services","Vinyltech"];
for (const n of PROT) {
  const rows = all.filter(r => r.name === n);
  for (const r of rows) console.log(`    ${n.padEnd(28)} dti=${String(r.dti_score).padEnd(5)} ${r.enrichment_status}`);
}

console.log(`\n6. THE SEVEN SIGNALS`);
const PROT_NAMES = ["Kwik Service Electric Inc", "Pat Bryant Electric", "Trinity Home Services", "Vinyltech"];
const withSite = all.filter((r) => String(r.website_url ?? r.domain ?? "").trim() && !PROT_NAMES.includes(r.name));
const probed = withSite.filter((r) => r.has_https !== null);
console.log(`  rows with a website: ${withSite.length}   carrying the seven signals: ${probed.length}`);
// The right assertion is about rows the probe could actually READ. A
// probe_failed or robots-blocked site has NULL on every signal BY DESIGN -
// that is the blank-vs-false rule, not a gap. Asserting "every URL has
// signals" reported 368 false failures against rows behaving correctly;
// confirmed by status: 264 probe_failed, 104 skipped_robots_txt, zero
// genuinely skipped.
const readable = withSite.filter((r) => r.enrichment_status === "fully_enriched");
const readableMissing = readable.filter((r) => r.has_https === null);
console.log(`  of those, successfully read: ${readable.length}`);
ok("every SUCCESSFULLY probed site carries the seven signals",
  readableMissing.length === 0, `${readableMissing.length} missing`);
const unreadable = withSite.filter((r) => r.has_https === null);
const wronglyUnread = unreadable.filter((r) =>
  r.enrichment_status !== "probe_failed" && r.enrichment_status !== "skipped_robots_txt");
ok("signal-less rows are all probe failures or robots refusals",
  wronglyUnread.length === 0, `${wronglyUnread.length} unexplained`);
// The blank-vs-false rule, applied per signal: a row we never probed must be
// NULL on every one of them, never false.
const fabricated = all.filter((r) => r.has_https === null &&
  (r.has_viewport === false || r.phone_listed === false || r.reviews_linked === false ||
   r.has_faq_or_blog === false || r.has_business_hours === false));
ok("no signal is false on a row we never probed", fabricated.length === 0, `${fabricated.length}`);
const areaHits = all.filter((r) => (r.service_area_count ?? 0) >= 3);
const noEvidence = areaHits.filter((r) => !Array.isArray(r.service_areas) || r.service_areas.length < 3);
console.log(`  businesses serving 3+ areas: ${areaHits.length}`);
ok("every service-area hit stores its evidence", noEvidence.length === 0, `${noEvidence.length} without`);

console.log(`\n7. LIVE PUBLIC API`);
const res = await fetch("https://trustlight.com/api/directory/search?per_page=100");
const pub = await res.json();
const pubZeroNoReason = [...pub.verified, ...pub.unvetted].filter(c => c.dti === 0 && !c.dti_zero);
ok("no published card shows a 0 without a reason", pubZeroNoReason.length === 0, `${pubZeroNoReason.length}`);
ok("unvetted cards carry a dti field", pub.unvetted.length === 0 || "dti" in pub.unvetted[0]);
const withSigs = [...pub.verified, ...pub.unvetted].filter((c) => Array.isArray(c.dti_signals));
ok("cards carry the three meter segments", withSigs.length > 0,
  `${withSigs.length} of ${pub.verified.length + pub.unvetted.length}`);
const badSegs = withSigs.filter((c) => c.dti_signals.length !== 3 ||
  c.dti_signals.map((g) => g.weight).join(",") !== "40,35,25");
ok("every meter is 3 segments weighted 40/35/25", badSegs.length === 0, `${badSegs.length} malformed`);
const leaked = [...pub.verified, ...pub.unvetted].filter(c => "website_url" in c || "enrichment_status" in c || "domain" in c);
ok("internal columns are not published on cards", leaked.length === 0, `${leaked.length} leaked`);
console.log(`\n${fails ? fails + " FAILURE(S)" : "ALL PASS"}`);

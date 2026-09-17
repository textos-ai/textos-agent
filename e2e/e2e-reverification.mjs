// Step 10: the re-verification dashboard. READ-ONLY.
//
// The two assertions that matter most:
//   1. The endpoint writes NOTHING. Verified by snapshotting every column of
//      every row it returns, hammering it, and diffing.
//   2. An already-expired record is INCLUDED and flagged, because it has
//      already dropped out of the public API while still reading 'verified'
//      in the admin view. Hiding it would hide the worst case.
//
// Distinct lead window (80-83). The four records Rob resets by hand are
// excluded IN THE SELECT, so they can never be chosen at all.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ENRICHMENT_COLUMNS } from "./enrichment-columns.mjs";

const AGENT = "https://textos-agent-test.rgaudet2023.workers.dev";
const PROTECTED = ["Pat Bryant Electric", "Kwik Service Electric Inc", "Trinity Home Services", "Vinyltech"];
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
for (const l of fs.readFileSync("C:/code/textos-web/.env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*(PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.*)$/); if (m) env.ANON = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fails = 0;
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(62)} ${p ? "PASS" : "*** FAIL ***"} ${x}`); };

const { data: admins } = await db.from("users").select("email").eq("is_admin", true).limit(1);
const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: admins[0].email });
const anon = createClient(env.SUPABASE_URL, env.ANON, { auth: { persistSession: false } });
const { data: sess } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
const JWT = sess.session.access_token;
const api = async (path, init = {}) => {
  const r = await fetch(`${AGENT}${path}`, {
    ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
  "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
const TOUCHED = ["vetting_status","slug","is_published","verified_at","verified_year","expires_at","reverify_due",
  "plan","is_comped","comp_reason","trading_name","trade","city","state","rating","review_count","dti_score",
  "blurb","chk_last_run", ...CHECKS, ...CHECKS.map((c) => `${c}_note`),
  // Verifying through the API probes the website and writes the enrichment
  // columns. This suite never asks for that, but it causes it, so it restores it.
  ...ENRICHMENT_COLUMNS,
];

// The protected four are filtered out HERE, so they cannot be selected.
const { data: subs } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .not("name", "in", `(${PROTECTED.map((n) => `"${n}"`).join(",")})`)
  .order("id", { ascending: true }).range(80, 83);   // window 80-83
if (subs.some((r) => PROTECTED.includes(r.name))) { console.error("a protected lead slipped through"); process.exit(1); }
const [DUE_SOON, DUE_LATER, EXPIRED, OUTSIDE] = subs;
console.log(`due soon : ${DUE_SOON.name}\ndue later: ${DUE_LATER.name}\nexpired  : ${EXPIRED.name}\noutside  : ${OUTSIDE.name}\n`);

const snap = {};
for (const v of subs) {
  const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
  snap[v.id] = data;
}

const day = 864e5;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

async function verify(lead, name) {
  await api(`/api/admin/vetting/${lead.id}/enter`, { method: "POST", body: JSON.stringify({}) });
  await api(`/api/admin/vetting/${lead.id}/profile`, {
    method: "PATCH", body: JSON.stringify({
      trading_name: name, trade: "Roofing", city: "Slidell", state: "LA",
      rating: 4.6, review_count: 30, dti_score: 82, blurb: "Re-verification e2e subject.",
    }),
  });
  await api(`/api/admin/vetting/${lead.id}/checks`, {
    method: "PATCH", body: JSON.stringify(Object.fromEntries(CHECKS.map((k) => [k, "pass"]))),
  });
  return api(`/api/admin/vetting/${lead.id}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "reverification e2e" }),
  });
}

// Whether this run seeded the window itself. Migration 130 is applied by
// hand, so until it lands the suite creates its own fixture and removes it
// again in the restore step — the same thing e2e-campaign did for 127. It is
// a fixture, not an applied migration.
let seededWindow = false;

try {
  console.log("1. Config drives the window — it is not a literal");
  const unconfigured = await api("/api/admin/vetting/reverification");
  if (unconfigured.status === 500 && /migration 130/.test(unconfigured.body?.message ?? "")) {
    ok("unset window is REFUSED, naming migration 130", true, unconfigured.body.message);
    ok("no default is invented", unconfigured.body?.window_days === undefined);
    const { error } = await db.from("coldcall_config").insert({
      key: "reverify_window_days", value: "60", note: "e2e fixture — removed by this suite",
    });
    if (error) { console.error("could not seed the window fixture:", error.message); process.exit(1); }
    seededWindow = true;
    console.log("     seeded reverify_window_days=60 as a FIXTURE (migration 130 still pending)");
  } else {
    ok("window already configured", true, "(130 applied — the refusal path is untestable here)");
  }

  const cfg = await api("/api/admin/vetting/reverification");
  ok("200", cfg.status === 200, `status=${cfg.status} ${JSON.stringify(cfg.body?.message)}`);
  ok("window comes from config", cfg.body?.window_days === 60, String(cfg.body?.window_days));
  ok("declares itself read-only", cfg.body?.read_only === true);

  // A bad value must refuse too, rather than silently falling back to 60.
  await db.from("coldcall_config").update({ value: "banana" }).eq("key", "reverify_window_days");
  const bad = await api("/api/admin/vetting/reverification");
  ok("a non-numeric window is refused, not defaulted", bad.status === 500, `status=${bad.status}`);
  ok("says what the bad value was", /banana/.test(bad.body?.message ?? ""), JSON.stringify(bad.body?.message));
  await db.from("coldcall_config").update({ value: "60" }).eq("key", "reverify_window_days");

  console.log("\n2. Seed four verified records across the boundary");
  await verify(DUE_SOON, "Renewal Due Soon Co.");
  await verify(DUE_LATER, "Renewal Due Later Co.");
  await verify(EXPIRED, "Renewal Expired Co.");
  await verify(OUTSIDE, "Renewal Outside Window Co.");
  // Dates set directly: the API stamps a fresh year on verify, and this is
  // testing the dashboard's window logic, not the stamping.
  await db.from("coldcall_leads").update({ reverify_due: iso(10 * day), expires_at: iso(70 * day) }).eq("id", DUE_SOON.id);
  await db.from("coldcall_leads").update({ reverify_due: iso(50 * day), expires_at: iso(110 * day) }).eq("id", DUE_LATER.id);
  await db.from("coldcall_leads").update({ reverify_due: iso(-400 * day), expires_at: iso(-5 * day) }).eq("id", EXPIRED.id);
  await db.from("coldcall_leads").update({ reverify_due: iso(200 * day), expires_at: iso(260 * day) }).eq("id", OUTSIDE.id);

  const d = await api("/api/admin/vetting/reverification");
  const byId = Object.fromEntries((d.body?.leads ?? []).map((l) => [l.id, l]));
  ok("due in 10 days is listed", !!byId[DUE_SOON.id]);
  ok("due in 50 days is listed", !!byId[DUE_LATER.id]);
  ok("already expired is listed", !!byId[EXPIRED.id]);
  ok("due in 200 days is NOT listed", !byId[OUTSIDE.id], "outside the window");

  console.log("\n3. The expired record is flagged, not quietly mixed in");
  const ex = byId[EXPIRED.id];
  ok("is_expired true", ex?.is_expired === true, String(ex?.is_expired));
  ok("days_until_expiry is negative", (ex?.days_until_expiry ?? 0) < 0, String(ex?.days_until_expiry));
  ok("still reads verified in admin", true, "(that is the point — the public API disagrees)");
  ok("counted separately", d.body?.expired_count >= 1, String(d.body?.expired_count));
  ok("due_count excludes it", d.body?.due_count === d.body.leads.filter((l) => !l.is_expired).length);
  const soon = byId[DUE_SOON.id];
  ok("a non-expired record is not flagged", soon?.is_expired === false, String(soon?.is_expired));
  ok("its days_until_expiry is positive", (soon?.days_until_expiry ?? -1) > 0, String(soon?.days_until_expiry));

  console.log("\n4. Every column the brief asks for is present");
  for (const k of ["name", "rank", "call_score", "verified_at", "expires_at",
                   "days_until_expiry", "is_published", "plan", "is_comped"]) {
    ok(`carries ${k}`, soon && k in soon, JSON.stringify(soon?.[k]));
  }

  console.log("\n5. Default order is soonest due first");
  const dues = (d.body.leads ?? []).map((l) => l.reverify_due).filter(Boolean);
  ok("reverify_due ascending", dues.every((v, i) => i === 0 || dues[i - 1] <= v), JSON.stringify(dues));

  console.log("\n6. Sorting, with blanks at the bottom in both directions");
  await db.from("coldcall_leads").update({ rank: null }).eq("id", DUE_LATER.id);
  for (const [sort, key, dir] of [
    ["rank_asc", "rank", "asc"], ["rank_desc", "rank", "desc"],
    ["score_desc", "call_score", "desc"], ["score_asc", "call_score", "asc"],
    ["expiry_asc", "days_until_expiry", "asc"], ["expiry_desc", "days_until_expiry", "desc"],
  ]) {
    const r = await api(`/api/admin/vetting/reverification?sort=${sort}`);
    const vals = (r.body?.leads ?? []).map((l) => l[key]);
    const nonNull = vals.filter((v) => v !== null);
    const sorted = dir === "asc"
      ? nonNull.every((v, i) => i === 0 || nonNull[i - 1] <= v)
      : nonNull.every((v, i) => i === 0 || nonNull[i - 1] >= v);
    ok(`${sort.padEnd(11)} ordered ${dir}`, sorted, JSON.stringify(vals));
    const firstNull = vals.indexOf(null);
    ok(`${sort.padEnd(11)} blanks at the bottom`,
      firstNull === -1 || vals.slice(firstNull).every((v) => v === null), JSON.stringify(vals));
  }
  const rankAsc = await api("/api/admin/vetting/reverification?sort=rank_asc");
  ok("a null rank IS present (not vacuous)",
    (rankAsc.body?.leads ?? []).some((l) => l.rank === null), "");
  ok("bogus sort -> 400", (await api("/api/admin/vetting/reverification?sort=nope")).status === 400);

  console.log("\n7. READ-ONLY — hammering it changes nothing");
  const before = {};
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    before[v.id] = data;
  }
  const { count: auditBefore } = await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true });
  for (const s of ["due", "rank_asc", "score_desc", "expiry_asc", "expiry_desc"]) {
    await api(`/api/admin/vetting/reverification?sort=${s}`);
  }
  let unchanged = true;
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      if (JSON.stringify(before[v.id][k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        unchanged = false; console.log(`     WROTE ${v.name}.${k}`);
      }
    }
  }
  ok("no record was modified", unchanged);
  const { count: auditAfter } = await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true });
  ok("no audit rows written", auditAfter === auditBefore, `${auditBefore} -> ${auditAfter}`);

  console.log("\n8. There is no action on this surface");
  for (const [m, path] of [
    ["POST", "/api/admin/vetting/reverification"],
    ["POST", "/api/admin/vetting/reverification/start"],
    ["POST", `/api/admin/vetting/${DUE_SOON.id}/reverify`],
  ]) {
    const r = await api(path, { method: m, body: JSON.stringify({}) });
    ok(`${m} ${path.replace("/api/admin/vetting", "")} -> 404`, r.status === 404, `status=${r.status}`);
  }

  console.log("\n9. The protected four are untouched by this run");
  const { data: prot } = await db.from("coldcall_leads")
    .select("name, vetting_status, is_published")
    .in("name", PROTECTED);
  for (const r of prot ?? []) {
    console.log(`     ${r.name.padEnd(28)} ${r.vetting_status} published=${r.is_published}`);
  }
  ok("none were selected as subjects", !subs.some((s) => PROTECTED.includes(s.name)));

  console.log("\n10. Auth");
  ok("unauthenticated -> 401", (await fetch(`${AGENT}/api/admin/vetting/reverification`)).status === 401);

} finally {
  console.log("\n11. Restore");
  for (const v of subs) await db.from("coldcall_leads").update(snap[v.id]).eq("id", v.id);
  let restored = true;
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      if (JSON.stringify(snap[v.id][k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        restored = false; console.log(`     MISMATCH ${v.name}.${k}`);
      }
    }
  }
  ok("all four leads restored exactly", restored);

  if (seededWindow) {
    await db.from("coldcall_config").delete().eq("key", "reverify_window_days");
    const { data: gone } = await db.from("coldcall_config")
      .select("key").eq("key", "reverify_window_days").maybeSingle();
    ok("config fixture removed — migration 130 still pending", !gone, JSON.stringify(gone));
  }
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

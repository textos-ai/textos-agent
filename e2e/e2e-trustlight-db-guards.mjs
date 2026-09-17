// The two guarantees the HTTP harness cannot reach, both called non-negotiable
// in the brief:
//   5. "Exclusivity is enforced in the database. Two businesses must not be
//      able to buy the same county for the same trade, even in a race."
//   §5 "Audit log — append-only."
//
// Restores everything it touches.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fails = 0;
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(58)} ${p ? "PASS" : "*** FAIL ***"} ${x}`); };

const TOUCHED = ["vetting_status", "plan", "exclusive_trade", "exclusive_county", "exclusive_state", "exclusive_until"];
const plusYear = new Date(Date.now() + 365 * 864e5).toISOString();

const { data: pair } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").order("id", { ascending: true }).range(50, 51);   // window 50-51
const [A, B] = pair;
const before = {};
for (const v of pair) {
  const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
  before[v.id] = data;
}
console.log(`subjects: A=${A.name}  B=${B.name}\n`);

const AREA = { exclusive_trade: "E2E-Guard-Trade", exclusive_county: "E2E-Guard-County", exclusive_state: "ZZ" };

try {
  console.log("1. Exclusivity — one verified exclusive per (trade, county, state)");
  const claim = (id) => db.from("coldcall_leads")
    .update({ vetting_status: "verified", plan: "exclusive", ...AREA, exclusive_until: plusYear })
    .eq("id", id).select("id").maybeSingle();

  const first = await claim(A.id);
  ok("first exclusive claim succeeds", !first.error, first.error?.message ?? "");

  const second = await claim(B.id);
  ok("SECOND claim on the same area is REFUSED", !!second.error,
    second.error ? `${second.error.code} ${second.error.message.slice(0, 90)}` : "*** IT WAS ALLOWED ***");
  ok("refusal is a unique violation (23505)", second.error?.code === "23505", second.error?.code ?? "none");

  // A different area must still be claimable.
  const other = await db.from("coldcall_leads")
    .update({ vetting_status: "verified", plan: "exclusive",
              exclusive_trade: "E2E-Guard-Trade", exclusive_county: "E2E-Other-County",
              exclusive_state: "ZZ", exclusive_until: plusYear })
    .eq("id", B.id).select("id").maybeSingle();
  ok("a DIFFERENT county is still claimable", !other.error, other.error?.message ?? "");

  // Non-verified must not hold the slot — that is what lets expiry/downgrade free it.
  await db.from("coldcall_leads").update({ vetting_status: "suspended" }).eq("id", A.id);
  const reclaim = await claim(B.id);
  ok("slot frees when the holder is no longer verified", !reclaim.error, reclaim.error?.message ?? "");

  console.log("\n2. Audit log is append-only");
  const ins = await db.from("coldcall_vetting_audit")
    .insert({ lead_id: A.id, field: "vetting_status", old_value: "lead", new_value: "verified", reason: "e2e guard test" })
    .select("id").single();
  ok("INSERT is allowed", !ins.error, ins.error?.message ?? "");

  if (ins.data) {
    const upd = await db.from("coldcall_vetting_audit").update({ reason: "tampered" }).eq("id", ins.data.id).select("id");
    ok("UPDATE is REFUSED by the trigger", !!upd.error,
      upd.error ? upd.error.message.slice(0, 90) : "*** TAMPERING WAS ALLOWED ***");

    const del = await db.from("coldcall_vetting_audit").delete().eq("id", ins.data.id).select("id");
    ok("DELETE is REFUSED by the trigger", !!del.error,
      del.error ? del.error.message.slice(0, 90) : "*** DELETION WAS ALLOWED ***");
  }

  console.log("\n3. Config is readable and seeded");
  const { data: cfg } = await db.from("coldcall_config").select("key, value").eq("key", "comp_grace_days").maybeSingle();
  ok("comp_grace_days present", cfg?.value === "30", JSON.stringify(cfg));

  console.log("\n4. 1a retirement landed");
  const { data: svcs } = await db.from("coldcall_services").select("slug, active").order("sort_order");
  const tl = (svcs ?? []).find((s) => s.slug === "trustlight");
  ok("trustlight catalog row is inactive", tl && tl.active === false, JSON.stringify(tl));
  ok("the other three stay active", (svcs ?? []).filter((s) => s.active).length === 3,
    JSON.stringify((svcs ?? []).filter((s) => s.active).map((s) => s.slug)));
  const { count: activeTl } = await db.from("coldcall_lead_signups")
    .select("id", { count: "exact", head: true }).eq("service_slug", "trustlight").eq("status", "active");
  ok("no active trustlight signups remain", activeTl === 0, String(activeTl));
  const { count: histTl } = await db.from("coldcall_lead_signups")
    .select("id", { count: "exact", head: true }).eq("service_slug", "trustlight");
  ok("history KEPT (soft-cancel, not deleted)", histTl === 1, `${histTl} row(s)`);
  const { count: svcTl } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).eq("svc_trustlight", true);
  // The invariant is that retiring the trustlight CATALOG row did not wipe the
  // per-lead interest toggle — not that the number is frozen. Leads keep
  // expressing interest on calls, so this only ever grows; 17 is what stood at
  // retirement. A wipe would show up as 0, or as a drop below that floor.
  ok("svc_trustlight interest toggle untouched", svcTl >= 17, `${svcTl} leads (>= 17 at retirement)`);

} finally {
  console.log("\n5. Restore");
  // Clear audit rows written by this test — the trigger blocks DELETE, so this
  // is reported rather than forced. Append-only means append-only.
  for (const v of pair) await db.from("coldcall_leads").update(before[v.id]).eq("id", v.id);
  let restored = true;
  for (const v of pair) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      if (JSON.stringify(before[v.id][k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        restored = false; console.log(`     MISMATCH ${v.name}.${k}`);
      }
    }
  }
  ok("both leads restored exactly", restored);
  const { count: auditRows } = await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true });
  console.log(`     audit rows left behind (cannot be deleted, by design): ${auditRows}`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

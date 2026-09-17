// MANUAL entry into the vetting queue — the "Send for verification" button.
//
// The AUTOMATIC path used to live here too, hooked on a trustlight signup.
// It moved onto coldcall_leads.plan (Rob's option 2, 2026-09-15) and is now
// covered by e2e-plan-trigger.mjs. The obsolete assertions were removed from
// this file rather than left failing.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const AGENT = "https://textos-agent-test.rgaudet2023.workers.dev";
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
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(60)} ${p ? "PASS" : "*** FAIL ***"} ${x}`); };

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

const { data: subject } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(12, 12).single();   // window 12
const ID = subject.id;
console.log(`subject: ${subject.name}\n`);
const RUN_START = new Date(Date.now() - 1000).toISOString();
const { data: snap } = await db.from("coldcall_leads").select("vetting_status, plan").eq("id", ID).single();
const auditCount = async () => (await db.from("coldcall_vetting_audit")
  .select("id", { count: "exact", head: true }).eq("lead_id", ID)).count;

try {
  console.log("1. Send for verification");
  const before = await auditCount();
  const m1 = await api(`/api/admin/vetting/${ID}/enter`, { method: "POST", body: JSON.stringify({}) });
  ok("200", m1.status === 200, `status=${m1.status}`);
  ok("moved to in_verification", m1.body?.vetting_status === "in_verification", m1.body?.vetting_status);
  ok("audit recorded", m1.body?.audit_recorded === true);

  const { data: aud } = await db.from("coldcall_vetting_audit")
    .select("reason, actor_email, old_value, new_value").eq("lead_id", ID).gte("created_at", RUN_START);
  ok("reason names the operator", aud.some((a) => /^manual: .+@/.test(a.reason ?? "")),
    JSON.stringify(aud.map((a) => a.reason)));
  ok("records lead -> in_verification",
    aud.some((a) => a.old_value === "lead" && a.new_value === "in_verification"));
  ok("actor recorded", aud.every((a) => !!a.actor_email));

  console.log("\n2. Cannot be clicked twice");
  const m2 = await api(`/api/admin/vetting/${ID}/enter`, { method: "POST", body: JSON.stringify({}) });
  ok("second click -> 409", m2.status === 409, `status=${m2.status} ${JSON.stringify(m2.body?.message)}`);
  ok("409 names the current status", m2.body?.details?.current === "in_verification");
  ok("no duplicate audit row", (await auditCount()) === before + 1, `${before} -> ${await auditCount()}`);

  console.log("\n3. It verifies nothing");
  const { data: d } = await db.from("coldcall_leads")
    .select("slug, verified_at, is_published, plan").eq("id", ID).single();
  ok("no slug / verified_at / publish", !d.slug && !d.verified_at && d.is_published === false, JSON.stringify(d));
  ok("and does NOT set a paid plan", d.plan === "none", d.plan);

  console.log("\n4. It lands on the queue's default view");
  const q = await api("/api/admin/vetting-queue?status=in_verification&page_size=200");
  ok("present in the in_verification queue", (q.body?.leads ?? []).some((l) => l.id === ID));

} finally {
  console.log("\n5. Restore");
  await db.from("coldcall_leads").update(snap).eq("id", ID);
  const { data: after } = await db.from("coldcall_leads").select("vetting_status, plan").eq("id", ID).single();
  ok("lead restored exactly", JSON.stringify(after) === JSON.stringify(snap), JSON.stringify(after));
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

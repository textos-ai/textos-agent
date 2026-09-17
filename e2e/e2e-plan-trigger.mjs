// The automatic vetting trigger, now on coldcall_leads.plan (Rob's option 2).
//
// Also asserts the OLD trigger is gone: a trustlight signup must no longer
// enter the queue, because decision 1a retired that service and a hook there
// would be unreachable code.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Distinct lead window (20-21) so this suite cannot fight another
// running back to back over the same records.
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

const { data: subs } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(20, 21);
const [A, B] = subs;
console.log(`plan subject  : ${A.name}\nsignup subject: ${B.name}\n`);
const RUN_START = new Date(Date.now() - 1000).toISOString();
const snap = {};
for (const v of subs) {
  const { data } = await db.from("coldcall_leads").select("plan, vetting_status").eq("id", v.id).single();
  snap[v.id] = data;
}
const auditFor = async (id) => (await db.from("coldcall_vetting_audit")
  .select("field, old_value, new_value, reason, actor_email")
  .eq("lead_id", id).gte("created_at", RUN_START)).data ?? [];

try {
  console.log("1. Validation");
  const bad = await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "gold" }) });
  ok("unknown plan -> 400", bad.status === 400, JSON.stringify(bad.body?.message));
  const noAuth = await fetch(`${AGENT}/api/admin/vetting/${A.id}/plan`, { method: "POST", body: "{}" });
  ok("unauthenticated -> 401", noAuth.status === 401, `status=${noAuth.status}`);

  console.log("\n2. plan='none' does NOT enter the queue");
  const none = await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "none" }) });
  ok("200", none.status === 200, `status=${none.status}`);
  ok("no vetting entry", none.body?.vetting === null, JSON.stringify(none.body?.vetting));
  const { data: s0 } = await db.from("coldcall_leads").select("vetting_status").eq("id", A.id).single();
  ok("still at 'lead'", s0.vetting_status === "lead", s0.vetting_status);

  console.log("\n3. plan='verification' ENTERS the queue");
  const v1 = await api(`/api/admin/vetting/${A.id}/plan`, {
    method: "POST", body: JSON.stringify({ plan: "verification", reason: "paid via Stripe" }),
  });
  ok("200", v1.status === 200, `status=${v1.status}`);
  ok("plan recorded", v1.body?.plan === "verification" && v1.body?.previous === "none",
    `${v1.body?.previous} -> ${v1.body?.plan}`);
  ok("vetting entry reported", v1.body?.vetting?.moved === true, JSON.stringify(v1.body?.vetting));
  const { data: s1 } = await db.from("coldcall_leads").select("vetting_status, plan").eq("id", A.id).single();
  ok("lead is now in_verification", s1.vetting_status === "in_verification", s1.vetting_status);
  ok("NOT auto-verified", s1.vetting_status !== "verified");

  const aud = await auditFor(A.id);
  ok("plan change audited", aud.some((a) => a.field === "plan" && a.old_value === "none" && a.new_value === "verification"));
  ok("audit reason names the PLAN trigger, not a signup",
    aud.some((a) => a.field === "vetting_status" && a.reason === "auto: plan set to verification"),
    JSON.stringify(aud.filter((a) => a.field === "vetting_status").map((a) => a.reason)));
  ok("actor recorded", aud.every((a) => !!a.actor_email), JSON.stringify([...new Set(aud.map((a) => a.actor_email))]));

  console.log("\n4. Upgrading verification -> exclusive does not restart vetting");
  const before4 = (await auditFor(A.id)).filter((a) => a.field === "vetting_status").length;
  const ex = await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "exclusive" }) });
  ok("200", ex.status === 200);
  ok("plan upgraded", ex.body?.plan === "exclusive" && ex.body?.previous === "verification");
  ok("no second queue entry", ex.body?.vetting === null, JSON.stringify(ex.body?.vetting));
  const after4 = (await auditFor(A.id)).filter((a) => a.field === "vetting_status").length;
  ok("no duplicate vetting_status audit row", after4 === before4, `${before4} -> ${after4}`);

  console.log("\n5. Re-saving the same plan is not a new signup");
  const beforeAll = (await auditFor(A.id)).length;
  await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "exclusive" }) });
  ok("no audit row for an unchanged plan", (await auditFor(A.id)).length === beforeAll,
    `${beforeAll} -> ${(await auditFor(A.id)).length}`);

  console.log("\n6. The plan trigger works on a business ALREADY being worked");
  await db.from("coldcall_leads").update({ vetting_status: "verified" }).eq("id", A.id);
  const onVerified = await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "none" }) });
  ok("downgrade accepted", onVerified.status === 200);
  const backUp = await api(`/api/admin/vetting/${A.id}/plan`, { method: "POST", body: JSON.stringify({ plan: "verification" }) });
  ok("re-entering a paid plan does not rewind a verified business",
    backUp.body?.vetting?.moved === false, JSON.stringify(backUp.body?.vetting));
  const { data: s6 } = await db.from("coldcall_leads").select("vetting_status").eq("id", A.id).single();
  ok("still verified", s6.vetting_status === "verified", s6.vetting_status);

  console.log("\n7. The OLD trigger is gone — a trustlight signup no longer enters");
  await db.from("coldcall_services").update({ active: true }).eq("slug", "trustlight");
  const sg = await api(`/api/admin/coldcall-leads/${B.id}/signups`, {
    method: "POST", body: JSON.stringify({ service_slug: "trustlight" }),
  });
  ok("signup still works", sg.status === 201, `status=${sg.status}`);
  ok("response carries no vetting block", sg.body?.vetting === undefined, JSON.stringify(sg.body?.vetting));
  const { data: s7 } = await db.from("coldcall_leads").select("vetting_status").eq("id", B.id).single();
  ok("the signup did NOT enter the queue", s7.vetting_status === "lead", s7.vetting_status);
  ok("and wrote no vetting audit row", (await auditFor(B.id)).length === 0, String((await auditFor(B.id)).length));

} finally {
  console.log("\n8. Restore");
  await db.from("coldcall_services").update({ active: false }).eq("slug", "trustlight");
  await db.from("coldcall_lead_signups").delete().eq("lead_id", B.id).eq("service_slug", "trustlight");
  for (const v of subs) await db.from("coldcall_leads").update(snap[v.id]).eq("id", v.id);
  let okAll = true;
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select("plan, vetting_status").eq("id", v.id).single();
    if (JSON.stringify(data) !== JSON.stringify(snap[v.id])) {
      okAll = false; console.log(`     MISMATCH ${v.name}: ${JSON.stringify(data)}`);
    }
  }
  ok("both leads restored exactly", okAll);
  const { data: svc } = await db.from("coldcall_services").select("active").eq("slug", "trustlight").single();
  ok("trustlight stays retired (1a intact)", svc.active === false);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

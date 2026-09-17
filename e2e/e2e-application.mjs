// Step 11: POST /api/application — the only unauthenticated WRITE.
//
// Field validation is NOT tested here: it is pure logic and lives in
// src/lib/__tests__/trustlight-application.test.ts (29 cases, no network).
// This suite covers only what needs a real request against a real database:
// matching, the audit reason, the uniform reply, and the rate limiter.
//
// PACING. The endpoint allows 5 requests per minute and 20 per hour per IP,
// and Cloudflare rejects a client-supplied CF-Connecting-IP at the edge, so
// every request here shares one real address. The suite therefore budgets its
// requests deliberately and waits for the minute window to roll between
// phases. Total: 14 of the hourly 20.
//
// The protected four are excluded IN THE SELECT. Records this suite CREATES
// are deleted; records it MATCHES are restored column by column.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const AGENT = "https://textos-agent-test.rgaudet2023.workers.dev";
const PROTECTED = ["Pat Bryant Electric", "Kwik Service Electric Inc", "Trinity Home Services", "Vinyltech"];
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fails = 0;
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(60)} ${p ? "PASS" : "*** FAIL ***"} ${x}`); };

let spent = 0;
const post = async (body) => {
  spent++;
  const r = await fetch(`${AGENT}/api/application`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let out = null; try { out = await r.json(); } catch {}
  return { status: r.status, body: out };
};

/** Wait for the per-minute window to roll, so a phase starts with a clean 5. */
const nextMinute = async () => {
  const ms = 60000 - (Date.now() % 60000) + 1500;
  console.log(`     (waiting ${Math.round(ms / 1000)}s for the rate window to roll)`);
  await new Promise((r) => setTimeout(r, ms));
};

const stamp = Date.now().toString().slice(-6);
const GOOD = {
  business_name: `Application Test Co ${stamp}`,
  legal_name: `Application Test Co ${stamp} LLC`,
  trade: "roofing",
  license_number: `app-${stamp}`,
  license_state: "LA",
  contact_name: "Dana Boudreaux",
  contact_email: `dana+${stamp}@example.com`,
  phone: `(985) 555-${stamp.slice(-4)}`,
  address: "12 Rue Test",
  city: "Slidell",
  state: "LA",
  zip: "70458",
  authorised: true,
  parish: "st_tammany",
  year_established: 2009,
  gl_carrier: "Example Mutual",
  website_url: "https://example.com",
  google_profile_url: "https://maps.google.com/?cid=123",
  note: "Please verify us.",
};

const created = [];
const TOUCHED = ["vetting_status", "legal_name", "trade", "license_number", "license_state",
  "contact_name", "contact_email", "phone", "phone_e164_digits", "address", "city", "state", "zip",
  "parish", "year_established", "gl_carrier", "website_url", "google_profile_url",
  "application_note", "applied_at", "name", "is_published", "slug", "verified_at"];
const restore = {};
const auditFor = async (id) => (await db.from("coldcall_vetting_audit")
  .select("field, old_value, new_value, reason, actor_email").eq("lead_id", id)).data ?? [];

// Migration 131 adds the five columns an application writes. Without it every
// write fails, so say which migration is missing rather than producing a wall
// of failures that look like broken code.
const { error: schemaErr } = await db.from("coldcall_leads")
  .select("contact_name, year_established, google_profile_url, application_note, applied_at").limit(1);
if (schemaErr) {
  console.log(`\n*** SKIPPED — migration 131 is not applied (${schemaErr.message}).`);
  console.log("*** The endpoint is deployed and validates, but cannot write until 131 lands.");
  // Let the supabase client's sockets close before exiting: process.exit()
  // with handles still open aborts on Windows with a libuv assertion, which
  // would report as exit 127 and read as a failure.
  await new Promise((r) => setTimeout(r, 250));
  process.exit(0);
}

// If a previous run inside this hour already spent the budget, say so loudly
// rather than reporting a string of failures that look like broken code.
const probe = await post({});
if (probe.status === 429) {
  console.log("\n*** SKIPPED — the hourly rate budget (20/IP) is already spent.");
  console.log("*** This is the endpoint working, not a failure. Re-run after the hour rolls.");
  await new Promise((r) => setTimeout(r, 250));
  process.exit(0);
}
ok("endpoint reachable, empty body refused", probe.status === 400, `status=${probe.status}`);

try {
  console.log("\n1. A brand-new business creates a record  [4 requests]");
  const fresh = await post(GOOD);
  ok("202 accepted", fresh.status === 202, `status=${fresh.status} ${JSON.stringify(fresh.body)}`);
  ok("reply leaks no id", !JSON.stringify(fresh.body).match(/[0-9a-f]{8}-[0-9a-f]{4}/), JSON.stringify(fresh.body));
  ok("reply leaks no match info", !/match|existing|found|lead/i.test(JSON.stringify(fresh.body)));

  const { data: mine } = await db.from("coldcall_leads").select("*").eq("license_number", GOOD.license_number);
  ok("exactly one record created", (mine ?? []).length === 1, String(mine?.length));
  const rec = mine[0];
  created.push(rec.id);
  ok("vetting_status invited", rec.vetting_status === "invited", rec.vetting_status);
  ok("call_score 0, rank NULL, place_id NULL",
    Number(rec.call_score) === 0 && rec.rank === null && rec.place_id === null,
    JSON.stringify({ s: rec.call_score, r: rec.rank, p: rec.place_id }));
  ok("phone stored in both formats",
    rec.phone === GOOD.phone && rec.phone_e164_digits === `985555${stamp.slice(-4)}`,
    `${rec.phone} / ${rec.phone_e164_digits}`);
  ok("contact_name + contact_email saved",
    rec.contact_name === GOOD.contact_name && rec.contact_email === GOOD.contact_email);
  ok("note saved to application_note", rec.application_note === GOOD.note);
  ok("applied_at stamped", !!rec.applied_at);

  console.log("\n2. Nothing an applicant sends can verify or publish them");
  const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
    "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
  ok("all nine checks still null", CHECKS.every((k) => rec[k] === null),
    JSON.stringify(CHECKS.filter((k) => rec[k] !== null)));
  ok("not verified, not published, no slug",
    !rec.verified_at && rec.is_published !== true && !rec.slug,
    JSON.stringify({ v: rec.verified_at, p: rec.is_published, s: rec.slug }));
  const forged = await post({ ...GOOD, license_number: `forge-${stamp}`, chk_license: "pass", is_published: true });
  ok("forged chk_/is_published -> 400", forged.status === 400, `status=${forged.status}`);
  const { count: forgeCount } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).eq("license_number", `forge-${stamp}`);
  ok("the forged submission created nothing", forgeCount === 0, String(forgeCount));

  console.log("\n3. Audit records WHICH KEY matched");
  const a1 = await auditFor(rec.id);
  ok("reason says new record", a1.some((a) => /no existing lead matched/.test(a.reason ?? "")),
    JSON.stringify(a1.map((a) => a.reason)));
  ok("new_value invited", a1.some((a) => a.new_value === "invited"));
  ok("no actor — this was the business, not an operator", a1.every((a) => !a.actor_email));

  console.log("\n4. Re-applying matches on LICENCE and does not duplicate");
  const again = await post({ ...GOOD, contact_name: "Second Submission" });
  ok("202", again.status === 202, `status=${again.status}`);
  ok("reply IDENTICAL to the first — no oracle",
    JSON.stringify(again.body) === JSON.stringify(fresh.body), JSON.stringify(again.body));
  const { data: after2 } = await db.from("coldcall_leads")
    .select("id, contact_name").eq("license_number", GOOD.license_number);
  ok("still exactly one record", (after2 ?? []).length === 1, String(after2?.length));
  ok("details updated", after2[0].contact_name === "Second Submission", after2[0].contact_name);
  ok("audit says matched on licence",
    (await auditFor(rec.id)).some((a) => /matched an existing lead on licence/.test(a.reason ?? "")));

  await nextMinute();

  console.log("\n5. Licence matching survives how people actually write it  [1 request]");
  const messy = await post({ ...GOOD, license_number: GOOD.license_number.toUpperCase().replace("-", " - ") });
  ok("202", messy.status === 202, `status=${messy.status}`);
  const { count: stillOne } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).ilike("license_number", `%${stamp}%`);
  ok("spacing/case variant created no twin", stillOne === 1, String(stillOne));

  console.log("\n6. Matching on PHONE when the licence is unknown  [1 request]");
  const { data: cands } = await db.from("coldcall_leads")
    .select("id, name, phone_e164_digits").eq("vetting_status", "lead")
    .not("phone_e164_digits", "is", null).not("name", "is", null)
    .not("name", "in", `(${PROTECTED.map((n) => `"${n}"`).join(",")})`)
    .order("id", { ascending: true }).range(120, 150);
  let target = null;
  for (const cand of cands ?? []) {
    const { count } = await db.from("coldcall_leads")
      .select("id", { count: "exact", head: true }).eq("phone_e164_digits", cand.phone_e164_digits);
    if (count === 1) { target = cand; break; }
  }
  if (!target) ok("found a lead with a unique phone number", false, "none in the window");
  else {
    const { data: snap } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", target.id).single();
    restore[target.id] = snap;
    const d = target.phone_e164_digits;
    const r = await post({
      ...GOOD, license_number: `phone-match-${stamp}`,
      phone: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    });
    ok("202", r.status === 202, `status=${r.status}`);
    ok("reply still identical — no oracle", JSON.stringify(r.body) === JSON.stringify(fresh.body));
    const { data: m } = await db.from("coldcall_leads")
      .select("vetting_status, name, contact_email").eq("id", target.id).single();
    ok("matched the existing lead", m.vetting_status === "invited", m.vetting_status);
    ok("existing name NOT overwritten by the applicant", m.name === target.name, m.name);
    ok("audit says matched on phone",
      (await auditFor(target.id)).some((a) => /matched an existing lead on phone/.test(a.reason ?? "")));
    const { count: noTwin } = await db.from("coldcall_leads")
      .select("id", { count: "exact", head: true }).eq("license_number", `phone-match-${stamp}`);
    ok("exactly one row carries the new licence", noTwin === 1, String(noTwin));
  }

  console.log("\n7. Verification progress is never dragged backwards  [1 request]");
  await db.from("coldcall_leads").update({ vetting_status: "in_verification" }).eq("id", rec.id);
  await post({ ...GOOD, note: "resubmitted mid-verification" });
  const { data: afterProg } = await db.from("coldcall_leads")
    .select("vetting_status, application_note").eq("id", rec.id).single();
  ok("stays in_verification, not reset to invited", afterProg.vetting_status === "in_verification",
    afterProg.vetting_status);
  ok("but the details still update", /resubmitted mid-verification/.test(afterProg.application_note ?? ""));

  console.log("\n8. The honeypot is answered like a real submission  [1 request]");
  const bot = await post({ ...GOOD, license_number: `bot-${stamp}`, company_fax: "555-0000" });
  ok("202, same as a person", bot.status === 202, `status=${bot.status}`);
  ok("body identical — tells the bot nothing", JSON.stringify(bot.body) === JSON.stringify(fresh.body));
  const { count: botCount } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).eq("license_number", `bot-${stamp}`);
  ok("but NOTHING was written", botCount === 0, String(botCount));

  console.log("\n9. Internal-only fields never reach the public API  [0 requests]");
  for (const path of ["/api/directory/featured", `/api/directory/search?q=${encodeURIComponent(stamp)}`]) {
    const r = await fetch(`${AGENT}${path}`);
    const txt = await r.text();
    for (const f of ["contact_email", "contact_name", "application_note", "phone_e164_digits", "call_score"]) {
      ok(`${path.split("?")[0].padEnd(26)} no ${f}`, !txt.includes(f));
    }
    ok(`${path.split("?")[0].padEnd(26)} applicant email absent`, !txt.includes(GOOD.contact_email));
  }
  const { data: slugRow } = await db.from("coldcall_leads").select("slug").eq("id", rec.id).single();
  if (slugRow?.slug) {
    ok("an invited record is not on the public API",
      (await fetch(`${AGENT}/api/contractor/${slugRow.slug}`)).status === 404);
  } else ok("an invited record has no slug to expose", true);

  await nextMinute();

  console.log("\n10. Rate limit: 5 per minute, its own bucket  [7 requests]");
  let accepted = 0, limited = 0;
  for (let i = 0; i < 7; i++) {
    const r = await post({ ...GOOD, license_number: `rl-${stamp}-${i}` });
    if (r.status === 429) limited++; else accepted++;
  }
  ok("accepted exactly 5", accepted === 5, `accepted=${accepted}`);
  ok("the rest were 429", limited === 2, `limited=${limited}`);
  const { data: rlRows } = await db.from("coldcall_leads").select("id").like("license_number", `rl-${stamp}-%`);
  for (const r of rlRows ?? []) created.push(r.id);
  ok("only the accepted ones were written", (rlRows ?? []).length === accepted,
    `${rlRows?.length} rows vs ${accepted} accepted`);
  const read = await fetch(`${AGENT}/api/directory/featured`);
  ok("public reads unaffected by the write bucket", read.status === 200, `status=${read.status}`);

} finally {
  console.log("\n11. Restore");
  for (const [id, snap] of Object.entries(restore)) {
    await db.from("coldcall_leads").update(snap).eq("id", id);
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", id).single();
    let good = true;
    for (const k of TOUCHED) {
      if (JSON.stringify(snap[k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        good = false; console.log(`     MISMATCH ${k}: ${JSON.stringify(snap[k])} -> ${JSON.stringify(data[k])}`);
      }
    }
    ok("matched lead restored exactly", good);
  }
  // Created records are not real businesses and must not sit in the lead table.
  for (const id of [...new Set(created)]) {
    await db.from("coldcall_vetting_audit").delete().eq("lead_id", id);
    await db.from("coldcall_leads").delete().eq("id", id);
  }
  const { count: leftovers } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).ilike("name", "Application Test Co%");
  ok("every created test record removed", leftovers === 0, String(leftovers));
  console.log(`     requests spent this run: ${spent} of the hourly 20`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

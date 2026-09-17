// The manual campaign actions: notified + consent recorded by hand, and the
// removal link an operator pastes into their own email.
//
// Sends nothing. Does not touch Pat Bryant Electric, Kwik Service Electric
// Inc, Trinity Home Services or Vinyltech.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ENRICHMENT_COLUMNS } from "./enrichment-columns.mjs";

// Distinct lead window (30-30) so this suite cannot fight another
// running back to back over the same records.
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
const pub = async (path, init = {}) => {
  const r = await fetch(`${AGENT}${path}`, init);
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
  "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
const TOUCHED = ["vetting_status","is_published","slug","trade","city","state","verified_at","verified_year",
  "expires_at","reverify_due","trading_name","rating","review_count","dti_score","blurb","chk_last_run",
  "is_comped","comp_reason","comp_offer_status","comp_offered_at","comp_decided_at",
  "notified_at","listing_consent","removal_token","removal_requested_at",
  ...CHECKS, ...CHECKS.map((c) => `${c}_note`),
  // Verifying through the API probes the website and writes the enrichment
  // columns. This suite never asks for that, but it causes it, so it restores it.
  ...ENRICHMENT_COLUMNS,
];

const { data: subject } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(30, 30).single();
if (PROTECTED.includes(subject.name)) { console.error("picked a protected lead — aborting"); process.exit(1); }
const ID = subject.id;
console.log(`subject: ${subject.name}\n`);
const { data: snap } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();
const RUN_START = new Date(Date.now() - 1000).toISOString();
const auditSince = async () => (await db.from("coldcall_vetting_audit")
  .select("field, old_value, new_value, reason, actor_email")
  .eq("lead_id", ID).gte("created_at", RUN_START)).data ?? [];

try {
  console.log("1. Comp and verify (the board only shows comped records)");
  await api(`/api/admin/vetting/${ID}/comp`, {
    method: "POST", body: JSON.stringify({ is_comped: true, comp_reason: "first-50 campaign" }),
  });
  await api(`/api/admin/vetting/${ID}/profile`, {
    method: "PATCH", body: JSON.stringify({
      trading_name: "Manual Consent Co.", trade: "Roofing", city: "Slidell", state: "LA", rating: 4.6, review_count: 33,
    }),
  });
  await api(`/api/admin/vetting/${ID}/enter`, { method: "POST", body: JSON.stringify({}) });
  await api(`/api/admin/vetting/${ID}/checks`, {
    method: "PATCH", body: JSON.stringify(Object.fromEntries(CHECKS.map((k) => [k, "pass"]))),
  });
  const v = await api(`/api/admin/vetting/${ID}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "manual consent e2e" }),
  });
  ok("verified", v.status === 200);
  const slug = v.body?.lead?.slug;
  await api(`/api/admin/vetting/${ID}/publish`, { method: "POST", body: JSON.stringify({ is_published: true }) });
  ok("published and live", (await pub(`/api/contractor/${slug}`)).status === 200);

  console.log("\n2. Campaign board shows it");
  const board = await api("/api/admin/vetting/campaign");
  const row = (board.body?.leads ?? []).find((l) => l.id === ID);
  ok("on the board", !!row);
  ok("shows 9/9 checks", row?.checks_passed === 9 && row?.checks_total === 9);
  ok("shows the comp reason", /first-50/.test(row?.comp_reason ?? ""));
  ok("grace period reported", board.body?.grace_days === 30, String(board.body?.grace_days));

  console.log("\n3. Removal link — mint, then idempotent");
  const l1 = await api(`/api/admin/vetting/${ID}/removal-link`, { method: "POST", body: JSON.stringify({}) });
  ok("200", l1.status === 200, `status=${l1.status}`);
  ok("minted on first call", l1.body?.minted === true);
  ok("url uses the configured site", /^https:\/\/trustlight\.com\/remove\/[a-f0-9]{48}$/.test(l1.body?.removal_url ?? ""),
    l1.body?.removal_url);
  ok("also gives a clickable test url", /textos-web-test\.pages\.dev\/remove\//.test(l1.body?.test_removal_url ?? ""));
  const l2 = await api(`/api/admin/vetting/${ID}/removal-link`, { method: "POST", body: JSON.stringify({}) });
  ok("second call returns the SAME link", l2.body?.removal_url === l1.body?.removal_url);
  ok("and does not re-mint", l2.body?.minted === false);
  const token = l1.body.removal_url.split("/remove/")[1];

  console.log("\n4. Manual notified + consent: pending");
  const backdate = new Date(Date.now() - 3 * 864e5).toISOString();
  const p1 = await api(`/api/admin/vetting/${ID}/notified`, {
    method: "POST", body: JSON.stringify({ listing_consent: "pending", notified_at: backdate, note: "emailed from my own inbox" }),
  });
  ok("200", p1.status === 200, `status=${p1.status}`);
  ok("notified_at backdated as supplied",
    new Date(p1.body?.lead?.notified_at).toISOString().slice(0, 10) === backdate.slice(0, 10),
    p1.body?.lead?.notified_at);
  ok("consent pending", p1.body?.lead?.listing_consent === "pending");
  ok("still published — pending is not a decline", p1.body?.lead?.is_published === true);
  const a1 = await auditSince();
  ok("audit records it as MANUAL, not a system send",
    a1.some((a) => a.field === "notified_at" && /manual: emailed by hand/.test(a.reason ?? "")),
    JSON.stringify(a1.filter((a) => a.field === "notified_at").map((a) => a.reason)));
  ok("audit names who recorded it", a1.every((a) => !!a.actor_email));

  console.log("\n5. Consent: granted");
  const g = await api(`/api/admin/vetting/${ID}/notified`, {
    method: "POST", body: JSON.stringify({ listing_consent: "granted" }),
  });
  ok("granted", g.body?.lead?.listing_consent === "granted");
  ok("stays published", g.body?.lead?.is_published === true);
  ok("stays live on the public API", (await pub(`/api/contractor/${slug}`)).status === 200);

  console.log("\n6. Validation");
  const badConsent = await api(`/api/admin/vetting/${ID}/notified`, {
    method: "POST", body: JSON.stringify({ listing_consent: "maybe" }),
  });
  ok("unknown consent -> 400", badConsent.status === 400, JSON.stringify(badConsent.body?.message));
  const future = await api(`/api/admin/vetting/${ID}/notified`, {
    method: "POST", body: JSON.stringify({ listing_consent: "pending", notified_at: new Date(Date.now() + 9 * 864e5).toISOString() }),
  });
  ok("future notified_at -> 400", future.status === 400, JSON.stringify(future.body?.message));

  console.log("\n7. Consent: declined removes the listing");
  const d = await api(`/api/admin/vetting/${ID}/notified`, {
    method: "POST", body: JSON.stringify({ listing_consent: "declined", note: "asked to be taken down on the phone" }),
  });
  ok("declined", d.body?.lead?.listing_consent === "declined");
  ok("unpublished", d.body?.lead?.is_published === false);
  ok("status is 'removed'", d.body?.lead?.vetting_status === "removed", d.body?.lead?.vetting_status);
  ok("GONE from the public API", (await pub(`/api/contractor/${slug}`)).status === 404);
  const a2 = await auditSince();
  ok("decline audited with the reason",
    a2.some((a) => a.field === "vetting_status" && /business declined/.test(a.reason ?? "")),
    JSON.stringify(a2.filter((a) => a.field === "vetting_status").map((a) => a.reason)));

  console.log("\n8. The removal link still works for the business itself");
  // Put it back so the self-service path can be exercised.
  await db.from("coldcall_leads").update({
    vetting_status: "verified", is_published: true, listing_consent: "pending", removal_requested_at: null,
  }).eq("id", ID);
  ok("live again", (await pub(`/api/contractor/${slug}`)).status === 200);
  const info = await pub(`/api/removal/${token}`);
  ok("GET the link — read only, no login", info.status === 200 && info.body?.name === "Manual Consent Co.",
    JSON.stringify(info.body?.name));
  ok("GET did not remove anything", (await pub(`/api/contractor/${slug}`)).status === 200);
  const rm = await pub(`/api/removal/${token}`, { method: "POST" });
  ok("POST removes", rm.status === 200 && rm.body?.removed === true);
  ok("gone from the public API", (await pub(`/api/contractor/${slug}`)).status === 404);

  console.log("\n9. Conversion tracking");
  await db.from("coldcall_leads").update({ vetting_status: "verified" }).eq("id", ID);
  const off = await api(`/api/admin/vetting/${ID}/comp-offer`, { method: "POST", body: JSON.stringify({ status: "offered" }) });
  ok("offered, dated", off.status === 200 && !!off.body?.comp_offered_at);
  const acc = await api(`/api/admin/vetting/${ID}/comp-offer`, { method: "POST", body: JSON.stringify({ status: "accepted" }) });
  ok("accepted, dated", acc.status === 200 && !!acc.body?.comp_decided_at);
  const board2 = await api("/api/admin/vetting/campaign");
  const row2 = (board2.body?.leads ?? []).find((l) => l.id === ID);
  ok("board shows the conversion", row2?.comp_offer_status === "accepted" && !!row2?.comp_decided_at,
    JSON.stringify({ s: row2?.comp_offer_status, d: row2?.comp_decided_at }));

  console.log("\n10. Un-comping leaves verification alone");
  const un = await api(`/api/admin/vetting/${ID}/comp`, { method: "POST", body: JSON.stringify({ is_comped: false }) });
  ok("un-comped", un.status === 200 && un.body?.is_comped === false);
  const { data: afterUncomp } = await db.from("coldcall_leads").select("vetting_status").eq("id", ID).single();
  ok("still verified", afterUncomp.vetting_status === "verified", afterUncomp.vetting_status);
  const board3 = await api("/api/admin/vetting/campaign");
  ok("off the campaign board", !(board3.body?.leads ?? []).some((l) => l.id === ID));

} finally {
  console.log("\n11. Restore");
  await db.from("coldcall_leads").update(snap).eq("id", ID);
  const { data: after } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();
  let restored = true;
  for (const k of TOUCHED) {
    if (JSON.stringify(snap[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      restored = false; console.log(`     MISMATCH ${k}: ${JSON.stringify(snap[k])} -> ${JSON.stringify(after[k])}`);
    }
  }
  ok("subject restored exactly", restored);
  // Scoped to THIS run and THIS lead. Counting the whole table made the result
  // depend on suite order — another suite's queued row failed this one.
  const { data: appr } = await db.from("coldcall_email_approvals")
    .select("id, status, sent_at").eq("lead_id", ID).gte("created_at", RUN_START);
  ok("manual consent created NO email approval row", (appr ?? []).length === 0, JSON.stringify(appr));
  // The standing rule, asserted table-wide: nothing has ever actually sent.
  const { count: sent } = await db.from("coldcall_email_approvals")
    .select("id", { count: "exact", head: true }).not("sent_at", "is", null);
  ok("no email has EVER been sent", sent === 0, String(sent));
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

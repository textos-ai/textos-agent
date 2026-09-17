// Step 7: the free-vetting campaign.
//
// NO REAL EMAIL IS SENT BY THIS SCRIPT. Every notify call is a dry run; the
// send path is exercised only to the point of asserting that a dry run sends
// nothing and stamps nothing. Rob reviews the content before anything goes out.
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
const TOUCHED = ["vetting_status","slug","is_published","verified_at","verified_year","expires_at","reverify_due",
  "is_comped","comp_reason","comp_offer_status","comp_offered_at","comp_decided_at",
  "notified_at","listing_consent","removal_token","removal_requested_at","plan",
  "trading_name","trade","city","state","rating","review_count","dti_score","blurb","chk_last_run",
  // Step 3 writes these three via the profile editor and they were missing
  // from this list, so every run left LIC-CAMPAIGN-99 behind on a real lead.
  // That residue is exactly what the application endpoint matches on, so it
  // could have produced a false licence match against test junk.
  "license_number","license_state","gl_carrier",
  // Contact fields: the profile endpoint publishes them now, so the email has
  // to list them and this suite has to set them. Same restore rule applies.
  "phone","website_url","address","zip","google_profile_url",
  ...CHECKS, ...CHECKS.map((c) => `${c}_note`)];

const { data: subs } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(16, 17);   // window 16-17
const [A, B] = subs;
console.log(`comped subject: ${A.name}\nsweep subject : ${B.name}\n`);
const snap = {};
for (const v of subs) {
  const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
  snap[v.id] = data;
}
const hadConfig = (await db.from("coldcall_config").select("key")).data.map((r) => r.key);

// Approval rows this run created. Scoped by time AND by subject so a row left
// by another suite cannot pass or fail this one.
const RUN_START = new Date(Date.now() - 1000).toISOString();
const approvalsThisRun = async () => (await db.from("coldcall_email_approvals")
  .select("id, status, sent_at, approved_at, from_email, to_email")
  .in("lead_id", subs.map((v) => v.id)).gte("created_at", RUN_START)).data ?? [];

try {
  console.log("1. Migration 127 config, and the sender ban");
  const cfgRows = Object.fromEntries(
    ((await db.from("coldcall_config").select("key, value")).data ?? []).map((r) => [r.key, r.value]));
  for (const k of ["trustlight_site_url", "trustlight_from_email", "trustlight_from_name"]) {
    ok(`127 seeded ${k}`, !!cfgRows[k], String(cfgRows[k]));
  }
  // Rob's standing rule: a TrustLight email from a victora.ai address reads as
  // phishing to exactly the audience we are trying to earn trust with.
  ok("sender is NOT a victora.ai address", !/victora\.ai/i.test(cfgRows.trustlight_from_email ?? ""),
    cfgRows.trustlight_from_email);
  ok("sender is a trustlight.com address", /@trustlight\.com$/.test(cfgRows.trustlight_from_email ?? ""),
    cfgRows.trustlight_from_email);
  // The off switch is the ABSENCE of this key. Its presence would mean sending
  // had been armed, which nobody has approved.
  ok("email sending is NOT armed", !("trustlight_email_enabled" in cfgRows),
    JSON.stringify(cfgRows.trustlight_email_enabled ?? null));

  // With no contact_email on record and no explicit `to`, queueing must refuse
  // rather than invent a recipient.
  const noTo = await api(`/api/admin/vetting/${A.id}/notify`, { method: "POST", body: JSON.stringify({}) });
  ok("no recipient -> refused", noTo.status === 400, `status=${noTo.status} ${JSON.stringify(noTo.body?.message)}`);
  ok("says why", /no contact_email/.test(noTo.body?.message ?? ""), JSON.stringify(noTo.body?.message));

  console.log("\n2. Comping requires a reason, and changes nothing about verification");
  const noReason = await api(`/api/admin/vetting/${A.id}/comp`, { method: "POST", body: JSON.stringify({ is_comped: true }) });
  ok("comp without a reason -> 400", noReason.status === 400, JSON.stringify(noReason.body?.message));
  const comped = await api(`/api/admin/vetting/${A.id}/comp`, {
    method: "POST", body: JSON.stringify({ is_comped: true, comp_reason: "first-50 free vetting campaign" }),
  });
  ok("comped", comped.status === 200 && comped.body?.is_comped === true);
  const { data: c1 } = await db.from("coldcall_leads").select("vetting_status, is_published").eq("id", A.id).single();
  ok("comping did NOT verify or publish", c1.vetting_status === "lead" && c1.is_published === false, JSON.stringify(c1));

  console.log("\n3. A comped business faces the SAME nine-check gate");
  await api(`/api/admin/vetting/${A.id}/enter`, { method: "POST", body: JSON.stringify({}) });
  const blocked = await api(`/api/admin/vetting/${A.id}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "campaign e2e" }),
  });
  ok("comped + 0/9 checks -> still 409 refused", blocked.status === 409, JSON.stringify(blocked.body?.message));

  await api(`/api/admin/vetting/${A.id}/profile`, {
    method: "PATCH", body: JSON.stringify({
      trading_name: "Campaign Roofing Co.", trade: "Roofing", city: "Slidell", state: "LA",
      rating: 4.8, review_count: 61, dti_score: 88, blurb: "Storm damage and full roof replacement.",
      license_number: "LIC-CAMPAIGN-99", license_state: "LA", gl_carrier: "Campaign Mutual",
    }),
  });
  // The contact path the profile endpoint publishes, and which the notify
  // email must therefore describe.
  await db.from("coldcall_leads").update({
    phone: "(985) 555-0199",
    website_url: "https://campaign-roofing-8823.example.invalid",
    address: "88 Campaign Way", zip: "70458",
    google_profile_url: "https://maps.example.invalid/campaign-roofing-8823",
  }).eq("id", A.id);

  await api(`/api/admin/vetting/${A.id}/checks`, {
    method: "PATCH", body: JSON.stringify(Object.fromEntries(CHECKS.map((k) => [k, "pass"]))),
  });
  const verified = await api(`/api/admin/vetting/${A.id}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "campaign e2e" }),
  });
  ok("9/9 -> verified, same as a paying business", verified.status === 200);
  const slug = verified.body?.lead?.slug;

  console.log("\n4. Preview renders without touching the record");
  const dry = await api(`/api/admin/vetting/${A.id}/notify`, {
    method: "POST", body: JSON.stringify({ preview: true, to: "nobody@example.com" }),
  });
  ok("200", dry.status === 200, `status=${dry.status}`);
  ok("preview: true", dry.body?.preview === true);
  ok("queued: false — a preview is not a queued email", dry.body?.queued === false);
  ok("returns subject, text and html", !!dry.body?.email?.subject && !!dry.body?.email?.text && !!dry.body?.email?.html);
  const { data: afterDry } = await db.from("coldcall_leads")
    .select("notified_at, listing_consent, removal_token").eq("id", A.id).single();
  // removal_token is deliberately NOT in this list: a preview may show a token
  // minted earlier by the removal-link control. What a preview must never do is
  // mark the business as notified or record a consent state.
  ok("a preview stamps NOTHING",
    !afterDry.notified_at && !afterDry.listing_consent, JSON.stringify(afterDry));
  ok("preview created NO approval row",
    (await approvalsThisRun()).length === 0, JSON.stringify(await approvalsThisRun()));

  console.log("\n5. The email says what will actually be published");
  const txt = dry.body.email.text;
  ok("names the business", txt.includes("Campaign Roofing Co."));
  ok("says it cost them nothing", /no cost to you/.test(txt));
  ok("says they did not sign up", /did not sign up/.test(txt));
  ok("lists the nine checks", /nine things/.test(txt));
  ok("shows the rating that will appear", txt.includes("4.8") && txt.includes("61"));
  ok("shows the DTI that will appear", /88 out of 100/.test(txt));
  ok("email lists the phone that will appear", /Phone: \(985\) 555-0199/.test(txt));
  ok("email lists the website that will appear", /campaign-roofing-8823\.example\.invalid/.test(txt));
  ok("email lists the address that will appear", /Address: 88 Campaign Way, Slidell, LA, 70458/.test(txt));
  ok("states what is NOT published", /do not publish your email address/.test(txt));
  ok("never promises to withhold the phone", !/do not publish your phone/.test(txt));
  ok("carries the removal link", /\/remove\/[a-f0-9]{48}/.test(txt), (txt.match(/\/remove\/\S+/) ?? [])[0]);
  ok("offers reply-to-decline as well", /reply to this email/.test(txt));
  // Assert VALUES are absent, not words: the email legitimately says
  // "your insurance with the carrier" when describing what was checked.
  ok("leaks no internal VALUE",
    !txt.includes("LIC-CAMPAIGN-99") && !txt.includes("Campaign Mutual"),
    "");

  console.log("\n6. Warnings tell the operator what is off");
  const warnDry = await api(`/api/admin/vetting/${B.id}/notify`, {
    method: "POST", body: JSON.stringify({ preview: true }),
  });
  ok("warns when not verified", (warnDry.body?.warnings ?? []).some((w) => /Not verified/.test(w)),
    JSON.stringify(warnDry.body?.warnings));
  ok("warns when not comped", (warnDry.body?.warnings ?? []).some((w) => /Not marked as comped/.test(w)));
  ok("warns when there is no address", (warnDry.body?.warnings ?? []).some((w) => /no contact_email/.test(w)));
  ok("no recipient resolved", warnDry.body?.would_send_to === null, JSON.stringify(warnDry.body?.would_send_to));

  console.log("\n6b. Queueing writes a PENDING approval and sends nothing");
  const queued = await api(`/api/admin/vetting/${A.id}/notify`, {
    method: "POST", body: JSON.stringify({ to: "nobody@example.com" }),
  });
  // 201: queueing CREATES an approval row. It is not a send.
  ok("queued", queued.status === 201, `status=${queued.status} ${JSON.stringify(queued.body?.message)}`);
  const mine = await approvalsThisRun();
  ok("exactly one approval row", mine.length === 1, String(mine.length));
  ok("status is pending", mine[0]?.status === "pending", mine[0]?.status);
  ok("NOT sent", !mine[0]?.sent_at, String(mine[0]?.sent_at));
  ok("NOT approved", !mine[0]?.approved_at, String(mine[0]?.approved_at));
  ok("from a trustlight.com address", /@trustlight\.com$/.test(mine[0]?.from_email ?? ""), mine[0]?.from_email);

  console.log("\n7. One-click removal");
  // Simulate the post-notify state without sending: mint the token directly.
  const token = "a".repeat(48);
  await db.from("coldcall_leads").update({
    removal_token: token, notified_at: new Date().toISOString(), listing_consent: "pending", is_published: true,
  }).eq("id", A.id);

  const liveBefore = await pub(`/api/contractor/${slug}`);
  ok("listing is live before removal", liveBefore.status === 200, `status=${liveBefore.status}`);

  const info = await pub(`/api/removal/${token}`);
  ok("GET removal info works with no login", info.status === 200, `status=${info.status}`);
  ok("shows the business name", info.body?.name === "Campaign Roofing Co.", info.body?.name);
  ok("GET is read-only — nothing removed by a link prefetch",
    (await db.from("coldcall_leads").select("vetting_status").eq("id", A.id).single()).data.vetting_status === "verified");
  ok("info leaks nothing internal",
    !JSON.stringify(info.body).match(/phone|chk_|_note|id"/), JSON.stringify(info.body));

  const rm = await pub(`/api/removal/${token}`, { method: "POST" });
  ok("POST removes with no login", rm.status === 200 && rm.body?.removed === true, JSON.stringify(rm.body));
  const { data: gone } = await db.from("coldcall_leads")
    .select("vetting_status, is_published, listing_consent, removal_requested_at").eq("id", A.id).single();
  ok("status is 'removed'", gone.vetting_status === "removed", gone.vetting_status);
  ok("unpublished", gone.is_published === false);
  ok("consent recorded as declined", gone.listing_consent === "declined", gone.listing_consent);
  ok("removal timestamped", !!gone.removal_requested_at);
  ok("listing is GONE from the public API", (await pub(`/api/contractor/${slug}`)).status === 404);
  const { data: rmAudit } = await db.from("coldcall_vetting_audit")
    .select("reason, actor_email, new_value").eq("lead_id", A.id).eq("new_value", "removed");
  ok("audited as self-service with no actor",
    rmAudit.some((a) => /self-service/.test(a.reason ?? "") && !a.actor_email), JSON.stringify(rmAudit.map((a) => a.reason)));
  const bogus = await pub(`/api/removal/${"f".repeat(48)}`, { method: "POST" });
  ok("an unknown token -> 404", bogus.status === 404, `status=${bogus.status}`);

  console.log("\n8. Campaign board");
  const board = await api("/api/admin/vetting/campaign");
  ok("200", board.status === 200, `status=${board.status}`);
  ok("grace period reported", board.body?.grace_days === 30, String(board.body?.grace_days));
  const row = (board.body?.leads ?? []).find((l) => l.id === A.id);
  ok("the comped record is on the board", !!row);
  ok("shows checks progress", row?.checks_passed === 9 && row?.checks_total === 9);
  ok("shows the comp reason", /first-50/.test(row?.comp_reason ?? ""));
  ok("shows the consent pipeline", row?.listing_consent === "declined" && !!row?.notified_at);

  console.log("\n9. Conversion tracking");
  const off = await api(`/api/admin/vetting/${A.id}/comp-offer`, { method: "POST", body: JSON.stringify({ status: "offered" }) });
  ok("offered recorded with a date", off.status === 200 && !!off.body?.comp_offered_at, JSON.stringify(off.body));
  const acc = await api(`/api/admin/vetting/${A.id}/comp-offer`, { method: "POST", body: JSON.stringify({ status: "accepted" }) });
  ok("accepted recorded with a date", acc.status === 200 && !!acc.body?.comp_decided_at);
  const notComped = await api(`/api/admin/vetting/${B.id}/comp-offer`, { method: "POST", body: JSON.stringify({ status: "offered" }) });
  ok("offer on a non-comped business -> 409", notComped.status === 409, JSON.stringify(notComped.body?.message));

  console.log("\n10. Grace-period sweep");
  // B: comped, offered 45 days ago, never converted.
  await db.from("coldcall_leads").update({
    is_comped: true, comp_reason: "sweep test", comp_offer_status: "offered",
    comp_offered_at: new Date(Date.now() - 45 * 864e5).toISOString(),
    vetting_status: "verified", is_published: true,
  }).eq("id", B.id);
  const sweepDry = await api("/api/admin/vetting/comp-sweep", { method: "POST", body: JSON.stringify({}) });
  ok("dry run reports what would drop", sweepDry.body?.dry_run === true && sweepDry.body?.would_drop >= 1,
    `would_drop=${sweepDry.body?.would_drop}`);
  ok("dry run names the lead", (sweepDry.body?.leads ?? []).some((l) => l.id === B.id));
  const { data: untouched } = await db.from("coldcall_leads").select("vetting_status").eq("id", B.id).single();
  ok("dry run changed nothing", untouched.vetting_status === "verified", untouched.vetting_status);

  const sweep = await api("/api/admin/vetting/comp-sweep", { method: "POST", body: JSON.stringify({ confirm: true }) });
  ok("sweep dropped it", sweep.body?.dropped >= 1, JSON.stringify(sweep.body));
  const { data: dropped } = await db.from("coldcall_leads").select("vetting_status, is_published").eq("id", B.id).single();
  ok("dropped to 'removed' and unpublished", dropped.vetting_status === "removed" && dropped.is_published === false);
  const { data: swAudit } = await db.from("coldcall_vetting_audit")
    .select("reason").eq("lead_id", B.id).eq("new_value", "removed");
  ok("audited with the grace reason", swAudit.some((a) => /grace period of 30 days/.test(a.reason ?? "")),
    JSON.stringify(swAudit.map((a) => a.reason)));

  console.log("\n11. A comped business with no offer is NEVER swept");
  await db.from("coldcall_leads").update({
    vetting_status: "verified", is_published: true, comp_offer_status: null, comp_offered_at: null,
  }).eq("id", B.id);
  const sweep2 = await api("/api/admin/vetting/comp-sweep", { method: "POST", body: JSON.stringify({}) });
  ok("not swept — the clock starts at the offer",
    !(sweep2.body?.leads ?? []).some((l) => l.id === B.id), JSON.stringify(sweep2.body?.leads));

} finally {
  console.log("\n12. Restore");
  for (const v of subs) await db.from("coldcall_leads").update(snap[v.id]).eq("id", v.id);
  let okAll = true;
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      if (JSON.stringify(snap[v.id][k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        okAll = false; console.log(`     MISMATCH ${v.name}.${k}`);
      }
    }
  }
  ok("both leads restored exactly", okAll);
  // 127 is applied, so these config rows are REAL. This suite must not delete
  // them — it only asserts it left them alone.
  const nowKeys = (await db.from("coldcall_config").select("key")).data.map((r) => r.key).sort();
  ok("config left exactly as found", JSON.stringify(nowKeys) === JSON.stringify(hadConfig.sort()),
    JSON.stringify(nowKeys));
  // Approvals are deletable (the 128 guard is BEFORE UPDATE only), so this run
  // cleans up after itself rather than leaving a queued email lying around.
  const left = await approvalsThisRun();
  if (left.length) await db.from("coldcall_email_approvals").delete().in("id", left.map((r) => r.id));
  ok("queued approvals cleaned up", (await approvalsThisRun()).length === 0);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

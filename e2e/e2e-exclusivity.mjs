// Step 9: the exclusivity manager.
//
// The assertion that matters most: two businesses cannot hold the same
// (trade, county, state), and the refusal is a SENTENCE naming the holder —
// never a raw 23505 constraint error. Tested by sending the request the UI
// would not send, and by making the collision happen on capitalisation alone.
//
// Distinct lead window (70-72). Does not touch Pat Bryant Electric, Kwik
// Service Electric Inc, Trinity Home Services or Vinyltech.
//
// NOTE: prod and dev share this database. Leads are driven through the
// workflow and restored. Audit rows CANNOT be removed (append-only by
// design) and are reported at the end.
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
const pub = async (path) => {
  const r = await fetch(`${AGENT}${path}`);
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
  "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
const TOUCHED = ["vetting_status","slug","is_published","verified_at","verified_year","expires_at","reverify_due",
  "plan","trading_name","trade","city","state","parish","rating","review_count","dti_score","blurb","chk_last_run",
  "exclusive_trade","exclusive_county","exclusive_state","exclusive_until",
  ...CHECKS, ...CHECKS.map((c) => `${c}_note`),
  // Verifying through the API probes the website and writes the enrichment
  // columns. This suite never asks for that, but it causes it, so it restores it.
  ...ENRICHMENT_COLUMNS,
];

const { data: subs } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(70, 72);   // window 70-72
if (subs.some((r) => PROTECTED.includes(r.name))) { console.error("hit a protected lead"); process.exit(1); }
const [A, B, C] = subs;
console.log(`holder : ${A.name}\nrival  : ${B.name}\nspare  : ${C.name}\n`);

const snap = {};
for (const v of subs) {
  const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
  snap[v.id] = data;
}
const RUN_START = new Date(Date.now() - 1000).toISOString();
const auditFor = async (id) => (await db.from("coldcall_vetting_audit")
  .select("field, old_value, new_value, reason, actor_email")
  .eq("lead_id", id).gte("created_at", RUN_START)).data ?? [];

const AREA = { trade: "e2e-roofing", county: "e2e_test_parish", state: "ZZ" };
const inAYear = new Date(Date.now() + 365 * 864e5).toISOString();
const yesterday = new Date(Date.now() - 864e5).toISOString();

async function makeVerified(lead, name) {
  await api(`/api/admin/vetting/${lead.id}/enter`, { method: "POST", body: JSON.stringify({}) });
  await api(`/api/admin/vetting/${lead.id}/profile`, {
    method: "PATCH", body: JSON.stringify({
      trading_name: name, trade: "Roofing", city: "Slidell", state: "LA",
      rating: 4.7, review_count: 40, dti_score: 80, blurb: "Exclusivity e2e subject.",
    }),
  });
  await api(`/api/admin/vetting/${lead.id}/checks`, {
    method: "PATCH", body: JSON.stringify(Object.fromEntries(CHECKS.map((k) => [k, "pass"]))),
  });
  const v = await api(`/api/admin/vetting/${lead.id}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "exclusivity e2e" }),
  });
  return v;
}

try {
  console.log("1. The board loads, and route ordering holds");
  const b0 = await api("/api/admin/vetting/exclusivity");
  ok("200 — not swallowed by /vetting/:id", b0.status === 200, `status=${b0.status}`);
  ok("says an expired claim still holds its slot", /still occupies its slot/.test(b0.body?.note ?? ""));
  ok("reports the area list honestly", b0.body?.areas_error === null || /129/.test(b0.body.areas_error),
    JSON.stringify(b0.body?.areas_error));

  console.log("\n2. Only a VERIFIED business can hold an area");
  const early = await api(`/api/admin/vetting/${A.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("unverified claim -> 409", early.status === 409, `status=${early.status}`);
  ok("says why", /only a verified business/.test(early.body?.message ?? ""), JSON.stringify(early.body?.message));
  const { data: untouched } = await db.from("coldcall_leads")
    .select("plan, exclusive_trade").eq("id", A.id).single();
  ok("refusal wrote NOTHING", untouched.exclusive_trade === null, JSON.stringify(untouched));

  console.log("\n3. Validation — an area with a missing part is not an area");
  await makeVerified(A, "Exclusive Holder Co.");
  for (const [label, body] of [
    ["no trade", { county: AREA.county, state: AREA.state, exclusive_until: inAYear }],
    ["no county", { trade: AREA.trade, state: AREA.state, exclusive_until: inAYear }],
    ["no state", { trade: AREA.trade, county: AREA.county, exclusive_until: inAYear }],
    ["no end date", { ...AREA }],
    ["bad state", { ...AREA, state: "LOUISIANA", exclusive_until: inAYear }],
    ["end date in the past", { ...AREA, exclusive_until: yesterday }],
  ]) {
    const r = await api(`/api/admin/vetting/${A.id}/exclusivity`, { method: "POST", body: JSON.stringify(body) });
    ok(`${label.padEnd(20)} -> 400`, r.status === 400, `status=${r.status} ${JSON.stringify(r.body?.message)}`);
  }

  console.log("\n4. The claim");
  const claim = await api(`/api/admin/vetting/${A.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("200", claim.status === 200, `status=${claim.status} ${JSON.stringify(claim.body?.message)}`);
  ok("claim_state active", claim.body?.claim_state === "active", claim.body?.claim_state);
  const { data: held } = await db.from("coldcall_leads")
    .select("plan, exclusive_trade, exclusive_county, exclusive_state, exclusive_until").eq("id", A.id).single();
  ok("plan set to exclusive", held.plan === "exclusive", held.plan);
  ok("area stored normalised", held.exclusive_trade === AREA.trade && held.exclusive_county === AREA.county
    && held.exclusive_state === "ZZ", JSON.stringify(held));
  const aud = await auditFor(A.id);
  ok("claim written to the audit log",
    aud.some((a) => a.field === "exclusive_area" && a.new_value?.includes(AREA.county) && /granted/.test(a.reason ?? "")),
    JSON.stringify(aud.filter((a) => a.field === "exclusive_area")));
  ok("the plan change is audited too", aud.some((a) => a.field === "plan" && a.new_value === "exclusive"));
  ok("audit names who did it", aud.every((a) => !!a.actor_email));

  console.log("\n5. A SECOND business cannot take the same area");
  await makeVerified(B, "Rival Roofing Co.");
  const clash = await api(`/api/admin/vetting/${B.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("409 refused", clash.status === 409, `status=${clash.status}`);
  ok("names the holder", /Exclusive Holder Co\./.test(clash.body?.message ?? ""), JSON.stringify(clash.body?.message));
  ok("gives the end date", /\d{4}-\d{2}-\d{2}/.test(clash.body?.message ?? ""));
  ok("suggests what to do", /Release that claim first|pick another area/.test(clash.body?.message ?? ""));
  // The whole point: never a raw constraint error in an operator's face.
  ok("NOT a raw constraint error",
    !/23505|duplicate key|coldcall_leads_one_exclusive_per_area/.test(clash.body?.message ?? ""),
    JSON.stringify(clash.body?.message));
  ok("structured detail for the UI", clash.body?.details?.held_by === A.id, JSON.stringify(clash.body?.details));
  const { data: rival } = await db.from("coldcall_leads").select("exclusive_trade").eq("id", B.id).single();
  ok("the rival got nothing", rival.exclusive_trade === null, JSON.stringify(rival));

  console.log("\n6. Capitalisation cannot smuggle a second claim past the index");
  // The unique index compares raw text, so "E2E-ROOFING" and "e2e-roofing"
  // would be two different rows unless the API normalises first.
  const shouty = await api(`/api/admin/vetting/${B.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({
      trade: AREA.trade.toUpperCase(), county: AREA.county.toUpperCase(),
      state: "zz", exclusive_until: inAYear,
    }),
  });
  ok("UPPERCASE of a held area is still refused", shouty.status === 409, `status=${shouty.status}`);
  ok("names the same holder", /Exclusive Holder Co\./.test(shouty.body?.message ?? ""));
  const { data: stillOne } = await db.from("coldcall_leads")
    .select("id").eq("plan", "exclusive").eq("vetting_status", "verified")
    .eq("exclusive_county", AREA.county);
  ok("exactly ONE row holds the area", (stillOne ?? []).length === 1, String((stillOne ?? []).length));

  console.log("\n7. A different area is still claimable");
  const other = await api(`/api/admin/vetting/${B.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, county: "e2e_other_parish", exclusive_until: inAYear }),
  });
  ok("200", other.status === 200, `status=${other.status} ${JSON.stringify(other.body?.message)}`);
  const board = await api("/api/admin/vetting/exclusivity");
  ok("board shows both claims", (board.body?.claimed ?? []).length >= 2, String(board.body?.claimed?.length));
  ok("both counted active", board.body?.active_count >= 2, String(board.body?.active_count));
  ok("none counted expired", board.body?.expired_count === 0, String(board.body?.expired_count));

  console.log("\n8. Open areas are per-trade, and only answerable with a trade");
  const noTrade = await api("/api/admin/vetting/exclusivity");
  ok("no trade -> open list is empty, not a guess", (noTrade.body?.open ?? []).length === 0);
  const withTrade = await api(`/api/admin/vetting/exclusivity?trade=${AREA.trade}`);
  ok("trade echoed back", withTrade.body?.trade === AREA.trade, withTrade.body?.trade);
  const claimedForTrade = (withTrade.body?.claimed ?? []).filter((r) => r.trade === AREA.trade);
  ok("the held areas are listed for that trade", claimedForTrade.length >= 2, String(claimedForTrade.length));

  console.log("\n9. Expiry — an ended claim still HOLDS until released");
  await db.from("coldcall_leads").update({ exclusive_until: yesterday }).eq("id", A.id);
  const expBoard = await api("/api/admin/vetting/exclusivity");
  const expRow = (expBoard.body?.claimed ?? []).find((r) => r.id === A.id);
  ok("reported as expired, not gone", expRow?.claim_state === "expired", JSON.stringify(expRow?.claim_state));
  ok("still listed as claimed", !!expRow);
  ok("counted as expired", expBoard.body?.expired_count === 1, String(expBoard.body?.expired_count));
  ok("days_left is negative", (expRow?.days_left ?? 0) < 0, String(expRow?.days_left));

  console.log("\n10. Claiming an area held by an EXPIRED claim releases it first");
  const takeover = await api(`/api/admin/vetting/${C.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("unverified takeover still refused", takeover.status === 409, `status=${takeover.status}`);
  await makeVerified(C, "Successor Roofing Co.");
  const takeover2 = await api(`/api/admin/vetting/${C.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("verified takeover of an EXPIRED area -> 200", takeover2.status === 200,
    `status=${takeover2.status} ${JSON.stringify(takeover2.body?.message)}`);
  const { data: oldHolder } = await db.from("coldcall_leads")
    .select("exclusive_trade, exclusive_county, exclusive_until").eq("id", A.id).single();
  ok("the expired holder was released", oldHolder.exclusive_trade === null, JSON.stringify(oldHolder));
  const relAudit = await auditFor(A.id);
  ok("the release is audited on the OLD holder",
    relAudit.some((a) => a.field === "exclusive_area" && a.new_value === null && /expired/.test(a.reason ?? "")),
    JSON.stringify(relAudit.filter((a) => a.field === "exclusive_area").map((a) => a.reason)));

  console.log("\n11. An ACTIVE claim is never taken away silently");
  const steal = await api(`/api/admin/vetting/${B.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("active area cannot be taken -> 409", steal.status === 409, `status=${steal.status}`);
  ok("names the active holder", /Successor Roofing Co\./.test(steal.body?.message ?? ""), JSON.stringify(steal.body?.message));
  const { data: successorIntact } = await db.from("coldcall_leads")
    .select("exclusive_county").eq("id", C.id).single();
  ok("the active holder kept its area", successorIntact.exclusive_county === AREA.county);

  console.log("\n12. Release");
  const rel = await api(`/api/admin/vetting/${C.id}/exclusivity/release`, { method: "POST", body: JSON.stringify({}) });
  ok("200", rel.status === 200, `status=${rel.status}`);
  const { data: freed } = await db.from("coldcall_leads")
    .select("plan, exclusive_trade, exclusive_county, exclusive_state, exclusive_until").eq("id", C.id).single();
  ok("all four area fields cleared",
    !freed.exclusive_trade && !freed.exclusive_county && !freed.exclusive_state && !freed.exclusive_until,
    JSON.stringify(freed));
  ok("plan deliberately LEFT ALONE", freed.plan === "exclusive", freed.plan);
  ok("the response says so", /plan was left as it was/i.test(rel.body?.note ?? ""), rel.body?.note);
  ok("release audited", (await auditFor(C.id)).some((a) => a.field === "exclusive_area" && a.new_value === null));
  const relAgain = await api(`/api/admin/vetting/${C.id}/exclusivity/release`, { method: "POST", body: JSON.stringify({}) });
  ok("releasing nothing -> 409", relAgain.status === 409, JSON.stringify(relAgain.body?.message));

  console.log("\n13. The area is free again immediately");
  const reclaim = await api(`/api/admin/vetting/${B.id}/exclusivity`, {
    method: "POST", body: JSON.stringify({ ...AREA, exclusive_until: inAYear }),
  });
  ok("a released area can be claimed -> 200", reclaim.status === 200,
    `status=${reclaim.status} ${JSON.stringify(reclaim.body?.message)}`);

  console.log("\n14. The sweep frees expired areas");
  await db.from("coldcall_leads").update({ exclusive_until: yesterday }).eq("id", B.id);
  const dry = await api("/api/admin/vetting/exclusivity-sweep", { method: "POST", body: JSON.stringify({}) });
  ok("dry run by default", dry.body?.dry_run === true);
  ok("names what would be freed", (dry.body?.areas ?? []).some((a) => a.id === B.id), JSON.stringify(dry.body?.areas));
  const { data: notYet } = await db.from("coldcall_leads").select("exclusive_county").eq("id", B.id).single();
  ok("dry run changed nothing", notYet.exclusive_county === AREA.county);

  const swept = await api("/api/admin/vetting/exclusivity-sweep", { method: "POST", body: JSON.stringify({ confirm: true }) });
  ok("sweep freed it", swept.body?.freed >= 1, JSON.stringify(swept.body));
  const { data: afterSweep } = await db.from("coldcall_leads")
    .select("exclusive_county, plan").eq("id", B.id).single();
  ok("area cleared", afterSweep.exclusive_county === null, JSON.stringify(afterSweep));
  ok("sweep audited with the expiry reason",
    (await auditFor(B.id)).some((a) => a.field === "exclusive_area" && /ended|expired/.test(a.reason ?? "")),
    JSON.stringify((await auditFor(B.id)).filter((a) => a.field === "exclusive_area").map((a) => a.reason)));
  const dry2 = await api("/api/admin/vetting/exclusivity-sweep", { method: "POST", body: JSON.stringify({}) });
  ok("nothing left to sweep", dry2.body?.would_free === 0, String(dry2.body?.would_free));

  console.log("\n15. Exclusivity NEVER reaches the public API");
  const { data: slugRow } = await db.from("coldcall_leads").select("slug, is_published").eq("id", C.id).single();
  if (slugRow?.slug) {
    await api(`/api/admin/vetting/${C.id}/publish`, { method: "POST", body: JSON.stringify({ is_published: true }) });
    const p = await pub(`/api/contractor/${slugRow.slug}`);
    const txt = JSON.stringify(p.body ?? {});
    ok("public profile carries no exclusive_* field", !/exclusive_/.test(txt), txt.slice(0, 200));
    ok("public profile carries no plan", !/"plan"/.test(txt));
    ok("public profile still carries no call_score", !/call_score/.test(txt));
  } else {
    ok("subject had a slug to publish", false, "no slug");
  }

  console.log("\n16. Auth");
  const noAuth = await fetch(`${AGENT}/api/admin/vetting/exclusivity`);
  ok("unauthenticated board -> 401", noAuth.status === 401, `status=${noAuth.status}`);
  const noAuthSweep = await fetch(`${AGENT}/api/admin/vetting/exclusivity-sweep`, { method: "POST" });
  ok("unauthenticated sweep -> 401", noAuthSweep.status === 401, `status=${noAuthSweep.status}`);

} finally {
  console.log("\n17. Restore");
  for (const v of subs) await db.from("coldcall_leads").update(snap[v.id]).eq("id", v.id);
  let okAll = true;
  for (const v of subs) {
    const { data } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", v.id).single();
    for (const k of TOUCHED) {
      if (JSON.stringify(snap[v.id][k] ?? null) !== JSON.stringify(data[k] ?? null)) {
        okAll = false; console.log(`     MISMATCH ${v.name}.${k}: ${JSON.stringify(snap[v.id][k])} -> ${JSON.stringify(data[k])}`);
      }
    }
  }
  ok("all three leads restored exactly", okAll);
  const { count: stillHeld } = await db.from("coldcall_leads")
    .select("id", { count: "exact", head: true }).eq("exclusive_county", AREA.county);
  ok("no test area left claimed", stillHeld === 0, String(stillHeld));
  const { count: auditRows } = await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true });
  console.log(`     audit rows in total (append-only, cannot be removed): ${auditRows}`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

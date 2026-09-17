// Step 5 backend: the vetting queue and the verification gate, against the
// DEPLOYED test worker with a real admin session.
//
// The assertion that matters most: vetting_status='verified' is REFUSED while
// any of the nine is not 'pass' — enforced server-side, not by a disabled
// button. It is tested by sending the request the UI would never send.
//
// NOTE: prod and dev share this database. One real lead is driven through the
// workflow and restored. The audit rows it writes CANNOT be removed (the table
// is append-only by design) and are reported at the end.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const AGENT = "https://textos-agent-test.rgaudet2023.workers.dev";
const env = {};
for (const l of fs.readFileSync("C:/code/textos-agent/.dev.vars", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
for (const l of fs.readFileSync("C:/code/textos-web/.env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*(PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.*)$/);
  if (m) env.SUPABASE_ANON_KEY = m[2].trim().replace(/^["']|["']$/g, "");
}
env.SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fails = 0;
const ok = (l, p, x = "") => { if (!p) fails++; console.log(`  ${l.padEnd(60)} ${p ? "PASS" : "*** FAIL ***"} ${x}`); };

const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
  "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
const TOUCHED = ["vetting_status","slug","is_published","verified_at","verified_year","expires_at",
  "reverify_due","chk_last_run","trade","city","state", ...CHECKS, ...CHECKS.map((c) => `${c}_note`)];
const SECRET = "GATE-TEST-NOTE-4471";

// admin session
const { data: admins } = await db.from("users").select("email").eq("is_admin", true).limit(1);
const { data: link, error: le } = await db.auth.admin.generateLink({ type: "magiclink", email: admins[0].email });
if (le) { console.error(le.message); process.exit(1); }
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: sess } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
const JWT = sess.session.access_token;

const api = async (path, init = {}) => {
  const r = await fetch(`${AGENT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const { data: subject } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(10, 10).single();   // window 10
const ID = subject.id;
console.log(`admin  : ${admins[0].email}`);
console.log(`subject: ${subject.name}\n`);

const { data: before } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();
const auditBefore = (await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true })).count;
// Rows written BEFORE this run (e.g. by e2e-trustlight-db-guards.mjs, which
// inserts via the service role with no actor) are not this route's output.
const RUN_START = new Date(Date.now() - 1000).toISOString();

try {
  console.log("1. Auth");
  const noAuth = await fetch(`${AGENT}/api/admin/vetting-queue`);
  ok("unauthenticated -> 401", noAuth.status === 401, `status=${noAuth.status}`);

  console.log("\n2. Queue");
  const qAll = await api("/api/admin/vetting-queue?page_size=5");
  ok("200", qAll.status === 200, `status=${qAll.status}`);
  ok("returns the 8 statuses for the filter UI", qAll.body?.statuses?.length === 8, String(qAll.body?.statuses?.length));
  const row = qAll.body?.leads?.[0];
  ok("row carries checks_passed/checks_total", row && row.checks_total === 9 && typeof row.checks_passed === "number",
    JSON.stringify(row && { p: row.checks_passed, t: row.checks_total }));
  ok("row carries days_in_status (null when never moved)", row && "days_in_status" in row, JSON.stringify(row?.days_in_status));
  ok("row carries name/trade/city/state/status",
    row && "name" in row && "trade" in row && "city" in row && "state" in row && "vetting_status" in row);
  ok("row leaks no phone", row && !("phone" in row));
  const qBad = await api("/api/admin/vetting-queue?status=bogus");
  ok("unknown status -> 400", qBad.status === 400, JSON.stringify(qBad.body));
  const qFiltered = await api("/api/admin/vetting-queue?status=in_verification&page_size=5");
  ok("status filter returns only that status", qFiltered.status === 200 &&
    (qFiltered.body.leads ?? []).every((l) => l.vetting_status === "in_verification"),
    `${qFiltered.body?.total} rows`);

  console.log("\n3. Detail");
  const d0 = await api(`/api/admin/vetting/${ID}`);
  ok("200", d0.status === 200, `status=${d0.status}`);
  ok("returns exactly nine checks", d0.body?.checks?.length === 9, String(d0.body?.checks?.length));
  ok("ninth is chk_court_records", d0.body?.checks?.some((k) => k.key === "chk_court_records"));
  ok("each check has key/label/result/note",
    d0.body.checks.every((k) => "key" in k && "label" in k && "result" in k && "note" in k));
  ok("can_verify false on a fresh lead", d0.body?.can_verify === false);
  ok("blocking lists all nine", d0.body?.blocking?.length === 9, String(d0.body?.blocking?.length));
  const d404 = await api("/api/admin/vetting/00000000-0000-0000-0000-000000000000");
  ok("unknown id -> 404", d404.status === 404, `status=${d404.status}`);

  console.log("\n4. THE GATE — verify is refused until all nine pass");
  const tryVerify = async (label, expectStatus) => {
    const r = await api(`/api/admin/vetting/${ID}/status`, {
      method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "gate test" }),
    });
    ok(label, r.status === expectStatus, `status=${r.status} ${JSON.stringify(r.body?.message ?? "")}`);
    return r;
  };
  const blocked0 = await tryVerify("0/9 passed -> 409 refused", 409);
  ok("409 names the blocking checks", Array.isArray(blocked0.body?.details?.blocking) && blocked0.body.details.blocking.length === 9,
    String(blocked0.body?.details?.blocking?.length));

  // Pass eight of nine, leave one 'fail'.
  const eight = Object.fromEntries(CHECKS.slice(0, 8).map((k) => [k, "pass"]));
  await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ ...eight, chk_reviews: "fail", chk_reviews_note: SECRET }) });
  const d8 = await api(`/api/admin/vetting/${ID}`);
  ok("8/9 reported", d8.body?.checks_passed === 8, String(d8.body?.checks_passed));
  await tryVerify("8/9 passed -> STILL 409 refused", 409);

  // 'na' must NOT satisfy the gate.
  await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ chk_reviews: "na" }) });
  const dNa = await api(`/api/admin/vetting/${ID}`);
  ok("'na' does not count as a pass", dNa.body?.checks_passed === 8, String(dNa.body?.checks_passed));
  await tryVerify("8 pass + 1 'na' -> STILL 409 refused", 409);

  // Confirm nothing was written while blocked.
  const { data: mid } = await db.from("coldcall_leads").select("vetting_status, slug, verified_at").eq("id", ID).single();
  ok("blocked attempts wrote NOTHING", mid.vetting_status !== "verified" && !mid.slug && !mid.verified_at,
    JSON.stringify(mid));

  // A published record must carry every REQUIRED_PUBLIC_FIELD or the public
  // API excludes it by design — set them before expecting visibility.
  const prof = await api(`/api/admin/vetting/${ID}/profile`, {
    method: "PATCH",
    body: JSON.stringify({ trade: "Roofing", city: "Slidell", state: "LA" }),
  });

  // ── The trade field is constrained to the public filter's vocabulary ──
  // An operator typing a word the public search cannot match is the same
  // class of bug as the parish case-collision, and it fails SILENTLY: the
  // business simply never appears for its own trade. So the editor
  // canonicalises what it accepts and refuses what it cannot.
  ok("a natural trade is canonicalised, not stored verbatim",
    prof.body?.lead?.trade === "roofing contractor", String(prof.body?.lead?.trade));

  for (const [typed, expected] of [["roofer", "roofing contractor"],
                                   ["Plumbing", "plumber"],
                                   ["AC", "hvac contractor"],
                                   ["Electrical", "electrician"],
                                   ["moving company", "moving company"]]) {
    const r = await api(`/api/admin/vetting/${ID}/profile`, {
      method: "PATCH", body: JSON.stringify({ trade: typed }),
    });
    ok(`trade "${typed}" -> "${expected}"`, r.body?.lead?.trade === expected,
      String(r.body?.lead?.trade));
  }

  const badTrade = await api(`/api/admin/vetting/${ID}/profile`, {
    method: "PATCH", body: JSON.stringify({ trade: "dentist" }),
  });
  ok("a trade outside the directory is refused", badTrade.status === 400, `status=${badTrade.status}`);
  ok("the refusal names the valid values",
    /roofing contractor/.test(JSON.stringify(badTrade.body ?? {})),
    JSON.stringify(badTrade.body?.message ?? "").slice(0, 90));
  const stillSet = await api(`/api/admin/vetting/${ID}`);
  ok("a refused trade wrote nothing", stillSet.body?.lead?.trade === "moving company",
    String(stillSet.body?.lead?.trade));

  const opts = await api(`/api/admin/vetting/${ID}/preview`);
  ok("the editor is handed the allowed values",
    Array.isArray(opts.body?.trade_options) && opts.body.trade_options.includes("roofing contractor"),
    String((opts.body?.trade_options ?? []).length));

  // Leave it on a real trade for the rest of the suite.
  await api(`/api/admin/vetting/${ID}/profile`, {
    method: "PATCH", body: JSON.stringify({ trade: "Roofing" }),
  });

  console.log("\n5. All nine pass -> verification stamps");
  await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ chk_reviews: "pass" }) });
  const d9 = await api(`/api/admin/vetting/${ID}`);
  ok("9/9 reported, can_verify true", d9.body?.checks_passed === 9 && d9.body?.can_verify === true);
  const verified = await tryVerify("9/9 passed -> 200 accepted", 200);
  const L = verified.body?.lead ?? {};
  ok("vetting_status is verified", L.vetting_status === "verified", String(L.vetting_status));
  ok("slug generated", typeof L.slug === "string" && /^[a-z0-9-]+$/.test(L.slug), String(L.slug));
  ok("verified_at stamped", !!L.verified_at);
  ok("verified_year stamped", L.verified_year === new Date().getFullYear(), String(L.verified_year));
  ok("expires_at is ~1 year out",
    Math.abs((new Date(L.expires_at) - Date.now()) / 86400000 - 365) < 2,
    `${Math.round((new Date(L.expires_at) - Date.now()) / 86400000)} days`);
  ok("reverify_due is 60 days before expiry",
    Math.abs((new Date(L.expires_at) - new Date(L.reverify_due)) / 86400000 - 60) < 2);
  ok("NOT auto-published", L.is_published === false, String(L.is_published));

  console.log("\n6. Publish is a separate, deliberate flip");
  const pub = await api(`/api/admin/vetting/${ID}/publish`, { method: "POST", body: JSON.stringify({ is_published: true, reason: "gate test" }) });
  ok("publish accepted once verified", pub.status === 200, `status=${pub.status}`);
  ok("returns the public url", typeof pub.body?.public_url === "string", String(pub.body?.public_url));
  const live = await fetch(`${AGENT}/api/contractor/${L.slug}`);
  ok("now visible on the PUBLIC api", live.status === 200, `status=${live.status}`);
  await api(`/api/admin/vetting/${ID}/publish`, { method: "POST", body: JSON.stringify({ is_published: false }) });
  ok("unpublish hides it from the public api again",
    (await fetch(`${AGENT}/api/contractor/${L.slug}`)).status === 404);

  console.log("\n7. Publish cannot outrun verification");
  await api(`/api/admin/vetting/${ID}/status`, { method: "POST", body: JSON.stringify({ vetting_status: "in_verification", reason: "gate test" }) });
  const badPub = await api(`/api/admin/vetting/${ID}/publish`, { method: "POST", body: JSON.stringify({ is_published: true }) });
  ok("publishing a non-verified business -> 409", badPub.status === 409, JSON.stringify(badPub.body?.message));
  const { data: afterDemote } = await db.from("coldcall_leads").select("is_published").eq("id", ID).single();
  ok("leaving 'verified' force-unpublished it", afterDemote.is_published === false, String(afterDemote.is_published));

  console.log("\n8. Input validation");
  const badKey = await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ chk_not_a_check: "pass" }) });
  ok("unknown check key -> 400", badKey.status === 400, JSON.stringify(badKey.body?.message));
  const badVal = await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ chk_license: "maybe" }) });
  ok("invalid check result -> 400", badVal.status === 400, JSON.stringify(badVal.body?.message));
  const badStatus = await api(`/api/admin/vetting/${ID}/status`, { method: "POST", body: JSON.stringify({ vetting_status: "bogus" }) });
  ok("invalid vetting_status -> 400", badStatus.status === 400, JSON.stringify(badStatus.body?.message));

  console.log("\n9. Audit trail");
  const det = await api(`/api/admin/vetting/${ID}`);
  const aud = det.body?.audit ?? [];
  ok("audit entries recorded", aud.length >= 3, `${aud.length} entries`);
  const mine = aud.filter((a) => a.created_at >= RUN_START);
  ok("every entry THIS RUN wrote records who", mine.length >= 3 && mine.every((a) => !!a.actor_email),
    `${mine.length} of ${aud.length} rows are this run's; actors: ${JSON.stringify([...new Set(mine.map((a) => a.actor_email))])}`);
  ok("records old -> new", aud.some((a) => a.field === "vetting_status" && a.new_value === "verified"));
  ok("records the publish flip", aud.some((a) => a.field === "is_published"));
  ok("records the reason", aud.some((a) => a.reason === "gate test"));
  ok("audit is newest-first", aud.length < 2 || new Date(aud[0].created_at) >= new Date(aud[1].created_at));
  ok("no refused attempt was logged as a change",
    !aud.some((a) => a.field === "vetting_status" && a.old_value === a.new_value));

  console.log("\n10. Internal notes never reach the public API");
  await api(`/api/admin/vetting/${ID}/checks`, { method: "PATCH", body: JSON.stringify({ chk_license_note: SECRET }) });
  const detNote = await api(`/api/admin/vetting/${ID}`);
  ok("note IS visible to the admin", JSON.stringify(detNote.body).includes(SECRET));
  const pubSearch = await (await fetch(`${AGENT}/api/directory/search?per_page=75`)).text();
  ok("note is NOT in the public search", !pubSearch.includes(SECRET));
  const pubFeat = await (await fetch(`${AGENT}/api/directory/featured`)).text();
  ok("note is NOT in the public featured", !pubFeat.includes(SECRET));

} finally {
  console.log("\n11. Restore");
  await db.from("coldcall_leads").update(before).eq("id", ID);
  const { data: after } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();
  let restored = true;
  for (const k of TOUCHED) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      restored = false; console.log(`     MISMATCH ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
    }
  }
  ok("subject lead restored exactly", restored);
  const auditAfter = (await db.from("coldcall_vetting_audit").select("id", { count: "exact", head: true })).count;
  console.log(`     audit rows written by this run: ${auditAfter - auditBefore} (append-only, cannot be removed)`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

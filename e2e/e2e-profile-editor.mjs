// Step 6: the profile editor and its public preview.
//
// The assertion that matters most: the preview is byte-identical to what the
// live public API actually returns. It is checked by verifying + publishing a
// record, fetching BOTH, and deep-comparing — not by eyeballing the shape.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ENRICHMENT_COLUMNS } from "./enrichment-columns.mjs";

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

const CHECKS = ["chk_licensing_board","chk_license","chk_insurance","chk_business_filing",
  "chk_court_records","chk_address","chk_years_in_business","chk_contact","chk_reviews"];
const PROFILE = ["legal_name","trading_name","trade","city","state","parish","license_number",
  "license_state","gl_carrier","years_in_business","blurb","services","rating","review_count",
  "dti_score","dti_findability","dti_answerability","dti_responsiveness","dti_completeness","dti_compliance"];
const TOUCHED = ["vetting_status","slug","is_published","verified_at","verified_year","expires_at",
  "reverify_due","chk_last_run", ...PROFILE, ...CHECKS, ...CHECKS.map((c) => `${c}_note`),
  // Verifying through the API probes the website and writes the enrichment
  // columns. This suite never asks for that, but it causes it, so it restores it.
  ...ENRICHMENT_COLUMNS,
];

const { data: subject } = await db.from("coldcall_leads")
  .select("id, name").eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(14, 14).single();   // window 14
const ID = subject.id;
console.log(`subject: ${subject.name}\n`);
const { data: before } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();

try {
  console.log("1. Editing the published profile");
  const patch = {
    legal_name: "  Preview Roofing LLC  ", trading_name: "Preview Roofing Co.",
    trade: "Roofing", city: "Slidell", state: "la", parish: "St Tammany",
    license_number: "LIC-PREVIEW-77", license_state: "la", gl_carrier: "Preview Mutual",
    years_in_business: 14, blurb: "Storm damage and full roof replacement.",
    services: "Roof replacement\nStorm damage\nEmergency tarping",
    rating: 4.77, review_count: 62,
    dti_score: 88, dti_findability: 90, dti_answerability: 85,
    dti_responsiveness: 88, dti_completeness: 92, dti_compliance: 84,
  };
  const up = await api(`/api/admin/vetting/${ID}/profile`, { method: "PATCH", body: JSON.stringify(patch) });
  ok("200", up.status === 200, `status=${up.status} ${JSON.stringify(up.body?.message ?? "")}`);
  const L = up.body?.lead ?? {};
  ok("text is trimmed", L.legal_name === "Preview Roofing LLC", JSON.stringify(L.legal_name));
  ok("state upper-cased", L.state === "LA" && L.license_state === "LA", `${L.state}/${L.license_state}`);
  ok("newline list became an array", Array.isArray(L.services) && L.services.length === 3, JSON.stringify(L.services));
  ok("rating rounded to 1dp", L.rating === 4.8, String(L.rating));

  console.log("\n2. Validation rejects malformed public claims");
  const bad = [
    ["rating out of range", { rating: 9 }],
    ["DTI over 100", { dti_score: 140 }],
    ["3-letter state", { state: "LAA" }],
    ["fractional years", { years_in_business: 3.5 }],
    ["unknown field", { phone: "555" }],
    ["internal field", { chk_license: "pass" }],
  ];
  for (const [label, body] of bad) {
    const r = await api(`/api/admin/vetting/${ID}/profile`, { method: "PATCH", body: JSON.stringify(body) });
    ok(`${label} -> 400`, r.status === 400, `status=${r.status} ${JSON.stringify(r.body?.message)}`);
  }
  const { data: intact } = await db.from("coldcall_leads").select("chk_license, phone").eq("id", ID).single();
  ok("a rejected edit wrote nothing", intact.chk_license === null);

  console.log("\n3. Preview says it is NOT public, and why");
  const p1 = await api(`/api/admin/vetting/${ID}/preview`);
  ok("200", p1.status === 200, `status=${p1.status}`);
  ok("visible=false", p1.body?.visibility?.visible === false);
  const bl = p1.body?.visibility?.blockers ?? [];
  ok("names every blocker, not just the first", bl.length === 4, JSON.stringify(bl));
  ok("blockers name status, publish, expiry and slug",
    bl.some((b) => /Not verified/.test(b)) && bl.some((b) => /Not published/.test(b)) &&
    bl.some((b) => /expiry/i.test(b)) && bl.some((b) => /slug/i.test(b)), JSON.stringify(bl));
  ok("profile route would 404", p1.body?.visibility?.appears_in?.profile === "404");
  ok("card still renders so it can be composed early", p1.body?.card?.name === "Preview Roofing Co.");
  ok("unvetted entry shows what the public sees TODAY",
    p1.body?.unvetted_entry && Object.keys(p1.body.unvetted_entry).sort().join() === "city,name,state,trade",
    JSON.stringify(p1.body?.unvetted_entry));

  console.log("\n4. Preview NEVER leaks the internal fields it can see");
  const raw1 = JSON.stringify(p1.body);
  // VALUES must be absent from the entire payload.
  for (const secret of ["LIC-PREVIEW-77", "Preview Mutual"]) {
    ok(`preview omits the value "${secret}"`, !raw1.includes(secret));
  }
  // Internal KEY NAMES must be absent from the three sections that mirror
  // public output. `editable_fields` legitimately lists some of them — it is
  // the editor's own field list, on an admin-only endpoint — so that is
  // asserted separately rather than quietly excluded from the scan.
  const mirrors = JSON.stringify({
    card: p1.body.card, profile: p1.body.profile, unvetted_entry: p1.body.unvetted_entry,
  });
  for (const key of ["license_number", "gl_carrier", "legal_name", "chk_", "_note",
                     "vetting_status", "is_published", "call_score"]) {
    ok(`public-shaped sections omit "${key}"`, !mirrors.includes(key));
  }
  ok("those names appear ONLY in editable_fields",
    ["license_number", "gl_carrier", "legal_name"].every((k) =>
      !mirrors.includes(k) && p1.body.editable_fields.includes(k)));

  // `phone` used to be on the list above, back when the profile published no
  // contact details at all. It does now — a directory that withholds the
  // contractor's phone number is no use to a homeowner — so the boundary moved
  // rather than disappearing, and the assertion moves with it. The phone
  // belongs to the PROFILE's contact block only: the card and the unvetted
  // entry are summaries and still carry none of it.
  const summaries = JSON.stringify({ card: p1.body.card, unvetted_entry: p1.body.unvetted_entry });
  ok("the card and unvetted entry still carry no phone", !summaries.includes("phone"));
  ok("the profile publishes the phone, deliberately, under contact",
    p1.body.profile?.contact?.phone !== undefined,
    JSON.stringify(p1.body.profile?.contact ?? null));

  console.log("\n5. Verify + publish, then compare preview against the LIVE response");
  await api(`/api/admin/vetting/${ID}/checks`, {
    method: "PATCH", body: JSON.stringify(Object.fromEntries(CHECKS.map((k) => [k, "pass"]))),
  });
  const st = await api(`/api/admin/vetting/${ID}/status`, {
    method: "POST", body: JSON.stringify({ vetting_status: "verified", reason: "profile editor e2e" }),
  });
  ok("verified", st.status === 200, `status=${st.status}`);
  const slug = st.body?.lead?.slug;
  await api(`/api/admin/vetting/${ID}/publish`, { method: "POST", body: JSON.stringify({ is_published: true }) });

  const p2 = await api(`/api/admin/vetting/${ID}/preview`);
  ok("preview now says LIVE", p2.body?.visibility?.visible === true, JSON.stringify(p2.body?.visibility?.blockers));
  ok("appears_in points at the real URL", p2.body?.visibility?.appears_in?.profile === `/contractor/${slug}`);

  const livePub = await (await fetch(`${AGENT}/api/contractor/${slug}`)).json();
  ok("PREVIEW PROFILE === LIVE PUBLIC PROFILE",
    JSON.stringify(p2.body.profile) === JSON.stringify(livePub.contractor),
    JSON.stringify(p2.body.profile) === JSON.stringify(livePub.contractor) ? "" :
      `\n     preview: ${JSON.stringify(p2.body.profile)}\n     live   : ${JSON.stringify(livePub.contractor)}`);

  const liveSearch = await (await fetch(`${AGENT}/api/directory/search?q=Preview%20Roofing&per_page=75`)).json();
  const liveCard = (liveSearch.verified ?? []).find((v) => v.slug === slug);
  ok("PREVIEW CARD === LIVE SEARCH CARD",
    liveCard && JSON.stringify(p2.body.card) === JSON.stringify(liveCard),
    liveCard ? "" : "card not found in live search");

  console.log("\n6. An edit after publishing flows straight through to the public API");
  await api(`/api/admin/vetting/${ID}/profile`, { method: "PATCH", body: JSON.stringify({ blurb: "Edited after publishing." }) });
  const p3 = await api(`/api/admin/vetting/${ID}/preview`);
  const live3 = await (await fetch(`${AGENT}/api/contractor/${slug}`)).json();
  ok("preview shows the edit", p3.body?.profile?.blurb === "Edited after publishing.", p3.body?.profile?.blurb);
  ok("live API shows the same edit", live3.contractor?.blurb === "Edited after publishing.", live3.contractor?.blurb);
  ok("still identical", JSON.stringify(p3.body.profile) === JSON.stringify(live3.contractor));

} finally {
  console.log("\n7. Restore");
  await db.from("coldcall_leads").update(before).eq("id", ID);
  const { data: after } = await db.from("coldcall_leads").select(TOUCHED.join(", ")).eq("id", ID).single();
  let restored = true;
  for (const k of TOUCHED) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      restored = false; console.log(`     MISMATCH ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
    }
  }
  ok("subject restored exactly", restored);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

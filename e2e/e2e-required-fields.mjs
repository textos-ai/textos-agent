// item 3: a verified record missing a required public field must not appear in
// featured, search or the profile — null must never reach a public response.
// item 4: sending is hard-stubbed.
//
// Uses its OWN scratch record and does not touch Pat Bryant Electric, Kwik
// Service Electric Inc, Trinity Home Services or Vinyltech — Rob is resetting
// those by hand.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Distinct lead window (40-40) so this suite cannot fight another
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
const pub = async (path) => { const r = await fetch(`${AGENT}${path}`); return { status: r.status, body: await r.json().catch(() => null), raw: "" }; };

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

const FIELDS = ["vetting_status","is_published","slug","trade","city","state","verified_at","verified_year",
  "expires_at","trading_name","rating","review_count","dti_score","blurb"];
const { data: subject } = await db.from("coldcall_leads")
  .select("id, name, " + FIELDS.join(", "))
  .eq("vetting_status", "lead").not("name", "is", null)
  .order("id", { ascending: true }).range(40, 40).single();
if (PROTECTED.includes(subject.name)) { console.error("picked a protected lead — aborting"); process.exit(1); }
const ID = subject.id;
const snap = Object.fromEntries(FIELDS.map((k) => [k, subject[k]]));
console.log(`subject: ${subject.name}\n`);

const SLUG = "e2e-required-fields-probe";
const plusYear = new Date(Date.now() + 365 * 864e5).toISOString();
const base = {
  vetting_status: "verified", is_published: true, slug: SLUG,
  verified_at: new Date().toISOString(), verified_year: new Date().getFullYear(), expires_at: plusYear,
  trading_name: "Required Fields Probe Co.", trade: "Roofing", city: "Slidell", state: "LA",
  rating: 4.5, review_count: 20, dti_score: 70, blurb: "Probe.",
};

const inFeatured = async () => ((await pub("/api/directory/featured")).body?.featured ?? []).some((v) => v.slug === SLUG);
const inSearch = async () => ((await pub("/api/directory/search?per_page=75")).body?.verified ?? []).some((v) => v.slug === SLUG);
const profileStatus = async () => (await pub(`/api/contractor/${SLUG}`)).status;

try {
  console.log("1. Fully-populated record IS public (control)");
  await db.from("coldcall_leads").update(base).eq("id", ID);
  ok("in featured", await inFeatured());
  ok("in search", await inSearch());
  ok("profile 200", (await profileStatus()) === 200);

  console.log("\n2. Each required field, when null, removes it from EVERY surface");
  for (const field of ["trade", "city", "state"]) {
    await db.from("coldcall_leads").update({ ...base, [field]: null }).eq("id", ID);
    const f = await inFeatured(), s = await inSearch(), p = await profileStatus();
    ok(`${field}=null -> gone from featured`, !f);
    ok(`${field}=null -> gone from search`, !s);
    ok(`${field}=null -> profile 404`, p === 404, `status=${p}`);
  }

  console.log("\n3. No null reaches ANY public response");
  await db.from("coldcall_leads").update({ ...base, trade: null }).eq("id", ID);
  const feat = await pub("/api/directory/featured");
  const srch = await pub("/api/directory/search?per_page=75");
  const nullTrade = [...(feat.body?.featured ?? []), ...(srch.body?.verified ?? [])].filter((c) => c.trade === null);
  ok("no card anywhere has trade:null", nullTrade.length === 0, JSON.stringify(nullTrade.map((c) => c.slug)));
  for (const f of ["slug", "trade", "city", "state"]) {
    const bad = [...(feat.body?.featured ?? []), ...(srch.body?.verified ?? [])].filter((c) => {
      const v = f === "city" || f === "state" ? c[f] : c[f];
      return v === null || v === undefined;
    });
    ok(`no card has ${f} null`, bad.length === 0, JSON.stringify(bad.map((c) => c.slug ?? c.name)));
  }

  console.log("\n4. Rating/DTI/blurb nulls are STILL allowed — new businesses are not punished");
  await db.from("coldcall_leads").update({ ...base, rating: null, review_count: null, dti_score: null, blurb: null }).eq("id", ID);
  ok("unrated business is still listed", await inSearch());
  const card = ((await pub("/api/directory/search?per_page=75")).body?.verified ?? []).find((v) => v.slug === SLUG);
  ok("rating comes through as null, never 0", card?.rating === null, JSON.stringify(card?.rating));

  console.log("\n5. The admin preview explains the exclusion");
  await db.from("coldcall_leads").update({ ...base, trade: null }).eq("id", ID);
  const prev = await api(`/api/admin/vetting/${ID}/preview`);
  ok("preview says not visible", prev.body?.visibility?.visible === false);
  ok("blocker names the missing field",
    (prev.body?.visibility?.blockers ?? []).some((b) => /Missing trade/.test(b)),
    JSON.stringify(prev.body?.visibility?.blockers));

  console.log("\n6. Sending: victora.ai is structurally refused");
  const hadCfg = (await db.from("coldcall_config").select("key")).data.map((r) => r.key);
  const seed = async (fromEmail) => {
    await db.from("coldcall_config").delete().in("key",
      ["trustlight_site_url", "trustlight_from_email", "trustlight_from_name"]);
    await db.from("coldcall_config").insert([
      { key: "trustlight_site_url", value: "https://trustlight.com", note: "e2e" },
      { key: "trustlight_from_email", value: fromEmail, note: "e2e" },
      { key: "trustlight_from_name", value: "TrustLight", note: "e2e" },
    ]);
  };

  await db.from("coldcall_leads").update(base).eq("id", ID);

  // Even misconfigured, a victora.ai sender can never produce a queued email.
  await seed("hello@victora.ai");
  const bad = await api(`/api/admin/vetting/${ID}/notify`, {
    method: "POST", body: JSON.stringify({ to: "nobody@example.com" }),
  });
  ok("victora.ai sender -> refused", bad.status === 500, `status=${bad.status}`);
  ok("refusal names the domain rule",
    /only trustlight\.com is permitted/.test(bad.body?.message ?? ""), JSON.stringify(bad.body?.message));
  const badPrev = await api(`/api/admin/vetting/${ID}/notify`, {
    method: "POST", body: JSON.stringify({ to: "nobody@example.com", preview: true }),
  });
  ok("even a PREVIEW is refused from victora.ai", badPrev.status === 500, `status=${badPrev.status}`);

  console.log("\n7. A trustlight.com sender renders, and still sends nothing");
  await seed("hello@trustlight.com");
  const prev2 = await api(`/api/admin/vetting/${ID}/notify`, {
    method: "POST", body: JSON.stringify({ to: "nobody@example.com", preview: true }),
  });
  ok("preview renders", prev2.status === 200 && !!prev2.body?.email?.subject, `status=${prev2.status}`);
  ok("preview is not queued", prev2.body?.queued === false);
  ok("from is trustlight.com", /@trustlight\.com/.test(prev2.body?.from ?? ""), prev2.body?.from);
  const { data: afterPrev } = await db.from("coldcall_leads")
    .select("notified_at, listing_consent").eq("id", ID).single();
  ok("a preview stamps NOTHING", !afterPrev.notified_at && !afterPrev.listing_consent, JSON.stringify(afterPrev));

  const addedKeys = ["trustlight_site_url", "trustlight_from_email", "trustlight_from_name"]
    .filter((k) => !hadCfg.includes(k));
  if (addedKeys.length) await db.from("coldcall_config").delete().in("key", addedKeys);

} finally {
  console.log("\n7. Restore");
  await db.from("coldcall_leads").update(snap).eq("id", ID);
  const { data: after } = await db.from("coldcall_leads").select(FIELDS.join(", ")).eq("id", ID).single();
  ok("subject restored exactly", JSON.stringify(after) === JSON.stringify(snap), JSON.stringify(after));
  const { data: prot } = await db.from("coldcall_leads")
    .select("name, vetting_status, is_published").in("name", PROTECTED);
  console.log("     protected leads (untouched by this script):");
  for (const r of prot ?? []) console.log(`       ${r.name.padEnd(28)} ${r.vetting_status}  published=${r.is_published}`);
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

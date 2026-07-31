// GET /facts → PUT it straight back → nothing changed.
//
// WHY THIS EXISTS
//
// Two data-loss faults shipped in one handler and neither was visible from any
// other angle:
//
//   * PUT nulled every business_profile column the payload omitted. The schema
//     normalises an absent field to null, so by the time the parsed object
//     reached the upsert, "the operator cleared this" and "the form did not send
//     this" were the same value. A payload missing street_address silently wiped
//     a real address — no error, no 400, no log.
//   * The read-back was not writable: Postgres `time` returns "07:00:00" and the
//     schema demanded "07:00", so posting the document back unchanged 400'd on
//     every open day.
//
// A document store whose own output is not accepted as input is broken, and a
// save that deletes what it was not asked about is worse. This test states the
// invariant that catches both and anything else of the same shape: read the
// document, write it back verbatim, and every stored field is byte-identical.
//
// AGAINST A THROWAWAY BUSINESS, NEVER A REAL ONE. Supabase is shared between
// test and prod, so a probe that writes must own its data: this creates a
// business, exercises the handler, and deletes it. Verifying against a live
// customer's row is how four columns on a real business got nulled.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const OWNER_ID = "3e2fe999-99c2-4583-82a6-6fc93f6632f8";
vi.mock("../lib/jwt", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("auth", { user_id: OWNER_ID, email: "owner@example.com" });
    await next();
  },
  verifyToken: async () => ({ user_id: OWNER_ID, email: "owner@example.com" }),
}));

function loadEnv(): Record<string, string> | null {
  let raw: string;
  try { raw = fs.readFileSync(".dev.vars", "utf8"); } catch { return null; }
  const g = (k: string) => (raw.match(new RegExp("^" + k + "=(.*)$", "m")) ?? [])[1]?.trim();
  const url = g("SUPABASE_URL"), key = g("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return { SUPABASE_URL: url.replace(/\/rest\/v1\/?$/, ""), SUPABASE_SERVICE_ROLE_KEY: key };
}
const env = loadEnv();

// Fixed slug, torn down at both ends of the run, so a crashed previous run
// cannot leave a row that collides with this one.
const SLUG = "zz-facts-round-trip-probe";
let sb: SupabaseClient;
let businessId: string;

async function destroy() {
  const { data } = await sb.from("businesses").select("id").eq("slug", SLUG).maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) return;
  for (const t of ["business_service_areas", "business_services", "business_hours",
    "business_faqs", "business_projects", "business_differentiators", "business_profile"]) {
    await sb.from(t).delete().eq("business_id", id);
  }
  await sb.from("businesses").delete().eq("id", id);
}

describe.skipIf(!env)("facts GET → PUT round trip", () => {
  beforeAll(async () => {
    sb = createClient(env!.SUPABASE_URL, env!.SUPABASE_SERVICE_ROLE_KEY);
    await destroy();
    const { data, error } = await sb.from("businesses")
      .insert({ user_id: OWNER_ID, slug: SLUG, name: "Round Trip Probe", kind: "existing" })
      .select("id").single();
    if (error) throw new Error(`probe business insert failed: ${error.message}`);
    businessId = (data as { id: string }).id;

    // A profile with every kind of field populated — text, a 2-letter code, a geo
    // PAIR, and the trade nouns whose loss started this.
    await sb.from("business_profile").insert({
      business_id: businessId,
      legal_name: "Round Trip Probe LLC",
      description: "Probe business for the facts round-trip test.",
      phone: "(504) 555-0100",
      email: "probe@example.com",
      street_address: "1 Probe Street",
      locality: "Probeville", region: "LA", postal_code: "70000", country: "US",
      geo_lat: 29.95, geo_lng: -90.07,
      license_number: "PROBE-1", license_authority: "Probe Board",
      trade_noun: "electrician", trade_noun_plural: "electricians",
      source: "operator",
    });
    await sb.from("business_hours").insert([
      { business_id: businessId, day_of_week: 0, is_closed: true, opens: null, closes: null },
      { business_id: businessId, day_of_week: 1, is_closed: false, opens: "07:00", closes: "19:00" },
    ]);
    await sb.from("business_services").insert([{
      business_id: businessId, service_key: "panel-upgrade", name: "Panel upgrade",
      blurb: "Blurb.", body: "Body.", bullets: ["One", "Two"], display_order: 0, source: "operator",
    }]);
    await sb.from("business_service_areas").insert([{
      business_id: businessId, area_slug: "probeville-la", city: "Probeville", region: "LA",
      postal_code: "70000", geo_lat: 29.95, geo_lng: -90.07,
      local_blurb: "Where the probe lives.", landmarks_blurb: "Past the probe bridge.",
      display_order: 0, source: "operator",
    }]);
    // The id-keyed three. Every nullable field is POPULATED, because the fault
    // being guarded against only shows on a field that had something to lose.
    await sb.from("business_faqs").insert([{
      business_id: businessId, question: "Are you licensed?", answer: "Yes, fully.",
      scope: "global", display_order: 0, source: "operator",
    }]);
    await sb.from("business_projects").insert([{
      business_id: businessId, caption: "Panel swap on Probe Street", city: "Probeville",
      service_key: "panel-upgrade", media_id: null, display_order: 0, source: "operator",
    }]);
    await sb.from("business_differentiators").insert([{
      business_id: businessId, headline: "Licensed and insured", body: "On every job.",
      icon: "shield", display_order: 0, source: "operator",
    }]);
  }, 60000);

  afterAll(async () => { await destroy(); }, 60000);

  it("accepts its own read-back and changes nothing", async () => {
    const routes = (await import("../routes/business-facts")).default;
    const get = async () => (await routes.fetch(
      new Request(`https://test.local/${SLUG}/facts`), env as never)).json() as Promise<any>;

    const before = await get();

    // VERBATIM. No reshaping, no field picking, no trimming of seconds — the
    // whole point is that the response is valid input exactly as it arrives.
    const res = await routes.fetch(new Request(`https://test.local/${SLUG}/facts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(before),
    }), env as never);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body).slice(0, 500)).toBe(200);

    const after = await get();

    // Every stored field identical. `updated_at`/`updated_by` are the save's own
    // provenance stamp and are expected to move; nothing else may.
    const stamp = new Set(["updated_at", "updated_by"]);
    const cmp = (a: any, b: any, where: string) => {
      for (const k of Object.keys(a ?? {})) {
        if (stamp.has(k)) continue;
        expect(JSON.stringify(b?.[k]), `${where}.${k}`).toBe(JSON.stringify(a[k]));
      }
    };
    cmp(before.profile, after.profile, "profile");
    // Every collection, including the three id-keyed ones. Those build their rows
    // from a field list rather than a spread, which is a different way to lose a
    // field but the same class of fault.
    for (const coll of ["hours", "services", "areas", "faqs", "projects", "differentiators"] as const) {
      expect(after[coll].length, coll).toBe(before[coll].length);
      before[coll].forEach((row: any, i: number) => cmp(row, after[coll][i], `${coll}[${i}]`));
    }
  }, 60000);

  /**
   * The OTHER failure mode, and the reason a verbatim round trip is not enough on
   * its own.
   *
   * The id-keyed collections assemble their rows from a hand-written field list.
   * A field added to the schema and forgotten there validates cleanly, saves
   * nothing, and reads back as whatever was already stored — so posting the
   * document back unchanged still passes. That is exactly the trade_noun shape:
   * accepted, silently discarded.
   *
   * The only thing that catches it is CHANGING every field and checking the
   * change survives. Round trip proves nothing is destroyed; this proves
   * everything is actually written.
   */
  it("persists a change to every editable field on the id-keyed collections", async () => {
    const routes = (await import("../routes/business-facts")).default;
    const get = async () => (await routes.fetch(
      new Request(`https://test.local/${SLUG}/facts`), env as never)).json() as Promise<any>;

    const before = await get();
    const edited = {
      ...before,
      faqs: before.faqs.map((f: any) => ({
        ...f, question: "EDITED question?", answer: "EDITED answer.", scope: "home_teaser",
      })),
      projects: before.projects.map((p: any) => ({ ...p, caption: "EDITED caption", city: "EDITED City" })),
      differentiators: before.differentiators.map((d: any) => ({
        ...d, headline: "EDITED headline", body: "EDITED body", icon: "EDITED-icon",
      })),
    };
    const res = await routes.fetch(new Request(`https://test.local/${SLUG}/facts`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edited),
    }), env as never);
    expect(res.status, JSON.stringify(await res.clone().json()).slice(0, 400)).toBe(200);

    const after = await get();
    // Same rows, not replacements — the id is what keeps display order and
    // identity stable across an edit.
    expect(after.faqs[0].id).toBe(before.faqs[0].id);
    expect(after.projects[0].id).toBe(before.projects[0].id);
    expect(after.differentiators[0].id).toBe(before.differentiators[0].id);

    expect(after.faqs[0].question).toBe("EDITED question?");
    expect(after.faqs[0].answer).toBe("EDITED answer.");
    expect(after.faqs[0].scope).toBe("home_teaser");
    expect(after.projects[0].caption).toBe("EDITED caption");
    expect(after.projects[0].city).toBe("EDITED City");
    expect(after.differentiators[0].headline).toBe("EDITED headline");
    expect(after.differentiators[0].body).toBe("EDITED body");
    expect(after.differentiators[0].icon).toBe("EDITED-icon");
  }, 60000);

  it("leaves an omitted nullable alone on an id-keyed row, and clears it on an explicit null", async () => {
    const routes = (await import("../routes/business-facts")).default;
    const get = async () => (await routes.fetch(
      new Request(`https://test.local/${SLUG}/facts`), env as never)).json() as Promise<any>;
    const put = async (payload: unknown) => routes.fetch(new Request(
      `https://test.local/${SLUG}/facts`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    ), env as never);

    const before = await get();
    const city = before.projects[0].city;
    const icon = before.differentiators[0].icon;
    expect(city).toBeTruthy();
    expect(icon).toBeTruthy();

    // OMITTED on an existing row — these are optionalText, so the schema turns
    // them into an explicit null exactly as it did for the profile.
    const omitted = {
      ...before,
      projects: before.projects.map((p: any) => { const c = { ...p }; delete c.city; return c; }),
      differentiators: before.differentiators.map((d: any) => { const c = { ...d }; delete c.icon; return c; }),
    };
    expect((await put(omitted)).status).toBe(200);
    let now = await get();
    expect(now.projects[0].city, "an omitted nullable must survive").toBe(city);
    expect(now.differentiators[0].icon, "an omitted nullable must survive").toBe(icon);

    // PRESENT AND NULL — still a deliberate clear.
    expect((await put({
      ...before,
      projects: before.projects.map((p: any) => ({ ...p, city: null })),
    })).status).toBe(200);
    now = await get();
    expect(now.projects[0].city, "an explicit null must clear").toBeNull();
    expect(now.differentiators[0].icon, "and must not touch its neighbours").toBe(icon);
  }, 60000);

  it("leaves a column alone when the payload omits it, and clears it when the payload says null", async () => {
    const routes = (await import("../routes/business-facts")).default;
    const get = async () => (await routes.fetch(
      new Request(`https://test.local/${SLUG}/facts`), env as never)).json() as Promise<any>;
    const put = async (payload: unknown) => routes.fetch(new Request(
      `https://test.local/${SLUG}/facts`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    ), env as never);

    const before = await get();
    expect(before.profile.street_address).toBe("1 Probe Street");
    expect(before.profile.trade_noun_plural).toBe("electricians");

    // OMITTED — the exact shape of the bug: a form that stopped posting these.
    const omitted = { ...before, profile: { ...before.profile } };
    delete omitted.profile.street_address;
    delete omitted.profile.trade_noun_plural;
    expect((await put(omitted)).status).toBe(200);

    const kept = await get();
    expect(kept.profile.street_address, "an omitted column must survive").toBe("1 Probe Street");
    expect(kept.profile.trade_noun_plural, "an omitted column must survive").toBe("electricians");

    // PRESENT AND NULL — a deliberate clear, which must still work.
    expect((await put({ ...before, profile: { ...before.profile, street_address: null } })).status).toBe(200);
    const cleared = await get();
    expect(cleared.profile.street_address, "an explicit null must clear").toBeNull();
    expect(cleared.profile.trade_noun_plural, "and must not touch its neighbours").toBe("electricians");
  }, 60000);

  it("accepts the HH:MM:SS the database returns", async () => {
    const routes = (await import("../routes/business-facts")).default;
    const get = async () => (await routes.fetch(
      new Request(`https://test.local/${SLUG}/facts`), env as never)).json() as Promise<any>;

    // The rest of the document rides along untouched. Posting empty collections
    // here would also delete a service a project still references, which is a
    // separate (pre-existing) fault and would make this test fail for a reason
    // that has nothing to do with time parsing.
    const before = await get();
    const res = await routes.fetch(new Request(`https://test.local/${SLUG}/facts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...before,
        hours: [
          { day_of_week: 0, is_closed: true, opens: null, closes: null },
          { day_of_week: 1, is_closed: false, opens: "07:00:00", closes: "19:00:00" },
        ],
      }),
    }), env as never);
    expect(res.status, JSON.stringify(await res.clone().json()).slice(0, 300)).toBe(200);
    const body = await res.json() as any;
    const mon = body.hours.find((h: any) => h.day_of_week === 1);
    expect(mon.opens.slice(0, 5)).toBe("07:00");
    expect(mon.closes.slice(0, 5)).toBe("19:00");
  }, 60000);
});

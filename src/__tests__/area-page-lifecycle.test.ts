// The life of an area page: created with its area, unpublished when the area
// goes, published again when it comes back, deleted only on purpose.
//
// WHY THIS EXISTS
//
// Removing a service area used to leave its page live, indexable and empty — the
// page existed, the fact row did not, and every area_* section rendered nothing.
// The fix is deliberately NOT a delete: a dropped form row and an intentional
// removal reach the save as the same signal, so the save unpublishes (reversible)
// and only a person deletes (not).
//
// That makes the interesting behaviour a STATE MACHINE across several saves, which
// no single-request test can see. This drives the real handlers through the whole
// cycle.
//
// AGAINST A THROWAWAY BUSINESS. Supabase is shared with prod, so a test that
// writes owns its own data and destroys it at both ends of the run.
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

const SLUG = "zz-area-lifecycle-probe";
let sb: SupabaseClient;
let businessId: string;

const AREA = (slug: string, city: string) => ({
  area_slug: slug, city, region: "LA", postal_code: null, geo_lat: null, geo_lng: null,
  local_blurb: `Why we know ${city} and the streets around it.`,
  landmarks_blurb: `Landmarks and corridors particular to ${city}.`,
});

const BASE_FACTS = {
  profile: {
    legal_name: "Area Lifecycle Probe LLC", locality: "Probeville", region: "LA",
    country: "US", trade_noun: "electrician", trade_noun_plural: "electricians",
  },
  hours: [], services: [], faqs: [], projects: [], differentiators: [],
};

async function destroy() {
  const { data } = await sb.from("businesses").select("id").eq("slug", SLUG).maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) return;
  const { data: sites } = await sb.from("sites").select("id").eq("business_id", id);
  const siteIds = ((sites ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (siteIds.length) {
    const { data: pages } = await sb.from("site_pages").select("id").in("site_id", siteIds);
    const pageIds = ((pages ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (pageIds.length) {
      const { data: secs } = await sb.from("site_sections").select("id").in("page_id", pageIds);
      const secIds = ((secs ?? []) as Array<{ id: string }>).map((s) => s.id);
      if (secIds.length) await sb.from("site_fields").delete().in("section_id", secIds);
      await sb.from("site_sections").delete().in("page_id", pageIds);
    }
    await sb.from("site_pages").delete().in("site_id", siteIds);
    await sb.from("sites").delete().in("id", siteIds);
  }
  for (const t of ["business_service_areas", "business_services", "business_hours",
    "business_faqs", "business_projects", "business_differentiators", "business_profile"]) {
    await sb.from(t).delete().eq("business_id", id);
  }
  await sb.from("businesses").delete().eq("id", id);
}

const factsRoutes = async () => (await import("../routes/business-facts")).default;
const siteRoutes = async () => (await import("../routes/business-site")).default;

async function saveFacts(areas: Array<ReturnType<typeof AREA>>) {
  const routes = await factsRoutes();
  const res = await routes.fetch(new Request(`https://test.local/${SLUG}/facts`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...BASE_FACTS, areas }),
  }), env as never);
  const body = await res.json() as any;
  expect(res.status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body;
}

async function areaPageRows() {
  const { data: sites } = await sb.from("sites").select("id").eq("business_id", businessId);
  const siteIds = ((sites ?? []) as Array<{ id: string }>).map((s) => s.id);
  const { data } = await sb.from("site_pages")
    .select("id, instance_key, route_path, noindex")
    .in("site_id", siteIds).eq("page_type", "area_detail");
  return ((data ?? []) as Array<{ id: string; instance_key: string; route_path: string; noindex: boolean }>)
    .sort((a, b) => a.instance_key.localeCompare(b.instance_key));
}

describe.skipIf(!env)("area page lifecycle", () => {
  beforeAll(async () => {
    sb = createClient(env!.SUPABASE_URL, env!.SUPABASE_SERVICE_ROLE_KEY);
    await destroy();
    const { data, error } = await sb.from("businesses")
      .insert({ user_id: OWNER_ID, slug: SLUG, name: "Area Lifecycle Probe", kind: "existing" })
      .select("id").single();
    if (error) throw new Error(`probe business insert failed: ${error.message}`);
    businessId = (data as { id: string }).id;

    // A site to hang pages off. Home only — the area pages are what the save is
    // supposed to create, so provisioning them here would defeat the test.
    const site = await siteRoutes();
    const res = await site.fetch(new Request(`https://test.local/${SLUG}/site/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: SLUG, template_key: "trades-v1" }),
    }), env as never);
    expect(res.status, await res.clone().text()).toBe(200);
  }, 120000);

  afterAll(async () => { await destroy(); }, 120000);

  it("creates a page for each area, unpublishes a removed one, republishes it on return", async () => {
    // 1. Two areas → two pages, both published.
    let body = await saveFacts([AREA("kenner-la", "Kenner"), AREA("gretna-la", "Gretna")]);
    expect(body.site_pages.ok, body.site_pages?.error).toBe(true);
    expect(body.site_pages.provisioned).toBe(2);
    let rows = await areaPageRows();
    expect(rows.map((r) => r.instance_key)).toEqual(["gretna-la", "kenner-la"]);
    expect(rows.every((r) => !r.noindex), "both start published").toBe(true);

    // 2. Drop one → its page is UNPUBLISHED, not deleted, and keeps its URL.
    const gretnaUrl = rows.find((r) => r.instance_key === "gretna-la")!.route_path;
    body = await saveFacts([AREA("kenner-la", "Kenner")]);
    expect(body.site_pages.unpublished).toEqual(["gretna-la"]);
    rows = await areaPageRows();
    expect(rows.length, "the row survives — unpublish never deletes").toBe(2);
    const gretna = rows.find((r) => r.instance_key === "gretna-la")!;
    expect(gretna.noindex, "removed area goes noindex").toBe(true);
    expect(gretna.route_path, "and keeps its address").toBe(gretnaUrl);
    expect(rows.find((r) => r.instance_key === "kenner-la")!.noindex).toBe(false);

    // 3. Saving again must not re-report it — the flag is already correct, and a
    //    handler that flips it every time would churn the row forever.
    body = await saveFacts([AREA("kenner-la", "Kenner")]);
    expect(body.site_pages.unpublished).toEqual([]);
    expect(body.site_pages.republished).toEqual([]);

    // 4. Put it back → REPUBLISHED, same row, same URL.
    body = await saveFacts([AREA("kenner-la", "Kenner"), AREA("gretna-la", "Gretna")]);
    expect(body.site_pages.republished).toEqual(["gretna-la"]);
    expect(body.site_pages.provisioned, "the page already existed").toBe(0);
    rows = await areaPageRows();
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.instance_key === "gretna-la")!.noindex).toBe(false);
    expect(rows.find((r) => r.instance_key === "gretna-la")!.route_path).toBe(gretnaUrl);
  }, 180000);

  it("serves an unpublished page with a real headline instead of a blank document", async () => {
    await saveFacts([AREA("kenner-la", "Kenner"), AREA("gretna-la", "Gretna")]);
    await saveFacts([AREA("kenner-la", "Kenner")]);
    const rows = await areaPageRows();
    const gretna = rows.find((r) => r.instance_key === "gretna-la")!;

    const sites = (await import("../routes/sites")).default;
    const res = await sites.fetch(new Request(
      `https://test.local/${SLUG}?path=${encodeURIComponent(gretna.route_path)}`), env as never);
    expect(res.status).toBe(200);
    const managed = (await res.json() as any).managed_site;
    expect(managed, "the URL must keep serving").not.toBeNull();
    expect(managed.noindex, "but must not be indexable").toBe(true);

    const html = managed.sections.map((s: any) => s.html).join("");
    expect(html, "an unpublished page still needs an h1").toContain("<h1");
    expect(html).toContain("no longer cover");
    // And a way out: the other area pages are still linked.
    expect(html).toContain("/areas/");

    // It is advertised nowhere.
    const advertised = managed.pages.filter((p: any) => !p.noindex).map((p: any) => p.route_path);
    expect(advertised, "drops out of nav, sitemap and llms.txt").not.toContain(gretna.route_path);
    const nav = managed.sections.find((s: any) => s.section_key === "site_nav")?.html ?? "";
    expect(nav).not.toContain(gretna.route_path);
  }, 180000);

  it("refuses to delete a page whose area still exists, and deletes one whose area is gone", async () => {
    await saveFacts([AREA("kenner-la", "Kenner"), AREA("gretna-la", "Gretna")]);
    const site = await siteRoutes();
    let rows = await areaPageRows();
    const gretna = rows.find((r) => r.instance_key === "gretna-la")!;

    // Still a service area — deleting would be undone by the next save.
    const refused = await site.fetch(new Request(
      `https://test.local/${SLUG}/site/pages/${gretna.id}`, { method: "DELETE" }), env as never);
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).message).toContain("still a service area");
    expect((await areaPageRows()).length, "nothing removed").toBe(2);

    // Remove the area (unpublishes), then delete deliberately.
    await saveFacts([AREA("kenner-la", "Kenner")]);
    const ok = await site.fetch(new Request(
      `https://test.local/${SLUG}/site/pages/${gretna.id}`, { method: "DELETE" }), env as never);
    expect(ok.status, await ok.clone().text()).toBe(200);

    rows = await areaPageRows();
    expect(rows.map((r) => r.instance_key), "only the deleted one is gone").toEqual(["kenner-la"]);

    // The URL now 404s at the compose layer, which is what the warning promised.
    const sites = (await import("../routes/sites")).default;
    const res = await sites.fetch(new Request(
      `https://test.local/${SLUG}?path=${encodeURIComponent(gretna.route_path)}`), env as never);
    const managed = (await res.json() as any).managed_site;
    expect(managed, "a deleted page is gone for good").toBeNull();
  }, 180000);

  /**
   * The map degrades to NOTHING, not to a broken frame.
   *
   * area_map is a template section now, so every area page carries a
   * site_sections row for it whether or not that area has a point to centre on.
   * An embed built from a null coordinate would either 404, or — worse — render
   * a map of 0,0 in the Gulf of Guinea presented as where a licensed electrician
   * works. The section must produce no output at all.
   *
   * End-to-end rather than a unit assertion: what is being tested is that a
   * PROVISIONED section with no data renders empty through compose, which the
   * renderer alone cannot show.
   */
  it("renders no map for an area with no coordinates, and a real one when they arrive", async () => {
    // The AREA helper deliberately carries geo_lat/geo_lng null.
    await saveFacts([AREA("kenner-la", "Kenner")]);
    const rows = await areaPageRows();
    const route = rows.find((r) => r.instance_key === "kenner-la")!.route_path;

    const sites = (await import("../routes/sites")).default;
    const render = async () => {
      const res = await sites.fetch(new Request(
        `https://test.local/${SLUG}?path=${encodeURIComponent(route)}`), env as never);
      const managed = (await res.json() as any).managed_site;
      return {
        keys: managed.sections.map((s: any) => s.section_key),
        html: managed.sections.map((s: any) => s.html).join(""),
        report: managed.field_report,
      };
    };

    let page = await render();
    // The section IS provisioned — this is not passing by being absent.
    expect(page.report.some((r: any) => r.section_key === "area_map"),
      "area_map must be provisioned for this to prove anything").toBe(true);
    // ...and it rendered nothing.
    expect(page.report.find((r: any) => r.section_key === "area_map").rendered).toBe(false);
    expect(page.keys, "no empty map section in the output").not.toContain("area_map");
    expect(page.html).not.toContain("openstreetmap");
    expect(page.html).not.toContain("<iframe");
    // The rest of the page is unharmed.
    expect(page.html).toContain("<h1");

    // Give the area a point; the map appears, centred on it.
    await sb.from("business_service_areas")
      .update({ geo_lat: 29.9941, geo_lng: -90.2417 })
      .eq("business_id", businessId).eq("area_slug", "kenner-la");

    page = await render();
    expect(page.keys).toContain("area_map");
    expect(page.html).toContain("openstreetmap.org/export/embed.html");
    expect(page.html).toContain("marker=29.99410,-90.24170");
    expect(page.html).toContain('loading="lazy"');
    expect(page.html, "never an API key in public markup").not.toMatch(/[?&]key=/);

    // And it sits directly after the hero, not wherever the array happened to put it.
    expect(page.keys.indexOf("area_map")).toBe(page.keys.indexOf("area_hero") + 1);
  }, 180000);

  it("reports URL changes before making them, and only rewrites when asked", async () => {
    await saveFacts([AREA("kenner-la", "Kenner")]);
    const site = await siteRoutes();
    const regen = async (apply: boolean) => {
      const res = await site.fetch(new Request(`https://test.local/${SLUG}/site/areas/regenerate-urls`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      }), env as never);
      return { status: res.status, body: await res.json() as any };
    };

    // In step with the facts → nothing to do.
    let r = await regen(false);
    expect(r.status).toBe(200);
    expect(r.body.would_change).toBe(0);

    // Drop the region, exactly the Gretna case. The stored URL must NOT move on
    // its own — that rule is what keeps inbound links alive.
    const before = (await areaPageRows())[0].route_path;
    await sb.from("business_service_areas").update({ region: null })
      .eq("business_id", businessId).eq("area_slug", "kenner-la");
    expect((await areaPageRows())[0].route_path, "stored URLs never move by themselves").toBe(before);

    // The dry run says what would change and writes nothing.
    r = await regen(false);
    expect(r.body.applied).toBe(false);
    expect(r.body.would_change).toBe(1);
    expect(r.body.changes[0].from).toBe(before);
    expect(r.body.changes[0].to).toBe("/areas/kenner-electrician");
    expect(r.body.warning).toContain("404");
    expect((await areaPageRows())[0].route_path, "a dry run writes nothing").toBe(before);

    // Applying rewrites it.
    r = await regen(true);
    expect(r.body.applied).toBe(true);
    expect((await areaPageRows())[0].route_path).toBe("/areas/kenner-electrician");
  }, 180000);
});

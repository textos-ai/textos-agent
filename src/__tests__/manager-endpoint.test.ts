// Executes the site-manager handler end to end.
//
// WHY THIS EXISTS
//
// Two ReferenceErrors have now shipped from this one handler — catalogByKey, then
// FACT_COLLECTIONS — both the same shape: a `const` declared below an
// immediately-executing .map() that reads it. tsc cannot see either, because the
// access happens inside a callback, and every other check missed them:
//
//   * a GET of /business/{slug}/marketing/custom-website returns 200 because that
//     page is a STATIC shell which calls this API from the browser
//   * the API returns 401 without a bearer token, so an unauthenticated probe never
//     reaches the code
//   * unit tests covered the registry, not the request
//
// Only running the handler catches it. Auth is stubbed — the point is the handler
// body, not the JWT path, which has its own coverage.
//
// Needs .dev.vars and network: SKIPPED when they are absent rather than failing, so
// the file is safe in an environment without credentials.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";

vi.mock("../lib/jwt", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("auth", { user_id: OWNER_ID, email: "owner@example.com" });
    await next();
  },
  verifyToken: async () => ({ user_id: OWNER_ID, email: "owner@example.com" }),
}));

const SLUG = "jkqualityelectric";
const OWNER_ID = "3e2fe999-99c2-4583-82a6-6fc93f6632f8";

function loadEnv(): Record<string, string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(".dev.vars", "utf8");
  } catch {
    return null;
  }
  const g = (k: string) => (raw.match(new RegExp("^" + k + "=(.*)$", "m")) ?? [])[1]?.trim();
  const url = g("SUPABASE_URL");
  const key = g("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  // createSupabaseClient appends /rest/v1; .dev.vars stores it already appended.
  // Getting this wrong surfaces as PGRST125 "Invalid path specified in request URL".
  return { SUPABASE_URL: url.replace(/\/rest\/v1\/?$/, ""), SUPABASE_SERVICE_ROLE_KEY: key };
}

const env = loadEnv();

describe.skipIf(!env)("GET /:slug/site/manage", () => {
  it("returns 200 and does not throw inside the handler", async () => {
    const routes = (await import("../routes/business-site")).default;
    const res = await routes.fetch(
      new Request(`https://test.local/${SLUG}/site/manage`),
      env as never,
    );
    // A ReferenceError in the handler surfaces as a bare 500 from Hono's onError.
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("returns every part the manager UI reads, with the fact-source join populated", async () => {
    const routes = (await import("../routes/business-site")).default;
    const res = await routes.fetch(
      new Request(`https://test.local/${SLUG}/site/manage`),
      env as never,
    );
    const body = await res.json() as {
      pages: unknown[];
      sections: Array<{ section_key: string; label?: string; contents: unknown }>;
      slots: unknown[];
      derived: unknown[];
    };

    for (const part of ["pages", "sections", "slots", "derived"] as const) {
      expect(Array.isArray(body[part]), part).toBe(true);
      expect((body[part] as unknown[]).length, part).toBeGreaterThan(0);
    }

    // Every group carries a label — the fallback exists, but a blank one means the
    // template lost its labels (migration 101's post-condition, checked from the
    // reader's side rather than only in SQL).
    for (const s of body.sections) {
      if (s.section_key === "__site__") continue;
      expect(s.label, s.section_key).toBeTruthy();
    }

    // At least one section resolves a Business Facts source, or the whole
    // contents block silently rendered nothing.
    expect(body.sections.some((s) => s.contents)).toBe(true);
  });

  // Part D. The scorer had 11 unit tests and no caller: it was computed nowhere
  // and returned nowhere, so the manager could not show it. Asserted from the
  // RESPONSE, which is the only place the UI reads it from.
  it("returns the area-page duplicate-content score alongside the areas", async () => {
    const routes = (await import("../routes/business-site")).default;
    const res = await routes.fetch(
      new Request(`https://test.local/${SLUG}/site/manage`),
      env as never,
    );
    const body = await res.json() as {
      area_quality: {
        threshold: number; below_count: number; edit_href: string;
        areas: Array<{ area_slug: string; city: string; unique_ratio: number; message: string }>;
      } | null;
      sections: Array<{ contents: { collection?: string } | null }>;
    };

    // The UI hangs this off the AREAS contents block, so a payload with areas and
    // no score would render nothing and look like the feature was never built.
    const hasAreasBlock = body.sections.some((s) => s.contents?.collection === "areas");
    if (!hasAreasBlock) return;

    expect(body.area_quality).not.toBeNull();
    const q = body.area_quality!;
    expect(q.areas.length).toBeGreaterThan(0);
    expect(q.threshold).toBeGreaterThan(0);
    expect(q.edit_href).toContain("facts");
    for (const a of q.areas) {
      expect(a.city, a.area_slug).toBeTruthy();
      // A ratio outside 0..1 means the masking or the token maths broke.
      expect(a.unique_ratio).toBeGreaterThanOrEqual(0);
      expect(a.unique_ratio).toBeLessThanOrEqual(1);
      // The server owns the sentence the manager prints; a blank one renders an
      // empty row rather than an obvious failure.
      expect(a.message, a.area_slug).toBeTruthy();
    }
  });
});

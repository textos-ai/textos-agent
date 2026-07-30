// A failed lookup must not be reported as a missing business.
//
// getBusinessBySlug was wrapped in `.catch(() => null)` at 13 call sites, so every
// database failure surfaced as 404 "business 'x' not found". On the
// FACT_COLLECTIONS crash that turned a malformed SUPABASE_URL into a missing
// business and sent debugging in the wrong direction. Same silent lie 1C removed
// from the render path, in a different costume.
//
// Both halves are asserted, because fixing one by breaking the other would be no
// better: a genuinely absent row must still be a clean null.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { SchemaError } from "../lib/db-errors";

vi.mock("../lib/jwt", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("auth", { user_id: OWNER_ID, email: "owner@example.com" });
    await next();
  },
  verifyToken: async () => ({ user_id: OWNER_ID, email: "owner@example.com" }),
}));

const OWNER_ID = "3e2fe999-99c2-4583-82a6-6fc93f6632f8";
const SLUG = "jkqualityelectric";

function creds(): { url: string; key: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(".dev.vars", "utf8"); } catch { return null; }
  const g = (k: string) => (raw.match(new RegExp("^" + k + "=(.*)$", "m")) ?? [])[1]?.trim();
  const url = g("SUPABASE_URL"), key = g("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? { url: url.replace(/\/rest\/v1\/?$/, ""), key } : null;
}
const c = creds();

describe.skipIf(!c)("a broken query is never 'not found'", () => {
  it("throws, rather than returning null, when the query cannot run", async () => {
    // A wrong base URL is exactly the fault that was misreported: PGRST125.
    const broken = createSupabaseClient({
      SUPABASE_URL: `${c!.url}/rest/v1`,   // the double-/rest/v1 trap
      SUPABASE_SERVICE_ROLE_KEY: c!.key,
    } as never);
    await expect(getBusinessBySlug(broken, OWNER_ID, SLUG)).rejects.toThrow(/query_failed\(businesses\)|Schema fault/);
  });

  it("still returns null for a business that genuinely does not exist", async () => {
    const ok = createSupabaseClient({ SUPABASE_URL: c!.url, SUPABASE_SERVICE_ROLE_KEY: c!.key } as never);
    await expect(getBusinessBySlug(ok, OWNER_ID, "definitely-not-a-real-slug")).resolves.toBeNull();
  });

  // 15s: this one goes through the real worker entry and makes live requests,
  // and a slow round trip is not a failure worth reporting as one.
  it("surfaces a failed lookup as a 500 with a message, not a 404", { timeout: 15000 }, async () => {
    // Through the REAL entry point: app.onError lives on the root app, so fetching
    // the sub-router directly would test Hono's bare default instead of what a
    // client actually receives.
    const worker = (await import("../index")).default;
    const res = await worker.fetch(
      new Request(`https://test.local/api/businesses/${SLUG}/site/manage`),
      { SUPABASE_URL: `${c!.url}/rest/v1`, SUPABASE_SERVICE_ROLE_KEY: c!.key } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("not found");
    expect(body).toMatch(/query_failed|Schema fault/);
  });

  it("classifies a missing table as an actionable SchemaError", () => {
    const e = new SchemaError("site_pages", "42P01", "relation does not exist");
    expect(e.message).toContain("missing migration");
    expect(e.message).toContain("site_pages");
  });
});

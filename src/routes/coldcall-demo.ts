// =============================================================
// Cold-call demo landing page — PUBLIC render endpoint.
// Mounted at /api/coldcall-demo.
//
// PUBLIC AND UNAUTHENTICATED BY NECESSITY, exactly like routes/sites.ts: the
// prospect opens the demo link on their own phone during the call. There is no
// login, and there must not be one.
//
// This file deliberately has NO `app.use("*", requireAuth)`. That is why it is
// a separate router from coldcall.ts, whose blanket guard would otherwise
// authenticate everything added to it. Do not merge these two files.
//
// It serves ONLY status='ready' rows, so a half-generated or failed demo is
// never publicly visible. It exposes the stored content model and nothing
// else — no lead id, no caller, no score, no enrichment.
// =============================================================

import { Hono } from "hono";
import type { Env } from "../env";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { createSupabaseClient } from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();

// ── GET /api/coldcall-demo/:slug ───────────────────────────────────────────
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  // Same shape guard sites.ts uses — reject anything that is not a slug before
  // it reaches the database.
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json(errBody("not_found", "not found"), 404);
  }

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("coldcall_demo_sites")
    .select("slug, content, status, hero_folder")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    log.error("[coldcall-demo] public_lookup_failed", { slug, err: error.message });
    return c.json(errBody("internal", "lookup_failed"), 500);
  }

  // generating / failed / missing all read as 404 to the public. A prospect
  // must never see "failed" — the caller sees that in the modal instead.
  if (!data || data.status !== "ready" || !data.content) {
    return c.json(errBody("not_found", "not found"), 404);
  }

  const row = data as { slug: string; content: unknown; hero_folder: string | null };

  // Theme resolves HERE, at request time, from the stored hero_folder — so
  // retinting a trade is a reload, not a regeneration. Served alongside the
  // content so the page makes one fetch, not two.
  //
  // NO SILENT DEFAULT: a folder with no theme row falls back to the 'generic'
  // ROW explicitly. If even that is missing the response says so, rather than
  // the page quietly painting itself some hardcoded blue.
  let theme: { primary_hex: string; accent_hex: string; source: string } | null = null;
  const wanted = row.hero_folder || "generic";
  const { data: themes, error: themeErr } = await supabase
    .from("coldcall_demo_theme")
    .select("folder, primary_hex, accent_hex")
    .in("folder", [wanted, "generic"]);
  if (themeErr) {
    log.warn("[coldcall-demo] theme_lookup_failed", { slug, err: themeErr.message });
  } else {
    const rows = (themes ?? []) as Array<{ folder: string; primary_hex: string; accent_hex: string }>;
    const exact = rows.find((t) => t.folder === wanted);
    const generic = rows.find((t) => t.folder === "generic");
    const pick = exact ?? generic ?? null;
    if (pick) {
      theme = { primary_hex: pick.primary_hex, accent_hex: pick.accent_hex, source: pick.folder };
      if (!exact) log.warn("[coldcall-demo] theme_missing_using_generic", { slug, folder: wanted });
    } else {
      log.error("[coldcall-demo] theme_missing_entirely", { slug, folder: wanted });
    }
  }

  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    slug: row.slug,
    content: row.content,
    hero_folder: row.hero_folder,
    theme,
  });
});

export default app;

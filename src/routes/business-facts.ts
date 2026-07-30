// Business facts — the local-business truth a site derives from.
//
// Phase 1A of the Website Manager. These are BUSINESS data, not site content:
// NAP, hours, license, services, service areas. A site derives from them via
// source_path (see migration 091 + docs/website-manager-concept.md).
//
// Four tables, one document: business_profile (1:1), business_hours (per-day),
// business_services, business_service_areas. The intake form reads and writes
// the whole set in one call, so this route exposes exactly two endpoints.
//
// NO LLM CALLS in this file, by design — it is a form-backed store. Nothing
// here needs a model, so nothing here touches model-config or the feature
// registry.
//
// NO SILENT DEFAULTS. Every validation failure returns a 400 naming the exact
// field and what was wrong. The DB carries the same constraints (CHECKs in 091)
// so a bug here fails loudly at the database rather than writing junk.
//
// REVIEWS: there is deliberately no endpoint, column, or payload field for
// review text. textos-agent/CLAUDE.md prohibits AI-generated testimonials on
// FTC grounds. `google_place_id` on the profile is the only sanctioned review
// source; the reviews section renders empty until it is set.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { requireAuth } from "../lib/jwt";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { provisionSite } from "../lib/site-render/provision";
import { FACTS_SECTIONS, factsAnchor } from "../lib/site-render/facts-sections";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── Validation ────────────────────────────────────────────────────────────
// Mirrors the CHECK constraints in migration 091 so the operator gets a field-
// level message instead of a raw Postgres constraint violation.

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;      // HH:MM, 24h

/** Trim, then treat "" as absent. Never substitutes a value. */
const optionalText = z
  .string()
  .trim()
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const requiredText = (field: string) =>
  z.string({ required_error: `${field} is required` })
    .trim()
    .min(1, `${field} must not be blank`);

const latitude  = z.number().min(-90).max(90).nullable().optional().transform((v) => v ?? null);
const longitude = z.number().min(-180).max(180).nullable().optional().transform((v) => v ?? null);

const ProfileSchema = z.object({
  legal_name:          optionalText,
  alternate_name:      optionalText,
  description:         optionalText,
  phone:               optionalText,
  email:               optionalText,
  street_address:      optionalText,
  locality:            optionalText,
  region:              optionalText,
  postal_code:         optionalText,
  country:             z.string().trim().length(2, "country must be a 2-letter ISO code, e.g. US")
                          .nullable().optional().transform((v) => v ?? null),
  geo_lat:             latitude,
  geo_lng:             longitude,
  license_number:      optionalText,
  license_authority:   optionalText,
  // The noun people search for. A business fact — true whether or not there
  // is a website — so it lives here beside services, not in the site manager.
  trade_noun:          optionalText,
  trade_noun_plural:   optionalText,
  google_place_id:     optionalText,
  google_business_url: optionalText,
  facebook_url:        optionalText,
  instagram_url:       optionalText,
  analytics_id:        optionalText,
  logo_media_id:       z.string().uuid().nullable().optional().transform((v) => v ?? null),
  hero_media_id:       z.string().uuid().nullable().optional().transform((v) => v ?? null),
}).superRefine((p, ctx) => {
  // Geo is a pair or nothing — a lone coordinate is meaningless and the DB
  // rejects it, so catch it here with a readable message.
  if ((p.geo_lat === null) !== (p.geo_lng === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["geo_lat"],
      message: "geo_lat and geo_lng must both be set or both be empty",
    });
  }
});

const HourSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),   // 0=Sunday .. 6=Saturday
  is_closed:   z.boolean(),
  opens:       z.string().regex(TIME_RE, "opens must be HH:MM (24h)").nullable().optional().transform((v) => v ?? null),
  closes:      z.string().regex(TIME_RE, "closes must be HH:MM (24h)").nullable().optional().transform((v) => v ?? null),
}).superRefine((h, ctx) => {
  const day = `day ${h.day_of_week}`;
  if (h.is_closed) {
    if (h.opens !== null || h.closes !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["opens"],
        message: `${day}: a closed day must not carry opens/closes` });
    }
    return;
  }
  if (h.opens === null || h.closes === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["opens"],
      message: `${day}: an open day needs both opens and closes` });
    return;
  }
  if (h.closes <= h.opens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["closes"],
      message: `${day}: closes (${h.closes}) must be later than opens (${h.opens})` });
  }
});

const ServiceSchema = z.object({
  service_key: requiredText("service_key")
    .regex(SLUG_RE, "service_key must be lowercase kebab-case, e.g. panel-upgrade"),
  name:        requiredText("name"),
  blurb:       optionalText,
  body:        optionalText,
  bullets:     z.array(z.string().trim().min(1)).default([]),
});

const AreaSchema = z.object({
  area_slug: requiredText("area_slug")
    .regex(SLUG_RE, "area_slug must be lowercase kebab-case, e.g. kenner-la"),
  city:        requiredText("city"),
  region:      optionalText,
  postal_code: optionalText,
  geo_lat:     latitude,
  geo_lng:     longitude,
  // REQUIRED and NON-DERIVABLE. These two strings are the only thing that
  // differentiates one area page from another — the source template's 10 area
  // pages are 92.5% word-identical after masking city names. Blank here means a
  // doorway page, so this is a hard error, not a warning.
  local_blurb: requiredText("local_blurb"),
  landmarks_blurb: requiredText("landmarks_blurb"),
}).superRefine((a, ctx) => {
  if ((a.geo_lat === null) !== (a.geo_lng === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["geo_lat"],
      message: `${a.area_slug}: geo_lat and geo_lng must both be set or both be empty` });
  }
});

// ── Phase 1C collections ──────────────────────────────────────────────────
// These three have no natural business-unique key (unlike service_key /
// area_slug), so rows carry an optional `id`. Rows with an id are updated in
// place; rows without one are inserted; ids absent from the payload are pruned.
// That keeps display_order stable and lets an operator reorder without the row
// identity churning.

const FaqSchema = z.object({
  id:       z.string().uuid().optional(),
  question: requiredText("question"),
  answer:   requiredText("answer"),
  scope:    z.enum(["global", "home_teaser", "area"]).default("global"),
});

const ProjectSchema = z.object({
  id:          z.string().uuid().optional(),
  caption:     requiredText("caption"),
  city:        optionalText,
  service_key: z.string().trim().regex(SLUG_RE, "service_key must be lowercase kebab-case")
                  .nullable().optional().transform((v) => v ?? null),
  media_id:    z.string().uuid().nullable().optional().transform((v) => v ?? null),
});

const DifferentiatorSchema = z.object({
  id:       z.string().uuid().optional(),
  headline: requiredText("headline"),
  body:     requiredText("body"),
  icon:     optionalText,
});

// Exported so a test can assert it accepts every field the form posts.
export const FactsSchema = z.object({
  profile:  ProfileSchema,
  hours:    z.array(HourSchema).max(7).default([]),
  services: z.array(ServiceSchema).default([]),
  areas:    z.array(AreaSchema).default([]),
  faqs:            z.array(FaqSchema).default([]),
  projects:        z.array(ProjectSchema).default([]),
  differentiators: z.array(DifferentiatorSchema).default([]),
}).superRefine((f, ctx) => {
  // A project may only reference a service this business actually has —
  // the DB enforces it too, but this gives a field-level message.
  const keys = new Set(f.services.map((s) => s.service_key));
  f.projects.forEach((p, i) => {
    if (p.service_key && !keys.has(p.service_key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projects", i, "service_key"],
        message: `'${p.service_key}' is not one of this business's services`,
      });
    }
  });
  const dupe = <T>(xs: T[], key: (x: T) => string, label: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      const k = key(x);
      if (seen.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [label],
          message: `duplicate ${label}: ${k}` });
      }
      seen.add(k);
    }
  };
  dupe(f.hours,    (h) => String(h.day_of_week), "day_of_week");
  dupe(f.services, (s) => s.service_key,          "service_key");
  dupe(f.areas,    (a) => a.area_slug,            "area_slug");
});

type Facts = z.infer<typeof FactsSchema>;

/** Flatten Zod issues into { field, message } so the form can mark inputs. */
function fieldErrors(err: z.ZodError): Array<{ field: string; message: string }> {
  return err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
}

// ── GET /:slug/facts ──────────────────────────────────────────────────────
// Returns the full fact set. A business with nothing entered yet returns
// profile:null and empty collections — that is an empty state, not an error.
app.get("/:slug/facts", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const [profileRes, hoursRes, servicesRes, areasRes, faqsRes, projectsRes, diffsRes, mediaRes] = await Promise.all([
    supabase.from("business_profile").select("*").eq("business_id", business.id).maybeSingle(),
    supabase.from("business_hours").select("*").eq("business_id", business.id)
      .order("day_of_week", { ascending: true }),
    supabase.from("business_services").select("*").eq("business_id", business.id)
      .order("display_order", { ascending: true }),
    supabase.from("business_service_areas").select("*").eq("business_id", business.id)
      .order("display_order", { ascending: true }),
    supabase.from("business_faqs").select("*").eq("business_id", business.id)
      .order("display_order", { ascending: true }),
    supabase.from("business_projects").select("*").eq("business_id", business.id)
      .order("display_order", { ascending: true }),
    supabase.from("business_differentiators").select("*").eq("business_id", business.id)
      .order("display_order", { ascending: true }),
    supabase.from("site_media")
      .select("id, url, alt_text, mime_type, width, height, bytes, kind, role, origin, poster_url")
      .eq("business_id", business.id).order("created_at", { ascending: false }),
  ]);

  const firstErr = [profileRes, hoursRes, servicesRes, areasRes, faqsRes, projectsRes, diffsRes, mediaRes].find((r) => r.error);
  if (firstErr?.error) {
    log.error("[facts] read_failed", { business_id: business.id, err: firstErr.error.message });
    return c.json(errBody("internal", `facts_read_failed: ${firstErr.error.message}`), 500);
  }

  return c.json({
    business: { slug: business.slug, name: business.name },
    // The page's own section registry. facts.astro renders each band heading
    // from this rather than hardcoding it, so the manager's "Business Facts →
    // <heading>" link quotes the same string the client sees. See
    // lib/site-render/facts-sections.ts.
    sections: FACTS_SECTIONS.map((x) => ({ ...x, anchor: factsAnchor(x.key) })),
    profile:  profileRes.data ?? null,
    hours:    hoursRes.data ?? [],
    services: servicesRes.data ?? [],
    areas:    areasRes.data ?? [],
    faqs:            faqsRes.data ?? [],
    projects:        projectsRes.data ?? [],
    differentiators: diffsRes.data ?? [],
    media:           mediaRes.data ?? [],
  });
});

// ── PUT /:slug/facts ──────────────────────────────────────────────────────
// Replaces the whole fact set. Upsert-then-prune per collection: rows in the
// payload are written first, then rows the payload no longer contains are
// deleted. Never leaves a window where the collection is empty.
//
// Every row written gets source='operator' + updated_by + updated_at. That is
// the provenance the brief requires; it is not optional and there is no code
// path that writes these tables without it.
app.put("/:slug/facts", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  let facts: Facts;
  try {
    facts = FactsSchema.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "facts_invalid", fieldErrors(err)), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  const stamp = { source: "operator" as const, updated_by: auth.user_id, updated_at: new Date().toISOString() };
  const bid = business.id;

  // 1. Profile — 1:1 upsert on business_id.
  const { error: pErr } = await supabase
    .from("business_profile")
    .upsert({ business_id: bid, ...facts.profile, ...stamp }, { onConflict: "business_id" });
  if (pErr) {
    log.error("[facts] profile_write_failed", { business_id: bid, err: pErr.message });
    return c.json(errBody("internal", `profile_write_failed: ${pErr.message}`), 500);
  }

  // 2-4. Collections — upsert, then prune what the payload dropped.
  const collections: Array<{
    table: string; conflict: string; keyCol: string;
    rows: Array<Record<string, unknown>>; keys: string[];
  }> = [
    {
      table: "business_hours", conflict: "business_id,day_of_week", keyCol: "day_of_week",
      rows: facts.hours.map((h) => ({ business_id: bid, ...h, ...stamp })),
      keys: facts.hours.map((h) => String(h.day_of_week)),
    },
    {
      table: "business_services", conflict: "business_id,service_key", keyCol: "service_key",
      rows: facts.services.map((s, i) => ({ business_id: bid, ...s, display_order: i, ...stamp })),
      keys: facts.services.map((s) => s.service_key),
    },
    {
      table: "business_service_areas", conflict: "business_id,area_slug", keyCol: "area_slug",
      rows: facts.areas.map((a, i) => ({ business_id: bid, ...a, display_order: i, ...stamp })),
      keys: facts.areas.map((a) => a.area_slug),
    },
  ];

  for (const col of collections) {
    if (col.rows.length > 0) {
      const { error } = await supabase.from(col.table).upsert(col.rows, { onConflict: col.conflict });
      if (error) {
        log.error("[facts] collection_write_failed", { business_id: bid, table: col.table, err: error.message });
        return c.json(errBody("internal", `${col.table}_write_failed: ${error.message}`), 500);
      }
    }
    // Prune. `keys` is empty when the operator cleared the collection, which is
    // a legitimate "delete everything" — not a guard-rail case.
    let del = supabase.from(col.table).delete().eq("business_id", bid);
    if (col.keys.length > 0) {
      const list = col.keyCol === "day_of_week" ? col.keys.join(",") : `"${col.keys.join('","')}"`;
      del = del.not(col.keyCol, "in", `(${list})`);
    }
    const { error: dErr } = await del;
    if (dErr) {
      log.error("[facts] collection_prune_failed", { business_id: bid, table: col.table, err: dErr.message });
      return c.json(errBody("internal", `${col.table}_prune_failed: ${dErr.message}`), 500);
    }
  }

  // 5-7. Id-keyed collections (Phase 1C). No natural business key, so rows with
  // an id are updated in place, rows without one are inserted, and ids the
  // payload dropped are deleted.
  const idKeyed: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [
    {
      table: "business_faqs",
      rows: facts.faqs.map((x, i) => ({
        ...(x.id ? { id: x.id } : {}),
        business_id: bid, question: x.question, answer: x.answer, scope: x.scope,
        display_order: i, ...stamp,
      })),
    },
    {
      table: "business_projects",
      rows: facts.projects.map((x, i) => ({
        ...(x.id ? { id: x.id } : {}),
        business_id: bid, caption: x.caption, city: x.city,
        service_key: x.service_key, media_id: x.media_id,
        display_order: i, ...stamp,
      })),
    },
    {
      table: "business_differentiators",
      rows: facts.differentiators.map((x, i) => ({
        ...(x.id ? { id: x.id } : {}),
        business_id: bid, headline: x.headline, body: x.body, icon: x.icon,
        display_order: i, ...stamp,
      })),
    },
  ];

  for (const col of idKeyed) {
    if (col.rows.length > 0) {
      const { error } = await supabase.from(col.table).upsert(col.rows, { onConflict: "id" });
      if (error) {
        log.error("[facts] idkeyed_write_failed", { business_id: bid, table: col.table, err: error.message });
        return c.json(errBody("internal", `${col.table}_write_failed: ${error.message}`), 500);
      }
    }
    const keptIds = col.rows.map((r) => r.id).filter(Boolean) as string[];
    let del = supabase.from(col.table).delete().eq("business_id", bid);
    if (keptIds.length > 0) del = del.not("id", "in", `(${keptIds.join(",")})`);
    const { error: dErr } = await del;
    if (dErr) {
      log.error("[facts] idkeyed_prune_failed", { business_id: bid, table: col.table, err: dErr.message });
      return c.json(errBody("internal", `${col.table}_prune_failed: ${dErr.message}`), 500);
    }
  }

  log.info("[facts] saved", {
    business_id: bid,
    hours: facts.hours.length, services: facts.services.length, areas: facts.areas.length,
    faqs: facts.faqs.length, projects: facts.projects.length, differentiators: facts.differentiators.length,
  });

  // Read back what was actually stored. The response is the DB's version, not
  // the request's — "verify by effect", per CLAUDE.md.
  const [profileRes, hoursRes, servicesRes, areasRes, faqsRes, projectsRes, diffsRes, mediaRes] = await Promise.all([
    supabase.from("business_profile").select("*").eq("business_id", bid).maybeSingle(),
    supabase.from("business_hours").select("*").eq("business_id", bid).order("day_of_week", { ascending: true }),
    supabase.from("business_services").select("*").eq("business_id", bid).order("display_order", { ascending: true }),
    supabase.from("business_service_areas").select("*").eq("business_id", bid).order("display_order", { ascending: true }),
    supabase.from("business_faqs").select("*").eq("business_id", bid).order("display_order", { ascending: true }),
    supabase.from("business_projects").select("*").eq("business_id", bid).order("display_order", { ascending: true }),
    supabase.from("business_differentiators").select("*").eq("business_id", bid).order("display_order", { ascending: true }),
    supabase.from("site_media").select("id, url, alt_text, mime_type, width, height, bytes, kind, role, origin, poster_url").eq("business_id", bid).order("created_at", { ascending: false }),
  ]);

  // Read-back errors are surfaced, not swallowed — a missing table here means
  // the write path is writing into a schema that does not match the code.
  const readErr = [profileRes, hoursRes, servicesRes, areasRes, faqsRes, projectsRes, diffsRes, mediaRes]
    .find((r) => r.error);
  if (readErr?.error) {
    log.error("[facts] readback_failed", { business_id: bid, err: readErr.error.message });
    return c.json(errBody("internal", `facts_readback_failed: ${readErr.error.message}`), 500);
  }

  return c.json({
    ok: true,
    profile:  profileRes.data ?? null,
    hours:    hoursRes.data ?? [],
    services: servicesRes.data ?? [],
    areas:    areasRes.data ?? [],
    faqs:            faqsRes.data ?? [],
    projects:        projectsRes.data ?? [],
    differentiators: diffsRes.data ?? [],
    media:           mediaRes.data ?? [],
  });
});

// ── POST /:slug/site ──────────────────────────────────────────────────────
// Provision a managed site for this business from a template. Creates the
// sites / site_pages / site_sections rows; section membership and order come
// from the template's section_catalog in the DB, never from code.
//
// Idempotent — re-running refreshes section rows and leaves site_fields alone,
// so site-authored copy survives a re-provision.
//
// Phase 1B: home page only. Body: { template_key?: string }.
app.post("/:slug/site", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const body = await c.req.json().catch(() => ({}));
  const templateKey =
    typeof (body as { template_key?: unknown }).template_key === "string"
      ? (body as { template_key: string }).template_key
      : "trades-v1";

  try {
    const result = await provisionSite(supabase, business.id, business.slug, templateKey, ["home"]);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("[facts] provision_failed", { business_id: business.id, err: String(err) });
    return c.json(errBody("internal", `provision_failed: ${String(err)}`), 500);
  }
});

export default app;

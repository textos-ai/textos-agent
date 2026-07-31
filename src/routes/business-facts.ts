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
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;   // HH:MM or HH:MM:SS, 24h

/**
 * A time of day, normalised to HH:MM.
 *
 * THE READ-BACK MUST BE WRITABLE. Postgres `time` returns "07:00:00", the schema
 * demanded "07:00", so GET /facts → PUT the response back unchanged returned 400
 * on every open day. A document store whose own output is not valid input is
 * broken: any client that edits one field and posts the document back — which is
 * exactly what the intake form does — is one round trip from a validation wall.
 *
 * Seconds are accepted and dropped rather than rejected, because they carry no
 * information here: opening hours are minute-granular and the DB column is the
 * only thing that ever adds ":00".
 */
const timeOfDay = z
  .string()
  .trim()
  .regex(TIME_RE, "must be HH:MM (24h)")
  .transform((s) => s.slice(0, 5))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/**
 * The keys an object ACTUALLY CARRIES, intersected with the ones we may write.
 *
 * The schema normalises every absent field to null (`.optional().transform(v => v
 * ?? null)`), which is right for validation and catastrophic for persistence:
 * by the time the parsed object reaches the upsert, "the operator cleared this"
 * and "the form did not post this" are the same value. A payload missing
 * street_address wiped a real address with no error.
 *
 * So the WRITE set comes from the raw request body, not the parsed one. Present
 * and empty is a deliberate clear and still writes null; absent is left alone.
 */
function presentKeys(rawRow: unknown, allowed: readonly string[]): string[] {
  if (!rawRow || typeof rawRow !== "object") return [];
  const raw = rawRow as Record<string, unknown>;
  return allowed.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
}

/** The parsed values for exactly the keys the payload carried. */
function patchFrom(
  rawRow: unknown,
  parsedRow: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of presentKeys(rawRow, allowed)) out[k] = parsedRow[k];
  return out;
}

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

// The field list is exported from the SHAPE, never written out a second time —
// a column added here must not also have to be added to a write-list, or the two
// drift and the new field silently stops persisting.
const ProfileFields = z.object({
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
  // analytics_id is GONE (Phase 3A part D). It had a write path here and no
  // consumer anywhere — the font_family shape, where an operator fills a box
  // nothing reads. A GA4 measurement ID is a setting for one WEBSITE, not a fact
  // about a company, so it moved to the GA4 provider's config in
  // site_integrations. Migration 113 backfills, 114 drops the column; removing
  // it from the schema first is what makes that drop safe.
  logo_media_id:       z.string().uuid().nullable().optional().transform((v) => v ?? null),
  hero_media_id:       z.string().uuid().nullable().optional().transform((v) => v ?? null),
});
const PROFILE_KEYS = Object.keys(ProfileFields.shape) as ReadonlyArray<string>;

const ProfileSchema = ProfileFields.superRefine((p, ctx) => {
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
  opens:       timeOfDay,
  closes:      timeOfDay,
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
const SERVICE_KEYS = Object.keys(ServiceSchema.shape) as ReadonlyArray<string>;

const AreaFields = z.object({
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
});
const AREA_KEYS = Object.keys(AreaFields.shape) as ReadonlyArray<string>;

const AreaSchema = AreaFields.superRefine((a, ctx) => {
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

const FAQ_KEYS = Object.keys(FaqSchema.shape) as ReadonlyArray<string>;
const PROJECT_KEYS = Object.keys(ProjectSchema.shape) as ReadonlyArray<string>;
const DIFFERENTIATOR_KEYS = Object.keys(DifferentiatorSchema.shape) as ReadonlyArray<string>;

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

  // The RAW body is kept alongside the parsed one. Which keys the client actually
  // sent is information the parsed object no longer carries, and it is the only
  // thing separating "clear this field" from "this form forgot a field".
  let rawBody: Record<string, unknown> = {};
  let facts: Facts;
  try {
    const json = await c.req.json();
    rawBody = (json && typeof json === "object") ? json as Record<string, unknown> : {};
    facts = FactsSchema.parse(json);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "facts_invalid", fieldErrors(err)), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  const stamp = { source: "operator" as const, updated_by: auth.user_id, updated_at: new Date().toISOString() };
  const bid = business.id;

  // 1. Profile — 1:1 upsert on business_id.
  //
  // ONLY THE COLUMNS THE PAYLOAD CARRIED. Spreading the parsed profile wrote a
  // null for every field the client omitted, so a form that dropped a field
  // deleted the fact behind it with no error and no way to tell it apart from a
  // deliberate clear. See presentKeys.
  const profilePatch = patchFrom(rawBody.profile, facts.profile, PROFILE_KEYS);
  // Geo is a pair in the DB's eyes (there is a CHECK, and superRefine mirrors
  // it). Writing one half of a pair the payload only half-carried would produce
  // exactly the lone coordinate both of them reject, so either key present
  // writes both.
  if ("geo_lat" in profilePatch || "geo_lng" in profilePatch) {
    profilePatch.geo_lat = facts.profile.geo_lat;
    profilePatch.geo_lng = facts.profile.geo_lng;
  }
  const { error: pErr } = await supabase
    .from("business_profile")
    .upsert({ business_id: bid, ...profilePatch, ...stamp }, { onConflict: "business_id" });
  if (pErr) {
    log.error("[facts] profile_write_failed", { business_id: bid, err: pErr.message });
    return c.json(errBody("internal", `profile_write_failed: ${pErr.message}`), 500);
  }

  // 2-4. Collections — upsert, then prune what the payload dropped.
  //
  // Rows are positional: zod preserves array order, so index i of the parsed
  // array is index i of the raw one.
  const rawArr = (k: string): unknown[] =>
    Array.isArray(rawBody[k]) ? rawBody[k] as unknown[] : [];
  const rawServices = rawArr("services");
  const rawAreas = rawArr("areas");

  const collections: Array<{
    table: string; conflict: string; keyCol: string;
    rows: Array<Record<string, unknown>>; keys: string[];
  }> = [
    {
      table: "business_hours", conflict: "business_id,day_of_week", keyCol: "day_of_week",
      rows: facts.hours.map((h) => ({ business_id: bid, ...h, ...stamp })),
      keys: facts.hours.map((h) => String(h.day_of_week)),
    },
    // Same omitted-column rule as the profile: a row writes only what it carried,
    // plus the natural key the upsert conflicts on (without which the row cannot
    // be matched at all) and the ordering the payload's position defines.
    {
      table: "business_services", conflict: "business_id,service_key", keyCol: "service_key",
      rows: facts.services.map((s, i) => ({
        business_id: bid,
        ...patchFrom(rawServices[i], s, SERVICE_KEYS),
        service_key: s.service_key,
        display_order: i, ...stamp,
      })),
      keys: facts.services.map((s) => s.service_key),
    },
    {
      table: "business_service_areas", conflict: "business_id,area_slug", keyCol: "area_slug",
      rows: facts.areas.map((a, i) => ({
        business_id: bid,
        ...patchFrom(rawAreas[i], a, AREA_KEYS),
        area_slug: a.area_slug,
        display_order: i, ...stamp,
      })),
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
  /**
   * One row of an id-keyed collection.
   *
   * INSERT vs UPDATE are not the same rule, and collapsing them is what the
   * profile bug was:
   *
   *   * No id — a NEW row. The whole parsed object is written, defaults and all,
   *     because there is nothing behind it to preserve and a column the payload
   *     did not mention has no stored value to fall back on.
   *   * An id — an EXISTING row. Only the keys the payload actually carried are
   *     written, so a form that stops posting `city` or `icon` leaves the stored
   *     one alone instead of nulling it. These fields are optionalText, so the
   *     schema turns "absent" into an explicit null exactly as it did for the
   *     profile; without this they carry the identical silent-delete bug.
   *
   * The field list comes off the schema's shape, so a field added to a schema and
   * forgotten in a hand-written row builder — the trade_noun shape, which
   * validates fine and then never persists — cannot happen here.
   */
  const idRow = (
    raw: unknown, parsed: Record<string, unknown>, keys: ReadonlyArray<string>, i: number,
  ): Record<string, unknown> => ({
    ...(parsed.id
      ? { id: parsed.id, ...patchFrom(raw, parsed, keys) }
      : Object.fromEntries(keys.filter((k) => k !== "id").map((k) => [k, parsed[k]]))),
    business_id: bid,
    display_order: i,
    ...stamp,
  });

  const rawFaqs = rawArr("faqs");
  const rawProjects = rawArr("projects");
  const rawDiffs = rawArr("differentiators");

  const idKeyed: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [
    {
      table: "business_faqs",
      rows: facts.faqs.map((x, i) => idRow(rawFaqs[i], x, FAQ_KEYS, i)),
    },
    {
      table: "business_projects",
      rows: facts.projects.map((x, i) => idRow(rawProjects[i], x, PROJECT_KEYS, i)),
    },
    {
      table: "business_differentiators",
      rows: facts.differentiators.map((x, i) => idRow(rawDiffs[i], x, DIFFERENTIATOR_KEYS, i)),
    },
  ];

  for (const col of idKeyed) {
    // PRUNE AGAINST WHAT WAS WRITTEN, NEVER AGAINST WHAT THE PAYLOAD CARRIED.
    //
    // These rows have no natural key, so a NEW one arrives with no id — the form
    // only sends one for a row it is editing. keptIds was built from the payload,
    // so a save containing nothing but new rows produced an EMPTY kept list, the
    // `length > 0` guard skipped the `not in` filter, and the delete ran
    // unscoped: insert five FAQs, then delete every FAQ for the business,
    // including the five just inserted. One request, 200 OK, nothing saved and
    // nothing to see in the response.
    //
    // The ids only exist after the insert, so they are read back from it. RETURNS
    // ALL AFFECTED ROWS, inserted and updated alike, which is exactly the set
    // that must survive the prune.
    let keptIds: string[] = [];
    if (col.rows.length > 0) {
      // ONE WRITE PER KEY SIGNATURE, and inserts kept apart from updates.
      //
      // PostgREST flattens an array of objects into a SINGLE column list and
      // fills any key a row lacks with null. So a save mixing an edited FAQ (has
      // id) with a newly typed one (has none) sent `id: null` for the new row and
      // the database rejected the whole batch:
      //   null value in column "id" of relation "business_faqs" violates not-null
      // That is the normal second save — edit one, add another — and it failed
      // wholesale. Grouping by exact key set also covers rows that legitimately
      // differ because patchFrom wrote only what each carried.
      const groups = new Map<string, Array<Record<string, unknown>>>();
      for (const r of col.rows) {
        const sig = Object.keys(r).sort().join(",");
        const g = groups.get(sig) ?? [];
        g.push(r);
        groups.set(sig, g);
      }
      for (const rows of groups.values()) {
        // No id means a genuinely new row: INSERT and let the database mint one.
        // An upsert would have to name a conflict target the row does not carry.
        const isNew = !("id" in rows[0]);
        const { data: written, error } = isNew
          ? await supabase.from(col.table).insert(rows).select("id")
          : await supabase.from(col.table).upsert(rows, { onConflict: "id" }).select("id");
        if (error) {
          log.error("[facts] idkeyed_write_failed", {
            business_id: bid, table: col.table, is_new: isNew, err: error.message });
          return c.json(errBody("internal", `${col.table}_write_failed: ${error.message}`), 500);
        }
        keptIds.push(...((written ?? []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean));
      }

      // NO FALLBACKS. If the write did not hand back one id per row, the prune
      // below cannot be trusted to spare the right rows — and the failure mode of
      // guessing here is deleting the operator's work. Halt instead, loudly.
      if (keptIds.length !== col.rows.length) {
        log.error("[facts] idkeyed_write_incomplete", {
          business_id: bid, table: col.table, sent: col.rows.length, written: keptIds.length,
        });
        return c.json(errBody("internal",
          `${col.table}_write_incomplete: sent ${col.rows.length} rows, the database confirmed `
          + `${keptIds.length}. Nothing was deleted. Try again.`), 500);
      }
    }

    // An EMPTY payload is the one legitimate unscoped delete: the operator
    // cleared the collection. That is now the only way to reach it — previously
    // "cleared everything" and "added the first row" were the same signal.
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

  // ── Area pages follow the area facts, with no separate step ───────────────
  //
  // Adding a service area in Business Facts has to produce a working area page.
  // It did not: BOTH provisionSite callers ask for ["home"], so nothing in the
  // running system has ever minted an area page — the one that existed came from
  // migration 109 running once, when this business had a single area. Fourteen
  // areas, one page, and the Service Areas dropdown expands from the PAGES.
  //
  // ADDITIVE ONLY, AND DELIBERATELY SO. provisionSite upserts pages and sections
  // and inserts site_fields only when absent; it contains no DELETE. This call
  // therefore cannot destroy authored copy or retire a URL. The reverse direction
  // — an area the operator dropped — is NOT handled here, because the prune above
  // makes a removal indistinguishable from a form that lost a row, and quietly
  // 404ing a live page on that signal is not a decision this handler should make.
  // Pages for removed areas stay live and are reported as stale (see below).
  //
  // Only when the set actually CHANGED. Provisioning walks every instance
  // sequentially, so running it on every profile-only save would add round trips
  // to a request that has nothing to provision.
  let sitePages: {
    ok: boolean; provisioned: number; missing_before: string[];
    unpublished: string[]; republished: string[]; error?: string;
  } | null = null;
  {
    const { data: siteRow } = await supabase
      .from("sites").select("id").eq("business_id", bid)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (siteRow) {
      const siteId = (siteRow as { id: string }).id;
      const { data: existingPages } = await supabase
        .from("site_pages").select("id, instance_key, noindex")
        .eq("site_id", siteId).eq("page_type", "area_detail");
      const rows = ((existingPages ?? []) as Array<{
        id: string; instance_key: string | null; noindex: boolean }>)
        .filter((p) => !!p.instance_key);
      const have = new Set(rows.map((p) => p.instance_key as string));
      const want = new Set(facts.areas.map((a) => a.area_slug));
      const missing = [...want].filter((k) => !have.has(k));

      // ── UNPUBLISH, NEVER DELETE ───────────────────────────────────────────
      //
      // An area page whose fact row is gone goes noindex. That one flag is the
      // whole mechanism: nav, the area card grid, sitemap.xml and llms.txt all
      // already filter on it, and robots.txt already emits a Disallow for it. The
      // URL keeps serving, so an inbound link still lands somewhere real instead
      // of a 404, and the page stops being advertised or indexed — which is the
      // indexable-empty-page defect closed without destroying anything.
      //
      // Reversible by construction: re-adding the area republishes the same row,
      // with its authored copy and its URL intact.
      //
      // Destruction stays a human decision. A dropped form row and a deliberate
      // deletion arrive here as the same signal, and only a person can tell them
      // apart — so the manager offers an explicit delete, and this does not.
      const toUnpublish = rows.filter((p) => !want.has(p.instance_key as string) && !p.noindex);
      const toRepublish = rows.filter((p) => want.has(p.instance_key as string) && p.noindex);
      for (const [list, noindex] of [[toUnpublish, true], [toRepublish, false]] as const) {
        if (list.length === 0) continue;
        const { error: nErr } = await supabase
          .from("site_pages").update({ noindex }).in("id", list.map((p) => p.id));
        if (nErr) {
          log.error("[facts] area_publish_flag_failed", { business_id: bid, noindex, err: nErr.message });
        }
      }
      const unpublished = toUnpublish.map((p) => p.instance_key as string);
      const republished = toRepublish.map((p) => p.instance_key as string);
      if (unpublished.length || republished.length) {
        log.info("[facts] area_pages_publish_state", { business_id: bid, unpublished, republished });
      }

      if (missing.length > 0) {
        try {
          // area_index rides along: the dropdown's parent link and the card grid
          // both live there, and a site provisioned before 2C has no such page.
          // Only the missing areas. Re-expanding all of them costs ~450ms each
          // and re-confirms pages that already exist; the common case is one new
          // area on a save. area_index carries instance_key null and so is never
          // filtered out — it is upserted every time, which is what makes a site
          // provisioned before 2C grow its /areas page on the first save.
          await provisionSite(
            supabase, bid, business.slug, "trades-v1",
            ["area_index", "area_detail"], false, missing,
          );
          sitePages = {
            ok: true, provisioned: missing.length, missing_before: missing,
            unpublished, republished,
          };
          log.info("[facts] area_pages_provisioned", {
            business_id: bid, site_id: siteId, count: missing.length,
          });
        } catch (err) {
          // The FACTS SAVED. Returning 500 here would tell the operator their
          // typing was lost, which is false. Report the provisioning failure as
          // its own outcome instead — loud in the logs, visible in the response,
          // never swallowed. areaSlug throws when trade_noun is missing, which is
          // the likeliest cause and is fixable on this same page.
          log.error("[facts] area_provision_failed", { business_id: bid, err: String(err) });
          sitePages = {
            ok: false, provisioned: 0, missing_before: missing,
            unpublished, republished, error: String(err),
          };
        }
      } else {
        sitePages = { ok: true, provisioned: 0, missing_before: [], unpublished, republished };
      }
    }
  }

  return c.json({
    ok: true,
    // Null when the business has no managed site yet — there is nothing to keep
    // in step, which is different from "nothing needed doing".
    site_pages: sitePages,
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

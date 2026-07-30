// Business facts bundle + source_path resolution.
//
// A managed site derives from business facts. Derived fields are NOT stored on
// the site — they are resolved at render time through `source_path`, so they are
// always current by construction and cannot drift. Change the phone number on
// the Facts page and the site shows the new one on the next request, with no
// regeneration step.
//
// source_path grammar (seeded in migration 092's field_derivation_map):
//   profile.<column>            → business_profile
//   profile.hours               → business_hours (the whole ordered set)
//   services[<service_key>].<f> → business_services
//   areas[<area_slug>].<f>      → business_service_areas
//   context.<key>               → business_context
//
// NO FALLBACKS. A missing load-bearing fact halts with a clear error rather than
// rendering a placeholder. This page is published for a licensed contractor —
// an invented license number, address, or phone is a real-world liability, not a
// cosmetic defect.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProfileRow {
  business_id: string;
  legal_name: string | null;
  alternate_name: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  street_address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  license_number: string | null;
  license_authority: string | null;
  /** Search noun for the trade, e.g. "electrician" (107). Drives area-page URLs. */
  trade_noun: string | null;
  trade_noun_plural: string | null;
  google_place_id: string | null;
  google_business_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  analytics_id: string | null;
  logo_media_id: string | null;
  hero_media_id: string | null;
}

export interface HourRow {
  day_of_week: number;
  opens: string | null;
  closes: string | null;
  is_closed: boolean;
}

export interface ServiceRow {
  service_key: string;
  name: string;
  blurb: string | null;
  body: string | null;
  bullets: string[];
  display_order: number;
}

export interface AreaRow {
  area_slug: string;
  city: string;
  region: string | null;
  postal_code: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  local_blurb: string;
  landmarks_blurb: string;
  display_order: number;
}

export interface FaqRow { id: string; question: string; answer: string; scope: string; display_order: number }
export interface ProjectRow { id: string; caption: string; city: string | null; service_key: string | null; media_id: string | null; display_order: number }
export interface DifferentiatorRow { id: string; headline: string; body: string; icon: string | null; display_order: number }
export interface MediaRow {
  id: string; url: string; alt_text: string | null; kind: string; mime_type: string | null;
  width: number | null; height: number | null; poster_url: string | null; role: string | null;
}

export interface SiteFacts {
  business: Record<string, unknown>;
  profile: ProfileRow | null;
  hours: HourRow[];
  services: ServiceRow[];
  areas: AreaRow[];
  faqs: FaqRow[];
  projects: ProjectRow[];
  differentiators: DifferentiatorRow[];
  context: Record<string, unknown> | null;
  media: Record<string, MediaRow>;
}

/**
 * Thrown when a table or column the render path needs does not exist.
 *
 * THE DISTINCTION THIS ENFORCES: an EMPTY table is a legitimate state — the
 * business has not entered any FAQs yet, and the section correctly renders
 * nothing. A MISSING table is a broken deployment: a migration was never
 * applied, the feature is dead, and every dependent section silently renders
 * nothing while the page still looks fine.
 *
 * Before this, `(res.data ?? [])` collapsed both into the same empty array. If
 * migration 093 had never been applied, FAQs / projects / differentiators /
 * media would all have read as empty and nobody would have known.
 */
// SchemaError and the fault-code list now live in lib/db-errors.ts so the route
// handlers classify failures the same way this render path does. Re-exported here
// because compose.ts, sites.ts and 16 unwrap() call sites already import it from
// this module, and one definition is the entire point.
export { SchemaError, SCHEMA_FAULT_CODES } from "../db-errors";
import { dbError } from "../db-errors";

interface PostgrestLike<T> { data: T | null; error: { code?: string; message?: string } | null }

/**
 * Unwrap a PostgREST result or throw.
 *
 * NEVER returns an empty array for a failed query. A schema fault throws
 * SchemaError (actionable: apply the migration); anything else throws a plain
 * Error rather than degrading to "no data", because a transient DB failure
 * rendering as an empty page is the same silent lie in a different costume.
 */
export function unwrap<T>(res: PostgrestLike<T>, table: string, fallback: T): T {
  if (res.error) throw dbError(table, res.error);
  return res.data ?? fallback;
}

/** Thrown when a load-bearing fact is absent. Surfaces as a 5xx, never a blank. */
export class MissingFactError extends Error {
  constructor(readonly fieldName: string, readonly sourcePath: string | null) {
    super(
      `Missing required business fact: ${fieldName}` +
        (sourcePath ? ` (source_path: ${sourcePath})` : "") +
        ". Enter it on the Business Facts page. Refusing to render a placeholder.",
    );
    this.name = "MissingFactError";
  }
}

export async function loadSiteFacts(
  supabase: SupabaseClient,
  businessId: string,
  business: Record<string, unknown>,
): Promise<SiteFacts> {
  const [p, h, s, a, ctx, m, fq, pj, df] = await Promise.all([
    supabase.from("business_profile").select("*").eq("business_id", businessId).maybeSingle(),
    supabase.from("business_hours").select("*").eq("business_id", businessId).order("day_of_week", { ascending: true }),
    supabase.from("business_services").select("*").eq("business_id", businessId).order("display_order", { ascending: true }),
    supabase.from("business_service_areas").select("*").eq("business_id", businessId).order("display_order", { ascending: true }),
    supabase.from("business_context").select("key_differentiators, positioning_statement, brand_voice, value_proposition").eq("business_id", businessId).maybeSingle(),
    supabase.from("site_media")
      .select("id, url, alt_text, kind, mime_type, width, height, poster_url, role")
      .eq("business_id", businessId),
    supabase.from("business_faqs").select("*").eq("business_id", businessId).order("display_order", { ascending: true }),
    supabase.from("business_projects").select("*").eq("business_id", businessId).order("display_order", { ascending: true }),
    supabase.from("business_differentiators").select("*").eq("business_id", businessId).order("display_order", { ascending: true }),
  ]);

  // Every read is unwrapped. A missing table throws SchemaError rather than
  // yielding an empty array — an unapplied migration must not look like a
  // business that simply has no FAQs yet.
  const media: SiteFacts["media"] = {};
  for (const row of unwrap<MediaRow[]>(m, "site_media", [])) media[row.id] = row;

  return {
    business,
    profile: unwrap<ProfileRow | null>(p, "business_profile", null),
    hours: unwrap<HourRow[]>(h, "business_hours", []),
    services: unwrap<ServiceRow[]>(s, "business_services", []),
    areas: unwrap<AreaRow[]>(a, "business_service_areas", []),
    faqs: unwrap<FaqRow[]>(fq, "business_faqs", []),
    projects: unwrap<ProjectRow[]>(pj, "business_projects", []),
    differentiators: unwrap<DifferentiatorRow[]>(df, "business_differentiators", []),
    context: unwrap<Record<string, unknown> | null>(ctx, "business_context", null),
    media,
  };
}

const PATH_RE = /^(profile|services|areas|context)(?:\[([^\]]+)\])?(?:\.(.+))?$/;

/**
 * Resolve a source_path against the facts bundle.
 * Returns `undefined` when the path is well-formed but the fact is absent —
 * callers decide whether that is fatal (requireFact) or an empty state.
 */
export function resolveSourcePath(path: string, facts: SiteFacts): unknown {
  const m = PATH_RE.exec(path.trim());
  if (!m) return undefined;
  const [, ns, key, field] = m;

  switch (ns) {
    case "profile": {
      if (field === "hours") return facts.hours;
      if (!field || !facts.profile) return undefined;
      // Media FKs resolve through site_media to a usable URL.
      // Media FKs resolve to the FULL media row (url + alt + dimensions +
      // poster), because a renderer needs alt text and intrinsic size, not just
      // a URL. Callers that want the URL read `.url`.
      if (field === "logo_media_id" || field === "hero_media_id") {
        const id = (facts.profile as unknown as Record<string, string | null>)[field];
        return id ? facts.media[id] : undefined;
      }
      const v = (facts.profile as unknown as Record<string, unknown>)[field];
      return v === null ? undefined : v;
    }
    case "services": {
      if (!key) return facts.services;
      const row = facts.services.find((x) => x.service_key === key);
      if (!row || !field) return row;
      const v = (row as unknown as Record<string, unknown>)[field];
      return v === null ? undefined : v;
    }
    case "areas": {
      if (!key) return facts.areas;
      const row = facts.areas.find((x) => x.area_slug === key);
      if (!row || !field) return row;
      const v = (row as unknown as Record<string, unknown>)[field];
      return v === null ? undefined : v;
    }
    case "context": {
      if (!field || !facts.context) return undefined;
      const v = facts.context[field];
      return v === null ? undefined : v;
    }
    default:
      return undefined;
  }
}

/** Resolve or halt. Use for anything the page cannot honestly render without. */
export function requireFact<T = unknown>(
  path: string,
  facts: SiteFacts,
  fieldName = path,
): T {
  const v = resolveSourcePath(path, facts);
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    throw new MissingFactError(fieldName, path);
  }
  return v as T;
}

// ── Formatting helpers (presentation of a fact, never invention of one) ──

/** "(504) 442-0980" → "+15044420980" for tel: and JSON-LD. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** "07:00:00" → "7:00 AM". */
export function formatTime(t: string): string {
  const [hStr, mStr] = t.split(":");
  const h = Number(hStr);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr} ${suffix}`;
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const SCHEMA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Collapse per-day rows into display ranges: contiguous days sharing the same
 * open/close collapse to "Mon – Sat". Presentation only — the stored facts stay
 * per-day, which is what openingHoursSpecification needs.
 */
export function summarizeHours(hours: HourRow[]): Array<{ day: string; value: string }> {
  if (hours.length === 0) return [];
  const ordered = [...hours].sort((a, b) => a.day_of_week - b.day_of_week);
  const sig = (h: HourRow) => (h.is_closed ? "closed" : `${h.opens}-${h.closes}`);

  const groups: Array<{ start: number; end: number; h: HourRow }> = [];
  for (const h of ordered) {
    const last = groups[groups.length - 1];
    if (last && sig(last.h) === sig(h) && h.day_of_week === last.end + 1) {
      last.end = h.day_of_week;
    } else {
      groups.push({ start: h.day_of_week, end: h.day_of_week, h });
    }
  }

  return groups.map((g) => {
    const label =
      g.start === g.end
        ? DAY_NAMES[g.start]
        : `${DAY_NAMES[g.start].slice(0, 3)} – ${DAY_NAMES[g.end].slice(0, 3)}`;
    const value = g.h.is_closed
      ? "Closed"
      : `${formatTime(g.h.opens as string)} – ${formatTime(g.h.closes as string)}`;
    return { day: label, value };
  });
}

/** "St Bernard, LA 70085" — omits absent parts rather than inventing them. */
export function addressLine(p: ProfileRow): string {
  return [p.locality, p.region].filter(Boolean).join(", ") + (p.postal_code ? ` ${p.postal_code}` : "");
}

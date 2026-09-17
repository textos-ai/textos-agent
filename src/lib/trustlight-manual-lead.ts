// =============================================================
// TrustLight — operator-created leads.
//
// A business that calls in, or one Rob meets, exists in neither path we had:
// it was never scraped, and it is not sitting at a laptop filling in the
// public application form. This is the third door, and it is the only one an
// authenticated operator can open.
//
// ── WHAT IT DELIBERATELY DOES NOT ACCEPT ────────────────────────────────────
// Only fields a PERSON can supply. Everything the system produces for itself
// is refused outright rather than silently ignored: rank, call_score and its
// components, rating, review_count, every enrichment column, hijack flags and
// the opening angle. Those come from the scrape or the probe, and a typed
// value there would be a measurement nobody took — the same mistake as writing
// has_website false because our own record was empty.
//
// The one exception is rating and review_count, and only when they arrive from
// Google Place Details server-side. They are still not typed; they are read
// from the source that owns them. The client cannot supply them at all.
// =============================================================
import { HOME_TRADE_CATEGORIES } from "./trustlight-public";
import { normalizePhone, formatPhone } from "./trustlight-application";

export interface ManualFieldError { field: string; message: string; }

/** Exactly the fields the form offers. Anything else is a bad request. */
export const MANUAL_FIELDS = [
  "name", "phone", "category", "city", "state",
  "address", "zip", "parish", "market", "website_url", "place_id",
] as const;

/**
 * Columns an operator may never write here, listed by name so the refusal can
 * say WHICH one and why. Silently dropping them would let a UI bug write a
 * fabricated score and nobody would find out.
 */
export const MANUAL_FORBIDDEN = [
  "rank", "call_score", "cat_score", "rc_score", "r_score", "phone_score", "adj",
  "rating", "review_count",
  "enrichment_status", "enriched_at", "site_state", "site_http_status",
  "has_website", "has_schema_org", "domain", "domain_age_days", "domain_registrar",
  "hijack_flag", "recently_registered", "opening_angle",
  "vetting_status", "is_published", "slug", "verified_at", "expires_at",
] as const;

const US_STATE = /^[A-Za-z]{2}$/;

export interface ValidatedManual {
  fields: Record<string, string>;
  phoneDigits: string;
}

export function validateManual(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedManual } | { ok: false; errors: ManualFieldError[] } {
  const errors: ManualFieldError[] = [];

  for (const k of Object.keys(body)) {
    if (k === "force") continue;
    if ((MANUAL_FORBIDDEN as readonly string[]).includes(k)) {
      errors.push({ field: k, message: `'${k}' is produced by the system and cannot be set by hand` });
      continue;
    }
    if (!(MANUAL_FIELDS as readonly string[]).includes(k)) {
      errors.push({ field: k, message: `'${k}' is not a field on this form` });
    }
  }

  const str = (k: string, max: number) => {
    const v = body[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") { errors.push({ field: k, message: "must be text" }); return undefined; }
    const t = v.trim();
    if (!t) return undefined;
    if (t.length > max) { errors.push({ field: k, message: `must be ${max} characters or fewer` }); return undefined; }
    return t;
  };

  const fields: Record<string, string> = {};

  // ── Required ──────────────────────────────────────────────────────────────
  const name = str("name", 200);
  if (!name) errors.push({ field: "name", message: "business name is required" });
  else fields.name = name;

  const rawPhone = str("phone", 40);
  let phoneDigits = "";
  if (!rawPhone) {
    errors.push({ field: "phone", message: "phone is required" });
  } else {
    const ten = normalizePhone(rawPhone);
    if (!ten) errors.push({ field: "phone", message: "must be a 10-digit US phone number" });
    else phoneDigits = ten;
  }

  // The vocabulary is the SAME sixteen the public directory filters on. A trade
  // outside it cannot be found by anyone using the site, which makes the record
  // invisible in exactly the way that has already cost four businesses.
  const category = str("category", 80);
  if (!category) {
    errors.push({ field: "category", message: "trade is required" });
  } else if (!(HOME_TRADE_CATEGORIES as readonly string[]).includes(category.toLowerCase())) {
    errors.push({
      field: "category",
      message: `must be one of: ${HOME_TRADE_CATEGORIES.join(", ")}`,
    });
  } else {
    fields.category = category.toLowerCase();
  }

  const city = str("city", 120);
  if (!city) errors.push({ field: "city", message: "city is required" });
  else fields.city = city;

  const state = str("state", 2);
  if (!state) errors.push({ field: "state", message: "state is required" });
  else if (!US_STATE.test(state)) errors.push({ field: "state", message: "must be a 2-letter state code" });
  else fields.state = state.toUpperCase();

  // ── Optional ──────────────────────────────────────────────────────────────
  for (const [k, max] of [["address", 240], ["zip", 12], ["parish", 120], ["market", 120]] as const) {
    const v = str(k, max);
    if (v !== undefined) fields[k] = v;
  }

  const site = str("website_url", 300);
  if (site !== undefined) {
    const withScheme = /^https?:\/\//i.test(site) ? site : "https://" + site;
    try {
      const u = new URL(withScheme);
      if (!u.hostname.includes(".")) throw new Error("no dot");
      fields.website_url = u.toString();
    } catch {
      errors.push({ field: "website_url", message: "does not look like a web address" });
    }
  }

  const pid = str("place_id", 200);
  if (pid !== undefined) {
    // Google's ids are URL-safe tokens. Rejecting anything else stops a pasted
    // Maps URL being stored as though it were an id.
    if (!/^[A-Za-z0-9_-]+$/.test(pid)) {
      errors.push({ field: "place_id", message: "should be the raw place_id, not a URL" });
    } else {
      fields.place_id = pid;
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { fields, phoneDigits } };
}

/**
 * The columns written for a brand-new operator-created record.
 *
 * call_score is NOT NULL with no default, so something must go there. 0, for
 * the same reason newLeadColumns() uses 0 for an application: call_score ranks
 * COLD-CALL prospects, and a business that phoned us or that Rob met in person
 * is worth nothing as a cold-call target — it has already been contacted, by
 * definition. 0 also sorts it to the bottom of the call worklist, which is
 * exactly where it belongs; a manually added business must never surface as
 * someone to cold-call.
 *
 * It is NOT a quality judgement and never reaches the public API. The public
 * score is dti_score, computed from measured signals, and the two are kept
 * apart deliberately — see the call_score guard in the DTI scorer.
 *
 * rank stays NULL: genuinely not ranked. Ranking is done by the enrichment
 * import over the scraped set, and inventing a rank here would place this
 * business among scored ones on evidence nobody gathered.
 *
 * `category` AND `trade` both get the operator's chosen value. The public
 * unvetted tier reads `category` and the verified tier reads `trade`; writing
 * one and not the other is precisely the split that made four paid businesses
 * invisible. The operator picked it from the canonical sixteen, so both
 * columns can hold it honestly from the start.
 */
export function manualLeadColumns(v: ValidatedManual, nowIso: string): Record<string, unknown> {
  const f = v.fields;
  const row: Record<string, unknown> = {
    name: f.name,
    category: f.category,
    trade: f.category,
    city: f.city,
    state: f.state,
    phone: formatPhone(v.phoneDigits),
    phone_e164_digits: v.phoneDigits,
    // 'invited' rather than 'lead'. 'lead' means scraped and never contacted,
    // which would drop this business into the cold-call pool after somebody
    // has already spoken to them. 'invited' is what the public application
    // form produces and means the same thing here: in the verification funnel,
    // not a calling target.
    vetting_status: "invited",
    applied_at: nowIso,
    call_score: 0,
    rank: null,
  };
  for (const k of ["address", "zip", "parish", "market", "website_url", "place_id"]) {
    if (f[k] !== undefined) row[k] = f[k];
  }
  return row;
}

// ── Google Place Details ────────────────────────────────────────────────────

export interface PlaceLookup {
  name: string | null;
  formatted_address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * Read one place from Google Place Details.
 *
 * Uses the LEGACY endpoint on purpose: the key in this account is already used
 * against maps.googleapis.com by daycycle-connect, so Place Details is the same
 * enabled product rather than a new one to switch on.
 *
 * Every field comes back nullable. A place Google does not return a rating for
 * gets null, never 0 — a zero here would be published as a review score.
 */
export async function placeDetails(
  placeId: string,
  apiKey: string,
): Promise<{ ok: true; place: PlaceLookup } | { ok: false; status: string; message: string }> {
  const u = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  u.searchParams.set("place_id", placeId);
  u.searchParams.set("fields",
    "name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,address_component");
  u.searchParams.set("key", apiKey);

  let res: Response;
  try {
    res = await fetch(u.toString(), { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    return { ok: false, status: "fetch_failed", message: String(err) };
  }
  if (!res.ok) return { ok: false, status: `http_${res.status}`, message: `Places returned ${res.status}` };

  const j = await res.json() as {
    status?: string; error_message?: string;
    result?: {
      name?: string; formatted_address?: string; formatted_phone_number?: string;
      website?: string; rating?: number; user_ratings_total?: number;
      address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
    };
  };
  if (j.status !== "OK" || !j.result) {
    return { ok: false, status: j.status ?? "unknown", message: j.error_message ?? `Places status ${j.status}` };
  }

  const comp = (type: string, short = false) => {
    const c = (j.result!.address_components ?? []).find((x) => (x.types ?? []).includes(type));
    return (short ? c?.short_name : c?.long_name) ?? null;
  };

  return {
    ok: true,
    place: {
      name: j.result.name ?? null,
      formatted_address: j.result.formatted_address ?? null,
      phone: j.result.formatted_phone_number ?? null,
      website: j.result.website ?? null,
      rating: typeof j.result.rating === "number" ? j.result.rating : null,
      review_count: typeof j.result.user_ratings_total === "number" ? j.result.user_ratings_total : null,
      city: comp("locality") ?? comp("sublocality") ?? null,
      state: comp("administrative_area_level_1", true),
      zip: comp("postal_code"),
    },
  };
}

// ── Duplicate detection ─────────────────────────────────────────────────────

export interface DuplicateMatch {
  id: string;
  name: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  vetting_status: string | null;
  matched_on: "name" | "phone";
}

/**
 * Businesses that may already be this one.
 *
 * Two keys, because they fail in different directions. PHONE is exact on the
 * normalised 10 digits and is the reliable one - 91% of rows carry it and a
 * shared number is a genuine signal. NAME is a case-insensitive contains,
 * which is deliberately loose: "Barreto Home Solutions" should surface when
 * somebody types "Barreto", because the point is to make a person look, not to
 * decide for them.
 *
 * Loose on purpose in one direction only. A false positive costs a glance; a
 * false negative creates the second record for a business that is already
 * halfway through vetting, and nothing downstream will ever reconcile them.
 *
 * This NEVER decides anything by itself - it returns candidates for a person
 * to judge.
 */
export async function findDuplicates(
  supabase: { from: Function },
  name: string,
  phone: string,
): Promise<{ ok: true; matches: DuplicateMatch[] } | { ok: false; message: string }> {
  const cols = "id, name, phone, city, state, vetting_status";
  const byId = new Map<string, DuplicateMatch>();

  const digits = String(phone ?? "").replace(/\D+/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) {
    const { data, error } = await supabase
      .from("coldcall_leads").select(cols).eq("phone_e164_digits", ten).limit(10);
    if (error) return { ok: false, message: error.message };
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      byId.set(r.id as string, { ...(r as unknown as DuplicateMatch), matched_on: "phone" });
    }
  }

  const n = String(name ?? "").trim();
  if (n.length >= 3) {
    // PostgREST pattern metacharacters are stripped rather than escaped: this
    // is a convenience lookup, and a name containing a % should search for the
    // rest of itself rather than error or match everything.
    const safe = n.replace(/[%,()\\]/g, "");
    if (safe) {
      const { data, error } = await supabase
        .from("coldcall_leads").select(cols).ilike("name", `%${safe}%`).limit(10);
      if (error) return { ok: false, message: error.message };
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        // A phone match is the stronger statement, so it is not downgraded.
        if (!byId.has(r.id as string)) {
          byId.set(r.id as string, { ...(r as unknown as DuplicateMatch), matched_on: "name" });
        }
      }
    }
  }

  return { ok: true, matches: [...byId.values()] };
}

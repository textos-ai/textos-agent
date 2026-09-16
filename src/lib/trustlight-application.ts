// =============================================================
// Contractor application — validation, normalisation and matching.
//
// Replaces the Formspree form on trustlight.com/start. This is the ONLY
// unauthenticated endpoint in the product that WRITES, which is why the rules
// live here rather than in the route: every one of them has to be impossible
// to route around.
//
// Two principles run through the whole file:
//
//   1. NOTHING THE APPLICANT SAYS IS A VERIFICATION. An application sets
//      vetting_status='invited' and fills in fields for an operator to CHECK.
//      It never touches a chk_* field, never sets verified_at, never publishes.
//      A business that could verify itself by typing into a form is the exact
//      thing TrustLight exists to prevent.
//
//   2. THE RESPONSE REVEALS NOTHING. Whether a submission matched an existing
//      lead is recorded in the audit log and never in the reply. Telling the
//      caller "we found you" would turn this into an oracle for probing which
//      businesses are in the lead database, one licence number at a time.
// =============================================================

/** Fields the applicant may send. Anything else is a 400, never a silent drop. */
export const APPLICATION_FIELDS = {
  // Required.
  business_name:      { type: "text",  max: 200, required: true },
  legal_name:         { type: "text",  max: 200, required: true },
  trade:              { type: "text",  max: 80,  required: true },
  license_number:     { type: "text",  max: 80,  required: true },
  license_state:      { type: "state", required: true },
  contact_name:       { type: "text",  max: 120, required: true },
  contact_email:      { type: "email", max: 200, required: true },
  phone:              { type: "phone", required: true },
  address:            { type: "text",  max: 200, required: true },
  city:               { type: "text",  max: 120, required: true },
  state:              { type: "state", required: true },
  zip:                { type: "zip",   required: true },
  authorised:         { type: "true",  required: true },
  // Optional.
  parish:             { type: "text",  max: 120 },
  year_established:   { type: "year" },
  gl_carrier:         { type: "text",  max: 160 },
  website_url:        { type: "url",   max: 300 },
  google_profile_url: { type: "url",   max: 500 },
  note:               { type: "text",  max: 2000 },
} as const;

export type ApplicationField = keyof typeof APPLICATION_FIELDS;

/**
 * The honeypot. Named to look like something a form-filling bot wants to
 * complete, and hidden from people by CSS on the page. A human never sees it,
 * so any value at all means the submission is automated.
 */
export const HONEYPOT_FIELD = "company_fax";

/** Rate limits. Far tighter than the 120/min on the public reads, because this
 *  one creates rows rather than serving cached ones. */
export const APPLICATION_RATE = {
  perMinute: 5,
  perHour: 20,
} as const;

export interface ValidationError { field: string; message: string; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Digits only, normalised to the 10-digit form every row in the table uses. */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  // A leading 1 is the US country code, not part of the number.
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

/** The display form the existing rows use: (225) 636-2310. */
export const formatPhone = (ten: string) =>
  `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;

/**
 * Licence numbers for COMPARISON only.
 *
 * Contractors write their own licence a dozen ways — "LA-12345", "la 12345",
 * "12345". Matching raw text would miss the very duplicates this endpoint
 * exists to catch. The ORIGINAL string is what gets stored; this collapsed
 * form is only ever used to compare.
 */
export const licenseKey = (raw: string) =>
  String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface ValidatedApplication {
  fields: Record<string, string | number | boolean>;
  phoneDigits: string;
  licenseCompare: string;
}

/**
 * Validate and normalise a submission.
 *
 * Every field is checked server-side regardless of what the form does — the
 * form is not the gate, this is. Unknown fields are refused rather than
 * ignored, so a renamed input surfaces immediately instead of silently never
 * being saved.
 */
export function validateApplication(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedApplication } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const out: Record<string, string | number | boolean> = {};

  for (const key of Object.keys(body)) {
    if (key === HONEYPOT_FIELD) continue;
    if (!(key in APPLICATION_FIELDS)) {
      errors.push({ field: key, message: `unknown field '${key}'` });
    }
  }

  for (const [name, spec] of Object.entries(APPLICATION_FIELDS)) {
    const raw = body[name];
    const absent = raw === undefined || raw === null
      || (typeof raw === "string" && raw.trim() === "");

    if (absent) {
      if ((spec as { required?: boolean }).required) {
        errors.push({ field: name, message: `${name} is required` });
      }
      continue;
    }

    switch (spec.type) {
      case "true": {
        if (raw !== true) {
          errors.push({ field: name, message: "you must confirm you are authorised to apply for this business" });
        } else out[name] = true;
        break;
      }
      case "state": {
        const v = String(raw).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(v)) errors.push({ field: name, message: `${name} must be a 2-letter state code` });
        else out[name] = v;
        break;
      }
      case "zip": {
        const v = String(raw).trim();
        if (!/^\d{5}(-\d{4})?$/.test(v)) errors.push({ field: name, message: "zip must be 5 digits, or 5+4" });
        else out[name] = v;
        break;
      }
      case "email": {
        const v = String(raw).trim();
        if (v.length > (spec as { max: number }).max) errors.push({ field: name, message: `${name} is too long` });
        else if (!EMAIL_RE.test(v)) errors.push({ field: name, message: "that email address does not look right" });
        else out[name] = v;
        break;
      }
      case "phone": {
        const ten = normalizePhone(String(raw));
        if (!ten) errors.push({ field: name, message: "phone must be a 10-digit US number" });
        else out[name] = ten;
        break;
      }
      case "year": {
        const n = Number(raw);
        const thisYear = new Date().getUTCFullYear();
        if (!Number.isInteger(n) || n < 1800 || n > thisYear) {
          errors.push({ field: name, message: `year_established must be between 1800 and ${thisYear}` });
        } else out[name] = n;
        break;
      }
      case "url": {
        const v = String(raw).trim();
        if (v.length > (spec as { max: number }).max) { errors.push({ field: name, message: `${name} is too long` }); break; }
        let parsed: URL | null = null;
        try { parsed = new URL(v); } catch { parsed = null; }
        // http/https only: a javascript: or data: URL stored here would later
        // be rendered in the admin.
        if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
          errors.push({ field: name, message: `${name} must be a http(s) address` });
        } else out[name] = parsed.toString();
        break;
      }
      default: {
        const v = String(raw).trim();
        const max = (spec as { max: number }).max;
        if (v.length > max) errors.push({ field: name, message: `${name} must be ${max} characters or fewer` });
        else out[name] = v;
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fields: out,
      phoneDigits: String(out.phone),
      licenseCompare: licenseKey(String(out.license_number)),
    },
  };
}

/** How an application found its lead. Recorded in the audit reason. */
export type MatchKey = "licence" | "phone" | "new";

export const MATCH_REASON: Record<MatchKey, string> = {
  licence: "application: submitted (matched an existing lead on licence number)",
  phone: "application: submitted (matched an existing lead on phone number)",
  new: "application: submitted (no existing lead matched — new record created)",
};

/**
 * The columns an application writes on the matched or created lead.
 *
 * Note what is NOT here: no chk_* field, no verified_at, no expires_at, no
 * is_published, no slug, no plan, no call_score beyond creation. An
 * application supplies EVIDENCE TO BE CHECKED and nothing else.
 *
 * `name` is only set when creating. On a matched lead the existing name is
 * left alone — it is what the operator and the call team already know the
 * business as, and an applicant renaming a record they do not own is a way to
 * quietly take it over.
 */
export function applicationPatch(
  v: ValidatedApplication,
  nowIso: string,
): Record<string, unknown> {
  const f = v.fields;
  const patch: Record<string, unknown> = {
    vetting_status: "invited",
    applied_at: nowIso,
    legal_name: f.legal_name,
    trade: f.trade,
    license_number: f.license_number,
    license_state: f.license_state,
    contact_name: f.contact_name,
    contact_email: f.contact_email,
    phone: formatPhone(v.phoneDigits),
    phone_e164_digits: v.phoneDigits,
    address: f.address,
    city: f.city,
    state: f.state,
    zip: f.zip,
  };
  // Optional fields are written only when supplied. Sending an empty form
  // field must not blank a value an operator has already researched.
  if (f.parish !== undefined) patch.parish = f.parish;
  if (f.year_established !== undefined) patch.year_established = f.year_established;
  if (f.gl_carrier !== undefined) patch.gl_carrier = f.gl_carrier;
  if (f.website_url !== undefined) patch.website_url = f.website_url;
  if (f.google_profile_url !== undefined) patch.google_profile_url = f.google_profile_url;
  if (f.note !== undefined) patch.application_note = f.note;
  return patch;
}

/**
 * Extra columns for a record that did not exist before.
 *
 * call_score is NOT NULL with no default, so a value must be supplied. 0 is
 * correct rather than convenient: call_score ranks COLD-CALL prospects, and
 * somebody who applied is worth nothing as a cold-call target because they
 * already came to us. It also sorts them to the bottom of the call worklist,
 * which is where they belong.
 *
 * rank stays NULL — genuinely not ranked, since ranking is done by the
 * enrichment import. place_id stays NULL too, which is what makes an inbound
 * record identifiable: 15,821 of 15,822 scraped rows have one.
 */
export function newLeadColumns(v: ValidatedApplication): Record<string, unknown> {
  return {
    name: v.fields.business_name,
    call_score: 0,
    rank: null,
    place_id: null,
  };
}

/**
 * Fields that must NEVER appear in a public response.
 *
 * lib/trustlight-public.ts whitelists columns, so these are excluded by
 * construction rather than by this list — but the list exists so the harness
 * can assert it directly, and so anyone adding a public field has to walk past
 * the word "never".
 */
export const INTERNAL_ONLY_FIELDS = [
  "contact_email",
  "contact_name",
  "application_note",
  "phone",
  "phone_e164_digits",
  "license_number",
  "gl_carrier",
] as const;

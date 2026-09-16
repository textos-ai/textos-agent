// Validation and normalisation for the contractor application.
//
// These are pure functions, so they are tested here rather than over HTTP.
// That is not only tidier: POST /api/application is rate limited to 5/minute
// and 20/hour per IP, so testing a regex by firing requests at it would both
// exhaust the budget and prove less.
import { describe, it, expect } from "vitest";
import {
  APPLICATION_FIELDS, HONEYPOT_FIELD, INTERNAL_ONLY_FIELDS, MATCH_REASON,
  applicationPatch, formatPhone, licenseKey, newLeadColumns, normalizePhone,
  validateApplication,
} from "../trustlight-application";

const GOOD: Record<string, unknown> = {
  business_name: "Bayou Roofing",
  legal_name: "Bayou Roofing LLC",
  trade: "roofing",
  license_number: "LA-12345",
  license_state: "la",
  contact_name: "Dana Boudreaux",
  contact_email: "dana@example.com",
  phone: "(985) 555-0134",
  address: "12 Rue Test",
  city: "Slidell",
  state: "la",
  zip: "70458",
  authorised: true,
};

const errorsFor = (body: Record<string, unknown>) => {
  const r = validateApplication(body);
  return r.ok ? [] : r.errors.map((e) => e.field);
};

describe("normalizePhone", () => {
  it("accepts the ways people actually type a number", () => {
    for (const input of ["(985) 555-0134", "985-555-0134", "985.555.0134", "9855550134", "+1 985 555 0134", "1-985-555-0134"]) {
      expect(normalizePhone(input)).toBe("9855550134");
    }
  });
  it("rejects anything that is not ten digits", () => {
    for (const input of ["12345", "", "98555501345678", "abc"]) {
      expect(normalizePhone(input)).toBeNull();
    }
  });
  it("round-trips to the display format the table already uses", () => {
    expect(formatPhone("9855550134")).toBe("(985) 555-0134");
  });
});

describe("licenseKey", () => {
  it("collapses the spellings of one licence to a single key", () => {
    const same = ["LA-12345", "la 12345", "LA12345", " la-12345 ", "l.a.12345"];
    const keys = new Set(same.map(licenseKey));
    expect(keys.size).toBe(1);
  });
  it("does not collapse genuinely different licences", () => {
    expect(licenseKey("LA-12345")).not.toBe(licenseKey("LA-12346"));
  });
});

describe("validateApplication", () => {
  it("accepts a complete application", () => {
    const r = validateApplication({ ...GOOD });
    expect(r.ok).toBe(true);
  });

  it("requires every required field, and names each one", () => {
    const missing = errorsFor({ business_name: "x" });
    for (const f of ["legal_name", "trade", "license_number", "license_state",
      "contact_name", "contact_email", "phone", "address", "city", "state", "zip", "authorised"]) {
      expect(missing).toContain(f);
    }
  });

  it("treats whitespace as absent", () => {
    expect(errorsFor({ ...GOOD, contact_name: "   " })).toContain("contact_name");
  });

  it("refuses an unknown field rather than dropping it", () => {
    // A renamed form input must surface, not silently never save.
    expect(errorsFor({ ...GOOD, sneaky: "x" })).toContain("sneaky");
  });

  it("refuses fields that would make the applicant verify themselves", () => {
    // The whole point: no chk_*, no is_published, no verified_at is accepted.
    for (const f of ["chk_license", "is_published", "verified_at", "vetting_status", "call_score", "slug"]) {
      expect(errorsFor({ ...GOOD, [f]: "pass" })).toContain(f);
    }
  });

  it("ignores the honeypot instead of calling it unknown", () => {
    // The route answers a filled honeypot with a normal 202; it must not turn
    // into a validation error that tells a bot what tripped it.
    expect(validateApplication({ ...GOOD, [HONEYPOT_FIELD]: "" }).ok).toBe(true);
    expect(errorsFor({ ...GOOD, [HONEYPOT_FIELD]: "anything" })).not.toContain(HONEYPOT_FIELD);
  });

  it("validates email shape", () => {
    for (const bad of ["nope", "a@b", "a b@example.com", "@example.com"]) {
      expect(errorsFor({ ...GOOD, contact_email: bad })).toContain("contact_email");
    }
  });

  it("validates state and zip", () => {
    expect(errorsFor({ ...GOOD, state: "LOUISIANA" })).toContain("state");
    expect(errorsFor({ ...GOOD, license_state: "1" })).toContain("license_state");
    expect(errorsFor({ ...GOOD, zip: "abcde" })).toContain("zip");
    const r = validateApplication({ ...GOOD, zip: "70458-1234" });
    expect(r.ok).toBe(true);
  });

  it("upper-cases state codes so matching is not defeated by capitalisation", () => {
    const r = validateApplication({ ...GOOD });
    if (!r.ok) throw new Error("expected valid");
    expect(r.value.fields.state).toBe("LA");
    expect(r.value.fields.license_state).toBe("LA");
  });

  it("requires the authorisation checkbox to be true, not merely present", () => {
    expect(errorsFor({ ...GOOD, authorised: false })).toContain("authorised");
    expect(errorsFor({ ...GOOD, authorised: "yes" })).toContain("authorised");
  });

  it("bounds year_established to something a business could have", () => {
    expect(errorsFor({ ...GOOD, year_established: 1500 })).toContain("year_established");
    expect(errorsFor({ ...GOOD, year_established: new Date().getUTCFullYear() + 1 })).toContain("year_established");
    expect(validateApplication({ ...GOOD, year_established: 2009 }).ok).toBe(true);
  });

  it("refuses a URL scheme that could execute when rendered in the admin", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
      expect(errorsFor({ ...GOOD, website_url: bad })).toContain("website_url");
    }
    expect(validateApplication({ ...GOOD, website_url: "https://example.com" }).ok).toBe(true);
  });

  it("enforces max lengths", () => {
    expect(errorsFor({ ...GOOD, note: "x".repeat(2001) })).toContain("note");
    expect(errorsFor({ ...GOOD, business_name: "x".repeat(201) })).toContain("business_name");
    expect(validateApplication({ ...GOOD, note: "x".repeat(2000) }).ok).toBe(true);
  });

  it("reports every problem at once, not one at a time", () => {
    const r = validateApplication({ ...GOOD, contact_email: "nope", zip: "x", state: "LONG" });
    if (r.ok) throw new Error("expected failure");
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("applicationPatch", () => {
  const valid = () => {
    const r = validateApplication({ ...GOOD, parish: "st_tammany", note: "hello" });
    if (!r.ok) throw new Error("fixture invalid");
    return r.value;
  };

  it("writes nothing that could verify or publish the applicant", () => {
    const patch = applicationPatch(valid(), "2026-09-16T00:00:00.000Z");
    const forbidden = ["verified_at", "expires_at", "is_published", "slug", "plan",
      "reverify_due", "verified_year", "call_score", "rank"];
    for (const k of forbidden) expect(patch).not.toHaveProperty(k);
    for (const k of Object.keys(patch)) expect(k.startsWith("chk_")).toBe(false);
  });

  it("sets vetting_status to invited and stamps applied_at", () => {
    const patch = applicationPatch(valid(), "2026-09-16T00:00:00.000Z");
    expect(patch.vetting_status).toBe("invited");
    expect(patch.applied_at).toBe("2026-09-16T00:00:00.000Z");
  });

  it("never sets name — an applicant cannot rename a record they do not own", () => {
    const patch = applicationPatch(valid(), "2026-09-16T00:00:00.000Z");
    expect(patch).not.toHaveProperty("name");
    // It IS set when creating, which is the only time there is no name to protect.
    expect(newLeadColumns(valid()).name).toBe("Bayou Roofing");
  });

  it("stores phone in both the display and the match format", () => {
    const patch = applicationPatch(valid(), "2026-09-16T00:00:00.000Z");
    expect(patch.phone).toBe("(985) 555-0134");
    expect(patch.phone_e164_digits).toBe("9855550134");
  });

  it("omits optional fields that were not supplied, rather than blanking them", () => {
    const r = validateApplication({ ...GOOD });
    if (!r.ok) throw new Error("fixture invalid");
    const patch = applicationPatch(r.value, "2026-09-16T00:00:00.000Z");
    // An operator may already have researched these; an empty form field must
    // not erase their work.
    for (const k of ["parish", "year_established", "gl_carrier", "website_url",
      "google_profile_url", "application_note"]) {
      expect(patch).not.toHaveProperty(k);
    }
  });

  it("stores the free-text note under application_note", () => {
    const patch = applicationPatch(valid(), "2026-09-16T00:00:00.000Z");
    expect(patch.application_note).toBe("hello");
    expect(patch).not.toHaveProperty("note");
  });
});

describe("newLeadColumns", () => {
  it("satisfies call_score NOT NULL without pretending to have scored them", () => {
    const r = validateApplication({ ...GOOD });
    if (!r.ok) throw new Error("fixture invalid");
    const cols = newLeadColumns(r.value);
    expect(cols.call_score).toBe(0);
    // Not ranked, and no place_id — which is what marks a record as inbound
    // rather than scraped.
    expect(cols.rank).toBeNull();
    expect(cols.place_id).toBeNull();
  });
});

describe("the contract the rest of the system relies on", () => {
  it("names which key matched in every audit reason", () => {
    expect(MATCH_REASON.licence).toMatch(/licence/i);
    expect(MATCH_REASON.phone).toMatch(/phone/i);
    expect(MATCH_REASON.new).toMatch(/new record/i);
    for (const r of Object.values(MATCH_REASON)) expect(r.startsWith("application: submitted")).toBe(true);
  });

  it("keeps contact_email and contact_name on the internal-only list", () => {
    expect(INTERNAL_ONLY_FIELDS).toContain("contact_email");
    expect(INTERNAL_ONLY_FIELDS).toContain("contact_name");
    expect(INTERNAL_ONLY_FIELDS).toContain("application_note");
  });

  it("collects no field the brief ruled out", () => {
    const collected = Object.keys(APPLICATION_FIELDS);
    for (const f of ["policy_number", "insurance_policy", "price", "plan",
      "rating", "review_count", "dti_score", "upload", "attachment"]) {
      expect(collected).not.toContain(f);
    }
  });
});

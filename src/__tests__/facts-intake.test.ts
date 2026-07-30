// The Business Facts intake schema must accept every profile column the form
// sends. A field present in the UI but absent from the Zod schema is stripped
// silently on save: the operator types a value, the request succeeds, and the
// column stays null with nothing reported. That is exactly how trade_noun was
// lost — the UI shipped, the schema patch silently no-oped, and only a database
// probe caught it.
import { describe, it, expect } from "vitest";
import { FactsSchema } from "../routes/business-facts";

// Mirrors PROFILE_FIELDS in textos-web/src/pages/business/facts.astro.
const FORM_PROFILE_FIELDS = [
  "legal_name", "alternate_name", "description", "phone", "email",
  "street_address", "locality", "region", "postal_code", "country",
  "geo_lat", "geo_lng", "license_number", "license_authority",
  "trade_noun", "trade_noun_plural",
  "google_place_id", "google_business_url", "facebook_url", "instagram_url",
  "analytics_id",
];

describe("facts intake accepts what the form sends", () => {
  it("keeps every profile field the UI posts", () => {
    const profile: Record<string, unknown> = {};
    for (const f of FORM_PROFILE_FIELDS) {
      profile[f] = f === "geo_lat" ? 29.9 : f === "geo_lng" ? -89.9
        : f === "country" ? "US" : `v-${f}`;
    }
    const parsed = FactsSchema.parse({
      profile, hours: [], services: [], areas: [], faqs: [], projects: [], differentiators: [],
    });
    for (const f of FORM_PROFILE_FIELDS) {
      expect(parsed.profile, `${f} was stripped by the schema`)
        .toHaveProperty(f);
    }
  });

  it("round-trips the trade noun specifically", () => {
    const parsed = FactsSchema.parse({
      profile: { trade_noun: "electrician", trade_noun_plural: "electricians" },
      hours: [], services: [], areas: [], faqs: [], projects: [], differentiators: [],
    });
    expect(parsed.profile.trade_noun).toBe("electrician");
    expect(parsed.profile.trade_noun_plural).toBe("electricians");
  });
});

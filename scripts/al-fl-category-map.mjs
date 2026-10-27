// AL/FL import (wave al-fl-2026-10): category slug -> stored category.
//
// Imported by BOTH the importer profile and the pre-load report, so the table
// Rob approved and the values actually written cannot drift apart.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// Keyed on the file's (category, category_raw) PAIR, not the slug alone, for
// one reason: two slugs in this export carry two different raws each.
//   hvac     -> "HVAC contractor"   AND "air conditioning repair"
//   flooring -> "flooring contractor" AND "tile contractor"
// Mapping by slug alone would collapse tile contractors into flooring and lose
// 97 rows of a real distinction the source took the trouble to record.
//
// Where category_raw already matches a stored category exactly (lowercased),
// that value wins — per the brief, and because it is the vocabulary the hero
// map, the demo pipeline and the public directory all key on.
//
// `trade: true` means the value is in HOME_TRADE_CATEGORIES and therefore gets
// a slug, a Places lookup, an enrichment probe, a DTI score and a public
// listing. `trade: false` means a non-trade: hero folder 'generic', no slug,
// no Places, no TrustLight — exactly how the 11,674 existing Louisiana
// non-trades are already handled (verified before writing this).

/** @type {Record<string, {to: string, trade: boolean, note?: string}>} */
export const PAIR_MAP = {
  // ── already-stored vocabulary, raw matches exactly ──
  "restaurant\u0000restaurant": { to: "restaurant", trade: false },
  "dentist\u0000dentist": { to: "dentist", trade: false },
  "doctor\u0000doctor": { to: "doctor", trade: false },
  "cafe\u0000cafe": { to: "cafe", trade: false },
  "bakery\u0000bakery": { to: "bakery", trade: false },
  "laundry\u0000laundry": { to: "laundry", trade: false },
  "gym\u0000gym": { to: "gym", trade: false },
  "bar\u0000bar": { to: "bar", trade: false },
  "spa\u0000spa": { to: "spa", trade: false },
  "florist\u0000florist": { to: "florist", trade: false },
  "electrician\u0000electrician": { to: "electrician", trade: true },
  "plumber\u0000plumber": { to: "plumber", trade: true },
  "painter\u0000painter": { to: "painter", trade: true },
  "locksmith\u0000locksmith": { to: "locksmith", trade: true },
  "handyman\u0000handyman": { to: "handyman", trade: true },
  "hvac\u0000HVAC contractor": { to: "hvac contractor", trade: true },
  "windows\u0000window installation": { to: "window installation", trade: true },
  "flooring\u0000flooring contractor": { to: "flooring contractor", trade: true },
  "concrete\u0000concrete contractor": { to: "concrete contractor", trade: true },
  "pool-service\u0000pool service": { to: "pool service", trade: true },
  "septic\u0000septic service": { to: "septic service", trade: true },
  "insulation\u0000insulation contractor": { to: "insulation contractor", trade: true },
  "drywall\u0000drywall contractor": { to: "drywall contractor", trade: true },
  "pressure-washer\u0000pressure washing": { to: "pressure washing", trade: true },
  "garage-door\u0000garage door repair": { to: "garage door repair", trade: true },
  "foundation-repair\u0000foundation repair": { to: "foundation repair", trade: true },
  // The brief's worked example: raw is already the stored value, and it is a
  // DIFFERENT trade from the flooring rows that share its slug.
  "flooring\u0000tile contractor": { to: "tile contractor", trade: true },

  // ── Google type names -> the stored human vocabulary ──
  "auto-repair\u0000car_repair": { to: "auto repair", trade: false },
  "real-estate\u0000real_estate_agency": { to: "real estate agency", trade: false },
  "insurance\u0000insurance_agency": { to: "insurance agency", trade: false },
  "hair-salon\u0000hair_salon": { to: "hair salon", trade: false },
  "accounting\u0000accounting": { to: "accountant", trade: false },
  "beauty-salon\u0000beauty_salon": { to: "beauty salon", trade: false },
  "event-venue\u0000event_venue": { to: "event venue", trade: false },
  "barber\u0000barber_shop": { to: "barber shop", trade: false },
  "physio\u0000physiotherapist": { to: "physical therapy", trade: false },
  "catering\u0000catering_service": { to: "catering service", trade: false },
  "car-wash\u0000car_wash": { to: "car wash", trade: false },
  "nail-salon\u0000nail_salon": { to: "nail salon", trade: false },
  "pet-store\u0000pet_store": { to: "pet store", trade: false },
  "yoga\u0000yoga_studio": { to: "yoga studio", trade: false },
  "mover\u0000moving_company": { to: "moving company", trade: true },
  "roofing\u0000roofing_contractor": { to: "roofing contractor", trade: true },
  // slug is in the vocabulary, raw ("lawn care") is not.
  "landscaper\u0000lawn care": { to: "landscaper", trade: true },

  // ── the three Gulf aliases, same decisions as wave gulf-coast-2026-10 ──
  "gutters\u0000gutter installation": { to: "gutter service", trade: true },
  "fence\u0000fencing contractor": { to: "fence contractor", trade: true },
  "hvac\u0000air conditioning repair": { to: "hvac contractor", trade: true },

  // ── NEW home trades (migration 137 adds the hero_map rows) ──
  "solar\u0000solar panel installation": { to: "solar panel installation", trade: true },
  "hurricane-shutters\u0000hurricane shutters": { to: "hurricane shutters", trade: true },
  "screen-enclosure\u0000screen enclosure": { to: "screen enclosure", trade: true },
  // Rob's brief said "irrigation"; the file's human name is "irrigation
  // system". Using the file's name, consistent with every other row in this
  // table, where category_raw is the stored value.
  "irrigation\u0000irrigation system": { to: "irrigation system", trade: true },

  // ── NEW non-trades (migration 137 adds hero_map -> generic) ──
  "food-truck\u0000food truck": { to: "food truck", trade: false },
  "auto-detailing\u0000auto detailing": { to: "auto detailing", trade: false },
  // slug says "photography", raw says "wedding photographer". The raw is the
  // narrower, truer description of what the source actually searched for.
  "photography\u0000wedding photographer": { to: "wedding photographer", trade: false },
};

export const pairKey = (category, categoryRaw) =>
  `${String(category ?? "").trim()}\u0000${String(categoryRaw ?? "").trim()}`;

/** Home trades this import introduces, with the hero folder from the brief. */
export const NEW_TRADES = {
  "solar panel installation": "electrician",
  "irrigation system": "landscaper",
  "hurricane shutters": "general-contractor",
  "screen enclosure": "general-contractor",
};

/** Non-trades this import introduces. All 'generic', per the convention. */
export const NEW_NON_TRADES = {
  "food truck": "generic",
  "auto detailing": "generic",
  "wedding photographer": "generic",
};

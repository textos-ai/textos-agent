const DTI_CONFIG_KEYS = {
  findable: "dti_weight_findable",
  reachable: "dti_weight_reachable",
  credible: "dti_weight_credible",
  minSignals: "dti_min_signals"
};
const DTI_SEED_WEIGHTS = {
  [DTI_CONFIG_KEYS.findable]: 40,
  [DTI_CONFIG_KEYS.reachable]: 35,
  [DTI_CONFIG_KEYS.credible]: 25,
  // One group is enough to score. Two of three would leave a business with a
  // live site but nothing else unscored, and "unscored" is what we are trying
  // to get rid of.
  [DTI_CONFIG_KEYS.minSignals]: 1
};
const DTI_DOMAIN_MATURE_DAYS = 1095;
const NOT_A_WEBSITE = [
  // Social profiles
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "nextdoor.com",
  "threads.net",
  // Directory listings
  "yelp.com",
  "angi.com",
  "angieslist.com",
  "homeadvisor.com",
  "thumbtack.com",
  "bbb.org",
  "houzz.com",
  "porch.com",
  "manta.com",
  "yellowpages.com",
  "superpages.com",
  "foursquare.com",
  "alignable.com",
  "buildzoom.com",
  "networx.com",
  "expertise.com",
  "chamberofcommerce.com",
  "mapquest.com",
  // Link aggregators and shorteners
  "linktr.ee",
  "linkin.bio",
  "beacons.ai",
  "bit.ly",
  "tinyurl.com",
  "campsite.bio",
  "carrd.co"
];
function hostOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}
function weightOf(weights, key) {
  const v = weights[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`dti: missing or invalid weight '${key}' in coldcall_config`);
  }
  return v;
}
function scoreDti(row, weights) {
  const empty = (reason) => ({ score: null, reason, signals: [], counted: 0, weightAvailable: 0 });
  if (row.enrichment_status === "no_website_found") {
    return {
      score: 0,
      reason: null,
      signals: [],
      counted: 0,
      weightAvailable: 0,
      zeroReason: "no_website"
    };
  }
  const host = hostOf(row.website_url ?? row.domain ?? null);
  if (host && NOT_A_WEBSITE.some((d) => host === d || host.endsWith("." + d))) {
    return {
      score: 0,
      reason: null,
      signals: [],
      counted: 0,
      weightAvailable: 0,
      zeroReason: "social_only",
      zeroDetail: host
    };
  }
  if (row.enrichment_status !== "fully_enriched") {
    return empty(`not scored: enrichment_status is '${row.enrichment_status ?? "null"}'`);
  }
  const bool = (v) => v === true ? 1 : v === false ? 0 : null;
  const tooling = [row.chat_widget, row.booking_tool, row.call_tracking];
  const toolingKnown = tooling.some((t) => t === true || t === false);
  const toolingValue = toolingKnown ? tooling.some((t) => t === true) ? 1 : 0 : null;
  const toolingNames = [
    row.chat_widget === true ? "chat" : null,
    row.booking_tool === true ? "booking" : null,
    row.call_tracking === true ? "call tracking" : null
  ].filter(Boolean);
  const sub = (label, parts) => {
    const known = parts.filter((p) => p.value !== null);
    if (!known.length) return { value: null, detail: "not checked", parts };
    const got = known.filter((p) => p.value > 0).map((p) => p.name);
    const missing = known.filter((p) => p.value === 0).map((p) => p.name);
    return {
      value: known.reduce((a, p) => a + p.value, 0) / known.length,
      detail: missing.length ? `missing: ${missing.join(", ")}` : `all present: ${got.join(", ")}`,
      parts
    };
  };
  const findable = sub("Findable", [
    { name: "live website", value: row.site_state == null ? null : row.site_state === "alive" ? 1 : 0 },
    { name: "HTTPS", value: bool(row.has_https) },
    { name: "mobile-ready", value: bool(row.has_viewport) },
    { name: "structured data", value: bool(row.has_schema_org) }
  ]);
  const reachable = sub("Reachable", [
    { name: "phone on the page", value: bool(row.phone_listed) },
    // Any ONE contact tool counts. A business reachable by chat is reachable,
    // and three separate weights would count the same quality three times.
    { name: "booking, chat or call handling", value: toolingValue },
    { name: "business hours", value: bool(row.has_business_hours) }
  ]);
  const credible = sub("Credible", [
    { name: "reviews linked", value: bool(row.reviews_linked) },
    {
      name: "multiple service areas",
      value: typeof row.service_area_count === "number" ? row.service_area_count >= 3 ? 1 : 0 : null
    },
    { name: "FAQ or blog", value: bool(row.has_faq_or_blog) }
  ]);
  const signals = [
    {
      key: "findable",
      label: "Findable",
      weight: weightOf(weights, DTI_CONFIG_KEYS.findable),
      value: findable.value,
      detail: findable.detail,
      parts: findable.parts
    },
    {
      key: "reachable",
      label: "Reachable",
      weight: weightOf(weights, DTI_CONFIG_KEYS.reachable),
      value: reachable.value,
      detail: reachable.detail,
      parts: reachable.parts
    },
    {
      key: "credible",
      label: "Credible",
      weight: weightOf(weights, DTI_CONFIG_KEYS.credible),
      value: credible.value,
      detail: credible.detail,
      parts: credible.parts
    }
  ];
  const scored = signals.filter((s) => s.weight > 0);
  const counted = scored.filter((s) => s.value !== null);
  const minSignals = weightOf(weights, DTI_CONFIG_KEYS.minSignals);
  if (counted.length < minSignals) {
    return {
      score: null,
      reason: `not scored: ${counted.length} signal(s) checked, minimum is ${minSignals}`,
      signals: scored,
      counted: counted.length,
      weightAvailable: 0
    };
  }
  const weightAvailable = counted.reduce((a, s) => a + s.weight, 0);
  if (weightAvailable <= 0) {
    return { score: null, reason: "not scored: no weight available", signals: scored, counted: counted.length, weightAvailable: 0 };
  }
  const earned = counted.reduce((a, s) => a + s.weight * s.value, 0);
  const score = Math.round(earned / weightAvailable * 100);
  if (score === 0) {
    const dead = row.site_state === "dead_http_error" || row.site_state === "parked_or_lead_gen";
    return {
      score,
      reason: null,
      signals: scored,
      counted: counted.length,
      weightAvailable,
      zeroReason: dead ? "site_unreachable" : "nothing_readable"
    };
  }
  return { score, reason: null, signals: scored, counted: counted.length, weightAvailable };
}
export {
  DTI_CONFIG_KEYS,
  DTI_DOMAIN_MATURE_DAYS,
  DTI_SEED_WEIGHTS,
  NOT_A_WEBSITE,
  scoreDti
};

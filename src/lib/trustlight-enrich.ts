// =============================================================
// TrustLight — on-demand site enrichment.
//
// A port of the LeadScout digital-footprint probe into the Worker, so a
// record can be enriched the moment it is verified instead of waiting for a
// batch that may never run again. It writes the same columns migration 116
// defined and obeys the same rules.
//
// ── THE BLANK-vs-FALSE RULE ─────────────────────────────────────────────────
// Every boolean this file produces is `boolean | null`, and NULL means WE DID
// NOT LOOK. It is never a stand-in for "absent".
//
//   null  — no site to probe, robots.txt said no, or the fetch failed
//   false — we loaded the page and the thing genuinely is not there
//   true  — we loaded the page and it is there
//
// A probe that fails must therefore write NULL to every signal, not false.
// Writing false would claim we checked, and the score would then punish a
// business for our own timeout. This is the single most important behaviour
// in this file.
//
// ── ROBOTS.TXT ──────────────────────────────────────────────────────────────
// Honoured by default. It can be overridden per record by an operator, but
// the caller has to pass that in explicitly and say why — see the route.
// =============================================================

/** Identifies us honestly. A probe that hides what it is has no business
 *  claiming to measure trust. */
export const ENRICH_UA =
  "TrustLightBot/1.0 (+https://trustlight.com/methodology; verification probe)";

const FETCH_TIMEOUT_MS = 10000;
/** Enough to see head, structured data and the widget snippets sites put in
 *  the footer. Far short of downloading whole media-heavy pages. */
const MAX_HTML_BYTES = 600_000;

export type EnrichStatus =
  | "fully_enriched" | "no_website_found" | "skipped_robots_txt"
  | "probe_failed" | "not_enriched";

export type EnrichResult = {
  enrichment_status: EnrichStatus;
  enriched_at: string;
  site_state: "alive" | "dead_http_error" | "parked_or_lead_gen" | "unknown" | "not_probed" | null;
  site_http_status: number | null;
  has_website: boolean | null;
  has_schema_org: boolean | null;
  analytics_pixels: boolean | null;
  chat_widget: boolean | null;
  booking_tool: boolean | null;
  call_tracking: boolean | null;
  ai_voice_agent: boolean | null;
  analytics_pixels_detail: string | null;
  chat_widget_detail: string | null;
  booking_tool_detail: string | null;
  call_tracking_detail: string | null;
  ai_voice_agent_detail: string | null;
  platform: string | null;
  domain: string | null;
  domain_age_days: number | null;
  domain_registered_on: string | null;
  domain_registrar: string | null;
  signal_confidence: string | null;
  // The seven signals. NULL on every failure path, like everything else here.
  has_https: boolean | null;
  has_viewport: boolean | null;
  phone_listed: boolean | null;
  has_business_hours: boolean | null;
  reviews_linked: boolean | null;
  has_faq_or_blog: boolean | null;
  service_area_count: number | null;
  service_areas: string[] | null;
  /** Operator-facing explanation. Not a column; returned to the caller. */
  note: string;
};

/**
 * Vendor patterns.
 *
 * Deliberately conservative: a false positive here becomes a published score,
 * so each pattern matches a script host or an unmistakable global rather than
 * a word that might appear in prose. `detail` records WHICH vendor, because
 * the boolean alone throws away the useful half of the answer.
 */
const DETECTORS: Array<{ group: keyof typeof GROUPS; name: string; re: RegExp }> = [
  // Chat
  { group: "chat", name: "Intercom", re: /widget\.intercom\.io|intercomSettings/i },
  { group: "chat", name: "Drift", re: /js\.driftt\.com|drift\.com\/include/i },
  { group: "chat", name: "Tawk.to", re: /embed\.tawk\.to/i },
  { group: "chat", name: "Crisp", re: /client\.crisp\.chat/i },
  { group: "chat", name: "LiveChat", re: /cdn\.livechatinc\.com/i },
  { group: "chat", name: "Tidio", re: /code\.tidio\.co/i },
  { group: "chat", name: "HubSpot Chat", re: /js\.hs-scripts\.com|js\.usemessages\.com/i },
  { group: "chat", name: "Podium", re: /connect\.podium\.com/i },
  { group: "chat", name: "GoHighLevel", re: /widgets\.leadconnectorhq\.com|msgsndr\.com/i },
  { group: "chat", name: "Facebook Messenger", re: /connect\.facebook\.net\/[^"']*customerchat/i },

  // Booking
  { group: "booking", name: "Calendly", re: /assets\.calendly\.com|calendly\.com\/[a-z0-9-]+/i },
  { group: "booking", name: "Housecall Pro", re: /housecallpro\.com\/book|hcpapi\.io/i },
  { group: "booking", name: "ServiceTitan", re: /servicetitan\.com\/scheduler|st-scheduler/i },
  { group: "booking", name: "Jobber", re: /getjobber\.com\/booking|clienthub\.getjobber\.com/i },
  { group: "booking", name: "Acuity", re: /acuityscheduling\.com/i },
  { group: "booking", name: "Square Appointments", re: /squareup\.com\/appointments/i },

  // Call tracking
  { group: "call", name: "CallRail", re: /cdn\.callrail\.com|callrail\.com\/companies/i },
  { group: "call", name: "CallTrackingMetrics", re: /tctm\.co|calltrackingmetrics\.com/i },
  { group: "call", name: "Invoca", re: /solutions\.invocacdn\.com/i },
  { group: "call", name: "WhatConverts", re: /whatconverts\.com\/track/i },

  // Analytics
  { group: "analytics", name: "GA4", re: /googletagmanager\.com\/gtag\/js|gtag\('config'/i },
  { group: "analytics", name: "GTM", re: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/ },
  { group: "analytics", name: "Meta Pixel", re: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\('init'/i },
  { group: "analytics", name: "Hotjar", re: /static\.hotjar\.com/i },
  { group: "analytics", name: "Clarity", re: /clarity\.ms\/tag/i },
  { group: "analytics", name: "Plausible", re: /plausible\.io\/js/i },

  // AI voice. Kept because the column exists, not because anything has ever
  // matched: 0 of 509 enriched businesses had one.
  { group: "voice", name: "Bland", re: /bland\.ai/i },
  { group: "voice", name: "Vapi", re: /vapi\.ai/i },
  { group: "voice", name: "Retell", re: /retellai\.com/i },
  { group: "voice", name: "Air.ai", re: /air\.ai\/embed/i },
];

const GROUPS = { chat: 1, booking: 1, call: 1, analytics: 1, voice: 1 } as const;

/** Site builder / CMS, for the `platform` column. */
const PLATFORMS: Array<[string, RegExp]> = [
  ["WordPress", /wp-content\/|wp-includes\/|wordpress/i],
  ["Wix", /static\.parastorage\.com|wixstatic\.com/i],
  ["Squarespace", /squarespace\.com|static1\.squarespace/i],
  ["Shopify", /cdn\.shopify\.com/i],
  ["Webflow", /assets-global\.website-files\.com|webflow\.io/i],
  ["GoDaddy", /img1\.wsimg\.com|godaddysites/i],
  ["Duda", /d1\.awsstatic-cdn|dudaone|multiscreensite\.com/i],
  ["GoHighLevel", /leadconnectorhq|msgsndr/i],
];

/** Parked / lead-gen holding pages, which are NOT a working website. */
const PARKED = /domain (is )?for sale|parked (free )?courtesy|buy this domain|godaddy\.com\/domainsearch|sedoparking|this domain is available/i;

function withTimeout(ms: number) {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? (AbortSignal as unknown as { timeout(n: number): AbortSignal }).timeout(ms)
    : undefined;
}

async function get(url: string, accept: string) {
  return fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": ENRICH_UA, Accept: accept },
    signal: withTimeout(FETCH_TIMEOUT_MS),
  });
}

/** Normalise whatever is in website_url into something fetchable. */
export function siteUrlOf(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch { return null; }
}

export function domainOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return null; }
}

/**
 * Does robots.txt forbid us?
 *
 * Conservative in BOTH directions. An unreachable or unparseable robots.txt
 * is treated as "allowed", because a site that does not publish one has not
 * asked us to stay away; but an explicit `Disallow: /` under `*` or our own
 * agent is honoured. Only root-level blanket disallows count - we fetch one
 * page, so a rule about /admin is irrelevant.
 */
export async function robotsForbids(siteUrl: string): Promise<boolean> {
  try {
    const u = new URL(siteUrl);
    const res = await get(`${u.origin}/robots.txt`, "text/plain");
    if (!res.ok) return false;
    const txt = (await res.text()).slice(0, 50_000);
    let applies = false;
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = line.match(/^(user-agent|disallow)\s*:\s*(.*)$/i);
      if (!m) continue;
      const [, key, val] = m;
      if (/^user-agent$/i.test(key)) {
        applies = val.trim() === "*" || /trustlight/i.test(val);
      } else if (applies && /^disallow$/i.test(key)) {
        if (val.trim() === "/") return true;
      }
    }
    return false;
  } catch {
    // A robots.txt we cannot reach is not a refusal.
    return false;
  }
}

/** Domain age via RDAP over HTTPS. rdap.org bootstraps to the right registry. */
export async function domainAge(domain: string): Promise<{
  registered_on: string | null; age_days: number | null; registrar: string | null;
}> {
  const none = { registered_on: null, age_days: null, registrar: null };
  try {
    const res = await get(`https://rdap.org/domain/${encodeURIComponent(domain)}`, "application/rdap+json");
    if (!res.ok) return none;
    const j = await res.json() as {
      events?: Array<{ eventAction?: string; eventDate?: string }>;
      entities?: Array<{ roles?: string[]; vcardArray?: unknown }>;
    };
    const ev = (j.events ?? []).find((e) => /registration/i.test(e.eventAction ?? ""));
    if (!ev?.eventDate) return none;
    const when = new Date(ev.eventDate);
    if (isNaN(when.getTime())) return none;
    const ageDays = Math.floor((Date.now() - when.getTime()) / 86400000);
    let registrar: string | null = null;
    for (const ent of j.entities ?? []) {
      if (!(ent.roles ?? []).includes("registrar")) continue;
      const vc = ent.vcardArray as unknown[];
      const props = Array.isArray(vc) && Array.isArray(vc[1]) ? vc[1] as unknown[][] : [];
      for (const p of props) if (p[0] === "fn" && typeof p[3] === "string") registrar = p[3];
    }
    return { registered_on: when.toISOString(), age_days: ageDays, registrar };
  } catch { return none; }
}

/** Structured data: JSON-LD, microdata or RDFa. */
function hasSchemaOrg(html: string): boolean {
  return /application\/ld\+json/i.test(html)
    || /itemtype\s*=\s*["']https?:\/\/schema\.org/i.test(html)
    || /vocab\s*=\s*["']https?:\/\/schema\.org/i.test(html);
}

function detect(html: string) {
  const hits: Record<string, string[]> = { chat: [], booking: [], call: [], analytics: [], voice: [] };
  for (const d of DETECTORS) if (d.re.test(html)) hits[d.group].push(d.name);
  return hits;
}


// ── THE SEVEN SIGNALS ───────────────────────────────────────────────────────
// Added 2026-09-17 after measuring thirteen candidates against 36 real
// contractor homepages. Six were rejected and the reasons are in migration
// 135; the short version is that a signal we detect wrongly is worse than one
// we do not measure, because the score has to survive a contractor disputing
// it.

/**
 * Cities we have actually seen, from coldcall_leads.city.
 *
 * This is the whole defence of the service-area detector. Without it, reading
 * capitalised words after a "Service Areas" heading harvested "Fascia",
 * "Soffit", "Please", "Links", a form label and, on one site, the owner's
 * name. A bare token only counts as a service area if it is a city we hold
 * independently.
 *
 * Known limit, stated rather than hidden: it only recognises cities in our
 * coverage area, so a contractor listing a town we have never scraped is
 * under-counted. That is the safe direction — we never invent a service area
 * a business does not claim.
 */
const CITY_GAZETTEER = new Set([
  "abita springs", "ama", "amite city", "angie", "arabi", "avondale",
  "bay st louis", "belle chasse", "bogalusa", "bourg", "boutte",
  "bridge city", "buras", "bush", "carriere", "chalmette", "chauvin",
  "convent", "covington", "cut off", "des allemands", "destrehan",
  "diamondhead", "dulac", "edgard", "elmwood", "estelle", "folsom",
  "franklinton", "galliano", "garyville", "golden meadow", "gramercy",
  "gray", "gretna", "hahnville", "hammond", "harahan", "harvey", "hester",
  "houma", "independence", "jefferson", "kenner", "kentwood", "kiln",
  "lacombe", "lafitte", "laplace", "larose", "lockport", "loranger",
  "luling", "lutcher", "madisonville", "mandeville", "marrero", "mathews",
  "meraux", "metairie", "montegut", "montz", "mt hermon", "new orleans",
  "new sarpy", "norco", "paradis", "paulina", "pearl river", "pearlington",
  "picayune", "ponchatoula", "poplarville", "port sulphur", "raceland",
  "reserve", "river ridge", "robert", "roseland", "schriever", "slidell",
  "st bernard", "st rose", "terrytown", "theriot", "thibodaux", "tickfaw",
  "vacherie", "venice", "violet", "waveland", "westwego",
]);

const US_STATES_RE = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";

/** A token before a city name meaning we are reading a STREET ADDRESS. Every
 *  site has one, and counting it would credit a business for having premises. */
const STREET_TOKENS = new Set(["street","st","avenue","ave","road","rd","drive","dr","lane","ln",
  "boulevard","blvd","highway","hwy","way","court","ct","place","pl","circle","cir","parkway","pkwy",
  "suite","ste","unit","apt","floor","fl","box","route","rt","terrace","ter","trail","trl","loop"]);

// "new" is NOT here, deliberately. It is a legitimate first word — New Orleans
// is the commonest city in this table at 1,661 records — and listing it caused
// the trim to render "New Orleans" as "Orleans, LA" in the stored evidence.
// The evidence is what a contractor gets shown when they dispute the signal,
// so it has to be the name they actually wrote.
const NOT_A_CITY = new Set(["the","and","in","near","serving","greater","all","we","our","your",
  "contact","call","email","home","about","services","service","areas","area","copyright","rights",
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday","january","february","march",
  "april","may","june","july","august","september","october","november","december"]);

/** Strip script, style and tags so prose matching is not fooled by JS string
 *  literals — the biggest source of false positives in text detection. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * Distinct service-area cities named on the page.
 *
 * HAND-VALIDATED on 36 real contractor sites: 16 detected, 16 correct on
 * reading the page — 100% precision. It misses 3 (two list cities with no
 * heading; one serves parishes, not cities), so recall is about 84%. It
 * under-counts and never invents, which is the direction that survives an
 * argument.
 *
 * Two strategies, because sites use both:
 *   1. "City, ST" anywhere, minus street addresses.
 *   2. A bare city list under a service-area heading, filtered by the
 *      gazetteer. Craig's Electrical lists SIXTEEN cities with no state on
 *      any of them; strategy 1 alone saw two.
 */
export function serviceAreas(html: string): string[] {
  const text = visibleText(html);
  const cities = new Map<string, string>();

  // BACKSLASHES ARE DOUBLED ON PURPOSE. This is a template literal, so `\s`
  // would be eaten by the string parser as an escape and `\b` would become an
  // actual backspace character before RegExp ever saw it. The first version of
  // this line used single backslashes and matched nothing at all.
  const re = new RegExp(
    `(\\S+)?\\s*\\b([A-Z][a-zA-Z]+(?:\\s[A-Z][a-zA-Z]+){0,2}),\\s*(${US_STATES_RE})\\b`, "g");
  for (const m of text.matchAll(re)) {
    const prev = String(m[1] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const city = m[2].trim();
    const st = m[3];
    const first = city.split(/\s+/)[0].toLowerCase();
    const last = city.split(/\s+/).slice(-1)[0].toLowerCase();
    if (STREET_TOKENS.has(prev) || /^\d+$/.test(prev)) continue;
    // TRIM leading non-city words, do not reject the whole match. The pattern
    // allows three capitalised words, so "Serving Lockport, LA" captures
    // "Serving Lockport" — rejecting it lost a real service area instead of
    // dropping one word. Only the LAST word being junk is fatal.
    let words = city.split(/\s+/);
    while (words.length > 1 &&
           (NOT_A_CITY.has(words[0].toLowerCase()) || STREET_TOKENS.has(words[0].toLowerCase()))) {
      words = words.slice(1);
    }
    const trimmed = words.join(" ");
    const first2 = words[0].toLowerCase();
    if (NOT_A_CITY.has(first2) || NOT_A_CITY.has(last) || STREET_TOKENS.has(first2)) continue;
    // Dedupe on the LAST word: the pattern greedily eats preceding capitalised
    // noise ("Google Review Metairie, LA"), and counting those as distinct
    // inflated totals past the threshold.
    const key = `${last},${st}`.toLowerCase();
    const display = `${trimmed.split(/\s+/).slice(-2).join(" ")}, ${st}`;
    if (!cities.has(key) || display.length < (cities.get(key) as string).length) cities.set(key, display);
  }

  const heading = /(service area[s]?|areas? we serve|areas? served|communities we serve|where we (?:work|serve)|(?:proudly )?serving)\s*:?/i.exec(text);
  if (heading) {
    const from = heading.index + heading[0].length;
    const chunk = text.slice(from, from + 400)
      .split(/\b(?:Contact|About|Blog|Home|Services|Free Estimate|Call|Privacy|Copyright)\b/)[0];
    for (const m of chunk.matchAll(/\b([A-Z][a-z]{2,}(?:\s(?:St\.?|Saint)?\s?[A-Z][a-z]{2,}){0,2})\b/g)) {
      const name = m[1].trim();
      const lower = name.toLowerCase();
      const lastW = name.split(/\s+/).slice(-1)[0].toLowerCase();
      if (!CITY_GAZETTEER.has(lower) && !CITY_GAZETTEER.has(lastW)) continue;
      const bareKey = `${CITY_GAZETTEER.has(lower) ? lower : lastW},bare`;
      if (![...cities.keys()].some((k) => k.startsWith(lastW + ","))) cities.set(bareKey, name);
    }
  }
  return [...cities.values()];
}

/** >=3 distinct cities means "serves a region" rather than "has an address".
 *  The distribution is bimodal at exactly this point. */
export const SERVICE_AREA_THRESHOLD = 3;

/** Reviews linked or embedded. All eight sampled matches were genuine Google
 *  Maps CID, g.page review or Yelp biz links — a solid detector. */
function detectReviewsLinked(html: string): boolean {
  return /href=["'][^"']*(google\.[a-z.]+\/maps|search\.google\.com\/local\/reviews|g\.page\/r\/|yelp\.com\/biz)[^"']*["']/i.test(html)
    || /(elfsight[^"']*review|trustindex|reviewsonmywebsite|shapo\.io|embedsocial|sociablekit[^"']*review|birdeye[^"']*review)/i.test(html);
}

/** schema.org openingHours. Verified against real markup on five sites. */
function detectHours(html: string): boolean {
  return /"openingHours(Specification)?"\s*:/i.test(html);
}

/** FAQPage schema is solid; a /faq or /blog link is a weaker proxy and is
 *  accepted because AEO presence is genuinely either. */
function detectFaqOrBlog(html: string): boolean {
  return /"@type"\s*:\s*"FAQPage"/i.test(html)
    || /href=["'][^"']*\/(faqs?|frequently-asked[a-z-]*)\/?["']/i.test(html)
    || /href=["'][^"']*\/(blog|news|articles|resources|tips)\/?["']/i.test(html);
}

/** A tel: link. Not prose: a phone number in text may be an image caption or
 *  a competitor's number in a testimonial. */
const detectPhone = (html: string) => /href=["']tel:\+?[\d\-(). ]{7,}["']/i.test(html);

const detectViewport = (html: string) =>
  /<meta[^>]+name=["']?viewport["']?[^>]*>/i.test(html.slice(0, 40000));

/**
 * The full probe for one record.
 *
 * EVERY early return writes NULL to every signal. That is what keeps a
 * failed probe from being mistaken for an absent feature.
 */
export async function enrichSite(
  websiteUrl: string | null | undefined,
  opts: { overrideRobots?: boolean } = {},
): Promise<EnrichResult> {
  const now = new Date().toISOString();
  const blank = (status: EnrichStatus, note: string, extra: Partial<EnrichResult> = {}): EnrichResult => ({
    enrichment_status: status, enriched_at: now,
    site_state: null, site_http_status: null, has_website: null,
    has_schema_org: null, analytics_pixels: null, chat_widget: null,
    booking_tool: null, call_tracking: null, ai_voice_agent: null,
    analytics_pixels_detail: null, chat_widget_detail: null, booking_tool_detail: null,
    call_tracking_detail: null, ai_voice_agent_detail: null,
    platform: null, domain: null, domain_age_days: null,
    domain_registered_on: null, domain_registrar: null, signal_confidence: null,
    has_https: null, has_viewport: null, phone_listed: null,
    has_business_hours: null, reviews_linked: null, has_faq_or_blog: null,
    service_area_count: null, service_areas: null,
    note, ...extra,
  });

  const url = siteUrlOf(websiteUrl);
  // Checked, and genuinely absent. has_website:false is the one honest false
  // available before we fetch anything.
  if (!url) return blank("no_website_found", "No website on the record.", { has_website: false });

  const domain = domainOf(url);

  if (!opts.overrideRobots && await robotsForbids(url)) {
    return blank("skipped_robots_txt",
      `robots.txt at ${domain} disallows crawling. Not probed.`,
      { has_website: true, site_state: "not_probed", domain });
  }

  let res: Response;
  try {
    res = await get(url, "text/html");
  } catch (err) {
    return blank("probe_failed",
      `Could not reach ${domain}: ${err instanceof Error ? err.message : String(err)}`,
      { has_website: true, site_state: "unknown", domain });
  }

  if (!res.ok) {
    return blank("probe_failed", `${domain} returned HTTP ${res.status}.`, {
      has_website: true, site_state: "dead_http_error", site_http_status: res.status, domain,
    });
  }

  let html: string;
  try {
    const buf = await res.arrayBuffer();
    // Workers' TextDecoder types do not accept the options bag; the default
    // is already non-fatal, which is what we want for arbitrary sites.
    html = new TextDecoder("utf-8")
      .decode(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf);
  } catch (err) {
    return blank("probe_failed", `Could not read ${domain}: ${String(err)}`, {
      has_website: true, site_state: "unknown", site_http_status: res.status, domain,
    });
  }

  // A parking page is not a website. Signals stay NULL - there was nothing
  // real to measure - but this is a known state, not a failure.
  if (PARKED.test(html)) {
    return blank("probe_failed", `${domain} looks like a parked or lead-gen page.`, {
      has_website: true, site_state: "parked_or_lead_gen", site_http_status: res.status, domain,
    });
  }

  const hits = detect(html);
  const platform = PLATFORMS.find(([, re]) => re.test(html))?.[0] ?? "none detected";
  const age = domain ? await domainAge(domain) : { registered_on: null, age_days: null, registrar: null };
  const join = (a: string[]) => (a.length ? JSON.stringify(a) : null);

  const areas = serviceAreas(html);

  return {
    enrichment_status: "fully_enriched",
    enriched_at: now,
    site_state: "alive",
    site_http_status: res.status,
    has_website: true,
    has_schema_org: hasSchemaOrg(html),
    analytics_pixels: hits.analytics.length > 0,
    chat_widget: hits.chat.length > 0,
    booking_tool: hits.booking.length > 0,
    call_tracking: hits.call.length > 0,
    ai_voice_agent: hits.voice.length > 0,
    analytics_pixels_detail: join(hits.analytics),
    chat_widget_detail: join(hits.chat),
    booking_tool_detail: join(hits.booking),
    call_tracking_detail: join(hits.call),
    ai_voice_agent_detail: join(hits.voice),
    platform,
    domain,
    domain_age_days: age.age_days,
    domain_registered_on: age.registered_on,
    domain_registrar: age.registrar,
    signal_confidence: "probed_live",
    // ── The seven, all from this one fetched page ─────────────────────────
    // `url` is the FINAL url after redirects, so https reflects where the
    // visitor actually lands rather than what was typed.
    has_https: /^https:/i.test(res.url || url),
    has_viewport: detectViewport(html),
    phone_listed: detectPhone(html),
    has_business_hours: detectHours(html),
    reviews_linked: detectReviewsLinked(html),
    has_faq_or_blog: detectFaqOrBlog(html),
    service_area_count: areas.length,
    // The evidence, stored so a contractor disputing the signal can be shown
    // exactly which cities we read off their page.
    service_areas: areas.length ? areas : null,
    note: `Probed ${domain}: HTTP ${res.status}, platform ${platform}, ` +
          `${areas.length} service area(s).`,
  };
}

/**
 * What is missing from this business's online presence, in plain words.
 *
 * Powers the line on a contractor's own profile. Every entry is a statement
 * about their web presence, never about them: "no online booking" is a fact,
 * "unprofessional" would be a judgement and has no place under a badge we
 * issued. Only signals we actually CHECKED are named - a NULL is silence.
 */
export function presenceGaps(row: {
  has_website?: boolean | null; has_schema_org?: boolean | null;
  booking_tool?: boolean | null; chat_widget?: boolean | null;
  call_tracking?: boolean | null; analytics_pixels?: boolean | null;
}): string[] {
  const gaps: string[] = [];
  if (row.has_website === false) gaps.push("no website");
  if (row.has_schema_org === false) gaps.push("no structured data for search engines and AI");
  if (row.booking_tool === false && row.chat_widget === false) gaps.push("no online booking or chat");
  else if (row.booking_tool === false) gaps.push("no online booking");
  if (row.call_tracking === false) gaps.push("no call tracking");
  if (row.analytics_pixels === false) gaps.push("no analytics");
  return gaps;
}

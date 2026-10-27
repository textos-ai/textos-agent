const ENRICH_UA = "TrustLightBot/1.0 (+https://trustlight.com/methodology; verification probe)";
const FETCH_TIMEOUT_MS = 1e4;
const MAX_HTML_BYTES = 6e5;
const DETECTORS = [
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
  { group: "voice", name: "Air.ai", re: /air\.ai\/embed/i }
];
const GROUPS = { chat: 1, booking: 1, call: 1, analytics: 1, voice: 1 };
const PLATFORMS = [
  ["WordPress", /wp-content\/|wp-includes\/|wordpress/i],
  ["Wix", /static\.parastorage\.com|wixstatic\.com/i],
  ["Squarespace", /squarespace\.com|static1\.squarespace/i],
  ["Shopify", /cdn\.shopify\.com/i],
  ["Webflow", /assets-global\.website-files\.com|webflow\.io/i],
  ["GoDaddy", /img1\.wsimg\.com|godaddysites/i],
  ["Duda", /d1\.awsstatic-cdn|dudaone|multiscreensite\.com/i],
  ["GoHighLevel", /leadconnectorhq|msgsndr/i]
];
const PARKED = /domain (is )?for sale|parked (free )?courtesy|buy this domain|godaddy\.com\/domainsearch|sedoparking|this domain is available/i;
function withTimeout(ms) {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(ms) : void 0;
}
async function get(url, accept) {
  return fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": ENRICH_UA, Accept: accept },
    signal: withTimeout(FETCH_TIMEOUT_MS)
  });
}
function siteUrlOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}
async function robotsForbids(siteUrl) {
  try {
    const u = new URL(siteUrl);
    const res = await get(`${u.origin}/robots.txt`, "text/plain");
    if (!res.ok) return false;
    const txt = (await res.text()).slice(0, 5e4);
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
    return false;
  }
}
async function domainAge(domain) {
  const none = { registered_on: null, age_days: null, registrar: null };
  try {
    const res = await get(`https://rdap.org/domain/${encodeURIComponent(domain)}`, "application/rdap+json");
    if (!res.ok) return none;
    const j = await res.json();
    const ev = (j.events ?? []).find((e) => /registration/i.test(e.eventAction ?? ""));
    if (!ev?.eventDate) return none;
    const when = new Date(ev.eventDate);
    if (isNaN(when.getTime())) return none;
    const ageDays = Math.floor((Date.now() - when.getTime()) / 864e5);
    let registrar = null;
    for (const ent of j.entities ?? []) {
      if (!(ent.roles ?? []).includes("registrar")) continue;
      const vc = ent.vcardArray;
      const props = Array.isArray(vc) && Array.isArray(vc[1]) ? vc[1] : [];
      for (const p of props) if (p[0] === "fn" && typeof p[3] === "string") registrar = p[3];
    }
    return { registered_on: when.toISOString(), age_days: ageDays, registrar };
  } catch {
    return none;
  }
}
function hasSchemaOrg(html) {
  return /application\/ld\+json/i.test(html) || /itemtype\s*=\s*["']https?:\/\/schema\.org/i.test(html) || /vocab\s*=\s*["']https?:\/\/schema\.org/i.test(html);
}
function detect(html) {
  const hits = { chat: [], booking: [], call: [], analytics: [], voice: [] };
  for (const d of DETECTORS) if (d.re.test(html)) hits[d.group].push(d.name);
  return hits;
}
const CITY_GAZETTEER = /* @__PURE__ */ new Set([
  "abita springs",
  "ama",
  "amite city",
  "angie",
  "arabi",
  "avondale",
  "bay st louis",
  "belle chasse",
  "bogalusa",
  "bourg",
  "boutte",
  "bridge city",
  "buras",
  "bush",
  "carriere",
  "chalmette",
  "chauvin",
  "convent",
  "covington",
  "cut off",
  "des allemands",
  "destrehan",
  "diamondhead",
  "dulac",
  "edgard",
  "elmwood",
  "estelle",
  "folsom",
  "franklinton",
  "galliano",
  "garyville",
  "golden meadow",
  "gramercy",
  "gray",
  "gretna",
  "hahnville",
  "hammond",
  "harahan",
  "harvey",
  "hester",
  "houma",
  "independence",
  "jefferson",
  "kenner",
  "kentwood",
  "kiln",
  "lacombe",
  "lafitte",
  "laplace",
  "larose",
  "lockport",
  "loranger",
  "luling",
  "lutcher",
  "madisonville",
  "mandeville",
  "marrero",
  "mathews",
  "meraux",
  "metairie",
  "montegut",
  "montz",
  "mt hermon",
  "new orleans",
  "new sarpy",
  "norco",
  "paradis",
  "paulina",
  "pearl river",
  "pearlington",
  "picayune",
  "ponchatoula",
  "poplarville",
  "port sulphur",
  "raceland",
  "reserve",
  "river ridge",
  "robert",
  "roseland",
  "schriever",
  "slidell",
  "st bernard",
  "st rose",
  "terrytown",
  "theriot",
  "thibodaux",
  "tickfaw",
  "vacherie",
  "venice",
  "violet",
  "waveland",
  "westwego"
]);
const US_STATES_RE = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const STREET_TOKENS = /* @__PURE__ */ new Set([
  "street",
  "st",
  "avenue",
  "ave",
  "road",
  "rd",
  "drive",
  "dr",
  "lane",
  "ln",
  "boulevard",
  "blvd",
  "highway",
  "hwy",
  "way",
  "court",
  "ct",
  "place",
  "pl",
  "circle",
  "cir",
  "parkway",
  "pkwy",
  "suite",
  "ste",
  "unit",
  "apt",
  "floor",
  "fl",
  "box",
  "route",
  "rt",
  "terrace",
  "ter",
  "trail",
  "trl",
  "loop"
]);
const NOT_A_CITY = /* @__PURE__ */ new Set([
  "the",
  "and",
  "in",
  "near",
  "serving",
  "greater",
  "all",
  "we",
  "our",
  "your",
  "contact",
  "call",
  "email",
  "home",
  "about",
  "services",
  "service",
  "areas",
  "area",
  "copyright",
  "rights",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]);
function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}
function serviceAreas(html) {
  const text = visibleText(html);
  const cities = /* @__PURE__ */ new Map();
  const re = new RegExp(
    `(\\S+)?\\s*\\b([A-Z][a-zA-Z]+(?:\\s[A-Z][a-zA-Z]+){0,2}),\\s*(${US_STATES_RE})\\b`,
    "g"
  );
  for (const m of text.matchAll(re)) {
    const prev = String(m[1] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const city = m[2].trim();
    const st = m[3];
    const first = city.split(/\s+/)[0].toLowerCase();
    const last = city.split(/\s+/).slice(-1)[0].toLowerCase();
    if (STREET_TOKENS.has(prev) || /^\d+$/.test(prev)) continue;
    let words = city.split(/\s+/);
    while (words.length > 1 && (NOT_A_CITY.has(words[0].toLowerCase()) || STREET_TOKENS.has(words[0].toLowerCase()))) {
      words = words.slice(1);
    }
    const trimmed = words.join(" ");
    const first2 = words[0].toLowerCase();
    if (NOT_A_CITY.has(first2) || NOT_A_CITY.has(last) || STREET_TOKENS.has(first2)) continue;
    const key = `${last},${st}`.toLowerCase();
    const display = `${trimmed.split(/\s+/).slice(-2).join(" ")}, ${st}`;
    if (!cities.has(key) || display.length < cities.get(key).length) cities.set(key, display);
  }
  const heading = /(service area[s]?|areas? we serve|areas? served|communities we serve|where we (?:work|serve)|(?:proudly )?serving)\s*:?/i.exec(text);
  if (heading) {
    const from = heading.index + heading[0].length;
    const chunk = text.slice(from, from + 400).split(/\b(?:Contact|About|Blog|Home|Services|Free Estimate|Call|Privacy|Copyright)\b/)[0];
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
const SERVICE_AREA_THRESHOLD = 3;
function detectReviewsLinked(html) {
  return /href=["'][^"']*(google\.[a-z.]+\/maps|search\.google\.com\/local\/reviews|g\.page\/r\/|yelp\.com\/biz)[^"']*["']/i.test(html) || /(elfsight[^"']*review|trustindex|reviewsonmywebsite|shapo\.io|embedsocial|sociablekit[^"']*review|birdeye[^"']*review)/i.test(html);
}
function detectHours(html) {
  return /"openingHours(Specification)?"\s*:/i.test(html);
}
function detectFaqOrBlog(html) {
  return /"@type"\s*:\s*"FAQPage"/i.test(html) || /href=["'][^"']*\/(faqs?|frequently-asked[a-z-]*)\/?["']/i.test(html) || /href=["'][^"']*\/(blog|news|articles|resources|tips)\/?["']/i.test(html);
}
const detectPhone = (html) => /href=["']tel:\+?[\d\-(). ]{7,}["']/i.test(html);
const detectViewport = (html) => /<meta[^>]+name=["']?viewport["']?[^>]*>/i.test(html.slice(0, 4e4));
async function enrichSite(websiteUrl, opts = {}) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const blank = (status, note, extra = {}) => ({
    enrichment_status: status,
    enriched_at: now,
    site_state: null,
    site_http_status: null,
    has_website: null,
    has_schema_org: null,
    analytics_pixels: null,
    chat_widget: null,
    booking_tool: null,
    call_tracking: null,
    ai_voice_agent: null,
    analytics_pixels_detail: null,
    chat_widget_detail: null,
    booking_tool_detail: null,
    call_tracking_detail: null,
    ai_voice_agent_detail: null,
    platform: null,
    domain: null,
    domain_age_days: null,
    domain_registered_on: null,
    domain_registrar: null,
    signal_confidence: null,
    has_https: null,
    has_viewport: null,
    phone_listed: null,
    has_business_hours: null,
    reviews_linked: null,
    has_faq_or_blog: null,
    service_area_count: null,
    service_areas: null,
    note,
    ...extra
  });
  const url = siteUrlOf(websiteUrl);
  if (!url) return blank("no_website_found", "No website on the record.", { has_website: false });
  const domain = domainOf(url);
  if (!opts.overrideRobots && await robotsForbids(url)) {
    return blank(
      "skipped_robots_txt",
      `robots.txt at ${domain} disallows crawling. Not probed.`,
      { has_website: true, site_state: "not_probed", domain }
    );
  }
  let res;
  try {
    res = await get(url, "text/html");
  } catch (err) {
    return blank(
      "probe_failed",
      `Could not reach ${domain}: ${err instanceof Error ? err.message : String(err)}`,
      { has_website: true, site_state: "unknown", domain }
    );
  }
  if (!res.ok) {
    return blank("probe_failed", `${domain} returned HTTP ${res.status}.`, {
      has_website: true,
      site_state: "dead_http_error",
      site_http_status: res.status,
      domain
    });
  }
  let html;
  try {
    const buf = await res.arrayBuffer();
    html = new TextDecoder("utf-8").decode(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf);
  } catch (err) {
    return blank("probe_failed", `Could not read ${domain}: ${String(err)}`, {
      has_website: true,
      site_state: "unknown",
      site_http_status: res.status,
      domain
    });
  }
  if (PARKED.test(html)) {
    return blank("probe_failed", `${domain} looks like a parked or lead-gen page.`, {
      has_website: true,
      site_state: "parked_or_lead_gen",
      site_http_status: res.status,
      domain
    });
  }
  const hits = detect(html);
  const platform = PLATFORMS.find(([, re]) => re.test(html))?.[0] ?? "none detected";
  const age = domain ? await domainAge(domain) : { registered_on: null, age_days: null, registrar: null };
  const join = (a) => a.length ? JSON.stringify(a) : null;
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
    note: `Probed ${domain}: HTTP ${res.status}, platform ${platform}, ${areas.length} service area(s).`
  };
}
function presenceGaps(row) {
  const gaps = [];
  if (row.has_website === false) gaps.push("no website");
  if (row.has_schema_org === false) gaps.push("no structured data for search engines and AI");
  if (row.booking_tool === false && row.chat_widget === false) gaps.push("no online booking or chat");
  else if (row.booking_tool === false) gaps.push("no online booking");
  if (row.call_tracking === false) gaps.push("no call tracking");
  if (row.analytics_pixels === false) gaps.push("no analytics");
  return gaps;
}
export {
  ENRICH_UA,
  SERVICE_AREA_THRESHOLD,
  domainAge,
  domainOf,
  enrichSite,
  presenceGaps,
  robotsForbids,
  serviceAreas,
  siteUrlOf
};

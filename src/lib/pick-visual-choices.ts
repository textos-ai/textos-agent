/**
 * Rule-based visual identity picker for public business sites.
 * Maps industry + brand voice → accent color, hero font, layout, eyebrow vocabulary.
 * Called by the personal-landing-page task at free-build time.
 */

export type AccentColor =
  | "terracotta" | "sage" | "navy" | "charcoal"
  | "sienna" | "forest" | "brass" | "ink";

export type HeroFont =
  | "fraunces" | "playfair" | "dm_serif"
  | "manrope" | "cormorant" | "space_grotesk";

export type HeroLayout = "photo" | "type";

export type EyebrowVocab = "standard" | "editorial" | "operator";

export interface VisualChoices {
  accent_color: AccentColor;
  hero_font: HeroFont;
  hero_layout: HeroLayout;
  eyebrow_vocab: EyebrowVocab;
  unsplash_query: string;
  unsplash_query_atmospheric?: string;
}

interface UnsplashResult {
  url: string;
  credit: string;
}

// ── Industry keyword buckets ───────────────────────────────────────────────

const FOOD_WORDS = ["food", "culinary", "restaurant", "chef", "catering", "bakery", "cafe", "kitchen", "dining", "cuisine", "bistro", "farm"];
const TECH_WORDS = ["tech", "software", "saas", "digital", "app", "platform", "ai", "data", "cloud", "developer", "automation", "api"];
const NATURE_WORDS = ["organic", "plant", "green", "nature", "eco", "garden", "sustainable", "farm", "outdoor", "wilderness", "botanical"];
const FINANCE_WORDS = ["finance", "financial", "accounting", "law", "legal", "consulting", "advisory", "insurance", "audit", "tax", "investment"];
const FASHION_WORDS = ["fashion", "clothing", "apparel", "jewelry", "luxury", "style", "boutique", "accessories", "beauty", "cosmetic"];
const CREATIVE_WORDS = ["art", "design", "creative", "studio", "gallery", "photography", "film", "media", "branding", "illustration"];
const HEALTH_WORDS = ["health", "wellness", "yoga", "fitness", "therapy", "healing", "medical", "clinical", "nutrition", "coaching", "mindfulness"];
const TRADE_WORDS = ["construction", "trade", "contractor", "manufacturing", "logistics", "supply", "repair", "plumbing", "electrical", "hvac"];

function matchesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w));
}

function detectBucket(industry: string, summary: string): string {
  const corpus = `${industry} ${summary}`;
  if (matchesAny(corpus, FOOD_WORDS))    return "food";
  if (matchesAny(corpus, NATURE_WORDS))  return "nature";
  if (matchesAny(corpus, HEALTH_WORDS))  return "health";
  if (matchesAny(corpus, CREATIVE_WORDS)) return "creative";
  if (matchesAny(corpus, FASHION_WORDS)) return "fashion";
  if (matchesAny(corpus, FINANCE_WORDS)) return "finance";
  if (matchesAny(corpus, TECH_WORDS))    return "tech";
  if (matchesAny(corpus, TRADE_WORDS))   return "trade";
  return "default";
}

// ── Bucket → visual choices ────────────────────────────────────────────────

const BUCKET_MAP: Record<string, Omit<VisualChoices, "eyebrow_vocab">> = {
  food:     { accent_color: "terracotta", hero_font: "cormorant",    hero_layout: "photo", unsplash_query: "restaurant food culinary" },
  nature:   { accent_color: "sage",       hero_font: "dm_serif",     hero_layout: "photo", unsplash_query: "nature garden organic" },
  health:   { accent_color: "forest",     hero_font: "dm_serif",     hero_layout: "photo", unsplash_query: "wellness health calm" },
  creative: { accent_color: "sienna",     hero_font: "fraunces",     hero_layout: "photo", unsplash_query: "creative studio art" },
  fashion:  { accent_color: "brass",      hero_font: "cormorant",    hero_layout: "photo", unsplash_query: "fashion style minimal" },
  finance:  { accent_color: "charcoal",   hero_font: "playfair",     hero_layout: "type",  unsplash_query: "finance business professional",    unsplash_query_atmospheric: "leather notebook coffee morning office light" },
  tech:     { accent_color: "navy",       hero_font: "manrope",      hero_layout: "type",  unsplash_query: "technology digital abstract",       unsplash_query_atmospheric: "morning light desk laptop minimal workspace" },
  trade:    { accent_color: "ink",        hero_font: "space_grotesk", hero_layout: "type", unsplash_query: "construction trade work",           unsplash_query_atmospheric: "modern office workspace natural light minimal" },
  default:  { accent_color: "charcoal",   hero_font: "space_grotesk", hero_layout: "type", unsplash_query: "business professional",             unsplash_query_atmospheric: "natural light workspace minimal architectural" },
};

function pickEyebrowVocab(brandVoice: string): EyebrowVocab {
  const v = brandVoice.toLowerCase();
  if (v.includes("editorial") || v.includes("journalistic") || v.includes("thoughtful")) return "editorial";
  if (v.includes("operator") || v.includes("bold") || v.includes("direct") || v.includes("action")) return "operator";
  return "standard";
}

export function pickVisualChoices(
  industry: string,
  summary: string,
  brandVoice: string,
): VisualChoices {
  const bucket = detectBucket(industry, summary);
  const base = BUCKET_MAP[bucket] ?? BUCKET_MAP["default"];
  return {
    ...base,
    eyebrow_vocab: pickEyebrowVocab(brandVoice),
  };
}

// ── Unsplash photo fetch ───────────────────────────────────────────────────

export async function fetchUnsplashPhoto(
  query: string,
  accessKey: string,
): Promise<UnsplashResult | null> {
  if (!accessKey) return null;
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape&content_filter=high`;
    const r = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });
    if (!r.ok) return null;
    const data = await r.json() as { results: Array<{ urls: { regular: string }; user: { name: string }; links: { html: string } }> };
    if (!data.results?.length) return null;
    // Pick a random photo from the first 5 to add variety across businesses
    const idx = Math.floor(Math.random() * Math.min(5, data.results.length));
    const photo = data.results[idx];
    return {
      url: photo.urls.regular,
      credit: `Photo by ${photo.user.name} on Unsplash`,
    };
  } catch {
    return null;
  }
}

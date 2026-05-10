/**
 * fal.ai Recraft V3 — logo image generation.
 * Pure fetch, no SDK — Cloudflare Workers compatible.
 *
 * Model: fal-ai/recraft-v3 (vector_illustration style)
 * Endpoint: https://fal.run/fal-ai/recraft-v3
 * Auth: Authorization: Key <FAL_API_KEY>
 *
 * Output is a PNG URL (vector-illustration aesthetic).
 * Store URL in business_assets; asset_type='logo' is the distinguishing field.
 * URL is ephemeral (fal CDN, ~24h TTL). R2 persistence is V1.1.
 */

import type { Env } from "../env";
import type { BusinessContextRow } from "./supabase";

const FAL_ENDPOINT = "https://fal.run/fal-ai/recraft-v3";

export interface LogoResult {
  image_url: string;
  prompt: string;
  style: "vector_illustration";
  seed?: number;
}

// ── Industry bucket → style hint for prompt ────────────────────────────────

const INDUSTRY_STYLE: Record<string, string> = {
  food:     "warm earthy tones, organic flowing shapes, culinary motif",
  nature:   "botanical illustration style, green and earth tones, leaf or plant motif",
  health:   "clean rounded forms, calming muted palette, wellness symbol",
  creative: "dynamic geometric shapes, bold accent color, expressive abstract mark",
  fashion:  "elegant minimal lines, refined monochrome palette, luxury aesthetic",
  finance:  "solid geometric forms, navy or charcoal palette, professional mark",
  tech:     "sharp geometric, modern angular forms, navy or deep blue accent",
  trade:    "strong bold shapes, industrial aesthetic, grounded dark palette",
  default:  "clean minimal geometric shapes, professional, versatile mark",
};

function detectBucket(industry: string, summary: string): string {
  const text = `${industry} ${summary}`.toLowerCase();
  if (/food|culinary|restaurant|chef|cater|bak|cafe|kitchen|dining/.test(text)) return "food";
  if (/organic|plant|green|nature|eco|garden|sustain|botanical/.test(text))     return "nature";
  if (/health|wellness|yoga|fitness|therapy|medical|nutrition/.test(text))       return "health";
  if (/art|design|creat|studio|gallery|photo|film|media|brand|illustrat/.test(text)) return "creative";
  if (/fashion|clothing|apparel|jewelry|luxury|style|boutique/.test(text))       return "fashion";
  if (/finance|financial|account|law|legal|consult|advisory|insurance/.test(text)) return "finance";
  if (/tech|software|saas|digital|app|platform|ai\b|data|cloud|developer/.test(text)) return "tech";
  if (/construct|trade|contractor|manufactur|logistic|supply|repair/.test(text)) return "trade";
  return "default";
}

// ── buildLogoPrompt ────────────────────────────────────────────────────────

export function buildLogoPrompt(
  ctx: Pick<BusinessContextRow, "industry" | "business_summary" | "brand_voice" | "key_differentiators">,
): string {
  const industry = ctx.industry ?? "business";
  const summary  = ctx.business_summary ?? "";
  const voice    = (ctx.brand_voice ?? "professional").toLowerCase();
  const diffs    = Array.isArray(ctx.key_differentiators)
    ? (ctx.key_differentiators as string[]).slice(0, 1).join("")
    : "";

  const bucket    = detectBucket(industry, summary);
  const styleHint = INDUSTRY_STYLE[bucket] ?? INDUSTRY_STYLE.default;

  let aesthetic = "minimal and professional";
  if (/bold|direct|confident/.test(voice))        aesthetic = "bold and confident";
  else if (/warm|friendly|approachable/.test(voice)) aesthetic = "approachable and warm";
  else if (/luxury|premium|refined/.test(voice))   aesthetic = "refined and premium";
  else if (/playful|fun|energetic/.test(voice))    aesthetic = "playful and energetic";

  const concept = diffs
    ? `icon representing ${diffs.trim()}`
    : `icon for a ${industry} business`;

  return [
    `Vector logo mark — ${concept}.`,
    styleHint + ".",
    `Aesthetic: ${aesthetic}.`,
    "Clean isolated symbol on white background.",
    "No text. No letters. No words.",
    "Single cohesive shape, scales cleanly at any size.",
  ].join(" ");
}

// ── generateLogoImage ──────────────────────────────────────────────────────

export async function generateLogoImage(
  prompt: string,
  env: Env,
): Promise<LogoResult | null> {
  const apiKey = env.FAL_API_KEY;
  if (!apiKey || apiKey === "PLACEHOLDER") return null;

  try {
    const res = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        style: "vector_illustration",
        image_size: "square_hd",
        num_images: 1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[fal] Recraft V3 ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as {
      images?: Array<{ url: string; width?: number; height?: number }>;
      seed?: number;
    };

    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) return null;

    return { image_url: imageUrl, prompt, style: "vector_illustration", seed: data.seed };
  } catch (err) {
    console.error("[fal] Recraft V3 fetch error:", err);
    return null;
  }
}

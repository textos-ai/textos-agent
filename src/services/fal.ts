/**
 * fal.ai Recraft V3 — logo image generation.
 * Pure fetch, no SDK — Cloudflare Workers compatible.
 *
 * Model: fal-ai/recraft-v3 (vector_illustration style)
 * Endpoint: https://fal.run/fal-ai/recraft-v3
 * Auth: Authorization: Key <FAL_API_KEY>
 */

import type { Env } from "../env";

const FAL_ENDPOINT = "https://fal.run/fal-ai/recraft-v3";

export interface LogoBrief {
  structure_hint: string;
  motif_hint: string;
  aesthetic_hint: string;
  color_hint: string;
}

export interface LogoResult {
  image_url: string;
  prompt: string;
  style: "vector_illustration";
  seed?: number;
}

// ── buildLogoPrompt ────────────────────────────────────────────────────────

export function buildLogoPrompt(
  brief: LogoBrief,
  businessName: string,
  industry: string,
): string {
  // Keep under Recraft V3's 1000-char limit. Template fixed portion is ~600 chars;
  // variable hints are capped at 80 chars each by the Haiku system prompt.
  return `Professional vector logo mark for ${businessName}, a ${industry || "modern"} brand.

Design: single abstract symbol capturing the brand's essence in one confident shape. ${brief.structure_hint}. Scales from 16px favicon to billboard size.

Visual language: ${brief.motif_hint}.
Aesthetic: ${brief.aesthetic_hint}.
Colors: ${brief.color_hint}. Maximum 2 colors plus white.

Constraints: Flat vector, no gradients, no shadows, no 3D. No text, letters, or numbers. No clip-art clichés (no gears, lightbulbs, globes, handshakes). Isolated on white. Strong negative space, simple silhouette, memorable at a glance.

Style: like Nike, Apple, Airbnb, Spotify marks — timeless geometry distilling identity.`;
}

// ── generateLogoImage ──────────────────────────────────────────────────────

export async function generateLogoImage(
  prompt: string,
  env: Env,
): Promise<LogoResult | null> {
  const apiKey = env.FAL_API_KEY;
  if (!apiKey || apiKey === "PLACEHOLDER") return null;

  console.log(`[fal] key prefix=${apiKey?.slice(0, 8) || "MISSING"} len=${apiKey?.length || 0}`);
  console.log(`[fal] endpoint=${FAL_ENDPOINT}`);
  console.log(`[fal] prompt preview="${prompt.slice(0, 100)}..."`);

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

    console.log(`[fal] response status=${res.status}`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "(unable to read body)");
      console.error(`[fal] error status=${res.status} body=${errText.slice(0, 500)}`);
      return null;
    }

    const data = await res.json() as {
      images?: Array<{ url: string; width?: number; height?: number }>;
      seed?: number;
    };

    console.log(`[fal] response keys=${Object.keys(data).join(",")}`);
    console.log(`[fal] images count=${data.images?.length || 0}`);
    if (data.images?.[0]) {
      console.log(`[fal] first image url=${data.images[0].url}`);
    }

    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) return null;

    return { image_url: imageUrl, prompt, style: "vector_illustration", seed: data.seed };
  } catch (err) {
    console.error("[fal] Recraft V3 fetch error:", err);
    return null;
  }
}

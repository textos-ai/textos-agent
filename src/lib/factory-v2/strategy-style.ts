// factory-v2 — Strategy build-time STYLE spec (font pairing + design tokens).
//
// Strategy's result is generated PER VISITOR by the result endpoint, but its
// STYLING must be decided ONCE at build and applied consistently (collect page
// + every visitor's result). This generates { font_pairing, style } once via
// the LLM (same closed font set + design-token dictionary as Assessment),
// caches it in KV, and is read by the collect build AND the result endpoint.
//
// Reuses: the design-token resolver (validation), STYLE_ROLE_COMPONENT (role →
// component), StyleChoices (shape), the closed font-pairing set.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Env } from '../../env';
import { CATALOG } from '../component-catalog/index';
import { resolveComponentTokens, type ChosenTokens } from '../component-catalog/design-token-resolver';
import { isFontPairing, FONT_PAIRING_IDS, DEFAULT_FONT_PAIRING } from './textos-style-layer';
import { StyleChoicesSchema, type StyleChoices } from './assessment-spec-schema';
import { STYLE_ROLE_COMPONENT } from './assessment-recipe';

const STYLE_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1200;
const MAX_ATTEMPTS = 3;

export interface StrategyStyleSpec {
  font_pairing: string;
  style: StyleChoices;
}

const StrategyStyleSpecSchema = z.object({
  font_pairing: z.string().refine(isFontPairing, { message: `font_pairing must be one of: ${FONT_PAIRING_IDS.join(', ')}` }),
  style: StyleChoicesSchema,
});

export class StrategyStyleError extends Error {
  constructor(message: string) {
    super(`factory-v2 strategy style: ${message}`);
    this.name = 'StrategyStyleError';
  }
}

/** Per-role token menu, built LIVE from the catalog capabilities (box aspects). */
function buildStyleGuide(): string {
  const ASPECTS = ['surface', 'radius', 'border', 'elevation'] as const;
  const lines: string[] = [];
  for (const [role, compId] of Object.entries(STYLE_ROLE_COMPONENT)) {
    if (role === 'score_badge') continue; // not used by Strategy
    const caps = CATALOG.by_id[compId]?.capabilities;
    if (!caps) continue;
    const parts = ASPECTS.map((a) => {
      const cap = caps[a];
      return cap ? `${a}:[${cap.supported.join('|')}]` : null;
    }).filter(Boolean);
    lines.push(`- ${role} (${compId}): ${parts.join('  ')}`);
  }
  return lines.join('\n');
}

function buildPrompt(business: { name: string; summary: string }): { system: string; user: string } {
  const system = `You pick the visual STYLE for "${business.name}"'s mini-app — a font pairing and per-component design tokens — to compose a FINISHED, polished look matching the business's personality. Business: ${business.summary}

Return ONLY JSON (first character "{"):
{
  "font_pairing": "artisan",
  "style": {
    "questions":           { "radius": "..." },
    "hero":                { "surface": "...", "radius": "...", "elevation": "..." },
    "interpretation_card": { "surface": "...", "radius": "...", "border": "...", "elevation": "..." },
    "recommendations":     { "border": "...", "radius": "...", "surface": "..." },
    "cta":                 { "surface": "...", "border": "...", "radius": "...", "elevation": "..." }
  }
}

font_pairing MUST be exactly one of: ${FONT_PAIRING_IDS.join(', ')}.
Each style token MUST be one of that component's allowed values:
${buildStyleGuide()}
Aim for a finished feel: frame content in real cards (surface "card"/"raised-card"), soft corners ("rounded"/"lg"), subtle lift ("sm"/"raised"). Omit any aspect to keep its default. Anything outside the allowed values is rejected.`;

  const user = `Pick the style for "${business.name}" now. Return JSON only, first character "{".`;
  return { system, user };
}

/** Validate the LLM's token picks against each component's supported[] (throw). */
function validateStyle(style: StyleChoices): void {
  for (const [role, compId] of Object.entries(STYLE_ROLE_COMPONENT)) {
    const entry = CATALOG.by_id[compId];
    if (!entry) continue;
    resolveComponentTokens(entry, (style[role as keyof StyleChoices] ?? {}) as ChosenTokens);
  }
}

export async function generateStrategyStyle(apiKey: string, business: { name: string; summary: string }): Promise<StrategyStyleSpec> {
  const client = new Anthropic({ apiKey, timeout: 90_000 });
  const { system, user } = buildPrompt(business);
  let lastErr = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const stream = client.messages.stream({ model: STYLE_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'max_tokens') {
      lastErr = 'output truncated';
      continue;
    }
    const block = msg.content[0];
    const text = block && block.type === 'text' ? (block as { text: string }).text : '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    } catch (err) {
      lastErr = `JSON.parse: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const zres = StrategyStyleSpecSchema.safeParse(parsed);
    if (!zres.success) {
      lastErr = `Zod: ${zres.error.message.slice(0, 200)}`;
      continue;
    }
    try {
      validateStyle(zres.data.style);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      continue;
    }
    return zres.data;
  }
  throw new StrategyStyleError(`failed after ${MAX_ATTEMPTS} attempts — last: ${lastErr}`);
}

/** KV-cached style per business (generated once at build; read by collect + result). */
export async function getOrGenStrategyStyle(
  env: Env,
  businessId: string,
  identity: { name: string; summary: string },
  forceRegen = false,
): Promise<StrategyStyleSpec> {
  const kv = env.SNAPSHOT_KV;
  const key = `fv2:strat-style:${businessId}`;
  if (kv && !forceRegen) {
    const cached = await kv.get(key);
    if (cached) {
      try {
        const spec = JSON.parse(cached) as StrategyStyleSpec;
        if (isFontPairing(spec.font_pairing)) return spec;
      } catch {
        /* regenerate */
      }
    }
  }
  const spec = await generateStrategyStyle(env.ANTHROPIC_API_KEY, identity);
  if (!isFontPairing(spec.font_pairing)) spec.font_pairing = DEFAULT_FONT_PAIRING;
  if (kv) await kv.put(key, JSON.stringify(spec), { expirationTtl: 86_400 });
  return spec;
}

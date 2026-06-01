// factory-v2 / generated-app DESIGN-TOKEN DICTIONARY (approved 2026-06-01).
//
// A CLOSED, canonical-name vocabulary for the Homer/generated-app layer. Each
// token MAPS ONTO a value that already exists — a Homer `--ins-*` variable
// (consumed by a Bootstrap utility class) or a `textos-style-layer.ts` `--tx-*`
// value. This module adds NAMES + guidance, never new values.
//
// SEPARATE from `textos-web/src/styles/tokens.css` (the platform studio/daylight
// layer) — different system; do not merge or reference it.
//
// Closed-set discipline mirrors textos-style-layer.ts (isFontPairing /
// UnknownFontPairingError): both the aspect names and each aspect's value set
// are closed; anything outside throws (no fallback).
//
// Resolver (emit utility class / CSS) is Phase C — NOT here. This module is the
// vocabulary + reference metadata only.

export const DESIGN_TOKENS = {
  elevation: ['flat', 'sm', 'raised', 'lg'],
  radius: ['square', 'sm', 'rounded', 'lg', 'xl', 'circle', 'pill'],
  border: ['none', 'hairline', 'accent', 'dashed'],
  surface: ['plain', 'card', 'raised-card', 'tinted'],
  emphasis: ['muted', 'default', 'strong', 'feature'],
} as const;

export type TokenAspect = keyof typeof DESIGN_TOKENS;
export type ElevationToken = (typeof DESIGN_TOKENS.elevation)[number];
export type RadiusToken = (typeof DESIGN_TOKENS.radius)[number];
export type BorderToken = (typeof DESIGN_TOKENS.border)[number];
export type SurfaceToken = (typeof DESIGN_TOKENS.surface)[number];
export type EmphasisToken = (typeof DESIGN_TOKENS.emphasis)[number];
export type DesignToken =
  | ElevationToken | RadiusToken | BorderToken | SurfaceToken | EmphasisToken;

export const TOKEN_ASPECTS = Object.keys(DESIGN_TOKENS) as TokenAspect[];

/** What a token resolves to (reference metadata; the Phase-C resolver consumes this). */
export interface TokenRef {
  /** Bootstrap/Homer utility class(es) that apply this token. */
  utility: string;
  /** backing --ins-* var / tx value, or a literal, or null for utility-only. */
  source: string | null;
  /** does the RESOLVED value change with skin/theme/font-pairing? */
  varies_by: 'none' | 'theme' | 'skin' | 'theme+skin' | 'font-pairing';
  when: string;
}

export const TOKEN_REFERENCE: { [A in TokenAspect]: Record<string, TokenRef> } = {
  elevation: {
    flat:   { utility: 'shadow-none', source: null, varies_by: 'none', when: 'no lift; flush surfaces & inputs' },
    sm:     { utility: 'shadow-sm', source: '--ins-box-shadow-sm', varies_by: 'theme', when: 'subtle lift: list items, quiet cards' },
    raised: { utility: 'shadow', source: '--ins-box-shadow', varies_by: 'theme+skin', when: 'standard raised card' },
    lg:     { utility: 'shadow-lg', source: '--ins-box-shadow-lg', varies_by: 'theme', when: 'modals, feature pop, hover-elevated' },
  },
  radius: {
    square:  { utility: 'rounded-0', source: '0', varies_by: 'none', when: 'sharp/technical: tables, code, edge media' },
    sm:      { utility: 'rounded-1', source: '--ins-border-radius-sm', varies_by: 'none', when: 'tight: badges, chips, small inputs' },
    rounded: { utility: 'rounded', source: '--ins-border-radius', varies_by: 'none', when: 'default: cards, inputs, buttons' },
    lg:      { utility: 'rounded-3', source: '--ins-border-radius-lg', varies_by: 'none', when: 'softer cards & hero panels' },
    xl:      { utility: 'rounded-4', source: '--ins-border-radius-xl', varies_by: 'none', when: 'large feature surfaces, image frames' },
    circle:  { utility: 'rounded-circle', source: '50%', varies_by: 'none', when: 'avatars, round score badges' },
    pill:    { utility: 'rounded-pill', source: '--ins-border-radius-pill', varies_by: 'none', when: 'pill buttons, tags, round CTAs' },
  },
  border: {
    none:     { utility: 'border-0', source: null, varies_by: 'none', when: 'seamless; bg-tinted surfaces with no outline' },
    hairline: { utility: 'border', source: '--ins-border-width + --ins-border-color', varies_by: 'theme', when: 'standard quiet 1px outline/divider' },
    accent:   { utility: 'border border-2 border-{skin-color}', source: '--ins-{color}', varies_by: 'skin', when: 'emphasized/selected/brand-edge outline' },
    dashed:   { utility: 'border border-dashed', source: '--ins-border-color (dashed)', varies_by: 'theme', when: 'placeholders, drop zones, "add" affordances' },
  },
  surface: {
    plain:         { utility: '(transparent, no border, flat)', source: null, varies_by: 'none', when: 'content flush on the page background' },
    card:          { utility: 'card', source: '--ins-card-bg + hairline + rounded', varies_by: 'theme+skin', when: 'standard contained content block' },
    'raised-card': { utility: 'card shadow', source: '--ins-card-bg + --ins-box-shadow', varies_by: 'theme+skin', when: 'elevated/feature card that should pop' },
    tinted:        { utility: 'bg-{color}-subtle', source: '--ins-{color}-bg-subtle', varies_by: 'skin', when: 'soft colored callout keyed to the skin (CTA, score band)' },
  },
  emphasis: {
    muted:   { utility: 'text-muted', source: '--tx-font-body', varies_by: 'theme', when: 'captions, helper text, de-emphasized meta' },
    default: { utility: '(base)', source: '--tx-font-body', varies_by: 'font-pairing', when: 'standard body copy' },
    strong:  { utility: 'fw-semibold', source: '--tx-font-body', varies_by: 'font-pairing', when: 'emphasized labels, key inline figures' },
    feature: { utility: 'display-* fw-bold', source: '--tx-font-heading', varies_by: 'font-pairing', when: 'hero headline, score number, section title — carries personality' },
  },
};

export function isTokenAspect(a: unknown): a is TokenAspect {
  return typeof a === 'string' && Object.prototype.hasOwnProperty.call(DESIGN_TOKENS, a);
}

/** True iff `name` is a valid token for `aspect`. Closed set — no fallback. */
export function isDesignToken(aspect: TokenAspect, name: unknown): boolean {
  return typeof name === 'string' && (DESIGN_TOKENS[aspect] as readonly string[]).includes(name);
}

export class UnknownDesignTokenError extends Error {
  constructor(aspect: string, name: string) {
    const known = isTokenAspect(aspect) ? (DESIGN_TOKENS[aspect] as readonly string[]).join(', ') : '(unknown aspect)';
    super(
      `factory-v2: "${name}" is not a valid ${aspect} token. Closed set: ${known}. ` +
        `No fallback — a design aspect a component needs that is absent from the dictionary is a ` +
        `front-door add, never an inline coinage.`,
    );
    this.name = 'UnknownDesignTokenError';
  }
}

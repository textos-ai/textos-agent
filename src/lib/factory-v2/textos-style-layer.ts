// factory-v2 — TextOS STYLE LAYER (bounded). The personality is in the TYPE.
//
// ┌─ BOUNDARY (do not let this sprawl) ──────────────────────────────────────┐
// │ Architecture: Homer is the base/structural layer (default). This is a    │
// │ NAMED, BOUNDED style layer applied ON TOP, via the document-shell ONLY   │
// │ (the single allowed non-component seam).                                  │
// │                                                                           │
// │ This layer may set ONLY:                                                  │
// │   1. a Google Font PAIRING — heading family + body family, on the root,   │
// │      so every Homer component inherits the type; and                      │
// │   2. a light heading-scale / spacing token set (line-height,             │
// │      letter-spacing on headings; body line-height) for a "finished" feel. │
// │                                                                           │
// │ It must NEVER:                                                            │
// │   • change structure/layout, or any component's box (margin/padding/      │
// │     width/display/flex/grid);                                             │
// │   • set colors, backgrounds, borders, shadows;                            │
// │   • target Homer component classes (.card, .btn, .avatar, .list-group,    │
// │     .wizard, …) or override Homer component internals;                    │
// │   • add per-component CSS.                                                │
// │ Selectors are limited to: :root, html, body, and heading TYPE selectors  │
// │ (h1–h6 / .h1–.h6 / .display-1–.display-6). Font-family + a couple of      │
// │ type tokens only. If a need ever requires more than this, it is NOT a     │
// │ style-layer change — escalate, don't widen the layer.                     │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The pairing id is a CLOSED set — anything outside it THROWS (same discipline
// as component slugs and skins).

export interface FontDef {
  /** CSS font-family value (family + generic fallback). */
  family: string;
  /** Google Fonts css2 `family=` spec (family + axes), e.g. "Playfair+Display:wght@400;700". */
  gf: string;
}

export interface FontPairing {
  heading: FontDef;
  body: FontDef;
  /** one-line rationale shown in diagnostics. */
  feel: string;
}

const INTER: FontDef = { family: "'Inter', system-ui, -apple-system, sans-serif", gf: 'Inter:wght@400;500;700' };

// The 8 curated pairings (closed set). Body is Inter except `editorial`.
export const TEXTOS_FONT_PAIRINGS: Record<string, FontPairing> = {
  refined: {
    heading: { family: "'Playfair Display', Georgia, serif", gf: 'Playfair+Display:wght@400;700' },
    body: INTER,
    feel: 'elegant, upscale, editorial-serif headlines',
  },
  festive: {
    heading: { family: "'Lobster', cursive", gf: 'Lobster' },
    body: INTER,
    feel: 'playful, celebratory script',
  },
  editorial: {
    heading: { family: "'Abril Fatface', Georgia, serif", gf: 'Abril+Fatface' },
    body: { family: "'Fraunces', Georgia, serif", gf: 'Fraunces:wght@400;500;600' },
    feel: 'magazine, high-contrast display + literary serif body',
  },
  'bold-poster': {
    heading: { family: "'Bebas Neue', Impact, sans-serif", gf: 'Bebas+Neue' },
    body: INTER,
    feel: 'loud, condensed, poster-like',
  },
  artisan: {
    heading: { family: "'Fraunces', Georgia, serif", gf: 'Fraunces:wght@400;600;700' },
    body: INTER,
    feel: 'crafted, warm, old-world-meets-modern (the safe default)',
  },
  handcrafted: {
    heading: { family: "'Caveat', cursive", gf: 'Caveat:wght@500;700' },
    body: INTER,
    feel: 'hand-lettered, personal, casual',
  },
  modern: {
    heading: { family: "'Space Grotesk', system-ui, sans-serif", gf: 'Space+Grotesk:wght@400;500;700' },
    body: INTER,
    feel: 'clean, technical, contemporary',
  },
  strong: {
    heading: { family: "'Archivo Black', Impact, sans-serif", gf: 'Archivo+Black' },
    body: INTER,
    feel: 'heavy, confident, no-nonsense',
  },
};

/** The default when the pairing is ambiguous/absent. */
export const DEFAULT_FONT_PAIRING = 'artisan';

export const FONT_PAIRING_IDS = Object.keys(TEXTOS_FONT_PAIRINGS);

export function isFontPairing(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEXTOS_FONT_PAIRINGS, v);
}

export class UnknownFontPairingError extends Error {
  constructor(id: string) {
    super(
      `factory-v2: font pairing "${id}" is not in the closed TextOS set (${FONT_PAIRING_IDS.join(', ')}). ` +
        `No fallback — the pairing id is a closed set.`,
    );
    this.name = 'UnknownFontPairingError';
  }
}

/**
 * Build the <head> injection for a pairing: the Google Fonts <link> + a
 * BOUNDED <style> (font-family on root/body/headings + light type tokens).
 * Throws on an unknown pairing id (closed-set discipline).
 */
export function buildStyleLayerHead(pairingId: string): string {
  if (!isFontPairing(pairingId)) throw new UnknownFontPairingError(pairingId);
  const p = TEXTOS_FONT_PAIRINGS[pairingId];
  const fontsHref = `https://fonts.googleapis.com/css2?family=${p.heading.gf}&family=${p.body.gf}&display=swap`;

  // BOUNDED CSS — type only. See the boundary box at the top of this file.
  const css = [
    `:root{--tx-font-heading:${p.heading.family};--tx-font-body:${p.body.family};}`,
    `html{--bs-body-font-family:var(--tx-font-body);}`,
    `body{font-family:var(--tx-font-body);line-height:1.6;}`,
    `h1,h2,h3,h4,h5,h6,.h1,.h2,.h3,.h4,.h5,.h6,` +
      `.display-1,.display-2,.display-3,.display-4,.display-5,.display-6` +
      `{font-family:var(--tx-font-heading);line-height:1.15;}`,
    `h1,.h1,h2,.h2,.display-1,.display-2,.display-3,.display-4{letter-spacing:-0.01em;}`,
  ].join('');

  return (
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="${fontsHref}">` +
    `<style data-tx-style-layer="${pairingId}">${css}</style>`
  );
}

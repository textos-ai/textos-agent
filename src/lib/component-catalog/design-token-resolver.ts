// factory-v2 — design-token RESOLVER (Phase C).
//
// Takes a component + the tokens chosen for it and returns the REAL Homer
// utility classes to apply. The "box" aspects (surface / elevation / radius /
// border) resolve to Bootstrap/Homer utility classes whose values are the
// existing --ins-* variables — so skin/theme-varied tokens (shadow, tinted,
// accent) resolve through the SKIN machinery (a class reference), never a
// frozen value. The `emphasis` aspect is realized by the bounded TextOS font
// layer (textos-style-layer.ts --tx-*), applied shell-wide — it is recorded but
// not injected per-component (the heading font already carries feature/strong).
//
// VALIDATION (no-fallbacks): a chosen token MUST be in the dictionary AND in the
// component's capabilities.supported[] for that aspect — else THROW. An omitted
// aspect falls back to the component's capabilities.default (today's render).
//
// The resolver emits classes ONLY for NON-default tokens — so an all-defaults
// choice is byte-identical to today's render (capabilities stay inert until a
// real, different token is chosen).

import {
  isDesignToken,
  UnknownDesignTokenError,
  TOKEN_ASPECTS,
  type TokenAspect,
} from './design-tokens';
import type { ComponentCatalogEntry } from './types';

/** Box-aspect tokens (skin/theme-varied ones are CLASS references, not values). */
const OVERRIDE_CLASSES: Partial<Record<TokenAspect, Record<string, string>>> = {
  elevation: { flat: 'shadow-none', sm: 'shadow-sm', raised: 'shadow', lg: 'shadow-lg' },
  radius: {
    square: 'rounded-0', sm: 'rounded-1', rounded: 'rounded', lg: 'rounded-3',
    xl: 'rounded-4', circle: 'rounded-circle', pill: 'rounded-pill',
  },
  border: {
    none: 'border-0', hairline: 'border',
    accent: 'border border-2 border-primary', // border-primary = skin --ins-primary (skin-varied)
    dashed: 'border border-dashed',
  },
  surface: {
    plain: 'bg-transparent border-0 shadow-none',
    card: 'card',
    'raised-card': 'card shadow', // shadow = --ins-box-shadow (theme/skin-varied)
    tinted: 'bg-primary-subtle border-0', // bg-primary-subtle = --ins-primary-bg-subtle (skin-varied)
  },
  // emphasis: NOT root-injected (would bold a whole component). Realized by the
  // --tx-* font layer shell-wide; for SCOPED text targets (e.g. a question
  // label) use EMPHASIS_CLASSES via tokenClass('emphasis', …).
};

/** Emphasis → text utility classes. Only applied to a SPECIFIC text element
 *  (never a component root), so it can't bold an entire component. */
const EMPHASIS_CLASSES: Record<string, string> = {
  muted: 'text-muted',
  default: '',
  strong: 'fw-semibold',
  feature: 'fs-4 fw-bold',
};

/** The Homer utility class(es) for a single (aspect, token) — for SCOPED
 *  application to a chosen element. Returns '' for a no-class token. */
export function tokenClass(aspect: TokenAspect, token: string | undefined): string {
  if (!token) return '';
  if (aspect === 'emphasis') return EMPHASIS_CLASSES[token] ?? '';
  return OVERRIDE_CLASSES[aspect]?.[token] ?? '';
}

export class UnsupportedTokenError extends Error {
  constructor(
    public readonly component_id: string,
    public readonly aspect: string,
    public readonly token: string,
    public readonly supported: string[],
  ) {
    super(
      `factory-v2: component "${component_id}" does not support ${aspect} token "${token}". ` +
        `Its capabilities.${aspect}.supported = [${supported.join(', ')}]. No fallback — a token must be ` +
        `in BOTH the dictionary AND the component's supported set.`,
    );
    this.name = 'UnsupportedTokenError';
  }
}

export type ChosenTokens = Partial<Record<TokenAspect, string>>;

export interface ResolvedTokens {
  /** Homer utility classes to inject (box aspects, non-default only). */
  classes: string;
  /** the final token per aspect the component actually has (default-filled). */
  resolved: Partial<Record<TokenAspect, string>>;
}

/**
 * Validate + resolve a component's chosen tokens. Throws on an unknown or
 * unsupported token; fills omitted aspects with the component's default.
 */
export function resolveComponentTokens(entry: ComponentCatalogEntry, chosen: ChosenTokens = {}): ResolvedTokens {
  const caps = entry.capabilities;
  const classes: string[] = [];
  const resolved: Partial<Record<TokenAspect, string>> = {};

  for (const aspect of TOKEN_ASPECTS) {
    const cap = caps?.[aspect];
    if (!cap) continue; // component doesn't expose this aspect → skip

    let token = chosen[aspect];
    if (token == null || token === '') token = cap.default; // omitted → safe default (today's render)

    // No-fallbacks validation: dictionary membership AND component support.
    if (!isDesignToken(aspect, token)) throw new UnknownDesignTokenError(aspect, String(token));
    if (!cap.supported.includes(token as never)) {
      throw new UnsupportedTokenError(entry.id, aspect, token, cap.supported as string[]);
    }

    resolved[aspect] = token;

    // Emit override classes ONLY for non-default box-aspect tokens.
    if (token !== cap.default) {
      const cls = OVERRIDE_CLASSES[aspect]?.[token];
      if (cls) classes.push(cls);
    }
  }

  return { classes: classes.join(' ').trim(), resolved };
}

/**
 * Inject resolved classes into rendered component HTML. If the component
 * declares `capabilities.style_target` (a class name on the element that should
 * receive the styling, e.g. score-badge → 'avatar-title'), inject there;
 * otherwise into the ROOT element (the first class attribute).
 */
export function injectTokenClasses(html: string, classes: string, targetClass?: string): string {
  if (!classes.trim()) return html;
  if (targetClass) {
    const re = new RegExp(`class="([^"]*\\b${targetClass}\\b[^"]*)"`);
    if (re.test(html)) return html.replace(re, (_m, c) => `class="${c} ${classes}"`);
  }
  return html.replace(/class="([^"]*)"/, (_m, c) => `class="${c} ${classes}"`);
}

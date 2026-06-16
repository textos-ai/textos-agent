# factory-v2 Design-Token Dictionary — PROPOSAL (awaiting Rob's approval)

**Status:** PROPOSAL ONLY. Nothing wired, no per-component metadata, no LLM
changes. This is the vocabulary for Rob to approve before Phase B (populate
per-component capability) / Phase C (LLM picks tokens).
**Scope:** the generated-app / Homer / factory-v2 layer ONLY.
**Date:** 2026-06-01.

---

## Principles (built on the recon, not duplicating it)

1. **Map names onto existing values — never define new ones.** Every token
   below resolves to a value that ALREADY exists: a Homer `--ins-*` CSS
   variable (consumed by a Bootstrap utility class) or a `textos-style-layer.ts`
   `--tx-*` value. We add a *named vocabulary*, not a value set.
2. **Closed set + throw-on-unknown** — same discipline as `isFontPairing()` /
   `UnknownFontPairingError` in `textos-style-layer.ts`. Both the aspect names
   and each aspect's value set are closed; anything outside throws.
3. **Separate from the platform layer.** `textos-web/src/styles/tokens.css`
   (studio/daylight) is a different system. This dictionary does NOT touch,
   merge with, or reference it.
4. **Don't propose a token Homer can't back.** Where the recon showed Homer
   has only one tier, we do NOT invent a second (see "standard" border, below).
5. **Skin/theme-varied tokens resolve through the existing machinery.** Some
   `--ins-*` values change with `[data-skin]` / `[data-bs-theme]`. Those tokens
   are flagged "varies by" — they are NOT fixed hex, and must NOT be frozen to
   one value.

---

## The dictionary (5 aspects, closed sets)

### 1. `elevation` — depth via shadow
| token | maps to | when to use | varies by |
|---|---|---|---|
| `flat` | `.shadow-none` (no shadow) | inputs, flush sections, anything that should sit on the page with no lift | — |
| `sm` | `.shadow-sm` → `--ins-box-shadow-sm` | subtle lift: list items, inline cards, quiet containers | theme (rgba on body color) |
| `raised` | `.shadow` → `--ins-box-shadow` | the standard raised surface: a normal content card | **theme + skin** |
| `lg` | `.shadow-lg` → `--ins-box-shadow-lg` | modals, popovers, hover-elevated or feature callouts that must pop | theme |
| _candidate:_ `inset` | `.shadow-inner` → `--ins-box-shadow-inset` | recessed wells (e.g. a sunken input group) — include only if a component needs it | theme |

### 2. `radius` — corner rounding (all FIXED rem — not skin/theme-varied)
| token | maps to | when to use | varies by |
|---|---|---|---|
| `square` | `.rounded-0` (0) | sharp/technical surfaces: data tables, code, edge-to-edge media | — |
| `sm` | `.rounded-1` → `--ins-border-radius-sm` (0.15rem) | tight rounding: badges, chips, small inputs | — |
| `rounded` | `.rounded` / `.rounded-2` → `--ins-border-radius` (0.2rem) | **default** component rounding: cards, inputs, buttons | — |
| `lg` | `.rounded-3` → `--ins-border-radius-lg` (0.4rem) | softer, friendlier cards and hero panels | — |
| `pill` | `.rounded-pill` → `--ins-border-radius-pill` (50rem) | pill buttons, tags, fully-round CTAs | — |
| _candidates:_ `xl` `.rounded-4` (1rem), `xxl` `.rounded-5` (2rem), `circle` `.rounded-circle` (50%) | available if a feature surface / avatar needs them | — |

### 3. `border` — outline (only ONE width tier exists in Homer → no fake "standard")
| token | maps to | when to use | varies by |
|---|---|---|---|
| `none` | `.border-0` | seamless surfaces (e.g. bg-tinted callouts that don't need an outline) | — |
| `hairline` | `.border` → `--ins-border-width` (1px) + `--ins-border-color` | the standard quiet 1px outline/divider on cards & inputs | theme (color) |
| `accent` | `.border` + `.border-2` + `.border-{skin-color}` (e.g. `.border-primary`) | emphasized / selected / brand-edge outline | **skin** (color) + width |
| `dashed` | `.border` + `.border-dashed` (`--ins-border-style:dashed`) | placeholders, drop zones, "add" affordances | theme (color) |

> **Dropped `standard`** (from the example set): Homer exposes only one 1px
> border tier (`--ins-border-width:1px`), so `hairline` and a separate
> `standard` would map to the **same** value — a distinction Homer can't back.
> Per principle 4, we don't propose it. `accent` (2px + skin color) is the real
> "heavier" tier.

### 4. `surface` — compositions (bg + radius + border + elevation presets)
| token | composition | when to use | varies by |
|---|---|---|---|
| `plain` | transparent bg, no border, `flat` | content flush on the page background (e.g. the light hero) | — |
| `card` | Homer `.card` = `--ins-card-bg` + `hairline` border + `rounded` + `sm` | standard contained content block | theme + skin (card bg/border) |
| `raised-card` | `.card` + `raised` (`.shadow`) | an elevated/feature card meant to stand out | theme + skin |
| `tinted` | `.bg-{color}-subtle` (+ optional `.border-{color}-subtle`) | soft colored callouts (CTA card, score band) keyed to the skin palette | **skin** |

### 5. `emphasis` — type weight/scale/color (via the tx layer + Bootstrap type utils)
| token | maps to | when to use | varies by |
|---|---|---|---|
| `muted` | `.text-muted` + `--tx-font-body` + `.fw-normal` | captions, helper text, de-emphasized meta | theme (color) |
| `default` | `--tx-font-body` + `.fw-normal`, base size | standard body copy | font-pairing (family) |
| `strong` | `--tx-font-body` + `.fw-semibold`/`.fw-bold` | emphasized labels, key inline figures | font-pairing |
| `feature` | `--tx-font-heading` + `.display-*`/`.fs-1`–`2` + `.fw-bold` | hero headline, the score number, section titles — the type that carries personality | **font-pairing** (heading family) |

> `emphasis` reuses `textos-style-layer.ts` (the `--tx-*` font pairing + type
> tokens) for family/line-height and Bootstrap `.fs-*`/`.fw-*`/`.text-muted`
> for scale/weight/color. It does NOT introduce new type values.

---

## Closed-set guard (shape proposal — mirrors `isFontPairing`)

```
// design-tokens.ts (PROPOSED — not built this turn)
export const DESIGN_TOKENS = {
  elevation: ['flat', 'sm', 'raised', 'lg'],
  radius:    ['square', 'sm', 'rounded', 'lg', 'pill'],
  border:    ['none', 'hairline', 'accent', 'dashed'],
  surface:   ['plain', 'card', 'raised-card', 'tinted'],
  emphasis:  ['muted', 'default', 'strong', 'feature'],
} as const;

export type TokenAspect = keyof typeof DESIGN_TOKENS;        // closed
export function isDesignToken(aspect: TokenAspect, name: string): boolean { … }
export class UnknownDesignTokenError extends Error { … }     // throw — no fallback
```
Each `(aspect, name)` resolves to its mapped utility class / `--ins-*` / tx
value through a single resolver — the one place the names meet the values.

---

## Skin/theme-varied tokens (do NOT freeze to a fixed value)

| aspect · token | varies by |
|---|---|
| `elevation: raised` | theme **and** skin (`--ins-box-shadow`) |
| `elevation: sm`, `lg`, `inset` | theme (rgba on `--ins-body-color`) |
| `border: hairline`, `dashed` | theme (`--ins-border-color`) |
| `border: accent` | **skin** (`.border-{color}`) |
| `surface: card`, `raised-card` | theme + skin (card bg/border) |
| `surface: tinted` | **skin** (`.bg-{color}-subtle`) |
| `emphasis: default`, `strong`, `feature` | **font-pairing** (`--tx-*` family) |
| `radius: *` | **fixed** — never varies |

These resolve through the existing `[data-skin]` / `[data-bs-theme]` /
font-pairing machinery — the resolver emits the utility class / var reference,
never a baked hex/rem for the varied ones.

---

## Out of scope this turn (Phase B / C, after approval)
- Per-component **capability** metadata (which tokens each catalog component
  supports + when-to-use) — extends `ComponentCatalogEntry` in `types.ts`.
- LLM token selection at build time.
- The `design-tokens.ts` resolver + wiring into `document-shell` / recipes.

**→ For approval:** the 5 aspects and their closed value-sets above (and the
two judgement calls: dropping `border: standard`, and listing `xl/xxl/circle/
inset` as candidates rather than core).

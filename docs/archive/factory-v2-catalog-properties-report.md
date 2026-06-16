# factory-v2 Catalog — Documented Control/Component Property Surface

**Generated:** 2026-06-02 · **Scope:** read-only audit of `src/lib/component-catalog/*.ts`
**Components:** 65 total — form 21 · display 12 · feedback 9 · utility 9 · data-viz 6 · navigation 5 · layout 3
**Purpose:** show Rob the full surface of what the Factory composes with (per the
`ComponentCatalogEntry` schema in `types.ts`) **and** where the documented surface
has holes — to decide whether an interaction/accessibility capability pass is worth
doing before building the Calculator archetype.

> This is a report of what the catalog **documents today**. "Undocumented" below
> means *not captured as a queryable field in the catalog* — the underlying HTML
> may still behave (e.g. native radios have arrow-key nav); the Factory just has no
> record of it, which is exactly why the Enter-key wizard behavior was a surprise.

---

## 0. How to read this

### The `ComponentCatalogEntry` schema (every component has these fields)
`id` · `name` · `category` · `description` · `homer_classes` · `source_page` ·
`html_template` · `fillable_slots[]` · `js_init` (`noop`|`auto`|`manual`) ·
`js_dependencies[]` (free-text; Pipeline B reads `/homer/*` paths from here) ·
`vendor_scripts[]?` (factory-v2 registry ids — the v2 assembler resolves these) ·
`js_init_snippet?` · `mobile_responsive` · `text_mode` (`native`|`adapted`|`visual-only`) ·
`text_mode_notes?` · `reliability_tier` (`core`|`extended`|`experimental`) ·
`reliability_notes?` · `source_verification` (`verbatim`|`inferred`|`custom`) ·
`inference_confidence?` · `archetype_fits[]` · `example_usage?` · `capabilities?`.

**There is NO field for:** keyboard events, focus order/trap, ARIA roles/attributes,
component states (hover/focus/active/disabled/selected/error), validation/required
semantics, default slot values (those live inline in the template), reduced-motion,
event/callback hooks, or i18n. (See §9 Gap Analysis.)

### Design-token notation (the `capabilities` block)
Five closed aspects (dictionary in `design-tokens.ts`). In the tables, a component's
supported values are listed per aspect with the **default marked `*`**; a blank means
the component does not expose that aspect.

| Aspect | Closed value set |
|---|---|
| **elevation** | flat · sm · raised · lg |
| **radius** | square · sm · rounded · lg · xl · circle · pill |
| **border** | none · hairline · accent · dashed |
| **surface** | plain · card · raised-card · tinted |
| **emphasis** | muted · default · strong · feature |

Token column shorthand: `S` surface · `R` radius · `B` border · `E` elevation · `M` emphasis.
Skin/variant-driven color (e.g. `bg-primary-subtle`, `btn-primary`) is **not** a token —
it comes from the skin palette via a `variant`/`style` slot.

### Global facts (uniform across all 65 — stated once, not repeated per row)
- **`mobile_responsive` = `true` for every component.** The field is non-discriminating;
  where a component actually strains on small screens it's noted only in free-text
  (`reliability_notes`/`text_mode_notes`), never structured. See §9.4.
- Every component has a `capabilities.when_to_use` line.

---

## 1. FORM (21)

| id — name | Archetypes | fillable_slots | Design tokens (`*`=default) | js_init · deps · vendor_scripts | Tier · text_mode | Documented interactive behavior |
|---|---|---|---|---|---|---|
| **text-input** — Text input | strategy, calculator | id, name, label, placeholder, required | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · native | static field |
| **textarea** — Textarea | strategy | id, name, label, placeholder, rows | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · native | static field |
| **email-input** — Email input | strategy, assessment, calculator | id, name, label, required | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · native | browser email validation (implicit) |
| **number-input** — Number input | calculator | id, name, label, min, max, step, value | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · native | native numeric stepper (implicit) |
| **input-with-unit** — Input w/ prefix/suffix | calculator | label, name, type, value, prefix, suffix | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · adapted | static field + affix |
| **select-native** — Native select | strategy, assessment, calculator | label, name, options, placeholder, required | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · native | native dropdown (implicit) |
| **select-choices** — Searchable select (Choices.js) | strategy, assessment | label, name, options, multiple, searchable | B hairline\* · R rounded\* · E flat\* | **auto** · choices.js v11 + form-choice.js · **not set** | extended · adapted | type-to-filter, multi-tag (library; undocumented as fields) |
| **radio-group** — Radio button group | strategy, assessment | label, name, id, options, inline | B hairline\*/accent · R circle\* | noop · — · — | core · native | native radio (arrow-key nav implicit) |
| **checkbox-group** — Checkbox group | assessment | label, name, id, options | B hairline\*/accent · R sm\* | noop · — · — | core · native | native checkbox (Space toggles, implicit) |
| **btn-check-radio** — Button-style radio | strategy, assessment | label, name, id, options | B hairline\*/accent · R rounded\* · S plain\*/tinted · M default\*/strong | noop · — · — | core · native | btn-check radio; `role=group aria-label` in template |
| **btn-check-checkbox** — Button-style checkbox | assessment | label, name, id, options | B hairline\*/accent · R rounded\* · S plain\*/tinted · M default\*/strong | noop · — · — | core · native | btn-check checkbox; `role=group` in template |
| **radio-cards** — Visual radio cards | strategy, assessment | label, name, id, options | B hairline\*/accent · R rounded\*/lg · S plain\*/card · M default/strong\* | noop · — · — | core · adapted | btn-check radios as cards; **no ARIA**; native arrow-keys implicit |
| **range-slider** — Range slider | calculator, assessment | id, name, label, min, max, step, value | S tinted\* · R pill\* | **manual** · — · — (`js_init_snippet` wires live badge) | core · adapted | drag; arrow-keys adjust (native, undocumented); JS updates value badge |
| **touchspin-stepper** — Touchspin stepper | calculator | label, name, value, min, max | B hairline\* · R rounded\* · E flat\* | **auto** (app.js base) · — · — | core · adapted | +/- buttons; auto-bound by app.js |
| **switch** — Toggle switch | strategy, calculator | id, name, label | B hairline\*/accent · R pill\* | noop · — · — | core · native | `role="switch"` in template; Space toggles (implicit) |
| **flatpickr-date** — Date picker | strategy, calculator | label, name, format, range | B hairline\* · R rounded\* · E flat\* | **auto** (app.js Plugins; flatpickr in base bundle) · — · — | extended · adapted | calendar popover; `disableMobile:true` noted as a TODO risk |
| **file-input** — File input | *(none)* | label, name, accept, multiple | B hairline\* · R rounded\* · E flat\* | noop · — · — | core · visual-only | native file picker |
| **form-validation-state** — Bootstrap validation | strategy, assessment, calculator | error_message, success_message | B hairline\*/accent · R rounded\* | **auto** (app.js wires `.needs-validation`) · — · — | core · adapted | on-submit valid/invalid styling |
| **submit-button** — Submit button | strategy, assessment, calculator | label, variant, size | B none\*/hairline · R rounded\*/pill · S tinted\* · M default/strong\* | noop · — · — | core · native | **Enter-in-field implicitly submits the form** (the wizard-fix gotcha) — undocumented |
| **star-rating** — Star rating (1-5) *(custom)* | assessment | label, name, id, stars | B none\* | **auto** · /homer/js/tx-star-rating.js · **not set** | core · adapted | click/hover stars; custom JS; **no ARIA, keyboard story undocumented** |
| **quill-editor** — Rich text editor *(form)* | *(none)* | id, height | B hairline\* · R rounded\* · E flat\* | **manual** · Quill (~200KB, not bundled) · **not set** | **experimental** · adapted | WYSIWYG editor (library) |

---

## 2. DISPLAY (12)

| id — name | Archetypes | fillable_slots | Design tokens (`*`=default) | js_init · deps | Tier · text_mode | Interactive behavior |
|---|---|---|---|---|---|---|
| **card-basic** — Basic card | strategy, assessment, calculator | header, title, content, footer | S card\*/raised-card/tinted · E flat\*/sm/raised/lg · R square/sm/rounded\*/lg/xl · B none/hairline\*/accent · M default/strong\*/feature | noop · — | core · native | static container |
| **card-cta** — CTA card | strategy, assessment, calculator | headline, supporting_text, cta_url, cta_label | S tinted\*/card/raised-card · B none\*/hairline · R rounded\*/lg/xl · E flat\*/sm/raised · M strong/feature\* | noop · — | core · adapted | one anchor CTA |
| **card-pricing** — Pricing/plan card | strategy | title, subtitle, price, price_meta, features, cta_url, cta_label, badge, variant | S card\*/tinted/raised-card · R rounded/lg/xl\* · B none/hairline\*/accent · E flat\*/sm/raised/lg · M strong/feature\* | noop · — | core · adapted | static; footer CTA |
| **list-group** — List group | strategy, assessment, calculator | items | B hairline\*/none · R rounded\*/square · S card\*/plain · E flat\*/sm | noop · — | core · native | static list (optional active/disabled item flags) |
| **timeline** — Timeline | strategy | items | S plain\* · M default/strong\* | noop · — | core · adapted | static vertical sequence |
| **badge** — Badge | strategy, assessment, calculator | label, style, pill | S tinted\* · R sm\*/rounded/pill · M strong\* | noop · — | core · native | static chip |
| **score-badge** — Large score badge | assessment | score, label, sublabel, variant | S tinted\* · R circle\* · M feature\* · E flat\*/sm/raised · **style_target=`avatar-title`** | noop · — | core · native | static; **no aria for the number** |
| **large-number** — Animated number | calculator, assessment | label, value, prefix, suffix, subtitle | S plain\*/card/tinted · M feature\* | **auto** (app.js initCounter, IntersectionObserver) · — | core · native | count-up animation; **no aria-live / reduced-motion** |
| **avatar** — Avatar | *(none)* | size, src, alt, icon, initials, variant | S tinted\* · R circle\* | noop · — | core · visual-only | static; `alt` slot present |
| **table-static** — Static table | calculator, assessment | columns, rows | S plain\*/card · B none/hairline\* · M default\*/strong | noop · — | core · adapted | static; **no caption/scope**; wide tables scroll on mobile (free-text note) |
| **blockquote** — Blockquote | strategy | quote, cite | S plain\*/tinted/card · B none\*/accent · M default\*/strong/feature | noop · — | core · native | static |
| **lightbox** — Image lightbox *(display)* | *(none)* | full_url, thumb_url, alt | R square\*/sm/rounded/lg | **manual** · GLightbox (not bundled) · **not set** | extended · visual-only | click-to-zoom overlay (library) |

---

## 3. NAVIGATION (5)

| id — name | Archetypes | fillable_slots | Design tokens (`*`=default) | js_init · deps · vendor_scripts | Tier · text_mode | Interactive behavior |
|---|---|---|---|---|---|---|
| **wizard** — Multi-step wizard | strategy, assessment | steps, step.id, step.title, step.subtitle, step.icon, step.content | B hairline\*/none · R rounded\*/square · E flat\*/sm | **auto** · Bootstrap Tab + form-wizard.js · **`['form-wizard']`** ✓ | extended · adapted | prev/next/submit buttons + progress + step validation. **Keyboard NOT documented:** Enter→advance/submit is recipe-injected, *not* a component property; Bootstrap-Tab arrow-key nav, focus order, `role=tab/tabpanel/aria-selected` all uncaptured |
| **tabs** — Tabs | strategy, assessment, calculator | tabs, tab.id, tab.label, tab.content | B hairline\*/none · R rounded/square\* · M default\*/strong | noop · Bootstrap · — | core · adapted | tab switch; Bootstrap arrow-key nav (undocumented) |
| **accordion** — Accordion | strategy, calculator | id, items, item.itemId, item.title, item.content, item.open | B hairline\*/none · R rounded\*/square · S card\*/plain · E flat\*/sm | noop · Bootstrap · — | core · adapted | collapse toggle; Enter/Space on header (undocumented) |
| **pagination** — Pagination | *(none)* | pages, prevDisabled, nextDisabled | B hairline\*/none · R rounded\*/square/pill | noop · — · — | core · adapted | page links |
| **breadcrumb** — Breadcrumb | *(none)* | items | *(none — minimal, no box)* | noop · — · — | core · visual-only | path links |

---

## 4. FEEDBACK (9)

| id — name | Archetypes | fillable_slots | Design tokens (`*`=default) | js_init · deps | Tier · text_mode | Interactive behavior · in-template ARIA |
|---|---|---|---|---|---|---|
| **alert** — Alert / inline notice | strategy, assessment, calculator | variant, message, icon, dismissible | S tinted\* · B none\*/accent · R rounded\* | noop · Bootstrap (Alert) | core · native | dismiss button (optional). ARIA: `role=alert` ✓ |
| **toast** — Toast notification | strategy, assessment, calculator | id, title, message | S card/raised-card\* · R rounded\* · E raised/lg\* | **manual** (`.show()`) · Bootstrap | core · adapted | floating dismiss. ARIA: `role=alert aria-live=assertive aria-atomic` ✓ |
| **progress-bar** — Progress bar | assessment, calculator | percent, variant, size, height, striped, animated | R rounded/pill\* | noop · — | core · adapted | optional animation (no reduced-motion). ARIA: `role=progressbar aria-valuenow/min/max` ✓ |
| **spinner** — Loading spinner | strategy, assessment, calculator | style, variant | *(none)* | noop · — | core · visual-only | spin animation. ARIA: `role=status` + `visually-hidden "Loading..."` ✓ |
| **modal** — Modal | strategy, assessment, calculator | id, title, content, footer, size, centered | S card/raised-card\* · R rounded/lg\* · E lg\* | noop · Bootstrap | core · adapted | overlay; Esc-close + focus-trap (Bootstrap, undocumented). ARIA: `tabindex=-1` only |
| **tooltip** — Tooltip | calculator | tip, label | R sm\*/rounded · E sm\* | **auto** · Bootstrap (Tooltip) | core · visual-only | hover **and focus** trigger (focus not documented) |
| **popover** — Popover | *(none)* | title, content, label | S card/raised-card\* · R sm/rounded\* · E sm/raised\* | **auto** · Bootstrap (Popover) | core · visual-only | click/hover popup |
| **sweetalert** — SweetAlert dialog | strategy, assessment, calculator | title, text, icon, confirmButtonText | *(none — library-owned)* | **manual** · sweetalert2 v11 (not bundled) | extended · adapted | Enter-confirm/Esc-cancel/focus-trap (library, undocumented) |
| **placeholder-skeleton** — Skeleton loader | strategy, assessment, calculator | bars | R square/rounded\* | noop · — | core · visual-only | shimmer animation (no reduced-motion) |

---

## 5. DATA-VIZ (6)  — all Chart.js `<canvas>`, `js_init: manual`

| id — name | Archetypes | fillable_slots | Design tokens | deps · vendor_scripts | Tier · text_mode | Notes |
|---|---|---|---|---|---|---|
| **chart-bar** — Bar chart | assessment, calculator | id, height | *(none — canvas)* | Chart.js v4 · **not set** | core · visual-only | colors via `ins('chart-*')` (skin) |
| **chart-line** — Line chart | calculator | id, height | *(none)* | Chart.js v4 · **not set** | core · visual-only | trend/projection |
| **chart-area** — Area chart | calculator | id, height | *(none)* | Chart.js v4 · **not set** | core · visual-only | filled line |
| **chart-doughnut** — Doughnut/pie | assessment, calculator | id, height | *(none)* | Chart.js v4 · **not set** | core · visual-only | part-to-whole |
| **chart-radar** — Radar chart | assessment | id, height | *(none)* | Chart.js v4 · **`['custom-chartjs']`** ✓ | core · visual-only | ≤6 axes (free-text); the Assessment visual |
| **chart-polar** — Polar-area | assessment | id, height | *(none)* | Chart.js v4 · **not set** | core · visual-only | magnitude-by-radius |

> **All six** emit a bare `<canvas>` with **no `aria-label`, `role="img"`, title, or
> data-table fallback** — invisible to screen readers (see §9.2). Only `chart-radar`
> declares its `vendor_scripts` registry id; the other five rely on the base bundle
> being the full one (see §9.3).

---

## 6. LAYOUT (3)

| id — name | Archetypes | fillable_slots | Design tokens | js_init | Tier · text_mode | Notes |
|---|---|---|---|---|---|---|
| **container** — Container | strategy, assessment, calculator | content, fluid | *(none — pure wrapper)* | noop | core · visual-only | explicitly carries no surface/border/radius/elevation/emphasis |
| **row-col** — Row + Column grid | strategy, assessment, calculator | cols, gap | *(none — pure layout)* | noop | core · visual-only | tokens live on children, not the grid |
| **section-hero** — Hero section | strategy, assessment, calculator | bg_url, headline, tagline, cta_url, cta_label, height, light | S plain\*/tinted/raised-card · M feature\* · R square\*/rounded/lg · E flat\*/sm/raised | noop | core · visual-only | `light` boolean slot toggles dark-slab vs transparent |

---

## 7. UTILITY (9)

| id — name | Archetypes | fillable_slots | Design tokens (`*`=default) | js_init · deps · vendor_scripts | Tier · text_mode | Interactive behavior |
|---|---|---|---|---|---|---|
| **clipboard-copy** — Copy button | strategy, assessment, calculator | target_id, value, label | B hairline\*/accent · R rounded\*/pill/square | **manual** · clipboard.js v2 (not bundled) · **not set** | extended · adapted | copies target to clipboard |
| **share-bar** — Social share bar | strategy, assessment, calculator | url, text, subject, body | B hairline\*/accent · R rounded\*/pill/square | **manual** · clipboard.js (copy btn) · **`[]`** (explicit: anchors need none) | core · adapted | anchor share links + copy button |
| **download-button** — Download button | strategy, assessment, calculator | url, label, variant, download | B hairline\*/accent · R rounded\*/pill/square | noop · — · — | core · adapted | anchor w/ `download` attr |
| **collapse** — Collapse / show-more | strategy, calculator | id, content | B hairline\*/accent · R rounded\*/pill/square | noop · Bootstrap · — | core · adapted | toggle reveal; Enter/Space on trigger (undocumented) |
| **offcanvas** — Offcanvas drawer | *(none)* | id, trigger, title, content, position | S plain\*/card · R rounded\*/pill/square | **auto** · Bootstrap · — | core · visual-only | slide-in drawer; Esc-close/focus-trap (undocumented) |
| **dropdown** — Dropdown menu | strategy, calculator | variant, label, items | B hairline\*/accent · R rounded\*/pill/square | noop · Bootstrap · — | core · adapted | menu; arrow-key nav/Esc (undocumented) |
| **password-strength** — Strength meter | *(none)* | *(none)* | *(none)* | **auto** · /homer/js/pages/misc-pass-meter.js · **not set** | extended · visual-only | live strength bar (likely unused in mini-apps) |
| **tour** — Guided tour | *(none)* | *(none)* | *(none — JS-driven, no markup)* | **manual** · tourguide.js (not bundled) · **not set** | **experimental** · visual-only | onboarding overlay (library) |
| **tx-bind** — Reactive input→output *(custom)* | calculator | input_id, output_id, value, expression, format | *(none — behavioral helper)* | **auto** · /homer/js/tx-bind.js · **not set** | core · visual-only | recomputes output on every keystroke (`input` event); `new Function()` evaluator |

---

## 8. Cross-cutting summaries

### 8.1 Archetype coverage (`archetype_fits`)
| Archetype | # components | Notable |
|---|---|---|
| strategy | 28 | the most-built; full form + display + nav coverage |
| assessment | 23 | radio/checkbox-heavy + charts + score-badge |
| calculator | 24 | number/unit inputs, range, touchspin, tx-bind, charts, table — **the archetype not yet built** |
| *(none)* — composable but unassigned | 9 | file-input, quill-editor, avatar, pagination, breadcrumb, lightbox, offcanvas, password-strength, tour, popover |

### 8.2 Reliability tier
| Tier | Count | Members |
|---|---|---|
| **core** | 56 | the default shipping set |
| **extended** | 7 | select-choices, flatpickr-date, sweetalert, lightbox, clipboard-copy, password-strength, wizard |
| **experimental** | 2 | quill-editor, tour (excluded by `getArchetypeComponents`) |

### 8.3 text_mode (Telegram/SMS readiness)
native 14 · adapted 28 · visual-only 23. (Charts, hero, spinner, avatar, file-input,
offcanvas, lightbox, tour, password-strength, tx-bind, breadcrumb, tooltip, popover,
skeleton = visual-only → no text/bot equivalent.)

### 8.4 Vendor-script registry (`vendor-scripts.ts`) — for reference
**Base-bundle capabilities** (validated, not loaded): `chartjs`, `custom-chartjs`
(provides `CustomChartJs`,`ins`; in `app.js` NOT `app.mini.js`), `jquery`, `bootstrap`,
`flatpickr`, `simplebar`.
**Add-on files:** `form-wizard`, `choices`, `form-choice`, `handlebars`, `typeahead`,
`form-typehead`, `datatables`(+`-bs5`/`-responsive`), `jszip`, `pdfmake`, `sweetalert2`.
**Base bundles:** `BASE_BUNDLE_FULL` (vendors.min.js + **app.js** → Chart, CustomChartJs,
ins, $, jQuery, bootstrap, flatpickr, SimpleBar, debounce) vs `BASE_BUNDLE_MINI`
(app.mini.js — **lacks** CustomChartJs/ins).

---

## 9. GAP ANALYSIS — what the catalog does NOT document

### 9.1 Keyboard / focus / interaction surface — **entirely uncaptured** ⚠️ (the headline gap)

The `ComponentCatalogEntry` schema has **no field** for keyboard events, focus
management, or interaction semantics. The only interaction-adjacent fields —
`js_init`, `js_init_snippet`, `js_dependencies`, `vendor_scripts` — describe how a
component is *initialized*, not how it *behaves on keypress/focus*. **Confirmed: this
is why the Enter-to-advance wizard behavior was a surprise** — no component records its
keyboard behavior, and the eventual fix lives in the recipe's inline script, not as a
catalog property of `wizard`.

Components with **meaningful keyboard/interactive behavior that is currently
undocumented** (behavior is real — native, Bootstrap, or library — the catalog just
doesn't record it):

| Component | Undocumented keyboard/focus behavior |
|---|---|
| **wizard** | Enter→next/submit (recipe-injected, not a catalog prop); Bootstrap-Tab ←/→ step nav; Tab focus order; `data-wizard-next/prev` are buttons (Space/Enter) |
| **submit-button** | **Enter in any form field implicitly submits** — the exact gotcha behind the wizard fix |
| **radio-group, btn-check-radio, radio-cards** | native radio ↑↓←→ moves *and* selects; Space selects; roving focus |
| **checkbox-group, btn-check-checkbox** | Space toggles; Tab between boxes |
| **switch** | Space toggles (`role="switch"` present, `aria-checked` not managed) |
| **select-native** | open + type-ahead option jump |
| **select-choices** | type-to-filter, ↑↓/Enter select, Backspace removes tag, Esc closes (Choices.js) |
| **range-slider** | ←→/PageUp/Down/Home/End adjust value |
| **touchspin-stepper** | ↑↓ on the number field; +/- buttons |
| **flatpickr-date** | calendar arrow-key day nav, Enter select, Esc close |
| **tabs** | Bootstrap ←/→ tab nav |
| **accordion / collapse** | Enter/Space on header/trigger toggles |
| **dropdown** | ↑↓ through items, Esc closes, focus return |
| **modal / offcanvas** | **Esc closes, focus trap, focus return** (Bootstrap) — only `tabindex=-1` hints at it |
| **tooltip / popover** | show on **focus** (keyboard), not just hover |
| **sweetalert** | Enter confirm / Esc cancel / focus trap (library) |
| **star-rating** *(custom)* | btn-check radios → arrow-keys/Space natively, but **no documented keyboard story and no per-star labels** |
| **tx-bind** *(custom)* | recomputes on **every keystroke** (`input` event) — live-update timing undocumented |
| **pagination, clipboard-copy, share-bar, download-button** | links/buttons: Tab + Enter/Space activate |

**Purely static (no interaction to document):** text/email/number inputs (beyond native
typing), card-basic, card-cta, card-pricing, list-group, timeline, badge, score-badge,
avatar, table-static, blockquote, container, row-col, section-hero, breadcrumb,
spinner, progress-bar, placeholder-skeleton.

### 9.2 Accessibility / ARIA — present ad-hoc in some templates, **no structured field, large holes**

ARIA today is **hand-written inline in `html_template`** for a handful of components and
absent everywhere else. There is no `aria`/`a11y` field, so you cannot query "which
components are screen-reader-ready."

**Has ARIA in-template (✓):**
| Component | ARIA present |
|---|---|
| alert | `role="alert"` |
| toast | `role="alert" aria-live="assertive" aria-atomic="true"` |
| progress-bar | `role="progressbar" aria-valuenow/valuemin/valuemax` |
| spinner | `role="status"` + `.visually-hidden "Loading..."` |
| btn-check-radio / btn-check-checkbox | `role="group"` (+ `aria-label` on radio) |
| switch | `role="switch"` (but `aria-checked` not toggled) |
| modal / offcanvas | `tabindex="-1"` (relies on Bootstrap for the rest) |
| avatar | `alt` slot on `<img>` |

**Missing / no accessibility story (✗):**
| Component | Gap |
|---|---|
| **all 6 charts** | bare `<canvas>` — no `role="img"`, `aria-label`, or data-table fallback → **invisible to SR** |
| **radio-cards** | no group role / labelling beyond the visual label |
| **star-rating** *(custom)* | no `role="radiogroup"`, no per-star `aria-label`, no `aria-checked` |
| **score-badge** | the headline number has no aria / SR text |
| **large-number** | animates 0→value with **no `aria-live`** (SR reads "0") |
| **table-static** | no `<caption>` or `scope` on headers |
| **wizard / tabs** | step/tab panes lack explicit `role="tab"/"tabpanel"/"aria-selected"` wiring in the template (leans on Bootstrap defaults) |
| **timeline, list-group, blockquote, breadcrumb** | semantic-only; no enrichment |

### 9.3 `vendor_scripts` coverage — populated on only **3 of 65** components ⚠️

The factory-v2 assembler resolves scripts from `vendor_scripts`, but it is set on only
`wizard` (`['form-wizard']`), `chart-radar` (`['custom-chartjs']`), and `share-bar`
(`[]`, deliberately empty). Every other JS-backed component relies on either the base
bundle (fine) or free-text `js_dependencies` that the v2 resolver ignores.

| Component | Real JS need | Resolvable by v2 assembler today? |
|---|---|---|
| select-choices | choices.min.js + form-choice.js | **No** — registry has `choices`/`form-choice`, but component's `vendor_scripts` is unset |
| sweetalert | sweetalert2.min.js | **No** — in registry (`sweetalert2`), `vendor_scripts` unset |
| chart-bar/line/area/doughnut/polar | Chart.js + CustomChartJs | **Partial** — works only because the full base bundle provides them; `vendor_scripts` unset (no build-time check) |
| star-rating *(custom)* | tx-star-rating.js | **No** — **not in the registry at all** |
| tx-bind *(custom)* | tx-bind.js | **No** — **not in the registry at all** |
| clipboard-copy / share-bar copy | clipboard.js | **No** — **not in the registry** |
| lightbox | GLightbox | **No** — **not in the registry** |
| quill-editor | Quill | **No** — **not in the registry** |
| password-strength | misc-pass-meter.js | **No** — **not in the registry** |
| tour | tourguide.js | **No** — **not in the registry** |
| touchspin-stepper, flatpickr-date, form-validation-state, large-number, tooltip, popover, toast, modal, accordion, tabs, collapse, offcanvas, dropdown | app.js / Bootstrap (base bundle) | **Yes** (base bundle) |

Net: of the components that need an **add-on** file, only `wizard` is fully wired; 7
libraries (clipboard, GLightbox, Quill, tourguide, tx-bind, tx-star-rating,
misc-pass-meter) **aren't in the vendor registry at all**. Composing any of those into a
real app would not auto-load its script.

### 9.4 Other inconsistent / missing property categories

| Category | Status |
|---|---|
| **Component states** (hover / focus / active / disabled / selected / error) | No field. Scattered hints in `capabilities.*.notes` ("selected → accent"), never structured. |
| **`mobile_responsive`** | Uniformly `true` (65/65) → carries no information. Real breakpoint strain (flatpickr `disableMobile`, wide tables scroll, Quill toolbar, radar ≤6 axes) lives only in free-text notes. |
| **Default slot values** | Encoded inline in templates (`{{rows\|5}}`, `{{variant\|primary}}`) — not surfaced as a queryable field. |
| **Validation / required semantics** | Only `text-input`/`email-input` pass a `required` slot; no structured validation model (`form-validation-state` is a separate wrapper component). |
| **Reduced-motion** | Animated components (large-number count-up, progress `animated`, skeleton shimmer, spinner, charts) document no `prefers-reduced-motion` story. |
| **"No design surface" vs "undocumented"** | Components with only `when_to_use` (charts, spinner, breadcrumb, container, row-col, tour, tx-bind, password-strength, sweetalert) don't *explicitly* flag "intentionally no tokens" vs "tokens not yet documented" — though most notes imply the former. |
| **`style_target`** | Used by exactly one component (`score-badge` → `avatar-title`). Fine, but worth knowing it's a near-unique escape hatch. |
| **`example_usage`** | Sparse — present on ~13 of 65. |
| **Event/callback hooks, analytics, i18n** | No fields. |

---

## 10. Bottom line for the build-vs-pass decision

- **What's solid:** design-token capabilities are documented consistently across all 65
  (every component has a `capabilities` block); archetype fits, tiers, text-mode, and
  slot lists are complete and queryable.
- **The two real holes** are exactly the ones the wizard fixes exposed:
  1. **Interaction/keyboard/focus is a totally uncaptured dimension** — behavior that
     exists (native + Bootstrap + library) is invisible to the catalog, so it surprises
     us per-component (Enter key) and per-recipe (the fix lives outside the catalog).
  2. **Accessibility/ARIA is ad-hoc** — good on ~8 components, absent on the rest, with
     charts + custom components (star-rating, score-badge, large-number) being the
     sharpest screen-reader gaps.
- **A secondary hole:** `vendor_scripts` is wired on only 3/65, and 7 add-on libraries
  aren't registered — so the v2 assembler can only auto-load scripts for `wizard` and the
  charts (via the full base bundle). Anything else composed in would silently miss its JS.
- **Calculator dependency check:** the Calculator-fit components lean on exactly the
  under-wired interactive pieces — `range-slider` (manual JS), `touchspin-stepper`,
  `number-input`, `tx-bind` (custom, unregistered, keystroke-reactive), and the charts.
  Building Calculator will hit gaps #1 and #3 directly (live-recompute + script loading +
  keyboard on sliders/steppers), so an interaction/vendor-wiring pass would de-risk it
  rather than being orthogonal to it.

*Report only — no code changed, nothing deployed.*

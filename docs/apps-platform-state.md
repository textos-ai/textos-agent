# Apps Platform — Current State vs PRDs

Last updated: 2026-06-02 (Calculator archetype dependency wiring — tx-bind added to
the vendor registry + chart-bar/chart-doughnut vendor_scripts; latent app.js
auto-init-dead-in-iframe backlog item recorded — see §5.6. Earlier same day:
Strategy styling backport + wizard UX fixes for BOTH archetypes — see §5.5. Strategy now carries the same font pairing + per-component
design tokens + both-sides card framing as the Assessment; radio-card option
subtext stacks under the title and Enter advances/submits the wizard, in both
live apps. Prior: 2026-06-01 Phase 1 COMPLETE — the clean factory-v2 Strategy app
serves on the REAL /sites/{slug}/apps/{slug}/ route on real business context
with a persisted skin, through the unchanged delivery path; see §4. Earlier the
same day: added §4 for the /dev/ pipeline; the §2 raw-HTML pipeline is slated
for retirement at cutover. Prior: 2026-05-30, items #2/#3 RESOLVED)

This document is the reconciliation between the apps-platform PRD intent
(`textos-component-factory-prd.md` — generated apps, primary spec;
`textos-homer-platform-prd.md` — platform UI companion; both in project
knowledge) and what is actually shipped in code today. Read it before
any apps-platform work; update it after any apps-platform commit.

Authoritative catalog: `C:\code\textos-web\.homer-reference\catalog-recon-report.md`
(Homer v3.2.0 recon — 42 catalog entries). See also
`docs/backlog-v2-architectural-debt.md` (items #1–#6) for the per-defect
backlog this drift summary points at.

---

## 1. PRD intent (summary)

- **Composition over generation.** The LLM picks components from a
  curated catalog and supplies *data only*; the assembler stitches the
  Homer markup. The model never writes HTML/CSS/JS.
- **Catalog is canonical.** The component library is the Homer set
  documented in `catalog-recon-report.md` (42 entries, each with verbatim
  `html_template`, `archetype_fits`, `js_dependencies`, `reliability_tier`).
- **Template engine renders Homer's authored notation.** The catalog
  templates use Homer/report notation: `{{slot:content}}` slots,
  `{{label|Default}}` pipe defaults, `{{flag?class}}` conditional classes,
  and `{{#section}}…{{/section}}` blocks.
- **Multi-step apps use Homer's wizard component.** The `wizard` catalog
  entry (`form-wizard.html`: `.ins-wizard` + `data-wizard-*` +
  Bootstrap `.nav-tabs`/`.tab-pane` + `form-wizard.js`) is the intended
  multi-step navigation primitive.
- **Tiered edits** (factory PRD §6): operator edits classified as
  style-only / layout / full-regen, applied at the appropriate layer.

---

## 2. Current implementation

> **Retirement notice (2026-06-01):** the pipeline described in this section
> (the `generate-business-app-v2` → `assembleApp()` →
> `phase-renderer`/`document-wrapper` path, with its code-side transform and
> emitted orchestration script) is the path shipping today, but it is **slated
> for retirement at cutover** in favour of the clean factory-v2 pipeline in
> **§4**, which now runs the full wizard→LLM→locked-recipe→catalog-compose→
> themed-result flow end-to-end. Until cutover this §2 path remains the
> production generator; do not delete it yet.

Describes only what is actually shipped right now, with file citations.

- **Catalog storage:** `src/lib/component-catalog/*.ts`
  (`form.ts`, `display.ts`, `layout.ts`, `feedback.ts`, `navigation.ts`,
  `data-viz.ts`, `utility.ts`, aggregated by `index.ts` into `CATALOG`).
  These are TypeScript object literals headed "Auto-extracted from
  catalog-recon-report.md (R4)" — a verbatim transcription of the report.
  This is **NOT** the Supabase `app_components` table the PRD (§4.2)
  envisions; it is hardcoded TS.
- **Template engine:** `src/lib/assembler/template.ts` — a thin wrapper
  over the **`mustache`** npm package (v4.2.0, per `package.json`). It
  overrides `Mustache.escape` for HTML-escaping but otherwise renders
  with plain vanilla Mustache (`Mustache.render`).
- **Assembler entry:** `src/lib/assembler/assembler.ts` — archetype
  lookup → Zod validate (`validation/index.ts`) → per-phase render →
  document wrap. Pure function, no network/DB/LLM.
- **Phase renderer / multi-step:** `src/lib/assembler/phase-renderer.ts`
  — `renderWizardInputs()` emits the wizard markup **hand-rolled** (its
  own `.tx-wizard` / `.tx-wizard-step` divs and hardcoded
  "Next →" / "← Back" buttons), **NOT** the Homer `wizard` catalog
  component. Step advance/back is wired by an emitted orchestration
  script (see below), not Homer's `form-wizard.js`.
- **Document wrapper:** `src/lib/assembler/document-wrapper.ts` — wraps
  phase chunks in a full HTML doc and **does** reference the real Homer
  runtime assets by URL: `${fe}/homer/css/vendors.min.css`,
  `${fe}/homer/css/app.min.css`, `${fe}/homer/js/vendors.min.js`,
  `${fe}/homer/js/app.mini.js`, plus any per-component `/homer/js/...`
  deps collected from the manifest. Also emits an inline phase-
  orchestration script (submit → paywall → result wiring) and an inline
  PDF-print `<style>`/`<script>` block.
- **Runtime assets (in textos-web):** `public/homer/*` — `vendors.min.js`
  (870KB: real jQuery 3.7.1 + Bootstrap 5.3.6 + Chart.js 4.4.9 +
  flatpickr + SimpleBar), `app.mini.js` (12KB stripped bootstrapper),
  `vendors.min.css`, `app.min.css`, Tabler icon font, plus the custom
  `tx-bind.js` and `tx-star-rating.js`. (Note: `app.min.js` does not
  exist — the wrapper loads `app.mini.js`, which is correct.)
- **Archetypes / recipes:** `src/lib/archetypes/*.ts` define each
  archetype's phases and per-component `slot_bindings` (strategy,
  assessment, calculator).
- **v2 handler:** `src/lib/tasks/generate-business-app-v2.ts` — plain-
  text-JSON Anthropic call + a code-side transform to the schema shape,
  then `assembleApp()`. Stores `asset_type='app'` in `business_assets`.

---

## 3. Known drift from PRD intent

Each delta: `{ item, intent_per_prd, current_state, blocking_or_followup, related_backlog_item }`.

1. **Catalog storage location**
   - intent_per_prd: catalog lives in a Supabase `app_components` table
     (PRD §4.2), editable as data.
   - current_state: hardcoded TS object literals in
     `src/lib/component-catalog/*.ts` (transcribed from the recon report).
   - blocking_or_followup: follow-up (works today; violates the
     tasks/components-as-data principle and CLAUDE.md "no constants for
     DB-driven data" spirit).
   - related_backlog_item: none yet — file a new backlog item.

2. **Template-engine constructs unsupported**
   - intent_per_prd: the template engine is a composition primitive that
     renders Homer's authored notation (`{{slot:content}}`,
     `{{label|Default}}` pipe defaults, `{{flag?class}}` conditional
     classes, section blocks).
   - current_state: `assembler/template.ts` uses **vanilla Mustache**,
     which understands `{{x}}` and `{{#x}}…{{/x}}` but **not** the three
     custom constructs: `{{slot:content}}` (read as a literal key
     "slot:content" → renders empty), `{{label|Default}}` pipe defaults
     (no default applied → renders empty), and `{{flag?class}}`
     conditional classes (renders empty). Net effect: faithful Homer
     components render their chrome but drop slotted bodies / defaults /
     conditional classes.
   - blocking_or_followup: ✅ **RESOLVED 2026-05-30.** `assembler/template.ts`
     now runs `preprocessHomerConstructs()` before Mustache, rewriting
     `{{slot:NAME}}`→`{{{NAME}}}`, `{{key|default}}`, `{{key?class}}`, and
     `{{key?truthy:falsy}}` (covered by `assembler/__tests__/template.test.ts`).
     Homer slots, pipe-defaults, and conditional classes now render. (The
     result phase can still look thin — that's backlog #5(b)/(c), the
     array-iteration and optional-gating gaps, NOT the template engine.)
   - related_backlog_item: backlog #5 (engine half done; 5(b)/(c)/(d) open).

3. **Multi-step renderer**
   - intent_per_prd: multi-step apps use the Homer `wizard` catalog
     component (`.ins-wizard` + `data-wizard-*` + `form-wizard.js`).
   - current_state: ✅ **RESOLVED 2026-05-30.** `phase-renderer.ts`
     `renderWizardInputs()` now composes the Homer `c_wizard` catalog
     component (`CATALOG.by_id['wizard']` → `renderTemplate(wizardCat.html_template,
     { steps })`), records `wizard` in the manifest so `form-wizard.js`
     auto-loads, and throws (no-fallbacks) if the wizard component or its
     catalog entry is missing — no more hand-rolled `.tx-wizard`.
   - blocking_or_followup: resolved. (Per-step "Step N" titles are still
     placeholders pending archetype generalization — that is backlog #1, a
     separate item, not the wizard-composition drift.)
   - related_backlog_item: backlog #3 (terminal submit button) — fixed;
     wizard-component adoption — now done (2026-05-30).

4. **Per-archetype generation (strategy-only)**
   - intent_per_prd: strategy, assessment, and calculator archetypes all
     generate correctly per their recipes.
   - current_state: generation is strategy-only; assessment/calculator
     are validated but mis-generated (prompt + transform are strategy-
     shaped). Frontend disables those tiles ("Coming soon").
   - blocking_or_followup: blocking for non-strategy archetypes;
     follow-up for strategy.
   - related_backlog_item: backlog #1.

5. **Validation pipeline (generate simple, validate strict)**
   - intent_per_prd: parsed LLM output validated against the archetype's
     Zod schema with a parse + validate + retry-once guard.
   - current_state: the executed path does a manual required-field check,
     not Zod validation; `validateContent` was imported-but-unused (since
     removed). Assembler does validate at assemble time, but the handler's
     "generate simple, validate strict" loop is not wired.
   - blocking_or_followup: follow-up.
   - related_backlog_item: backlog #2.

6. **Question/recipe contract mismatch**
   - intent_per_prd: the renderer honors each question's LLM-supplied
     type and renders all questions the model emits.
   - current_state: the strategy recipe hardcodes 7 fixed-type question
     slots; the prompt emits 10 single-choice questions, so several lose
     their choices and q8–q10 don't render. (Assessment already does
     type-driven candidate selection; strategy does not.)
   - blocking_or_followup: blocking correct strategy output.
   - related_backlog_item: backlog #6.

7. **Model hardcoded in the executed call**
   - intent_per_prd: the call uses the tier-resolved model.
   - current_state: the primary `anthropic.messages.create` hardcodes
     `claude-sonnet-4-20250514` rather than `resolveModelForTier(tier)`
     (retry path and work_log use the resolved model — they can diverge).
   - blocking_or_followup: follow-up (time-pressured: that model id is
     scheduled to retire 2026-06-15).
   - related_backlog_item: backlog #3 (architectural-debt doc item #3).

8. **CTA URL placeholder substitution**
   - intent_per_prd: the assembler swaps the CTA sentinel for the operator
     URL at render time.
   - current_state: the resolver only swaps the exact sentinel string
     `cta_url_placeholder`, but the transform emits
     `"/business/{{business_slug}}/contact"` — not the sentinel — so the
     raw string (with an unsubstituted `{{business_slug}}`) renders into
     the href.
   - blocking_or_followup: follow-up.
   - related_backlog_item: backlog #5(d).

---

## 4. Clean factory-v2 pipeline (NEW — running end-to-end on /dev/)

A from-scratch reimplementation of the apps platform that honours the PRD
"compose, never generate" mandate literally, built up in steps and now a
**running app**, not just a static proof. It lives in `src/lib/factory-v2/`
(plus two TEMP routes) and is independent of the §2 path — it shares only the
read-only `src/lib/component-catalog/*` catalog.

### 4.1 The chain (all stages working)

1. **COLLECT (wizard).** `strategy-collect-recipe.ts` composes the running
   wizard 100% from the catalog: `section-hero[light]` + the Homer `wizard`
   component (progress + Back/Next + Submit) with one catalog input per §13
   question (`text-input` / `textarea` / `radio-cards`). No hand-written app
   HTML; `form-wizard.js` drives step nav.
2. **Real answers → LLM (content only).** On submit the visitor's REAL answers
   POST back and feed `strategy-live-generator.ts`
   (`generateStrategyContentFromAnswers`) — Opus 4.8, streaming, plain-text
   JSON + Zod (`strategy-content-schema.ts`), reusing the parameterized
   `buildStrategyLivePrompt`. The proven sample generator
   (`strategy-content-generator.ts`) is left untouched. The LLM supplies
   **content only** — no HTML, no component choices.
3. **Locked recipe → catalog compose.** `strategy-result-recipe.ts` maps the
   validated content onto the LOCKED result order (`section-hero[light]` →
   `card-basic ×N` → `list-group` → `card-cta` → `share-bar` →
   `download-button`); `assemble.ts` renders each block ONLY from its catalog
   `html_template` and **throws `UnknownComponentError` on any unknown id**
   (no fallback). `template-render.ts` is the clean-room re-impl of the Homer
   construct preprocessing (`{{slot:…}}`, `{{key|default}}`, `{{key?class}}`,
   `{{key?truthy:falsy}}`), mirroring `assembler/template.ts`.
4. **Themed result.** `document-shell.ts` stamps the chosen Homer skin +
   light scheme once on the root — `<html data-skin="{skin}"
   data-bs-theme="light">` — and every catalog component inherits the palette
   (no per-component theming). Hero renders on BOTH the collect and result
   pages, light.

### 4.2 Styling fold (Step B) + persisted skin (Phase 1)

- `strategy-skin.ts` defines the six Homer skins (`default | two | three |
  four | five | six`); the shell stamps the chosen skin + `data-bs-theme=
  "light"` on the root, and every component inherits via Homer's `--ins-*`
  CSS variables (verified in `public/homer/css/app.min.css`).
- **Persistence (Phase 1, RESOLVED):** the skin is no longer derived from the
  business name. `strategy-skin-store.ts` (`getOrCreateSkin`) picks a random
  skin ONCE on first render and persists it to `factory_v2_app_skin(business_id
  PK, skin)` (migration 043), reading it back on every render — same business
  → same skin. `factory_v2_app_skin` is the **Option-A interim store**; migrate
  to per-app `app_configs.skin` at cutover when the app persists as a real
  `business_assets` row.

### 4.3 Routes

**STABLE (live path — `routes/factory-v2-api.ts`, `/api/factory-v2`):**
- `POST /:businessId/by-slug/:appSlug/result` — public, rate-limited (per-IP +
  per-app KV). The published app's iframe wizard POSTs visitor answers here;
  runs the proven chain on the business's REAL context (no-fallbacks) and
  returns the composed result inner HTML. **The live app depends only on this**
  — not on any `/dev/` route.
- `POST /:businessId/publish` — **test-only** (`ENVIRONMENT==='test'`); builds
  the self-contained wizard HTML (skin baked, absolute result URL, absolute
  Homer assets) and upserts the `business_assets` app row the existing
  `/api/generated-apps` by-slug endpoint serves. Pending owner auth (Phase 4).

**TEMP `/dev/` (retire at cutover):**
- `routes/factory-v2-proof.ts` (`/api/factory-v2-proof`) — step-3 proof,
  secret-gated, sample answers → captured static HTML.
- `routes/factory-v2-app.ts` (`/dev/factory-strategy-app[/:slug]`) — step-4 /
  Phase-1 dev app: `GET` serves the themed wizard, `POST` runs the chain;
  `/:slug` loads real context + persisted skin + a `?debug=context`
  introspection mode. Browser-callable, not secret-gated.

### 4.4 Open follow-ups (backlog)

- **Skin store migration.** `factory_v2_app_skin` is the interim home; move to
  per-app `app_configs.skin` at cutover when the factory-v2 app persists as a
  real `business_assets` 'app' row.
- **Publish owner auth (Phase 4).** `POST /publish` is test-only gated; a prod
  path needs proper `requireAuth` + ownership re-verify (mirror
  `/api/generated-apps` PATCH/DELETE).
- **CTA / share / download URLs.** `card-cta` `cta_url`, `share-bar` url, and
  `download-button` url are `#` placeholders. Wire a real PDF for download and
  clipboard.js (or share intents) for share; substitute the operator URL for
  the CTA at render time.
- This clean path supersedes the §2 pipeline at cutover (see §2 retirement
  notice).

### 4.5 Phase 1 COMPLETE — real business + live /sites/ route (2026-06-01)

The clean pipeline now runs on a REAL business through the REAL site route, not
just `/dev/` with sample data.

- **Real context, no-fallbacks.** `strategy-context.ts` loads `businesses` +
  `business_context` (by slug or id) and HALTS (`MissingContextError` → 422
  naming the fields) if any required field is missing — `businesses.name` +
  `business_context.{industry, business_summary, value_proposition,
  brand_voice}` (a generic industry counts as missing). No fallback to
  `SAMPLE_BUSINESS`. Verified: `gaudet-charcuterie-o8km` has all required
  fields; the result reflects gaudet's real brand.
- **Live on the real route.** Published to
  `/sites/gaudet-charcuterie-o8km/apps/charcuterie-strategy/` via a
  `business_assets` upsert (asset_type='app', app_slug, is_current=true,
  `asset_data={html, app_title, app_tagline, app_type:'strategy'}`),
  superseding the prior row at that slug (update-in-place under the unique
  `(business_id, app_slug)` index). Served through the **UNCHANGED** delivery
  path: `_redirects` → `apps-shell.astro` → `/api/sites` → `/api/generated-apps`
  by-slug → iframe `srcdoc`. **Zero edits** to `_redirects`, `_routes.json`,
  `apps-shell.astro`, `sites.ts`, or the by-slug endpoint. No schema change.
- **about:srcdoc fix.** Inside the apps-shell iframe the document is `srcdoc`,
  so `window.location` can't be the POST target; `strategy-collect-recipe.ts`
  gained a `postUrl` param that bakes the absolute `/api/factory-v2/.../result`
  URL. CORS already allows the iframe's inherited origin (`*.textos-web-test
  .pages.dev`).
- **Pipeline B untouched** — this is a parallel publish + serve path that reuses
  the shared serving infra read-only.
- Commits: `20b69a6` (Phase 1: real context + no-fallbacks + persisted skin),
  `a08cc7a` (Phase 1 step 2: live on /sites/ + stable /api/ result endpoint).

---

## 5. Design-token dictionary + per-component capability (Phase A/B)

A controlled style vocabulary for the generated-app / Homer layer, built ON TOP
of values that already exist — it adds NAMES, never new values. Separate from
`textos-web/src/styles/tokens.css` (the platform studio/daylight system).

- **Dictionary** (`src/lib/component-catalog/design-tokens.ts`): 5 CLOSED
  aspects, each a canonical-name set mapped onto an existing Homer `--ins-*`
  variable / Bootstrap utility / `textos-style-layer.ts` `--tx-*` value:
  - `elevation` {flat, sm, raised, lg} → `.shadow*` / `--ins-box-shadow*`
  - `radius` {square, sm, rounded, lg, xl, circle, pill} → `.rounded*` /
    `--ins-border-radius*` (fixed rem — never skin/theme-varied)
  - `border` {none, hairline, accent, dashed} → `.border*` / `--ins-border*`
  - `surface` {plain, card, raised-card, tinted} → `.card` / `.bg-{color}-subtle`
  - `emphasis` {muted, default, strong, feature} → `--tx-*` pairing + `.fs-*`/`.fw-*`
  `TOKEN_REFERENCE` carries each token's `{utility, source, varies_by, when}`.
  Closed-set discipline mirrors `isFontPairing`: `isDesignToken(aspect, name)` +
  `UnknownDesignTokenError` (throw, no fallback). **No resolver yet** — emitting
  the utility/CSS is Phase C.
- **Capability metadata** (`types.ts` → `ComponentCapabilities` /
  `AspectCapability<T>`; `capabilities?` on every `ComponentCatalogEntry`):
  all **65** catalog entries now declare, per relevant aspect, the dictionary
  tokens they `supported[]` + the `default` (today's actual render) + a one-line
  `notes`, plus a component-level `when_to_use`. Tokens are union-typed against
  `design-tokens.ts`, so `tsc` rejects any non-dictionary word (zero free-text —
  machine-verified). Color stays the skin/`variant` mechanism (no color aspect).
- **Inert until Phase C.** `capabilities` is pure metadata; nothing reads it
  yet. Composition wiring (LLM picks tokens per component) is Phase C.
- **Proposal of record:** `docs/factory-v2-design-token-dictionary-proposal.md`.
- **Conditional front-door (backlog):** a `spacing`/gap/padding aspect is the
  one deferred candidate — add ONLY if Phase C output looks cramped after
  composing with the 5 aspects. Width/fluid, native-control internals, and the
  tooltip dark-bubble surface were considered and **dropped** as edge cases.

### 5.1 Phase C COMPLETE — the LLM composes with tokens (2026-06-01)

The capability metadata is no longer inert: the build-time LLM picks per-
component design tokens, and the assembler resolves them to real Homer classes.

- **Resolver** (`component-catalog/design-token-resolver.ts`):
  `resolveComponentTokens(entry, chosen)` validates each token ∈ dictionary
  AND ∈ `entry.capabilities[aspect].supported[]` — throws `UnknownDesignTokenError`
  / `UnsupportedTokenError` (no fallback); fills omissions with `default`; emits
  Homer utility classes ONLY for **non-default** box tokens (so all-defaults =
  today's render). Skin/theme-varied tokens resolve to **class references**
  (`.shadow`, `.bg-primary-subtle`, `.border-primary`) that flow through the
  skin machinery — never frozen values. `emphasis` is realized by the `--tx-*`
  font layer (shell-wide), except for scoped text targets via `tokenClass()`.
  `injectTokenClasses()` injects into the root or `capabilities.style_target`
  (e.g. score-badge → `avatar-title`).
- **Assembler hook** (`assemble.ts`): `CompositionBlock.extra_classes` →
  injected after render. The recipe resolves each result/collect role's tokens
  and passes them; the LLM's picks live in the spec's `style` block, validated
  in the generate loop (`validateAssessmentStyle`, retry-on-throw).
- **Proven on the Assessment (gaudet):** LLM-picked finished look (tinted hero,
  raised-card framed interpretation cards + CTA, lifted score badge, larger
  question labels) — all resolved to Homer classes, zero custom CSS. Verified by
  Rob: composes a finished look with no per-app tuning.

### 5.2 Hard-won gotchas (Homer-specific — verify EFFECT, not presence)

These cost real cycles in Phase C; recorded so they don't recur:
- **(a) Homer's `fs-*` ramp is rescaled/inverted vs Bootstrap.** `.fs-5` =
  `0.845rem` (≈ body `0.8125rem`), `.fs-1` is the *largest* (~1.33rem). A
  Bootstrap-intuition `fs-5 = "large"` pick lands ≈ body size → "no change."
  Use `.fs-3` (~1.26rem) for a clear bump. (Fixed: question labels `fs-5→fs-3`.)
- **(b) `.d-flex{…!important}` beats inline `style="display:none"`.** A
  stylesheet `!important` rule wins over a non-`!important` inline declaration —
  so a toggled element must NOT carry a `display-*` utility. (Fixed: the
  `#asmt-result` / `.asmt-cards` hide-on-load wrappers; flex moved to an inner
  div.)
- **(c) `app.mini.js` hides `CustomChartJs`/`ins` in an IIFE** (private); the
  full `app.js` declares them at top level (global). The chart-bearing apps need
  the full `app.js` base bundle. (Fixed: document-shell loads `app.js`.)
- **(d) STANDING RULE: verify a class's EFFECT / a symbol's availability, not
  just its presence in the markup.** "class is in the HTML" ≠ "class wins at the
  right value"; "script tag is present" ≠ "symbol is global." Check the cascade
  / the scope.
- **Known cosmetic:** the full `app.js` admin-init logs a harmless
  `lucide is not defined` (chrome-less mini-apps don't load lucide); it fires
  after `CustomChartJs` is defined, so charts are unaffected. Part B's
  base-bundle model can optionally load lucide to silence it.

### 5.3 Vendor-script dependency system (Part B, 2026-06-01)

The assembler enforces each composed app's vendor scripts from the catalog; the
LLM never picks scripts. Build-time throw turns silent runtime breakage (the
Part-A radar) into a loud build error.

- **Registry** (`component-catalog/vendor-scripts.ts`): closed set
  `id → { src, in_base_bundle, provides:[symbols], requires:[ids] }`.
  - base-bundle **capabilities** (`src:null`): `chartjs`, `custom-chartjs`,
    `jquery`, `bootstrap`, `flatpickr`, `simplebar` — validated against the base
    bundle's exposed globals, not loaded separately.
  - **add-on files** (`src` set): `form-wizard`, `choices`, `form-choice`,
    `handlebars`, `typeahead`, `form-typehead`, `datatables`(+`-bs5`/
    `-responsive`), `jszip`, `pdfmake`, `sweetalert2`.
  - `BASE_BUNDLE_FULL` (vendors.min.js + **app.js**) provides `Chart,
    CustomChartJs, ins, $, jQuery, bootstrap, flatpickr, SimpleBar, debounce`;
    `BASE_BUNDLE_MINI` (app.mini.js) lacks `CustomChartJs`/`ins`. The
    **provides-SYMBOL** model is the Part-A lesson encoded: track exposed
    globals, not just files.
  - `isVendorScript` + `UnknownVendorScriptError` + `UnmetVendorDependencyError`
    (throw, no fallback).
- **Separate `vendor_scripts` field** on `ComponentCatalogEntry` (NOT
  `js_dependencies`). Pipeline B's `assembler/document-wrapper.ts` reads the
  `/homer/*` paths out of `js_dependencies`; replacing them would drop
  `form-wizard.js` from Pipeline B wizards. So `vendor_scripts` carries the
  registry ids and `js_dependencies` is **left exactly as-is — Pipeline B
  untouched**. Populated so far: `wizard → ['form-wizard']`,
  `chart-radar → ['custom-chartjs']` (the Assessment's deps).
- **Assembler derives** (`resolveVendorScripts(componentIds, base)`): union the
  components' `vendor_scripts` → transitive `requires` closure → validate
  base-bundle capabilities against `base.provides` (THROW if unmet, naming the
  component + missing symbols) → drop base-satisfied → topo-sort add-ons →
  ordered `src` list → `document-shell` `extraScripts`. The recipe's hand-coded
  `['form-wizard.js']` is gone; it's now derived (verified identical — no
  regression; radar still paints). Proven: `?debug=deps-mini` (the lean base
  bundle) throws naming `chart-radar` + `CustomChartJs` — it would have caught
  the Part-A break at build time.
- **Backlog (cutover):** fully migrate Pipeline B's `document-wrapper.ts` to the
  registry ids and retire the `js_dependencies` path-parsing — then a single
  field serves both pipelines. Until then, both fields coexist.

### 5.4 Both archetypes LIVE on real /sites/ URLs (2026-06-01)

The clean factory-v2 pipeline now serves **two archetypes** on real site routes,
through the **unchanged** delivery path (`_redirects` → `apps-shell` →
`/api/sites` → by-slug → iframe `srcdoc`); zero delivery-file edits, no schema
change. Both are test-only published (owner auth = Phase 4); Pipeline B
untouched.

- **Strategy** — `/sites/gaudet-charcuterie-o8km/apps/charcuterie-strategy/`.
  Per-visitor LLM result via the stable `/api/factory-v2/.../result` endpoint
  (the iframe POSTs answers; about:srcdoc absolute-URL fix; CORS).
- **Assessment** — `/sites/gaudet-charcuterie-o8km/apps/charcuterie-iq/`.
  **Fully client-side** — the baked scorer + radar run entirely in the sandboxed
  `srcdoc` iframe (full `app.js` base exposes `CustomChartJs`; **no result
  endpoint, no CORS round-trip**). First Chart.js-in-sandbox app — verified
  painting. Publish handler: `POST /dev/factory-assessment-app/:slug/publish`
  (real context no-fallbacks + stored skin + cached spec + tokens + derived
  vendor scripts → `business_assets` upsert).
- **Both pages framed** (the Assessment recipe): hero in its own amber band
  ABOVE a Homer `card-basic` (`card-body`) frame on BOTH collect and result,
  same `rounded-3 shadow-sm` (radius:lg + elevation:sm) tokens — composition
  only, no new CSS. (Note: neither side was carded before; the collect "frame"
  was just the wizard's nav-tabs.)

### 5.5 Strategy styling backport + wizard UX fixes — both archetypes (2026-06-02)

Two follow-ups that close the gap between the two live archetypes (commits
`a7c48d3` styling backport, then the wizard-fix commit below). Verified by Rob on
test; both `/sites/` apps republished (no delivery-file or schema edits).

**(1) Styling layer backported to Strategy** (was built after Strategy, so the
Assessment had it first). Strategy now matches the Assessment's finished look:
- **Font pairing** — `strategy-style.ts`: `getOrGenStrategyStyle(env, businessId,
  identity)` has the build-time LLM pick `{ font_pairing, style }` once from the
  closed 8-set + the design-token dictionary, **KV-cached** (`fv2:strat-style:
  ${businessId}`, 24h) and shared by the collect build AND the result endpoint so
  both stay in lockstep. Pairing is stamped on the document shell (the injected
  result inherits it). Reuses `StyleChoicesSchema` (now **exported** from
  `assessment-spec-schema.ts`), `STYLE_ROLE_COMPONENT`, the resolver.
- **Design tokens** — `strategy-collect-recipe.ts` (hero box tokens + question
  label `fs-3`/emphasis + radio radius) and `strategy-result-recipe.ts`
  (`buildStrategyResultHtml(content, style)` token-styles hero/cards/list/cta),
  all through `resolveComponentTokens` (throw-on-unknown).
- **Both-sides card framing** — collect wizard and result blocks each wrapped in
  a Homer `card-basic` (`rounded-3 shadow-sm`), hero above — identical to the
  Assessment. Same shared `FRAME_CLASSES`.
- **Result endpoint unchanged** — per-visitor generation intact; verified
  no-regression (a 60-guest vineyard-rehearsal sample produced a tailored plan
  fused with gaudet's old-world-curing brand). Routes threaded:
  `factory-v2-api.ts` (result + publish) and `factory-v2-app.ts` (/dev/).
- Picked for gaudet: `artisan` (Fraunces/Inter); tinted hero, raised-card
  interpretation cards + CTA, hairline borders.

**(2) Wizard UX fixes (shared) — radio-card subtext + Enter-to-advance.** Both
fix latent issues in the shared wizard pattern, so they apply to BOTH archetypes:
- **Radio-card subtext collision** — the `radio-cards` catalog template
  (`component-catalog/form.ts`, **shared**) rendered icon/title/subtext as direct
  children of the option `<label class="btn …">`. Homer's `.btn` resolves to
  `display:inline-flex` (later of two same-specificity rules wins), so the
  children laid out in a **row** and `d-block` was inert → title and subtext
  collided ("Drop-off boards**We deliver…**"). **Fix:** wrap the three in
  `<span class="d-flex flex-column w-100">` so they stack regardless of the
  `.btn` flex context; subtext is `d-block text-muted mt-1`. Composition only, no
  custom CSS. The label class is unchanged, so the recipe's radius-token
  injection still matches. Benefits both archetypes (Assessment picked up the fix
  on republish; its options have no subtext/icon, so only the wrapper shows).
  Another instance of gotcha §5.2(d): verify the EFFECT (the cascade), not the
  presence of `d-block`.
- **Enter advances / submits the wizard** — added a `keydown` handler to each
  recipe's inline script (`strategy-collect-recipe.ts` + `assessment-recipe.ts`,
  per-recipe, not shared JS). On Enter it **drives Homer's own wizard API** by
  clicking the active `.tab-pane`'s `[data-wizard-next]` (bound to
  `FormWizard.nextStep`, validation included) — or the step's `type="submit"` on
  the last step — rather than re-implementing step logic. Enter inside a
  `<textarea>` is left alone (newline); everywhere else `preventDefault()` stops
  a lone text input from implicitly submitting mid-wizard. No double-fire. (We
  did NOT touch the shared `form-wizard.js` — that would change platform-wide
  wizard behavior incl. Pipeline B; the recipe-scoped handler is the safe fix.)

### 5.6 Calculator archetype — dependency wiring (2026-06-02)

Groundwork for the **3rd factory-v2 archetype, Calculator** (Compute brain:
client-side formula, numeric inputs → live computed result, leads with
large-number + charts; client-side like Assessment, **no paywall** — distinct from
the legacy Pipeline B `src/lib/archetypes/calculator.ts`, untouched). Wiring ONLY;
the recipe is NOT built yet.

- **Vendor registry** (`component-catalog/vendor-scripts.ts`): added
  `'tx-bind' → { src:'/homer/js/tx-bind.js', in_base_bundle:false,
  provides:['txBind'], requires:[] }` — the custom reactive input→output engine
  that powers Calculator's live recompute (self-inits via its own IIFE listener,
  exposes `window.txBind`).
- **`vendor_scripts` set** on `tx-bind` → `['tx-bind']` and `chart-bar` /
  `chart-doughnut` → `['custom-chartjs']` (parity with `chart-radar`).
- **Verified derivation:** `resolveVendorScripts(calcSet, BASE_BUNDLE_FULL)` →
  exactly `['/homer/js/tx-bind.js']` (custom-chartjs is `in_base_bundle` →
  validated, not separately loaded). Under `BASE_BUNDLE_MINI` it **throws**
  `UnmetVendorDependencyError` (missing `CustomChartJs`/`ins`, needed by
  chart-bar/chart-doughnut) — the build-time guard that would have caught the
  Part-A radar break.

**BACKLOG / latent platform bug (found reading `app.js`, recorded so it's not
re-discovered the hard way):** Homer's `app.js` runs all auto-init inside ONE
`DOMContentLoaded` handler — `(new App).init(), (new LayoutCustomizer).init(),
(new Plugins).init(), …` — and `App.init()`'s first call `initComponents()` begins
with `lucide.createIcons()`. In a chrome-less factory-v2 iframe `lucide` is
undefined → **ReferenceError aborts the entire chain**. Consequence: every
component that relies on this auto-init **silently no-ops in iframe apps** — notably
`large-number`'s count-up (`initCounter`) and `touchspin-stepper`'s +/- buttons
(`initTouchSpin`). This is the SAME class as the Part-A radar (§5.2c). Components
using Bootstrap's `data-bs-toggle` data-api (accordion, modal, collapse) are
unaffected (they register at load, not via this handler); `tx-bind` is unaffected
(its own independent listener); explicitly-instantiated `CustomChartJs` is
unaffected.

**Route-around for the Calculator build (recorded in project memory too):** drive
the headline number via `tx-bind`, not `initCounter`; prefer
`number-input`/`range-slider`/`select-native` over `touchspin-stepper` (or init it
explicitly); init charts with explicit `new CustomChartJs(...)` in the recipe inline
script (mirror the Assessment radar); `range-slider` feeds `tx-bind` via `data-bind`
(live compute works without the value-badge snippet). Backlog fix (not done): make
mini-apps tolerate the missing `lucide`, or strip the lucide call from the
mini-app init path, so the auto-init chain survives.

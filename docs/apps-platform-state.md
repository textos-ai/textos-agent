# Apps Platform — Current State vs PRDs

Last updated: 2026-06-01 (added §4 — the clean factory-v2 pipeline now runs
end-to-end as a wizard→LLM→locked-recipe→catalog-compose→themed-result app on
/dev/; the §2 raw-HTML pipeline is now slated for retirement at cutover. Prior:
2026-05-30, items #2/#3 RESOLVED)

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

### 4.2 Styling fold (Step B)

- `strategy-skin.ts` picks one of the six Homer skins (`default | two | three
  | four | five | six`) and the choice is **stable** — same skin on every
  render. The shell adds `data-bs-theme="light"`. Skins resolve to distinct
  palettes via Homer's `--ins-*` CSS variables (verified in
  `public/homer/css/app.min.css`).

### 4.3 Routes (both TEMP — retire at cutover)

- `routes/factory-v2-proof.ts` (`/api/factory-v2-proof`) — step-3 proof:
  hardcoded sample answers → result HTML for capture into
  `textos-web/public/dev/`. Secret-gated.
- `routes/factory-v2-app.ts` (`/dev/factory-strategy-app`) — step-4 running
  app: `GET` serves the themed wizard page (Homer assets loaded absolute from
  the textos-web origin, since the Worker has no `/homer/*`), `POST` runs the
  chain on the visitor's real answers and returns the composed result inner
  HTML. Browser-callable, **not** secret-gated (must accept an anonymous
  visitor POST) — keep it a `/dev/` route, not a permanent public endpoint.
  Verified live on test 2026-06-01: skin stamped + stable, all 7 questions
  collected, result reflects the answers, hero on both pages light,
  throw-on-unknown active.

### 4.4 Open follow-ups (backlog)

- **Skin persistence.** The stable skin is currently DERIVED from the business
  name (`pickStableSkin(SAMPLE_BUSINESS.name)`); production must make a real
  random pick ONCE at app-build time and persist it on the business app
  metadata (`business_assets` / `app_configs`; no dedicated `skin` column
  yet). File a backlog item.
- **CTA / share / download URLs.** `card-cta` `cta_url`, `share-bar` url, and
  `download-button` url are `#` placeholders. Wire a real PDF for download and
  clipboard.js (or share intents) for share; substitute the operator URL for
  the CTA at render time.
- This clean path supersedes the §2 pipeline at cutover (see §2 retirement
  notice).

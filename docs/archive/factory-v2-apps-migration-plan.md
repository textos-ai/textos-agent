# factory-v2 — Apps-Build-Path Migration Plan (Option A)

**Status:** PLAN ONLY — no code, no deploy. For Rob's review → pick the thin slice → then build.
**Date:** 2026-06-04
**Goal:** move the user-facing apps build path (`/business/{slug}/apps` → `generate-business-app-v2`)
OFF Pipeline B (`src/lib/assembler/`) and ONTO the finished factory-v2 generators, with real
auth/billing/multi-app support. Pipeline B stays in the repo, just no longer the app-build path.

---

## ⚠️ Two findings that change the brief's premise (read first)

1. **The apps-page Strategy currently runs on Pipeline B, and factory-v2 Strategy is NOT a generic
   builder.** factory-v2 Strategy's collect questions are **hardcoded** (`STRATEGY_COLLECT_QUESTIONS`
   = the charcuterie event set in `strategy-collect-recipe.ts`). It has **no build-time question
   generator** — `strategy-content-generator.ts` runs on `SAMPLE_BUSINESS`/`WHITMORE_BOUDREAUX_ANSWERS`
   (fixtures). So "Strategy through factory-v2" is **not reuse** — it requires building a generic,
   per-business question generator that doesn't exist yet, PLUS reworking the per-visitor result
   endpoint to read those per-app questions.
2. **Therefore the brief's suggested thin slice (Strategy) is actually the heaviest archetype**, not
   the easiest. **Assessment and Calculator** already have generic build-time spec generators
   (`generateAssessmentSpec`/`generateCalculatorSpec` design from business context) and are fully
   client-side — they are the right thin slice. See §4; I recommend re-sequencing.

Everything else in the brief holds. The migration is mostly a **dispatch + storage + intent-threading**
wrapper around the existing factory-v2 generators; the auth/billing/task_run machinery already exists
and is reused unchanged.

---

## 0. The two pipelines + what the apps page actually touches (confirmed)

| Concern | Current (Pipeline B) | Target (factory-v2) |
|---|---|---|
| Apps tile "Build it" | `POST /api/businesses/{slug}/tasks/generate-business-app-v2/run` `{config:{archetype_id, description}}` | **same endpoint, same contract** |
| Run endpoint | `business-task-run.ts`: `requireAuth` → subscription/balance pre-check (402) → create `task_run` → `runTaskWithDeduction` → dispatch via `FREE_BUILD_TASK_HANDLERS[slug]` | **UNCHANGED — reused as-is** |
| Task handler | `runGenerateBusinessAppV2` → `buildStrategyBuildPrompt` + `StrategyContentSchema` + `assembleApp` (Pipeline B) → insert `business_assets` row | **reworked** to dispatch to factory-v2 generators + recipes |
| App list | `GET /api/generated-apps/{businessId}/list` → `business_assets` (app=active) + `app_draft` (building) + failed `task_runs` | **UNCHANGED — row-based, reused** |
| Manage / Delete / serve | `/business/{slug}/apps/{appSlug}/manage`; `DELETE /api/generated-apps/{businessId}/{appId}`; `GET …/by-slug/{slug}` → `asset_data.html` via apps-shell iframe | **UNCHANGED — row-based, reused** (⚠ manage-page compat: see §5) |

**Key insight:** the run endpoint already provides owner auth + 402 paywall + token deduction +
`task_run` tracking. The migration lives almost entirely **inside the task handler** (build + store);
the handler inherits auth/billing/job-tracking for free.

---

## 1. The build-path migration

**Rework the existing `generate-business-app-v2` handler — do NOT add a new task.** Keeping the same
task slug preserves the apps-page API contract verbatim (`{accepted, task_run_id}`, 402, poll,
`/list` refresh). The run endpoint, `FREE_BUILD_TASK_HANDLERS` registration, and token-cost row stay.

Inside the handler, replace the Pipeline-B body (and delete the line-59 non-strategy throw) with:

1. **Compose business identity from `TaskCtx`** (no slug re-lookup — the handler already has
   `business` + `ctx`): `{ name: business.name, summary: <industry + business_summary +
   value_proposition + brand_voice + positioning> }` — mirror `buildRealIdentity`'s composition but
   sourced from `ctx`. No-fallbacks: throw if a load-bearing context field is missing (matches
   `research-strategy.ts`).
2. **Resolve skin:** `getOrCreateSkin(supabase, business.id)` (already generic).
3. **Per-archetype dispatch** to a shared `buildFactoryV2App(...)`:
   - `assessment` → `generateAssessmentSpec(apiKey, identity, intent)` → `buildAssessmentPage(spec)`
   - `calculator` → `generateCalculatorSpec(apiKey, identity, intent)` → `buildCalculatorPage(spec)`
   - `strategy` → **(deferred — see §4/§5; keep on Pipeline B until the generic strategy generator
     exists, OR build it as the last slice)**
   Each returns `{ innerHtml, inlineScript, scripts, componentIds }`.
4. **Wrap** → `wrapProofDocument(innerHtml, { skin, assetBase: FRONTEND/homer origin, extraScripts:
   scripts, inlineScript, fontPairing: spec.font_pairing })` → self-contained `html`.
5. **Store one `business_assets` row** (the handler already does this for strategy): `asset_type='app'`,
   unique `app_slug` (§2b), `asset_data = { html, spec, app_title, app_tagline, app_type:
   archetype_id, archetype_id, generation_version: 3, build_context }`. `/list`, by-slug, delete,
   apps-shell delivery all work on this row unchanged.

**Factor a shared `buildFactoryV2App(env, identity, skin, { archetype, intent })` → `{ html, spec,
title, tagline }`** so BOTH the task handler (prod, auth+billed) and the existing `/dev/` publish
endpoints can call it (dedupe; the `/dev/` endpoints stay as test-only proofs).

**Pipeline B stays:** `assembleApp`, `src/lib/archetypes/*`, `src/lib/prompts/app-content-prompts.ts`,
`src/lib/assembler/*` are untouched — just no longer called by this handler (for the migrated
archetypes). Optionally keep a `generation_version`-based branch so old Pipeline-B apps still render.

---

## 2. The three design decisions

### (a) USER DESCRIPTION → "operator intent" threading  — RECOMMENDED, needs Rob's nod on prompt wording
The factory-v2 generators design from business **context** only; the apps page's free-text
"describe your app" is currently dropped. An ignored description is a broken promise.

- **Add an optional `intent: string` param** to `generateAssessmentSpec` / `generateCalculatorSpec`
  (and the future strategy generator), threaded into `buildAssessmentBuildPrompt` /
  `buildCalculatorBuildPrompt`.
- The prompt gains ONE bounded section: *"The operator described what they want this app to do:
  '{intent}'. Shape the app's topic/questions/computation to honor this intent, while keeping ALL the
  archetype's locked structure and HARD RULES below."* — intent is **subordinate** to the locked rules
  (it changes the subject matter, never the schema/sanitizer/component set).
- **No schema/validator changes** — intent only steers generation; the spec shape + sanitizer +
  cross-field rules are unchanged.
- ⚠ **Flag:** this edits the *locked* build prompts (additive — one intent block). Low risk, but Rob
  approves the exact wording + the "intent is subordinate" framing before we touch locked prompts.

### (b) MULTI-APP PER BUSINESS → per-app row, drop KV-single-spec  — RECOMMENDED
factory-v2's `/dev/` path caches ONE spec per business in KV (`fv2:asmt-spec:{businessId}`, etc.) with
a fixed slug (`charcuterie-*`). The apps page builds MANY distinct apps.

- **Drop KV for the prod path.** Each build generates a FRESH spec; **store the spec IN the
  `business_assets` row** (`asset_data.spec`), not KV. (KV remains only for `/dev/` proofs.)
- **Unique slugs:** reuse the handler's existing `generateUniqueAppSlug(supabase, businessId, title)`
  — slugify `spec.hero.title`, dedupe with a numeric suffix. One slug per app.
- **Persistence/list/manage/delete:** one `business_assets` row per app (the model `/list`, by-slug,
  delete, and apps-shell already use). No new tables. `app_configs` is NOT required for v1 (it's the
  per-app pricing/tier source for the *catalog* apps; factory-v2 apps are self-contained html rows).
- **Runtime read of the per-app spec:** Assessment + Calculator are fully client-side — the stored
  `html` is self-contained; nothing reads the spec at runtime. **Strategy is the exception** — its
  per-visitor result endpoint must read this app's questions/context to generate (today it reads only
  business context with fixed questions). See §4/§5.

### (c) AUTH / BILLING / JOB TRACKING → reuse the run endpoint entirely  — RECOMMENDED
- **No new wrapper.** Because the build moves INTO the `generate-business-app-v2` handler, it runs
  under the existing `business-task-run.ts` flow: `requireAuth` (owner JWT) → 402 subscription/balance
  gate → `task_run` row → `runTaskWithDeduction` (atomic token debit) → poll. The factory-v2 build
  inherits all of it.
- The `/dev/` factory-v2 publish endpoints (test-only, unauth, KV) stay as **dev proofs only**; the
  production path never uses them. Both call the shared `buildFactoryV2App` (§1) so logic isn't
  duplicated.
- **Token cost** is the `tasks` row's `token_cost` for `generate-business-app-v2` (DB-driven,
  unchanged). ⚠ revisit whether the per-build cost still fits the new single ~6k-token factory-v2 spec
  call (probably fine; Rob's call).

---

## 3. Reused vs. new

**Reused AS-IS (no rebuild):** the factory-v2 spec generators (assessment/calculator), recipes
(`buildAssessmentPage`/`buildCalculatorPage`), design-token + skin + font-pairing + card-framing
layers, the vendor-dependency system (jspdf/tx-pdf/chart/wizard derivation), the PDF download, the
strategy per-visitor result endpoint, `business_assets` storage + `/list` + delete + by-slug +
apps-shell delivery, and the **entire run endpoint** (auth/billing/task_run/deduction).

**New (the wrapper):**
1. Per-archetype dispatch inside the handler + shared `buildFactoryV2App`.
2. `intent` (description) threading in the 2 (then 3) build prompts.
3. Identity composition from `TaskCtx.ctx` (no-fallbacks).
4. Per-app row storage replacing KV (mostly reuses the handler's existing insert + `generateUniqueAppSlug`).
5. UI: flip `enabled:true` for assessment/calculator in `apps.astro` `V2_ARCHETYPES`; make the
   "Building your **strategy** app…" copy archetype-aware (minor).
6. **STRATEGY ONLY (the big new piece):** a generic build-time strategy **question generator** (today
   hardcoded) + making the strategy result endpoint read per-app questions. This is real new work, not reuse.

---

## 4. Proposed thin slice  — ASSESSMENT first (NOT Strategy)

The brief suggested Strategy "since it's already the apps-page archetype," but per the findings above
factory-v2 Strategy is the heaviest (no generic generator). The minimal end-to-end proof is the
archetype that already has a generic generator + client-side runtime:

**THIN SLICE = Assessment, built from coachpilot's apps page, end-to-end:**
1. Rework the handler's `assessment` branch → `generateAssessmentSpec(apiKey, identity, intent)` +
   `buildAssessmentPage` + `wrapProofDocument` + store unique-slug row (the shared `buildFactoryV2App`).
2. Thread `intent` into `buildAssessmentBuildPrompt` (decision a).
3. Flip `enabled:true` for assessment in `apps.astro`.
4. **Verify:** coachpilot owner clicks Assessment tile → types a description → Build it → real
   `task_run` + token deduction + 402 path intact → unique slug → app appears `active` in `/list` →
   live at `/sites/coachpilot/apps/{slug}/` → and the **description visibly shaped the assessment**.
   Confirm Manage/Delete work on the new row.

**Then sequence:**
- **Slice 2 — Calculator:** identical pattern (generic generator + client-side). Flip its flag.
- **Slice 3 — Strategy (largest):** build the generic strategy question generator + rework the result
  endpoint to read per-app questions, then migrate its handler branch off Pipeline B. **Until slice 3
  ships, leave Strategy on Pipeline B** (it works generically) — the handler dispatches strategy→Pipeline B,
  assessment/calculator→factory-v2. This is a clean partial cutover, not a regression.

---

## 5. Risks / unknowns (flag before building)

| # | Risk | Mitigation / note |
|---|---|---|
| 1 | **factory-v2 Strategy has hardcoded questions** — Strategy migration needs a NEW generic question generator + result-endpoint rework. | Sequence Strategy LAST; keep it on Pipeline B meanwhile. Biggest scope item — size it separately. |
| 2 | **Editing locked build prompts** to thread `intent`. | Additive one-block change; intent explicitly subordinate to the locked rules. Rob approves wording. |
| 3 | **Identity from `TaskCtx.ctx` (no-fallbacks)** — a business with thin `business_context` fails the build loudly. | Confirm coachpilot has `industry/business_summary/value_proposition/brand_voice`. Define the required-field set + a clear error (mirror `research-strategy.ts`). |
| 4 | **Manage-page compatibility** — `/business/{slug}/apps/{appSlug}/manage` may read Pipeline-B-specific `asset_data` fields (e.g. `content.section_plan`, `manifest`); a factory-v2 row (different shape) could break it. | **Verify before slice 1.** May need a `generation_version` branch in the manage page, or store a minimal compatible shape. Unknown until inspected. |
| 5 | **KV → row spec storage** divergence — `/dev/` proofs use KV, prod uses the row. | Acceptable (two entry points, one shared builder). Optionally unify later. |
| 6 | **Slug collisions** across many apps. | `generateUniqueAppSlug` already dedupes; low risk. |
| 7 | **Billing/token cost** for the new single factory-v2 spec call vs Pipeline B. | DB-driven `token_cost`; revisit the number. 402/subscription path reused unchanged. |
| 8 | **`/list` "building" status** — factory-v2 build inserts the `app` row at completion (→ `active`); no `app_draft` row. | Building UX is driven by the `task_run` poll (works today for v2). Optional: insert an `app_draft` row for an in-list building state. Minor. |
| 9 | **`asset_base`/asset origin in the handler** — `wrapProofDocument` needs the absolute textos-web origin (test vs prod). | Derive from `env.FRONTEND_URL` (test → textos-web-test, prod → app origin). The `/dev/` path hardcodes the test origin; the handler must be env-aware. |
| 10 | **`generation_version`** must distinguish factory-v2 (3) from Pipeline B (2) for any version-branching consumers (list/manage/serve). | Set `generation_version: 3`; audit consumers that branch on it. |

---

## TL;DR for Rob
- The migration is a **dispatch + storage + intent wrapper inside the existing task handler**; the
  auth/billing/task_run/list/delete/serve machinery is all reused unchanged.
- **Do the thin slice as Assessment (or Calculator), not Strategy** — factory-v2 Strategy has
  hardcoded questions and needs a brand-new generic generator (size it as the last, largest slice).
- **Decisions needed from you:** (a) approve `intent`-into-locked-prompts wording; (b) confirm per-app
  row + unique slug + drop-KV model; (c) confirm reuse-the-run-endpoint billing (and revisit
  `token_cost`); (d) pick the thin-slice archetype + whether Strategy stays on Pipeline B until its
  generic generator is built.
- **Verify-before-build unknowns:** manage-page compatibility with factory-v2 `asset_data` (#4), and
  coachpilot's `business_context` completeness (#3).

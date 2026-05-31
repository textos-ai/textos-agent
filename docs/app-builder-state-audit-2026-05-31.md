# App Builder — State-of-the-Art Audit

**Date:** 2026-05-31
**Author:** Claude Code (read-only investigation)
**HEADs at audit time:** textos-agent `da60caa`, textos-web `8abc167`
**Key file SHAs:** `generate-business-app-v2.ts` last touched `de45115`;
`assembler.ts` `0a51766`; `document-wrapper.ts` `38cda04`.
**Method:** direct code trace + git. **Live DB/R2 queries were NOT runnable**
from this environment — see Section C. Nothing was guessed; unverifiable
items are marked as such.

---

## Executive summary (read this first)

The v2 app generator runs end-to-end and stores assembled HTML, but it is a
**shell, not a product**, on two axes:

1. **Content is fake.** The executed design-step prompt is a hardcoded inline
   "simple app" prompt (not §13, not STYLE_GUIDE), and the result phase — the
   thing a visitor pays for — is **100% static placeholder text** written in
   code, not generated. The "proper" §13/Zod path exists but is dead.
2. **Delivery's last hop is uncommitted.** v2 apps are addressed at
   `/sites/{slug}/apps/{slug}/`, but the page that renders that URL
   (`apps-shell.astro` + the `_redirects` rule) is uncommitted WIP. On
   deployed `main`, a generated app has no page to appear on.

Catalog composition itself is real and working (Homer components, ~29
referenced). The gap is content quality + the final delivery hop, plus a pile
of no-fallbacks violations and stale spec/reality drift.

---

## SECTION A — Pipeline trace

### A1. Entry point
`POST /:slug/tasks/:taskSlug/run` — `src/routes/business-task-run.ts:51`.
Dispatch resolves the slug against `FREE_BUILD_TASK_HANDLERS`
(`business-task-run.ts:693`, map at `free-build-orchestrator.ts:70`) →
`runGenerateBusinessAppV2` (`src/lib/tasks/generate-business-app-v2.ts:62`).
Config (`archetype_id`, `description`, `llm_tier`) is read from
`task_runs.config` by `parseV2Config` (`generate-business-app-v2.ts:474-508`).

### A2. Design step (LLM → spec)
- **Prompt file:** `src/lib/prompts/app-content-prompts.ts` (`buildSystemPrompt`).
- **What actually executes:** NOT that file. The live call uses an **inline
  hardcoded prompt** — `workingSystemPrompt` (`generate-business-app-v2.ts:102`)
  + `simpleAppPrompt` (`:104-122`), which asks for `{app_title, app_description,
  questions[], free_tier_reveals, paid_tier_reveals, cta_label}` and "exactly 10
  questions." The richer `systemPrompt` + `jsonSchemaRef` (`:79-92`, built from
  the Zod schema) and `buildSystemPrompt`/`buildUserPrompt` are **only used on
  the parse-retry path** (`:187`, `:201`). The happy path never sees them.
- **Model:** **hardcoded** `model: "claude-sonnet-4-20250514"` in the primary
  call (`:142`). The tier-resolved `model = resolveModelForTier(llmTier)`
  (`:70`) is used only on retry (`:196`). (= backlog #3; this ID retires
  2026-06-15.)
- **§13 contract?** No. The executed prompt emits a different shape; neither the
  inline prompt nor the dead `buildSystemPrompt` references the §13 fields
  (`hero_icon`, `image_prompt`, `submit_button_text`, `result.summary`).
- **STYLE_GUIDE cited?** No — not in the executed prompt nor in
  `app-content-prompts.ts` (grep: zero hits for style_guide/§13/hero_icon/
  image_prompt).
- **Strategy-v2 §13 output?** No — it emits the legacy "simple" shape, which
  code then transforms (see A3).

### A3. Validation
- **Zod exists but is unused on the happy path.** `StrategyContentSchema` /
  `AssessmentContentSchema` / `CalculatorContentSchema` are imported
  (`:26-29`) and `jsonSchemaRef` is generated (`:79`), but the executed
  validation is a **manual field check** (`:242-248`: `app_title` present +
  `questions` non-empty). `validateContent` (the assembler's Zod gate) is not
  called from the handler. (= backlog #2.)
- **No-fallbacks: VIOLATED, extensively.** The transform (`:251-312`)
  synthesizes content: default paywall copy (`:276-278`), fallback
  title/subtitle (`:254`), and — most importantly — the **entire
  `result.sections` is hardcoded placeholder text** (`:285-304`: "Your strategy
  recommendations will appear here based on your responses.", "Review your
  current approach", "Set measurable goals", etc.). The LLM's output is used
  **only for the questions**; the result (the payoff) is static filler
  regardless of business or responses. `extractAppTitle`/`extractAppIcon` also
  carry fallbacks (`:526`, `:624`).
- **Invalid output today:** JSON parse failure → one retry → throw (fails
  loudly, good). But *valid-but-empty* output still produces the generic
  placeholder result — a silent wrong answer, which is worse than a hard fail.

### A4. Assembler
- **Entry:** `assembleApp` (`src/lib/assembler/assembler.ts:14`): archetype
  lookup → `validateContent` (Zod, `validation/index.ts`) → `renderPhase` per
  phase → `wrapDocument`. Pure function.
- **Catalog-driven?** Yes for component HTML — `renderPhase`/`document-wrapper`
  import `CATALOG` and render catalog `html_template`s. The 3 archetype recipes
  reference **~29 distinct catalog components** (`section-hero`, `wizard`,
  `radio-cards`, `text-input`, `textarea`, `email-input`, `submit-button`,
  `card-basic`, `card-cta`, `list-group`, `share-bar`, `download-button`,
  `modal`, `spinner`, `alert`, charts, etc.).
- **Hand-written HTML:** the **document shell + ~90-line orchestration script +
  PDF block** are hand-written TS in `document-wrapper.ts` (205 LOC total; the
  emitted orchestration JS is `:106-196`). Component bodies are catalog-driven;
  only the shell/wiring/PDF are hand-rolled.
- **Homer skin classes emitted?** Yes — `vendors.min.css` + `app.min.css`
  loaded (`document-wrapper.ts:43-46`); catalog templates carry Bootstrap/Homer
  classes. **But STYLE_GUIDE frame NOT implemented:** the shell is a plain
  `<div class="container ... " style="max-width: 720px">` (`:89`), not
  STYLE_GUIDE §1's 768px `.textos-app-frame` card (border/radius/shadow on
  soft-gray); no `data-bs-theme` dark mode (§8).

### A5. Output destination
- **Stored inline in Supabase:** `business_assets.asset_data.html` (asset_type
  `'app'`, `generate-business-app-v2.ts:397-419`). Not R2; not a per-app Pages
  project.
- **URL pattern:** `/sites/{business_slug}/apps/{app_slug}/` (`asset_url`,
  `:417`).
- **Homer bundle source:** `${FRONTEND_URL}/homer/...` — i.e.
  **textos-web/public/homer/ served by the Pages site** (`document-wrapper.ts:
  43-53`), **NOT** R2 / `apps.textos.ai/homer/` as the PRD assumes. The R2
  `ASSETS` bucket (`textos-assets`, `wrangler.toml:74-77`) is for
  documents/images/exports.

---

## SECTION B — Component catalog

### B1. `src/lib/component-catalog/` (9 files, 1872 LOC)
| File | LOC | Holds | Imported by assembler? |
|---|---|---|---|
| `form.ts` | 574 | form components (inputs, wizard, radio-cards…) | yes (via `index`) |
| `display.ts` | 330 | cards, hero, large-number… | yes |
| `feedback.ts` | 228 | alert, modal, spinner, score-badge… | yes |
| `utility.ts` | 229 | share-bar, download, tx-bind… | yes |
| `navigation.ts` | 165 | wizard nav, accordion… | yes |
| `data-viz.ts` | 142 | chart-bar/doughnut/radar… | yes |
| `layout.ts` | 77 | container, row-col… | yes |
| `index.ts` | 66 | aggregates all → `CATALOG` (by_id/category/archetype/tier) | — |
| `types.ts` | 61 | `ComponentCatalogEntry` etc. | — |

Each non-index file exports arrays of catalog **data** objects (`id`,
`html_template`, `js_dependencies`, `archetype_fits`, `reliability_tier`).
`index.ts` builds `CATALOG`; `phase-renderer.ts` and `document-wrapper.ts`
consume it. So the catalog is **data the assembler reads**, not functions.

### B2. `app_components` Supabase table — **DOES NOT EXIST**
No migration creates it (grep across `migrations/` + `supabase/migrations/`
finds only `app_errors` in `027_app_errors.sql`). The PRD §4.2 catalog-as-DB is
**spec'd, not shipped**; the catalog is the hardcoded TS above
(= `apps-platform-state.md` drift #1).

### B3. Recon report vs TS catalog
`textos-web/.homer-reference/catalog-recon-report.md` exists (1893 lines, ~42
entries per the PRD). The TS catalog is headed "Auto-extracted from
catalog-recon-report.md (R4)." Exact 1:1 reconciliation was **not byte-verified
in this pass** (the TS files show ~65 `id:` occurrences, likely including
sub-entries); low-priority to confirm.

### B4. Homer bundle / R2
**Not on R2.** Generated apps load Homer from `${FRONTEND_URL}/homer/...`
(textos-web Pages `public/homer/`). The R2 `ASSETS`/`textos-assets` bucket is
bound (`wrangler.toml:74-77`, `124-126`) but is for documents/images/exports,
not the Homer bundle. The PRD's "apps.textos.ai/homer/ on R2" is not how it
works today.

---

## SECTION C — Generated apps in the wild  ⚠️ BLOCKED (no local DB access)

**Could not run live queries.** `textos-agent/.env` holds only
`CLOUDFLARE_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_API_TOKEN`; there is no Supabase
URL or service-role key locally and no `.dev.vars` (the service-role key is a
Worker secret). Per the no-guessing rule, counts/URLs are left for Rob to run in
the Supabase dashboard. **Ready-to-run SQL:**

```sql
-- C1 all-time + last 7 days
SELECT count(*) FROM business_assets WHERE asset_type='app';
SELECT count(*) FROM business_assets WHERE asset_type='app' AND created_at > now() - interval '7 days';

-- C1 latest 5
SELECT b.slug AS business_slug, a.app_slug, a.asset_data->>'app_type' AS app_type,
       a.created_at, a.asset_url
FROM business_assets a JOIN businesses b ON b.id = a.business_id
WHERE a.asset_type='app' ORDER BY a.created_at DESC LIMIT 5;

-- C3 most recent failed generation
SELECT tr.id, tr.status, tr.error, tr.started_at
FROM task_runs tr JOIN tasks t ON t.id = tr.task_id
WHERE t.slug = 'generate-business-app-v2' AND tr.status = 'failed'
ORDER BY tr.started_at DESC LIMIT 5;
```

**C2 (visit latest app):** cannot fetch without a slug from the above query —
and note it may 404 regardless, because the deployed serving path for
`/sites/{slug}/apps/{slug}/` is uncommitted (Section D). Defer to the dashboard
run + a WIP-tree preview.

---

## SECTION D — Apps-on-users'-websites gap

### D1. Current integration — partially built; final hop is uncommitted WIP
- **Public site (committed on main):** `textos-web/src/pages/sites/[slug]/
  index.astro` (SSR) renders an "AI-Generated App" section with featured + grid
  app cards (`:538`, `:893`, `:912`) linking to `/sites/{slug}/apps/{app_slug}/`.
  Apps are fetched from the agent `routes/sites.ts` GET `/:slug`
  (`business_assets` where `asset_type='app'`, newest first, `sites.ts:65-90`).
  *(main's committed index.astro already contains this section — verified.)*
- **The app-view URL** `/sites/:biz/apps/:app/` rewrites via `_redirects` →
  `/business/apps-shell/` (`public/_redirects:51-52`), and `apps-shell.astro`
  **iframes** the stored HTML fetched from the agent
  `/api/generated-apps/{businessId}/by-slug/{app-slug}` (`apps-shell.astro:64`,
  `:113-114`).
- **⚠️ But on `main` the serving path does not exist:**
  - committed `_redirects` has **zero** `apps/:app` rules (verified
    `git show main:public/_redirects`);
  - `apps-shell.astro` is **untracked** — not on `main` at all (verified
    `git ls-files`).
  Both live only in the working tree / `wip/builder-apps-experiments`.
- **Net:** a v2-generated app (`asset_url = /sites/{slug}/apps/{slug}/`) has
  **no committed page to render it** on the deployed site → 404/broken. The
  multi-app delivery works only in the uncommitted WIP. (A legacy singleton
  `/sites/:biz/app/ → /business/app/` via `app.astro` is the older path.)

### D2. MVP options to close the last hop
1. **Land the WIP** — commit `apps-shell.astro` + the `_redirects` `/apps/:app`
   rule (the index.astro cards are already on main). Iframe the agent's
   app-html endpoint. *Least new work — it's ~built; it just isn't committed.*
2. **Agent-direct serve** — a Worker route returns `business_assets.html`
   directly at the app URL (no frontend shell). Simplest end-to-end, but loses
   the frontend chrome/SEO wrapper.
3. **Astro SSR inline** — a real `sites/[slug]/apps/[app].astro` page that
   fetches and inlines the HTML (no iframe). Best SEO; most work + XSS surface.

---

## SECTION E — Honest assessment

### E1. Biggest gap (blunt)
Two stacked failures. **(1) Content is fake:** the result phase — the paid
payoff — is hardcoded placeholder text in `generate-business-app-v2.ts:282-311`,
not generated from the business or the model; the §13/STYLE_GUIDE prompt that
would produce real content is dead. **(2) Delivery is uncommitted:** the page
that renders a generated app on a public site is WIP, so even a good app would
not appear on a deployed user site. "Apps appear on users' websites" fails on
both content and the final hop.

### E2. Single highest-leverage next step
**Make the design step real.** Replace the inline `simpleAppPrompt` (`:102-122`)
and the placeholder transform (`:251-312`) with a design step that (a) prompts
for the actual STYLE_GUIDE §13 contract — including real `result.summary` +
`result.sections` — (b) validates the parsed output with the existing Zod
`StrategyContentSchema` (wire the imported-but-unused `validateContent`), and
(c) deletes the static result filler so the LLM's strategy reaches the result
phase. This is the one change that turns "generates a shell" into "generates a
real app." It also forces the §13 ↔ `StrategyContentSchema` reconciliation
(E4). Delivery (D2 option 1) is the fast second step.

### E3. Broken / fragile / out-of-sync (flagged, NOT fixed)
- Retiring model `claude-sonnet-4-20250514` hardcoded in the primary call
  (`:142`); resolved model only on retry. → LLM Management Feature; June 15.
- No-fallbacks violated throughout the transform (static result, default paywall
  copy, fallback titles/icons).
- Zod schemas imported but unused on the happy path; "generate simple / validate
  strict" not wired.
- Open assembler bugs (`apps-platform-state.md`): #5(b) `sections[]` no fan-out
  (only first section renders), #5(c) optional `action_items` skipped, #5(d)
  `cta_url` sentinel mismatch (transform emits
  `/business/{{business_slug}}/contact`).
- Charts render blank; paywall email capture is fire-and-forget
  (`document-wrapper.ts:175-181`).
- Delivery hop (`apps-shell.astro` + `_redirects` `/apps/:app`) uncommitted;
  main's index.astro cards point at an unservable URL.
- App icons are emoji (`🎯📊🧮`, `:624`) vs STYLE_GUIDE's Tabler-slug intent.

### E4. Docs vs reality — update the docs to match reality
- **PRD §4.2 `app_components` DB table** — unbuilt; catalog is TS (drift #1).
- **PRD "Homer on R2 at apps.textos.ai/homer/"** — reality serves from
  `textos-web/public/homer/` via Pages. Update the asset-path assumption.
- **STYLE_GUIDE §1 frame (768px `.textos-app-frame`)** — code uses a 720px
  plain container, no frame card. Implement or update the spec.
- **STYLE_GUIDE §13 contract** (`hero_icon`, `image_prompt`,
  `submit_button_text`, `result.summary`) **≠ implemented
  `StrategyContentSchema`** (`hero`, `paywall`, `result.sections`). Reconcile;
  pick one canonical shape. (This is the crux of E2.)
- STYLE_GUIDE Tabler hero icon vs emoji; dark mode (§8) unimplemented.

---

*End of audit. No code changed during this audit beyond the Step 1 backlog
commit and this document.*

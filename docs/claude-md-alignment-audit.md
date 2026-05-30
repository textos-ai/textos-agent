# CLAUDE.md ↔ PRD Alignment Audit

**Date:** 2026-05-30
**Trigger:** after the CLAUDE.md three-tier reorg, verify the instruction
layer (CLAUDE.md hierarchy + referenced docs) against the current PRD/spec
layer so the reorg didn't regress, mislocate, or lose anything.
**Baseline (source of truth):** v2 apps-platform PRDs
(`textos-component-factory-prd.md`, `textos-homer-platform-prd.md`) +
`STYLE_GUIDE.md` + `apps-platform-state.md`.
**Conflict tie-breaker:** newest-dated document wins.

**Dates in play:** PRDs `2026-05-25` · `prompt-schema.md` `2026-05-28` ·
`STYLE_GUIDE.md` / `apps-platform-state.md` / `backlog-v2-architectural-debt.md`
`2026-05-29` · new CLAUDE.md hierarchy `2026-05-30` (+ live code).

---

## Verdict

**The reorg introduced no regressions, no broken references, and no lost
rules.** Every conflict found is pre-existing drift between the 05-25 PRDs
and the newer 05-29 specs/code — surfaced by the audit, not caused by the
move.

## Integrity checks

- **Reference integrity — PASS.** All 28 pointer targets across the
  hierarchy resolve (cross-repo docs, PRDs, STYLE_GUIDE, code files,
  catalog-recon report, `_redirects`, `sites/[slug]`).
- **Lost-content — PASS.** Every block removed from the old roots is present
  in its new home: NO-CONSTANTS + no-fallbacks, `errBody`/`BaseRow`
  (typescript-contracts), field-locking + PDF/R2 + Meta/AD_WALLET
  (autonomous-engine), `debit_tokens`/`token_cost` (tasks),
  `gen_random_uuid` (migrations), `stream_events` (×3), testimonials,
  prompt-schema, service-role.

## Findings

### F1 — Template-engine + wizard status was stale in the reconciliation docs → FIXED IN DOCS 2026-05-30
Two 05-29 reconciliation docs described engine gaps that the code had since
closed. Verified against live code and the docs were corrected:

- **Drift #2 (template engine constructs)** — `apps-platform-state.md` said
  "vanilla Mustache, `{{slot:content}}` renders empty, **blocking**." The
  live `src/lib/assembler/template.ts` implements `preprocessHomerConstructs()`
  (`{{slot:NAME}}`→`{{{NAME}}}`, `{{k|default}}`, `{{k?class}}`, `{{k?a:b}}`)
  with `template.test.ts` coverage. → marked **RESOLVED** in
  `apps-platform-state.md` #2 and `backlog #5(a)`.
- **Drift #3 (wizard)** — doc said the renderer hand-rolls `.tx-wizard` and
  the Homer `wizard` catalog entry "is not used." The live
  `phase-renderer.ts` `renderWizardInputs()` composes the Homer `c_wizard`
  component and throws (no-fallbacks) if it's missing. → marked **RESOLVED**
  in `apps-platform-state.md` #3.

Not a regression — pre-existing doc lag the reorg exposed. The new
`src/lib/CLAUDE.md` already described the *current* (fixed) behavior.

### F1b — Result-phase sub-defects confirmed STILL OPEN (not closed)
Verified in code 2026-05-30; left open in the backlog (did not blanket-close #5):
- **#5(b)** — `renderResult()` maps `phase.components` once; no `sections[]`
  fan-out, and `slot-resolver.ts` `tokenize()` turns `sections[]` → index 0.
  Only the first result section renders.
- **#5(c)** — `shouldSkipCandidate()` still `return true`s for any optional
  non-multi-candidate, so the `action_items` list-group is skipped.
- **#5(d)** — `generate-business-app-v2.ts:309` emits
  `cta_url_placeholder: "/business/{{business_slug}}/contact"`, not the
  `cta_url_placeholder` sentinel the resolver substitutes.

### F2 — PRD catalog model vs implementation → NOTE ADDED 2026-05-30
component-factory PRD §4.2/§9 want a Supabase `app_components` table; the
code (and `src/lib/CLAUDE.md`) use a hardcoded TS catalog + archetype model.
`apps-platform-state.md` #1 (newest) confirms the TS catalog is the intended
current state and the DB table is a future follow-up. A one-line
"future direction" note was added to `src/lib/CLAUDE.md` so the PRD's
eventual expectation stays visible.

### F3 — STYLE_GUIDE supersedes the PRD on visuals (informational)
STYLE_GUIDE (05-29, locked) sets frame **max-width 768px** and keeps the
generated-app **primary = Homer green**; the PRD says 720px (Addendum A.7)
and `#c8832a` amber (homer-platform §7 — amber is scoped to platform pages,
not generated apps). Newest-wins → STYLE_GUIDE governs generated apps. The
`.md` files hardcode neither value, so there's no instruction-layer conflict;
`src/lib/CLAUDE.md`'s authority chain already orders STYLE_GUIDE → PRDs.

### F4 — Homer asset paths (informational)
PRD Addendum A specifies `apps.textos.ai/homer/assets/…?v=3.2.0`; the code
and web `CLAUDE.md` use `/homer/css/…`, `/homer/js/app.mini.js` (no
`/assets/`, no version query). Code is operative; the `.md` matches it.

## Actions taken (2026-05-30)
- `apps-platform-state.md`: header date bumped; drift **#2** and **#3**
  marked RESOLVED with code citations.
- `backlog-v2-architectural-debt.md`: #5(a) annotated — engine pre-pass
  implemented; 5(b)/(c)/(d) confirmed still open.
- `src/lib/CLAUDE.md`: added the catalog "future direction" note (F2).
- This audit saved as `docs/claude-md-alignment-audit.md`.

## Not changed (deliberately)
- Drift #1, #4, #5, #6, #7, #8 in `apps-platform-state.md` — not verified
  fixed; left as-is.
- No instruction-file rule was altered for F3/F4 (no conflict in the `.md`
  layer; PRD-vs-code visual/path drift is a code concern, tracked elsewhere).

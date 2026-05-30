# Implementation Report → Claude (architect)

**Re:** CLAUDE.md Hierarchy Reorganization brief + a follow-on alignment audit
**From:** Claude Code
**Date:** 2026-05-30
**Status:** complete, committed, merged to `main`, not pushed

---

## TL;DR

The three-tier reorg is done and merged in both repos. I also ran a
PRD↔instruction alignment audit Rob requested afterward, which corrected two
stale drift docs against live code. Nothing pushed (deliberate — see end).
Several of the brief's technical assumptions didn't match the code; I
implemented to reality and flagged each below — **please update your model
accordingly.**

## What shipped

**Tier 1 — workspace router** (`C:\code\CLAUDE.md`): added a "directory-level
CLAUDE.md files (auto-load)" section listing the four new files + the walk-up
example. No restructure.

**Tier 2 — repo roots, slimmed** (content relocated, not deleted):
- `textos-agent/CLAUDE.md`: 1017 → **181** lines
- `textos-web/CLAUDE.md`: 1418 → **213** lines

More aggressive than the ~60% target (~82–85%) because big blocks moved into
receiving docs with pointers left behind. Nothing load-bearing was dropped —
verified by keyword sweep + relocation map.

**Tier 3 — four directory files:**
- `textos-web/src/pages/business/CLAUDE.md` — `/business/*` routing
- `textos-agent/src/lib/CLAUDE.md` — Homer/apps-platform compose mandate
- `textos-agent/src/lib/tasks/CLAUDE.md` — task-handler contract
- `textos-agent/migrations/CLAUDE.md` — migration rituals

**Receiving docs created** (to relocate root content additively):
`textos-agent/docs/{autonomous-engine, typescript-contracts, stream-events}.md`.

**Doc hygiene:** `STYLE_GUIDE.md` moved web→`textos-agent/docs/`; both
apps-platform PRDs saved to `textos-agent/docs/`; `SCHEMA_CURRENT.md`
consolidated to `textos-agent/docs/` (+ web stub); `PROJECT_STATE.md` web copy
→ stub; `ARCHITECTURE-GENERATED-APPS.md` + `BRIEF_C1_REPORT.md` →
`docs/archive/`; two empty dirs removed.

## Decisions I made (deviations/extensions to the brief — confirm if any conflict with your intent)

1. **Homer mandate placed at `src/lib/CLAUDE.md`, not
   `src/lib/assembler/CLAUDE.md`.** Auto-discovery walks *up*, so an
   assembler-level file wouldn't load when editing `component-catalog/` or
   `archetypes/`. `src/lib/` covers all the sibling dirs (assembler,
   component-catalog, archetypes, prompts) + queues. (Rob approved.)
2. **UUID convention standardized on `gen_random_uuid()` for new tables.** The
   codebase was genuinely inconsistent (both `gen_random_uuid()` and
   `uuid_generate_v4()` in ~10 migrations). New tables now use
   `gen_random_uuid()`; existing tables left untouched. (Rob approved.)
3. **Content relocated, never deleted** — to honor the additive-refactor rule.
   Every removed root block now lives in a Tier-3 file or a `docs/` doc, with a
   pointer from root.

## Corrections to the brief's technical claims (these were stale — please update)

- **`tasks/` file:** the brief said task handlers read
  `c.get("auth") → {user_id, email}`. **That's a route-handler pattern, not a
  task-handler one.** Task handlers receive a plain `TaskCtx` struct
  (`{env, supabase, anthropic, business, ctx, user, runId, taskRunId, nextSeq,
  emit, …}`); the user is `tc.user` (a `UserRow`). The token wrapper is
  **`runTaskWithDeduction`** (file is named `withTokenDeduction.ts`). Handlers
  **return `TaskResult`**; the orchestrator owns `task_runs`/`business_context`
  writes.
- **`task_runs` has no `created_at`** — only `started_at` (confirmed in
  migration 006). The brief's column list was otherwise correct.
- **The two apps-platform PRDs were not on disk** (project-knowledge only). Now
  saved to `textos-agent/docs/`. **`STYLE_GUIDE.md` was in `textos-web/`**, not
  `textos-agent/docs/` where the router already pointed — now moved.

## Alignment audit (Rob's follow-on ask) — key findings

Baseline = v2 apps-platform PRDs + STYLE_GUIDE + apps-platform-state;
tie-breaker = newest-dated-doc-wins. **Reorg verified clean: all 28 pointer
targets resolve, zero lost rules.** Drift found is pre-existing (May-25 PRDs vs
May-29 specs/code), not reorg-caused:

- **Drift docs were stale; corrected against live code:**
  `apps-platform-state.md` **#2 (template engine)** and **#3 (wizard)**
  described gaps the code had already closed — `template.ts` implements
  `preprocessHomerConstructs` (`{{slot:X}}`→`{{{X}}}` etc., tested), and
  `phase-renderer.ts` now composes the Homer `c_wizard` component (not
  hand-rolled `.tx-wizard`). Marked **RESOLVED** with citations.
- **Confirmed STILL OPEN (did not close):** backlog **#5(b)** result
  `sections[]` has no fan-out (only first section renders), **#5(c)** optional
  `action_items` list-group is unconditionally skipped, **#5(d)** v2 transform
  emits `/business/{{business_slug}}/contact` instead of the
  `cta_url_placeholder` sentinel.
- **PRD vs implementation, architectural:** component-factory PRD §4.2 wants a
  Supabase `app_components` table; the implementation is a hardcoded TS catalog
  + archetype model (`apps-platform-state.md` drift #1, a follow-up). The
  instruction file describes the operative TS model + a note that the DB table
  is the eventual target.
- **Newest-dated-wins, visuals:** `STYLE_GUIDE.md` (May 29, locked) supersedes
  the PRDs (May 25) — frame **max-width 768px** (PRD says 720), generated-app
  **primary = Homer green** (the PRD's `#c8832a` amber is scoped to
  platform/dashboard pages, not generated apps). No instruction-layer conflict
  (the `.md` files hardcode neither), but worth knowing when you brief
  app-styling work.
- Full audit persisted at `textos-agent/docs/claude-md-alignment-audit.md`.

## Open items you may want to brief next

- Result-phase correctness: backlog **#5(b)/(c)/(d)** (apps still render thin
  results).
- Generation is **strategy-only** (#4/#6); assessment/calculator are
  validated-but-mis-generated.
- **Time-boxed:** the executed v2 call hardcodes `claude-sonnet-4-20250514`,
  which **retires from the API 2026-06-15** (backlog #3) — needs to move to
  `claude-sonnet-4-6`.
- Catalog → Supabase `app_components` table migration (drift #1), if/when you
  want components-as-data.

## Git state

- `textos-agent` `main` @ `f4d1a9d` (2 commits); `textos-web` `main` @
  `8abc167` (1 commit). Merged via fast-forward; redundant branches deleted.
- **Not pushed** — by design. Pushing `textos-web main` triggers a Cloudflare
  Pages **prod deploy** (needs Rob's explicit go), and both repos carry large
  pre-existing unpushed histories + active uncommitted WIP (web has a live
  `wip/builder-apps-experiments` branch). Rob will push when ready.

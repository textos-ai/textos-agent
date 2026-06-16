# factory-v2 — Backlog

Running backlog for the clean factory-v2 apps platform. Companion to
`docs/apps-platform-state.md` (which records WHAT is built + how); this file
records WHAT'S LEFT, grouped by urgency. Update as items land or new ones surface.

**Last updated:** 2026-06-04

---

## STATE

3 archetypes (Strategy / Assessment / Calculator) live + finished + PDF export;
universal model complete. Forks below are next; rest is cleanup.

---

## IN FLIGHT

- ~~Commit PDF work (agent repo + 3 textos-web PDF files only) + republish all 3
  archetypes live.~~ ✅ **DONE 2026-06-04** — agent `66014f1`, textos-web `0a5189e`
  (exactly the 3 PDF files), all three republished live (`mode: updated`); download
  stamp verified in each published app's bytes.

---

## CLEANUP / LOOSE ENDS

- **textos-web tree reconciliation:** uncommitted changes (skin pages, builder /
  live / paywall / `[slug]`) live on test, not in git — commit intentional, revert
  stale, before any push/prod.
- **share-bar copy button still inert** (needs clipboard.js wired).
- **~47 commits ahead of origin, unpushed** — decide when to push.

---

## BACKLOG (recorded, not urgent)

- **app.js auto-init dead in iframe** (count-up / touchspin no-op; routed around;
  real fix later).
- **skin storage:** interim `factory_v2_app_skin` table → migrate to per-app
  `app_configs.skin` at cutover.
- **Retire Pipeline B at full cutover** (also migrate `js_dependencies` → registry
  ids).
- **Interaction / accessibility capability pass across 65 components** (keyboard /
  ARIA; bare chart canvases) — sized by the catalog-properties report.
- **PowerShell H.trim deploy garble** — investigate stabler deploy path if it
  worsens.

---

## BIG FORKS (next product chapters)

- **Phase 2:** gates / lead capture / payment (email gates, leads table, Stripe
  Connect).
- **Phase 4:** owner self-serve (build trigger → owner UI, real owner auth
  replacing the test-only publish gate, per-user style picker).

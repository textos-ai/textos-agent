# Website Manager — Concept

> **⚠️ THIS FILE IS INCOMPLETE — the v2 body is missing.**
>
> Created 2026-07-27 by Claude Code to hold the Decisions log below.
> Searched both repos by name and by pattern on 2026-07-27; no
> `website-manager-concept.md` existed anywhere on disk, so §1–§3 of v2
> (including **§2**, the site-table spec, and **§3**, the superseded
> intake section) are **not present here**.
>
> Sections 1–3 live on the architect side (claude.ai project knowledge).
> Paste the v2 body in above the Decisions section when convenient — the
> Decisions log is written to survive that merge without edits.
>
> Consequence for anyone reading this file as a spec: migration
> `091_website_manager_schema.sql` implements Part B (the seven site
> tables) from the *brief's* column list plus inference. Every inferred
> column is marked `-- INFERRED` inline in that file. `site_fields`
> provenance and all of Part A are specified, not inferred.

---

## 1. Purpose

*(v2 body not on disk — see banner above.)*

## 2. Data model

*(v2 body not on disk — this is the section migration 091 Part B implements
from inference. Reconcile when the body lands.)*

## 3. Intake

*(v2 body not on disk. **Superseded** — see "Business facts vs site content"
in Decisions below.)*

---

## Decisions

Standing decisions, newest section last. These are settled; do not
re-litigate without a superseding entry.

### DECIDED 2026-07-27 — "Open my website" target

The Context page's **OPEN MY WEBSITE** button points to the custom site when
the business has one, and falls back to the generated landing page otherwise.
One button, resolved by what exists.

**Do not implement yet** — it changes when custom sites render (Phase 1B+).
Recorded here so it isn't re-litigated.

### DECIDED 2026-07-27 — Business facts vs site content

Local-business facts (NAP, hours, license, services, service areas) are
**business data** and live in the Context section. Sites **derive** from them
via `source_path`.

This supersedes concept v2 §3, which treated intake as a site-level concern.

*Implemented by:* migration `091_website_manager_schema.sql` Part A
(`business_profile`, `business_hours`, `business_services`,
`business_service_areas`) and the Context-section intake surface.

### DECIDED 2026-07-27 — Composition

Trades sites **compose Homer catalog components**. 12 of 17 sections already
exist in the catalog; `section-hero` and `card-cta` come from Homer's own
`landing.html` demo.

Client sites are skinned **per-client** using the token mechanism
`/sites/[slug]` already has — **not** Victora's brand tokens, which are the
platform skin.

Missing components get **added to the catalog** under a new `site` archetype
rather than hand-written inline.

*Implemented by:* `ArchetypeId` gains `'site'` in
`src/lib/component-catalog/types.ts`; the trades-serving entries are tagged
into it.

*Still open (Phase 1B):* **how** an Astro SSR renderer consumes catalog
entries. Recon on 2026-07-27 found that catalog `html_template` values are
Mustache strings compiled by `preprocessHomerConstructs()` and consumed by
exactly one caller — `assembleApp()`, which emits an HTML blob. `/sites/[slug]`
is Astro SSR (`prerender = false`) and shares no code with it. There is **no
existing "catalog entry as canonical markup, two consumers" pattern** anywhere
in either repo (`src/components/victora/**` holds nine dashboard-chrome
components, none mirroring a catalog entry; `textos-web` has zero references to
`component-catalog`). Composing from the catalog under SSR therefore needs a
bridge that does not exist yet — build-time `.astro` generation from catalog
entries, request-time Mustache in an Astro component, or something else. That
choice is a Phase 1B brief, not an implementation detail.

*Catalog count note:* the docs say "42 cataloged components"
(`textos-web/CLAUDE.md`, `.claude/rules/homer-architecture.md`,
`src/lib/CLAUDE.md`). The operative TS catalog has **67** ids. Stale by 25;
worth reconciling before anyone specs against "the 42."

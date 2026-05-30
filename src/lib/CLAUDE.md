# CLAUDE.md — apps platform / Homer mandate (`src/lib/`)

This file governs the **v2 apps platform** — the archetype-driven
generator that composes operator mini-apps from Homer components. It
lives at `src/lib/` so it auto-loads for every sibling that
participates in generation:

```
src/lib/
  archetypes/         ← strategy | assessment | calculator definitions
  assembler/          ← assembleApp(): the deterministic composer
  component-catalog/  ← the Homer catalog, transcribed to TS
  prompts/            ← LLM design-step prompts
  tasks/generate-business-app-*.ts   ← entry handlers (own CLAUDE? see tasks/)
src/queues/app-gen-html-consumer.ts  ← async generation path (same rules)
```

If you touch any of these, the rules below are non-negotiable.

---

## The mandate: COMPOSE, never hand-write

**Never** hand-write template HTML, Mustache, or CSS for app
components. Every visual element — hero, radio cards, inputs, buttons,
sections, CTAs, multi-step nav — MUST compose a Homer component from
the catalog. If you're writing a `<div class="...">` for an app
surface by hand, stop — find or add the catalog component.

If a component the platform needs is genuinely **missing** from the
catalog, **STOP and surface the gap to Rob.** Do not invent a
replacement.

If the implementation conflicts with the spec, **the implementation is
the bug** — fix the implementation, don't justify the drift.

---

## Architecture (how a generated app is built)

1. **Archetype** (`archetypes/`): one of `strategy | assessment |
   calculator`. Defines the ordered `phases` and which components fit.
2. **`assembleApp(input)`** (`assembler/assembler.ts`) — a **pure
   function**: same input → same output, no network / DB / LLM. It:
   - looks up the archetype,
   - `validateContent()` against the archetype's **Zod** schema +
     cross-field rules (`assembler/validation/`) — throws on bad shape,
   - `renderPhase()` for each phase in order,
   - `wrapDocument()` to emit the final HTML shell.
   The LLM produces the *content* upstream; the assembler only composes.
3. **Catalog** (`component-catalog/`): `CATALOG` is indexed `by_id`,
   `by_category` (`form | navigation | display | feedback | data-viz |
   layout | utility`), `by_archetype`, and `by_tier`
   (`core | extended | experimental`). `getArchetypeComponents()`
   **excludes `experimental`** — don't rely on experimental components
   in a shipping path.

---

## Slot / template conventions (`assembler/template.ts`)

Catalog templates are authored in a Homer notation that is **not**
vanilla Mustache. `preprocessHomerConstructs()` rewrites four
constructs before `Mustache.render`:

| Authored | Becomes | Meaning |
|---|---|---|
| `{{slot:NAME}}` | `{{{NAME}}}` | raw-HTML slot fill — view key is the **flat** `NAME` (e.g. `content`), rendered unescaped |
| `{{key\|default}}` | `{{#key}}{{key}}{{/key}}{{^key}}default{{/key}}` | fallback when empty |
| `{{key?className}}` | `{{#key}}className{{/key}}` | emit class if truthy |
| `{{key?truthy:falsy}}` | `{{#key}}truthy{{/key}}{{^key}}falsy{{/key}}` | ternary |

`Mustache.escape` is force-enabled for plain `{{...}}` tags so
LLM-supplied strings are HTML-escaped (XSS neutralization). Only
triple-brace `{{{…}}}` (and `{{slot:…}}`, which compiles to it) is
raw. **Never** put unescaped LLM output into a template by hand.

---

## Mandatory pre-work (read before editing any file above)

1. **`docs/STYLE_GUIDE.md`** — the locked visual spec. Authority #1.
2. The intent PRDs (now on disk):
   - `../../docs/textos-component-factory-prd.md` (generated apps —
     primary spec; see Addendum A for Homer v3.2.0 specifics)
   - `../../docs/textos-homer-platform-prd.md` (platform-UI companion;
     note: platform chrome lives in **textos-web**, generated apps here
     are chrome-less landing pages)
3. **`../../../textos-web/.homer-reference/catalog-recon-report.md`** —
   verbatim Homer recon (42 entries, html_template, archetype_fits,
   js_dependencies, reliability_tier).
4. The existing `component-catalog/*.ts` entry for any component you're
   modifying.

Authority chain when they disagree: **STYLE_GUIDE → PRDs →
catalog-recon-report → `component-catalog/*.ts`** (the operative TS).

---

## Drift doc

`docs/apps-platform-state.md` reconciles PRD intent with current
implementation. **Read it before** apps-platform work and **update it
after** any apps-platform commit.

---

## Generated apps vs platform pages (don't confuse them)

- **Generated mini-apps** (this repo): chrome-less. A centered
  Bootstrap container, no sidebar/topbar. Composed here, stored as
  HTML, served via the frontend's `/sites/` route.
- **TextOS platform pages**: full Homer admin chrome
  (`HomerLayout.astro`) — those live in **textos-web**, not here. The
  platform PRD covers them; this directory does not build them.

The repo-root `textos-agent/CLAUDE.md` and the workspace router own the
broader rules. This file owns apps-platform composition.

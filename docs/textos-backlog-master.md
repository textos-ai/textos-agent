# TextOS Backlog — Master

Central backlog for cross-cutting, pre-launch, and feature-level work.
Area-specific debt keeps its own file (e.g.
`backlog-v2-architectural-debt.md` for the v2 app generator,
`backlog-json-logging-mandate.md` for logging). Cross-cutting features
go here.

---

## Pre-launch priorities

### LLM Management Feature (pre-launch)

Three-part feature replacing all hardcoded LLM strings:

1. **DB-driven LLM registry** — Supabase table holds model_id,
   provider, alias (sonnet/opus/haiku), context_window,
   max_output_tokens, input/output pricing, status, retirement_date,
   recommended_replacement_alias. Worker resolves alias → active
   model at request time, KV-cached. Zero hardcoded model strings
   anywhere in the worker.

2. **Third-party integration manager** — admin surface listing
   every external service (Anthropic, SendGrid, Stripe, Hunter,
   fal.ai, Blotato, Twilio, Google, Buffer, etc.) with
   enabled/disabled, last-success timestamp, error rate. V1 =
   status surface; V1.1 = runtime gate (couples with backlog
   item for mandatory JSON logging — same fetch wrapper).

3. **API key manager** — hybrid storage. Platform keys stay as
   Worker secrets (admin UI shows presence + last-rotated, never
   the value). Per-business keys (Stripe Connect, future personal
   SendGrid, Blotato sub-accounts) live in Supabase encrypted
   columns (admin UI can set/rotate directly).

**Hard deadline (implicit):** 2026-06-15 — Anthropic retires
claude-sonnet-4-20250514 and claude-opus-4-20250514. Once the
registry exists, both swaps become DB updates
(sonnet → claude-sonnet-4-6, opus → claude-opus-4-7). If June 15
approaches and registry isn't ready, fall back to a hardcoded
string swap as insurance.

**Sub-items rolled up here:** any standalone backlog items for the
Sonnet swap and Opus 4 swap fold into this feature. Removed as
standalone items where they existed — `backlog-v2-architectural-debt.md`
#3 (model hardcoded in the executed call) now points here for the
swap + deadline; its remaining architectural-debt note (resolve the
model from the registry rather than hardcode) stays in that file.

**Hardcoded app-builder model (to be made admin-configurable):**
The app design + build pipeline currently hardcodes claude-opus-4-8
via the APP_BUILDER_MODEL constant. This is deliberate interim state.
Once the LLM registry + admin panel ship, the app-builder model must
be selectable from the admin panel (per-pipeline model assignment),
not a code constant. Migrate APP_BUILDER_MODEL → registry-driven
lookup at that time.

---

## Visitor-facing monetization (deferred — post app-build)

The business owner configures per-app access_gate + result_gate
(free|paywall|email). Architecture lands in Increment 2 (fields +
assembler seams, defaulted to free, unwired). Deferred until the app
build pipeline is solid:
- Stripe Connect for business→visitor payment (separate flow from
  operator→TextOS tokens — do not conflate)
- Visitor token charge at the gate
- Email capture → leads table
- Enforcement logic at the two // GATE SEAM points

Find the seams by grepping "GATE SEAM" in the assembler.

**Schema reconciliation (do before wiring):** `app_configs` already carries
pre-existing visitor-monetization columns — `free_tier_enabled`,
`paid_tier_price_cents`, `token_cost_per_use` — that predate the gate model.
Migration 042 adds `access_gate` / `result_gate` alongside them. When
monetization wires, reconcile the two schemes so there aren't two parallel
ways to express "is this app/result free or paid" (e.g. does `access_gate='paywall'`
supersede `free_tier_enabled=false`? where does `paid_tier_price_cents` apply —
access, result, or both?). Decide one source of truth; don't leave both live.

---

## App builder — Increment 2 follow-ups

> **Increment 2 — SIGNED OFF (2026-05-31, Rob).** Build pipeline + runtime
> result endpoint both verified working. Result is genuinely input-responsive:
> two runs with different guest-count / service-style / theme / date / org
> produced correspondingly different plans (meat counts, service model,
> timeline, and presentation concept all tracked the answers). No fallback
> content observed. Wizard renders well (dark hero, stepper, rich radio cards,
> validation). The result-endpoint 502 is closed (streaming + max_tokens 6000 +
> truncation guard — commits `0efa65d`, `661f55d`). Next: **Increment 3**
> (frame / hero / wizard styling) — see polish items below.

- **§13 test fixtures stale.** `src/lib/assembler/fixtures/strategy.fixture.ts`
  still holds the pre-§13 shape (`hero` / `plan_title` / baked `result.sections`);
  `assembler/__tests__/assembler.test.ts` + `validation.test.ts` import it and
  would fail at runtime against the new `StrategyContentSchema`. Update the
  fixture to the §13 build shape (app_title, app_tagline, hero_icon,
  image_prompt, submit_button_text, questions[text + options.icon],
  result.section_plan + cta) and re-point the two tests. Not deploy-blocking —
  tests aren't bundled.
- **Fresh §13 pipeline tests.** The 6 old `generate-business-app-v2*.test.ts`
  (tool_use / buildSystemPrompt / placeholder transform) were removed; write new
  tests for the plain-JSON §13 build step and the runtime result endpoint.
- **Strategy question-type dispatch (was backlog #6).** Increment 2 constrains
  the design prompt to the recipe's fixed 7-question layout (2 text, 1 textarea,
  2 radio, 1 text, 1 textarea). Make the wizard render each question by its
  LLM-chosen type (as assessment already does) so the layout isn't hardcoded.

---

## App builder — Increment 3 (frame / hero / wizard / result polish)

- **PDF button shows before the result exists.** Captured 2026-05-31 (Increment 2
  screenshot review). The "Download as PDF" button is visible during the
  "Building your plan…" spinner state, before any result has rendered. Hide or
  disable it until the result phase is populated. Front-end only; folds into this
  increment's wizard/result polish pass.
- **Progressive/streamed result render — now elevated (see
  `backlog-v2-architectural-debt.md` #9).** Bumped UP in priority 2026-05-31: the
  ~29s blank spinner is the visitor's actual experience, and since the result
  endpoint already streams server-side (`anthropic.messages.stream`), surfacing
  sections as they arrive is a **front-end-only** change. Strong candidate for
  Increment 3.

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

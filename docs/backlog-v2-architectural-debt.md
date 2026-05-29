# Backlog: generate-business-app-v2 — Architectural Debt

**Captured:** 2026-05-29 (Path A cleanup — pre-cleanup audit of `src/lib/tasks/generate-business-app-v2.ts`)
**Priority:** High — these are correctness gaps, not polish. Schedule before v2 is exposed to non-strategy archetypes or promoted past test.
**Owner:** TBD
**Context:** The 2026-05-28 debug marathon (see `docs/prompt-schema.md` §7 and `docs/v1-vs-v2-prompt-comparison.md`) ended with a deliberately minimal "v1-style simple prompt + code-side transform" stopgap that works (~16–20s on test). Path A removed the debug scaffolding around that stopgap **without changing its behavior**. The four items below are the real debts that survive — intentionally left untouched in Path A.

---

## 1. v2 generates strategy-only

The handler accepts `archetype_id` of `strategy | assessment | calculator` (validated in `parseV2Config`), but generation ignores the archetype:

- The executed system/user prompts (`workingSystemPrompt`, `simpleAppPrompt`) are hardcoded to a **strategy** app with a fixed 10-question structure.
- The transformation layer (`transformedContent`) is strategy-shaped (`hero` / `questions` / `paywall` / `result`).

**Consequence:** `assessment` and `calculator` requests would be mis-generated — they'd receive a strategy prompt and be forced into the strategy output shape.

**Fix:** Wire prompt construction and the transform to the selected archetype (per-archetype prompts + per-archetype transform/shape).

---

## 2. Zod validation does not run

- `validateContent` (from `../assembler`) was imported but never called — **removed in Path A as dead code.**
- The Zod content schemas (`StrategyContentSchema`, `AssessmentContentSchema`, `CalculatorContentSchema`) are only used to build `jsonSchemaRef` for the (dead) "proper" request path; they never validate the parsed model output.
- The de-facto validator today is the manual required-field check (`app_title` / `questions` array non-empty) immediately before the transform.

**Fix:** After JSON parse, validate the parsed content against the archetype's Zod schema (`StrategyContentSchema` for strategy, etc.) with the parse + validate + retry-once guard described in `docs/prompt-schema.md` §2.1. This is the documented "generate simple, validate strict" pattern.

---

## 3. Model is hardcoded in the executed call

The live `anthropic.messages.create` call hardcodes `model: "claude-sonnet-4-20250514"`, **not** the `model` variable resolved from the tier (`resolveModelForTier(llmTier)`) at the top of the handler. The retry path and work_log already use the resolved `model`, so the two can diverge.

**Fix:** Use the resolved `model` variable in the primary call. Verify the swap is a no-op for the `sonnet` tier before shipping (confirm `resolveModelForTier('sonnet')` === `claude-sonnet-4-20250514`).

**Time pressure:** `claude-sonnet-4-20250514` is a Sonnet-4-class ID scheduled to **retire from the API on 2026-06-15** (`docs/api-docs/anthropic/model-deprecations-and-lifecycle.md`, `docs/prompt-schema.md` §3). v2 must move off it — likely to `claude-sonnet-4-6` (1M context, 64K output, structured-outputs support) — before that date. This ties into the structured-outputs migration noted in `docs/prompt-schema.md` §7 follow-ups.

---

## 4. The "proper" archetype-driven request scaffolding is dead but retained

The handler still builds `systemPrompt` (archetype prompt + `jsonSchemaRef` from the Zod schema via `zodToJsonSchema`) and `userPrompt`. The fully-unused `requestBody` object that wrapped these was **removed in Path A**, but `systemPrompt` / `userPrompt` / `jsonSchemaRef` remain — they are currently only consumed by the **retry path** and the dev/test work_log preview, not the primary call.

**Fix:** Once #1 and #2 are addressed, repurpose this scaffolding into the real pipeline (archetype-driven prompt + Zod-validated output, optionally `output_config.format` structured outputs on a supporting model per #3). Until then, leave it untouched — it's the seed of the correct implementation, not noise.

---

## Notes

- Path A scope was **pure removal of debug scaffolding** (console.logs, diagnostic comments, dead `requestBody`, redundant aliases, the documented-ineffective `Promise.race` + `setTimeout` wrapper) plus adapting the v2 unit tests. No behavior change to the working strategy path.
- The dev/test full-payload work_log logging was **kept** (aligns with `docs/backlog-json-logging-mandate.md`).

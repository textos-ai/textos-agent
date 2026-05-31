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

> **→ Folded into the LLM Management Feature** (`textos-backlog-master.md`, 2026-05-31).
> The model-string swap and the 2026-06-15 retirement deadline are tracked there.
> The standalone "Sonnet swap" framing is retired; the architectural fix that
> remains here is to resolve the model from the DB registry rather than hardcode it.

The live `anthropic.messages.create` call hardcodes `model: "claude-sonnet-4-20250514"`, **not** the `model` variable resolved from the tier (`resolveModelForTier(llmTier)`) at the top of the handler. The retry path and work_log already use the resolved `model`, so the two can diverge.

**Fix:** Use the resolved `model` variable in the primary call (and, once the LLM registry lands, resolve from it). Verify the swap is a no-op for the `sonnet` tier before shipping (confirm `resolveModelForTier('sonnet')` === `claude-sonnet-4-20250514`).

**Time pressure:** `claude-sonnet-4-20250514` is a Sonnet-4-class ID scheduled to **retire from the API on 2026-06-15** (`docs/api-docs/anthropic/model-deprecations-and-lifecycle.md`, `docs/prompt-schema.md` §3). v2 must move off it — likely to `claude-sonnet-4-6` (1M context, 64K output, structured-outputs support) — before that date. This ties into the structured-outputs migration noted in `docs/prompt-schema.md` §7 follow-ups.

---

## 4. The "proper" archetype-driven request scaffolding is dead but retained

The handler still builds `systemPrompt` (archetype prompt + `jsonSchemaRef` from the Zod schema via `zodToJsonSchema`) and `userPrompt`. The fully-unused `requestBody` object that wrapped these was **removed in Path A**, but `systemPrompt` / `userPrompt` / `jsonSchemaRef` remain — they are currently only consumed by the **retry path** and the dev/test work_log preview, not the primary call.

**Fix:** Once #1 and #2 are addressed, repurpose this scaffolding into the real pipeline (archetype-driven prompt + Zod-validated output, optionally `output_config.format` structured outputs on a supporting model per #3). Until then, leave it untouched — it's the seed of the correct implementation, not noise.

---

## 5. Result phase renders almost empty

**Captured:** 2026-05-29 (during the four-bug fix pass; commit `de45115` fixed the inputs phase, lists, title, and the submit→paywall→result *wiring* — so the visitor can now *reach* the result — but the result *content* is still largely blank).
**Tag:** assembler debt. Downstream of #1 and #2 (the strategy transform/shape and the lack of real validation are what let this ship). Independent of the four bugs already fixed.
**Verification:** Generate a fresh strategy app, complete the wizard, click through the paywall. The unlocked result (`.tx-phase-result`) shows section *headings* only — no intro text, no section bodies, no action items, and a broken CTA link. Confirmed against the live row `c780bdb3-…` whose `asset_data.html` exhibits all four sub-defects below.

Four distinct sub-defects, all in the assembler, compound here:

**(a) `card-basic` slot mismatch → intro + every section body render blank.**
`c_card_basic.html_template` (`src/lib/component-catalog/display.ts:16-23`) emits the body via `{{slot:content}}`. The strategy result recipe binds `content: 'result.intro'` and `content: 'result.sections[].body'` (`src/lib/archetypes/strategy.ts:213-218`, `221-225`), and the slot resolver returns a view keyed `content` — there is no key `slot:content`. The template engine is plain Mustache (`src/lib/assembler/template.ts`), which treats `{{slot:content}}` as a lookup of a key literally named `slot:content`, finds nothing, and renders empty. Net: the title (`{{title}}`) renders, the body never does. `{{slot:content}}` is a homemade token that Mustache does not understand; either the catalog templates need a pre-pass that rewrites `{{slot:X}}`→`{{X}}` (or `{{{X}}}` for trusted markup), or the templates should use plain Mustache tags. Check every catalog template for `{{slot:...}}` — `container` and `row-col` use it too (`layout.ts:16`, `35`).

> **Update 2026-05-30 (engine half done):** the recommended pre-pass is
> implemented — `src/lib/assembler/template.ts` `preprocessHomerConstructs()`
> rewrites `{{slot:X}}`→`{{{X}}}` (plus `{{k|default}}`, `{{k?class}}`,
> `{{k?a:b}}`), with `assembler/__tests__/template.test.ts` coverage. Homer
> slots/defaults/conditional classes now render. **Still open** (re-verified
> in code 2026-05-30): **5(b)** — `renderResult()` in `phase-renderer.ts`
> maps `phase.components` once with no `sections[]` fan-out, and
> `slot-resolver.ts` `tokenize()` turns `sections[]` into index 0, so only
> the first section renders. **5(c)** — `shouldSkipCandidate()` still
> `return true`s for any optional non-multi-candidate, so the `action_items`
> list-group is skipped. **5(d)** — `generate-business-app-v2.ts:309` still
> emits `cta_url_placeholder: "/business/{{business_slug}}/contact"`, which
> is not the `cta_url_placeholder` sentinel `slot-resolver.ts` substitutes,
> so the raw templated path renders into the href.

**(b) `result.sections[]` array iteration is not implemented → only the first section renders.**
The recipe says "One card-basic per `result.sections[]` entry. Assembler iterates." (`strategy.ts:221-227`) — but `renderResult()` in `src/lib/assembler/phase-renderer.ts:134-141` just maps over `phase.components` **once** and calls `renderOne` per component; there is no per-array-element fan-out. Worse, the empty-bracket path `result.sections[].heading` tokenizes to index **0**, not "all": in `src/lib/assembler/slot-resolver.ts:108-110`, `Number(path.slice(i+1, close))` on `[]` is `Number('')` === `0`, which is finite, so the resolver silently reads `result.sections[0]`. Combined, exactly the **first** section's heading renders and the rest are dropped. Fix needs a real iteration construct in the phase renderer (expand a `foo[]`-bound component into one rendered instance per array element, with each element's scalar paths resolved against that element) — this is shared machinery the Assessment/Calculator result phases will also want.

**(c) `action_items[]` never render (optional-gating swallows them).**
The action-items `list-group` is declared `optional: true` (`strategy.ts:230-237`). In `phase-renderer.ts:184-240`, `shouldSkipCandidate()` falls through to `if (pc.optional) return true` for any optional component that isn't one of the recognized multi-candidate types (assessment question / calculator input / calculator chart). So the list-group is always skipped and action items never appear. The optional-means-skip default was built for runtime-only components (spinner, alert) that "light up at submit/error time"; a content-bearing optional like action_items needs a real present-vs-absent check (render when the bound array exists and is non-empty), not an unconditional skip.

**(d) `cta_url` shows the literal `/business/{{business_slug}}/contact`.**
The slot resolver only swaps the **exact** sentinel string `cta_url_placeholder` for the operator URL (`src/lib/assembler/slot-resolver.ts:43-45`, `94-96`). But the v2 transform emits `cta_url_placeholder: "/business/{{business_slug}}/contact"` (`src/lib/tasks/generate-business-app-v2.ts:305`) — a value that is *not* the sentinel — so no substitution fires and the raw string (including the never-substituted `{{business_slug}}`) renders into the `href`. Either the transform should emit the literal sentinel `"cta_url_placeholder"` (matching the contract in `strategy.ts:483-490` and the fixture `strategy.fixture.ts:79`), or the result CTA should be built from `business_context.operator_url` directly. Note `{{business_slug}}` is not a supported placeholder anywhere — there is no Mustache view key for it at render time, so it would survive regardless.

**Fix (summary):** treat this as one "make the result phase actually render its content" task — (a) resolve the `{{slot:...}}` token convention, (b) implement array-element iteration in the phase renderer, (c) give content-bearing optional components a presence check, (d) make the CTA URL use the real sentinel/operator URL. Best done together with #1/#2 since a correct per-archetype transform + Zod validation defines the shape this renderer must honor.

---

## 6. Strategy recipe has 7 fixed-type slots; the prompt produces 10 single-choice questions

**Captured:** 2026-05-29 (same pass as #5).
**Tag:** renderer–recipe contract debt. Downstream of #1 (the strategy prompt + transform and the strategy recipe were authored against different shapes and never reconciled).
**Verification:** Generate a fresh strategy app. Only a subset of questions render as proper choice cards; several render as empty text inputs and the last few don't appear at all. Confirmed against row `c780bdb3-…`: of 10 generated questions, only q4/q5 rendered correctly as `radio-cards`; q1–q3 and q6–q7 rendered as `text-input`/`textarea` with their choices dropped; q8/q9/q10 did not render at all.

**Root cause — three layers disagree on count and type:**

- **Prompt:** `simpleAppPrompt` (`src/lib/tasks/generate-business-app-v2.ts:104-122`) instructs "Create exactly 10 questions" and, in practice, the model returns all of them as `single_choice` with `options`.
- **Transform:** maps each question to `type: 'radio_cards'` when `single_choice` else `'text'`, and distributes them across 3 steps via `step: Math.min(Math.floor(index/3)+1, 3)` (`generate-business-app-v2.ts:256-269`). It preserves all 10 with their options.
- **Recipe:** `STRATEGY_ARCHETYPE.phases[0].components` (`src/lib/archetypes/strategy.ts:59-136`) hardcodes exactly **7** question slots at fixed indices with fixed component types: `questions[0]`→text-input, `questions[1]`→text-input, `questions[2]`→textarea (step 1); `questions[3]`→radio-cards, `questions[4]`→radio-cards (step 2); `questions[5]`→text-input, `questions[6]`→textarea (step 3). These slots are **not** `optional`, so the renderer emits them unconditionally and ignores `questions[i].type`.

**Consequences:**
- A question landing in a `text-input`/`textarea` slot (indices 0,1,2,5,6) renders a free-text field and **never reads `questions[i].options`** — the choice cards are silently lost (q1–q3, q6–q7 in the live row).
- Questions at indices ≥ 7 (q8,q9,q10) have **no recipe slot** → never rendered at all.
- Only indices 3 and 4 (radio-cards slots) happen to match the model's `radio_cards` type, so only those two render correctly.

**Contrast with Assessment, which already does this right:** the Assessment inputs phase uses `optional: true` multi-candidate components and `shouldSkipCandidate()` selects the component per `questions[i].type` via `mapAssessmentTypeToComponent()` (`src/lib/assembler/phase-renderer.ts:184-201`, `242-249`). Strategy uses fixed non-optional slots and therefore can't honor the LLM's per-question type or a variable question count.

**Fix:** make the Strategy inputs phase type- and count-driven like Assessment — render one component per `content.questions[i]`, choosing the component from `questions[i].type` (`text`→text-input, `textarea`→textarea, `radio_cards`→radio-cards), grouped into wizard steps by `questions[i].step`, for however many questions exist — rather than enumerating fixed indexed slots. This needs the same per-array iteration machinery as #5(b), and it should be reconciled with #1 (decide the canonical strategy question count/types in the prompt + transform + Zod schema so all three agree). Until then, the safest interim is to make the prompt/transform emit exactly the 7 questions in the types the recipe expects — but that's a stopgap; the durable fix is a type-driven renderer.

---

## Notes

- Path A scope was **pure removal of debug scaffolding** (console.logs, diagnostic comments, dead `requestBody`, redundant aliases, the documented-ineffective `Promise.race` + `setTimeout` wrapper) plus adapting the v2 unit tests. No behavior change to the working strategy path.
- The dev/test full-payload work_log logging was **kept** (aligns with `docs/backlog-json-logging-mandate.md`).

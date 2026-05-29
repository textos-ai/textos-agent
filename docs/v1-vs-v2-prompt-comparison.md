# V1 vs V2 App-Generation Prompts — Side-by-Side

**Built:** 2026-05-28, overnight, after the v2 hang was resolved.
**Purpose:** See and compare exactly what we send to Claude in the working
(v1) path vs the v2 path — both the broken v2 prompt that hung for 5 minutes
and the simplified v2 prompt that now works in ~20 seconds.

---

## ⚠️ Read this first — provenance of each prompt

Not all three prompts below come from the same source, so trust them
accordingly:

| Prompt | Source | Trust level |
|---|---|---|
| **V1 working** (`business-landing-page`) | Synced repo (project knowledge) | ✅ Verbatim |
| **V2 BROKEN** (tool_use, hung 5 min) | Captured verbatim from `task_runs.work_log` during last night's debug | ✅ Verbatim — this is exactly what was on the wire |
| **V2 NEW** (simplified, works) | Reconstructed from Code's post-mortem summary | ⚠️ **Approximate** — Code wrote this last night and the repo isn't synced. **Verify against the actual `generate-business-app-v2.ts` source in the morning.** |

**Also note:** the truest apples-to-apples v1 comparison would be
`generate-business-app-design.ts` (the v1 *app* design step), but project
knowledge didn't have its full prompt body. `business-landing-page.ts` is
shown instead — it's a working, structurally-similar content-generation call
from the same codebase. If you sync/paste `generate-business-app-design.ts`
in the morning, I'll add it for an exact match.

---

## TL;DR — the difference in one table

| | V1 working | V2 BROKEN | V2 NEW (works) |
|---|---|---|---|
| System prompt size | ~450 chars | ~2,400 chars | ~480 chars |
| Embedded JSON schema in prompt? | **No** — output shape described in the *user* prompt as a flat field list | **Yes** — full nested schema sent as a `tools` definition (~3 KB) | **No** — simple flat structure requested |
| Total request payload | ~2–3 KB | ~5.4 KB (5,388 bytes logged) | ~0.7 KB |
| Delivery mechanism | Plain text → parse JSON | `tool_use` with forced `tool_choice` | Plain text → parse JSON → transform |
| `max_tokens` | 2,000 | 4,000 | 2,000 |
| Output the LLM must produce | Flat object, ~25 fields | Deeply nested object (hero + questions[] + options[] + paywall + result + sections[] + cta) | Simple object (title + questions[] + reveals) |
| Result | ✅ ~17–22 s | ❌ 5-min hang, no error | ✅ ~20 s |

**The single biggest structural difference:** V1 never sends a schema as a
formal structure. It *describes* the shape it wants in plain English in the
user prompt and lets Claude return matching JSON. V2-broken sent a large,
deeply-nested formal JSON Schema (with `anyOf` unions and
`additionalProperties` everywhere) as a `tools` definition. V2-new went back
to V1's approach: ask in plain language, keep it small, transform afterward.

---

## 1. V1 WORKING — `business-landing-page.ts` (Call 1)

This call generates a complete business website's structure and content. It
is at least as "rich" an output as a v2 app, and it completes every time in
~17–22 seconds.

**System prompt (verbatim):**

```
You are a creative director for {business.name}, a {industry} business.
{business_summary}. Value prop: {value_proposition}. Target customer:
{JSON of target_customer}. Brand voice: {brand_voice}. Return ONLY valid
JSON. No preamble. First character must be {.
```

**User prompt (verbatim, abridged field list — full list in repo):**

```
Design the structure and visual identity for this business website.

Return ONLY valid JSON (no markdown, no backticks) with these fields:
- hero_layout, hero_font, accent_color, eyebrow_vocab, hero_css_pattern
- hero_eyebrow: 2-4 words all caps
- hero_headline: 4-7 words
- hero_headline_accent: 1-3 accent words from headline
- hero_subhead: one sentence 15-25 words
- hero_cta_label: 3-5 words
- cta_type: "calendly", "email_capture", or "stripe"
- metrics: array of 3 objects with value and label
- icp_headline: 5-8 words
- icp_signals: array of 3 short signals
- pain_points: array of 3 objects with icon (emoji) and headline (4-6 words)
- why_us: array of 3 objects with headline (3-5 words)
- palate_cleanser_type: "pull_quote", "big_number", or "manifesto"
- palate_cleanser_content: under 15 words
- seo_title / seo_description / seo_keywords
- nav_links: array of 3 objects with label and anchor
- nav_cta_label: 3-5 words
- fal_og_image_prompt: under 80 words
```

**Request parameters (verbatim):**

```js
anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 2000,
  stream: false,
  system: call1SystemPrompt,
  messages: [{ role: "user", content: call1UserPrompt }],
})
// wrapped in Promise.race with a 45s timeout
```

**Why it works:**
- No `tools`, no `tool_choice` — just "return JSON shaped like this."
- The shape is a *flat field list described in prose*, not a formal nested
  schema object.
- `max_tokens: 2000`, `stream: false`.
- Output is a single flat-ish object — no deep nesting.

---

## 2. V2 BROKEN — the prompt that hung for 5 minutes

This is captured **verbatim** from `task_runs.work_log` (request body, 5,388
bytes). The structure-defining bulk is the `tools[0].input_schema`, sent as a
formal JSON Schema.

**System prompt (verbatim):**

```
You produce content for a Personalized Strategy Plan mini-app for a specific
business. You do NOT write HTML or JavaScript. You fill the content_schema
with high-quality, business-specific content.

BUSINESS CONTEXT:
- Business name: Ground Force Humanitarian Aid
- Business type: donation_funded
- Industry: Nonprofit Disaster Relief & Emergency Humanitarian Services
- Key differentiators: Exclusively focused on elderly and disabled disaster
  victims [...long...], Five integrated programs operating simultaneously
  [...long...], Proven $1-to-$12 relief leverage ratio [...long...]
- Target customer: Elderly, disabled, and vulnerable Americans (primarily
  65+) [...long...]
- Value proposition: A year-round, boots-on-the-ground safety net [...long...]

OPERATOR INTENT:
Quick 10-question marketing plan for a humanitarian aid organization to
attract recurring donors

QUALITY BAR:
- Result must provide monetary-equivalent value (replaces a consultant hour,
  a paid tool, an audit)
- Result must end with a clear CTA
- Content must be specific to this business, not generic
- Above-the-fold rule: hero section must work without scrolling

STRATEGY ARCHETYPE GUIDANCE:
- Produce 3-5 strategy sections, each actionable
- Section bodies should be 2-3 sentences
- Action items should be concrete and specific
- Focus on tactics that this specific business can implement immediately
- Each section should build toward a cohesive strategic direction

FORBIDDEN VOCABULARY:
Never use these terms: AI, agent, task, automation, tool, bot, execute,
process, prompt, generate, "Get Started", "Dashboard". Use
operator-vocabulary terms: business, customer, plan, brief, build.

OUTPUT INSTRUCTION:
Call the generate_app_content tool with content that conforms to the
input_schema.
```

**User prompt (verbatim):**

```
Create content for this mini-app based on the business context and intent
described above.

Operator's specific request: "Quick 10-question marketing plan for a
humanitarian aid organization to attract recurring donors"

Call the generate_app_content tool with appropriate content.
```

**The `tools` definition (verbatim — THIS is the bulk, ~3 KB):**

```json
{
  "name": "generate_app_content",
  "description": "Produce content for a Personalized Strategy Plan mini-app",
  "input_schema": {
    "type": "object",
    "required": ["hero", "questions", "paywall", "result"],
    "additionalProperties": true,
    "properties": {
      "hero": {
        "type": "object",
        "required": ["title", "subtitle"],
        "additionalProperties": true,
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "subtitle": { "type": "string", "minLength": 1 }
        }
      },
      "questions": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": ["id", "step", "label", "type", "required"],
          "additionalProperties": true,
          "properties": {
            "id": { "type": "string", "minLength": 1 },
            "rows": { "type": "number" },
            "step": {
              "anyOf": [
                { "type": "number" },
                { "enum": ["1", "2", "3"], "type": "string" }
              ]
            },
            "type": { "enum": ["text", "textarea", "radio_cards"], "type": "string" },
            "label": { "type": "string", "minLength": 1 },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["value", "title"],
                "additionalProperties": true,
                "properties": {
                  "desc":  { "type": "string" },
                  "title": { "type": "string", "minLength": 1 },
                  "value": { "type": "string", "minLength": 1 }
                }
              }
            },
            "required": { "type": "boolean" },
            "placeholder": { "type": "string" }
          }
        }
      },
      "paywall": {
        "type": "object",
        "required": ["title", "body", "cta_label"],
        "additionalProperties": true,
        "properties": {
          "body":       { "type": "string", "minLength": 1 },
          "title":      { "type": "string", "minLength": 1 },
          "footer":     { "type": "string" },
          "cta_label":  { "type": "string", "minLength": 1 },
          "email_label":{ "type": "string" }
        }
      },
      "result": {
        "type": "object",
        "required": ["plan_title", "intro", "sections", "cta"],
        "additionalProperties": true,
        "properties": {
          "plan_title": { "type": "string", "minLength": 1 },
          "intro":      { "type": "string", "minLength": 1 },
          "sections": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "required": ["heading", "body"],
              "additionalProperties": true,
              "properties": {
                "body":         { "type": "string", "minLength": 1 },
                "heading":      { "type": "string", "minLength": 1 },
                "action_items": { "type": "array", "items": { "type": "string" } }
              }
            }
          },
          "cta": {
            "type": "object",
            "required": ["headline", "body", "cta_label", "cta_url_placeholder"],
            "additionalProperties": true,
            "properties": {
              "body":               { "type": "string", "minLength": 1 },
              "headline":           { "type": "string", "minLength": 1 },
              "cta_label":          { "type": "string", "minLength": 1 },
              "cta_url_placeholder":{ "type": "string", "minLength": 1 }
            }
          }
        }
      }
    }
  }
}
```

**Request parameters (verbatim):**

```js
anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4000,
  temperature: 0.7,
  system: <the system prompt above>,
  messages: [{ role: "user", content: <the user prompt above> }],
  tools: [ <the tool definition above> ],
  tool_choice: { type: "tool", name: "generate_app_content" }
})
```

**What was different / suspect (in rough order of likelihood):**
1. **A large formal nested schema** sent as a `tools` definition (the bulk of
   the 5.4 KB). This is the thing v1 never does.
2. **Deeply nested required structure** — `result.sections[].action_items[]`,
   `questions[].options[]`, etc. The model had to produce a big, deep object.
3. **`anyOf` union** on the `step` field + **`additionalProperties: true`**
   on every object.
4. **`max_tokens: 4000`** (double v1) — allowed a longer, larger generation.

> ⚠️ Honest caveat: during the debug we **removed `tool_use`** entirely (went
> plain-text) and it **still hung**, and we tried `max_tokens: 2000` and it
> **still hung**. So no single one of items 1–4 above was *individually* the
> whole cause. The plain-text version that still hung had a ~7,815-char prompt
> (the schema was embedded as text instead of as a tool). Only when the prompt
> was cut to ~677 chars (V2 NEW below) did it work. **The mechanism is not
> fully understood — see "What we actually know" at the end.**

---

## 3. V2 NEW — the simplified prompt that works (~20 s)

⚠️ **Reconstructed from Code's post-mortem, not verbatim from source.**
Verify against `generate-business-app-v2.ts` in the morning.

**System prompt (approx, ~480 chars):**

```
You are designing a strategy app for {business}. Return ONLY valid JSON.
```

**User prompt (approx, ~677 chars total request):**

```
Design a simple strategy app with this structure:
{
  "app_title": "string",
  "app_description": "string",
  "questions": [
    { "id": "string", "text": "string", "type": "single_choice|text",
      "options": ["string"] }
  ],
  "free_tier_reveals": ["string"]
}
```

**Request parameters (approx):**

```js
anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 2000,
  stream: false,
  system: <short system prompt>,
  messages: [{ role: "user", content: <short user prompt> }],
})
```

**Then a transformation layer** (`transformToSchema`) maps the simple output
into the full content schema the assembler expects — auto-filling `step`,
`paywall`, `result`, and synthesizing `options` values/descriptions.

**Trade-off to be aware of:** because the rich parts (paywall, result
sections, option descriptions) are now auto-generated/templated rather than
written by Claude, the generated app's content reads thinner and more generic
than the eventual vision. This is an acceptable MVP shortcut to prove the UX,
but it brushes against the project's "no fallbacks" rule and should be
revisited deliberately when building richer apps.

---

## 4. The actual diff — what changed from broken → working

1. **Dropped the formal schema from the wire.** No `tools`/`tool_choice`; no
   large JSON Schema object. (Matches v1.)
2. **Shrank the prompt ~91%** — from ~7,815 chars (or 5.4 KB with the tool) to
   ~677 chars.
3. **Asked for a flat, shallow structure** instead of a deep nested one.
4. **`max_tokens` 4000 → 2000.** (Matches v1.)
5. **Added a transformation layer** to rebuild the rich structure in code
   after generation, instead of asking the LLM to produce it.

In short: **V2-new is V1's playbook.** Small prompt, plain-text JSON request,
flat shape, 2000 tokens, build complexity in code afterward.

---

## 5. What we actually KNOW vs. what is still a guess

You said you want to *understand* prompt limits before building complex apps.
Here is the honest state of knowledge, separated cleanly:

**Known (evidence-backed):**
- The big v2 prompt (tool-use 5.4 KB, and plain-text 7.8 KB) hung for exactly
  5 minutes — the Cloudflare `waitUntil` cap — with no error.
- The small v2 prompt (~677 chars) completes in ~20 s.
- v1's working calls all use small prompts, flat shapes, `max_tokens ≤ 2000`,
  no formal schema on the wire.
- In a controlled diagnostic *inside the v2 handler*, two small Anthropic
  calls succeeded in <1 s right before the big call hung — so connectivity,
  credentials, and execution path are fine.

**NOT known (still a guess — do not treat as settled):**
- *Why* a ~7.8 KB prompt hangs for 5 minutes with no error, when v1's HTML
  step reportedly sends large prompts and ~8,000-token outputs and completes
  in 40–90 s. "Prompt size" alone does not cleanly explain this; something
  about *this* prompt/shape crosses a threshold that v1's does not.
- Whether the trigger is total prompt size, output structure depth, the
  `anyOf`/`additionalProperties` constructs, generation *duration*, or an
  interaction of several.
- The exact safe ceiling (chars / tokens / nesting depth) for a reliable
  call in our Workers environment.

**Code's post-mortem asserts "prompt complexity overload / memory pressure /
cold starts."** Treat that as a working hypothesis, not a proven root cause —
the memory/cold-start claims are unverified and partly contradicted by v1's
large-output calls working fine.

---

## 6. To make this comparison complete (morning to-dos)

1. **Sync the repo** (tap Sync on the project knowledge panel) so I can read
   the *actual* new `generate-business-app-v2.ts` and replace the
   reconstructed V2-NEW section with verbatim source.
2. **Paste or sync `generate-business-app-design.ts`** — the true v1 *app*
   analog — so the v1 column is an exact app-to-app match rather than the
   landing-page stand-in.
3. Decide whether to run the **"understand prompt limits" experiment** (a
   short, controlled sweep: hold the execution path constant and vary one
   thing at a time — prompt size, nesting depth, schema-on-wire vs not,
   max_tokens — to find the actual breaking threshold). This is the only way
   to turn the guesses above into knowledge before building complex apps.

---

*Generated overnight so it's waiting when you wake up. The V1 and V2-BROKEN
prompts are verbatim; the V2-NEW prompt needs a quick source check.*

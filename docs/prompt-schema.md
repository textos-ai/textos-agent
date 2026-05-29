# prompt-schema.md — API Request/Response Surface Reference

**Owner:** TextOS (Rob Gaudet)
**Maintained by:** Claude (architect) + Claude Code (implementer)
**First built:** 2026-05-28 from official Anthropic documentation
**Status:** Anthropic complete (v1). Other APIs (fal.ai, SendGrid, Stripe, Hunter.io, Blotato) to follow.

---

## 0. What this file is and why it exists

This is the single source of truth for **the exact shape of every request we send to, and every response we receive from, the external APIs TextOS depends on** — starting with Anthropic.

It exists because on 2026-05-28 we lost ~6 hours to a `generate-business-app-v2` call that hung for exactly 5 minutes with no error. The root cause turned out to be a documented limit we didn't know about (see §6, "The 2026-05-28 incident"). Had this reference existed, the cause would have been obvious in minutes. **Never again.** Before designing any prompt, schema, tool definition, or output contract, the relevant section of this file must be consulted.

### Mandatory usage rules (for Claude AND Claude Code)

1. **Review-before-build.** Before writing or modifying any code that sends a request to or parses a response from an external API, read the relevant section of this file. For Anthropic calls, that means §1–§6 below.
2. **Schema must be tied to the selected model.** Every Anthropic call in the codebase is associated with a model (via `model-router.ts` / `MODEL_IDS`). The capabilities and limits in §3 differ by model. When choosing or changing a call's model, re-check that the request shape is valid for that model (e.g. structured outputs support, max output tokens, prefill support).
3. **Stay inside the documented limits in §4.** Especially: structured-outputs/strict-tools complexity limits (union types ≤ 16, optional params ≤ 24, 180s grammar-compilation timeout) and per-model max output tokens.
4. **Log full JSON both directions.** Per the JSON-logging mandate (`docs/backlog-json-logging-mandate.md`), every external call's request + response is logged in full. This file defines the *shape*; the logging mandate defines the *capture*. They are complementary.
5. **When the docs and this file disagree, the docs win — then update this file.** Re-fetch the linked official pages periodically; APIs change. Note the "last verified" date at the top of each API section.

---

# PART 1 — ANTHROPIC (Claude API)

**Last verified against official docs:** 2026-05-28
**Base URL:** `https://api.anthropic.com`
**Primary endpoint:** `POST /v1/messages`
**SDK in use:** `@anthropic-ai/sdk` `^0.39.0` (TypeScript, in `textos-agent`)
**Official docs (saved locally — see `/docs/api-docs/anthropic/`):**
- Messages API: https://platform.claude.com/docs/en/api/messages/create
- Working with Messages: https://platform.claude.com/docs/en/build-with-claude/working-with-messages
- Structured Outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Tool use overview: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Strict tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
- Streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Models (canonical capability/limit reference): https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/models.md

---

## 1. Request shape — `POST /v1/messages`

### Required headers
| Header | Value |
|---|---|
| `x-api-key` | your API key (SDK sends automatically) |
| `anthropic-version` | `2023-06-01` |
| `content-type` | `application/json` |

### Request body fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | **Yes** | Exact model ID — see §3. e.g. `claude-sonnet-4-20250514`. |
| `max_tokens` | integer | **Yes** | Max tokens to *generate*. Must be ≤ the model's max output (see §3). This is a **ceiling**, not a target. |
| `messages` | array | **Yes** | Conversation turns. Each `{ role: "user" \| "assistant", content }`. Stateless — send full history each call. |
| `system` | string \| array | No | System prompt. String or array of content blocks. |
| `stream` | boolean | No | Default `false`. **See §5 — strongly recommended `true` for large outputs in Cloudflare Workers.** |
| `temperature` | number | No | 0–1. Default 1.0. Lower = more deterministic. |
| `top_p` | number | No | Nucleus sampling. Don't combine with `temperature` tuning. |
| `top_k` | integer | No | Top-k sampling. |
| `stop_sequences` | array of strings | No | Custom stop strings. |
| `tools` | array | No | Tool definitions — see §2. |
| `tool_choice` | object | No | `{type:"auto"}`, `{type:"any"}`, `{type:"tool", name:"..."}`, or `{type:"none"}`. |
| `output_config` | object | No | **Structured outputs (the modern way to get guaranteed JSON)** — see §2.3. |
| `thinking` | object | No | Extended/adaptive thinking parameters (model-dependent). |
| `metadata` | object | No | e.g. `{ user_id }`. |

### `content` block types (inside a message)
- `{ "type": "text", "text": "..." }`
- `{ "type": "image", "source": { "type": "base64"|"url"|"file", ... } }` — media types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- `{ "type": "document", "source": {...} }` — PDFs via Files API or base64
- `{ "type": "tool_use", "id", "name", "input" }` — (in assistant turns)
- `{ "type": "tool_result", "tool_use_id", "content", "is_error"? }` — (in user turns, replying to a tool_use)

### Minimal request (verbatim shape)
```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "Hello, Claude" }]
}
```

---

## 2. Three ways to get structured data back

This is the most important section for TextOS — almost every task wants structured JSON. There are **three** mechanisms, in rough order of how we should prefer them today:

### 2.1 Plain-text JSON (what v1 tasks do; the safe default today)
Ask for JSON in the prompt, return as text, parse it yourself.
- **Request:** no `tools`, no `output_config`. System/user prompt describes the desired shape *in prose* (NOT as an embedded formal schema). `stream: false` ok for small outputs.
- **Response:** `content[0].text` is a string; strip code fences, `JSON.parse`, then validate with Zod in our code.
- **Pros:** zero schema-compilation cost, no complexity limits, works on every model, fastest to ship. This is why every working TextOS task uses it.
- **Cons:** not *guaranteed* valid — needs a parse + validate + retry-once guard in code.
- **TextOS examples:** `business-landing-page.ts`, `welcome-email.ts`, `storyCardGenerator.ts`, `logo.ts`, and the now-working `generate-business-app-v2.ts`.

### 2.2 Tool use (`tools` + `tool_choice`)
Define a tool with an `input_schema`; force the model to "call" it; read structured args from the `tool_use` block.
- **Request:**
  ```json
  {
    "tools": [{
      "name": "generate_app_content",
      "description": "...",
      "input_schema": { "type": "object", "properties": {...}, "required": [...] }
    }],
    "tool_choice": { "type": "tool", "name": "generate_app_content" }
  }
  ```
- **Response:** `stop_reason: "tool_use"`; find the block where `type === "tool_use" && name === "..."`; read `.input`.
- **⚠️ DANGER (this is what bit us 2026-05-28):** when a tool is forced and/or the model must conform to the schema, the schema is compiled into a constraining grammar. **Large/complex schemas (deep nesting, `anyOf`/union types, many optional fields, `additionalProperties: true` everywhere) can blow past the grammar-compilation limits and hit a 180-second compilation timeout — which in Cloudflare Workers surfaces as a silent 5-minute hang.** See §4 and §6.
- **Use when:** you genuinely need the model to call functions in an agent loop, not just to format output.

### 2.3 Structured Outputs (`output_config.format`) — the *modern* guaranteed-JSON feature
Generally available on Opus 4.7, Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5, Haiku 4.5 (and Mythos Preview). **NOT supported on `claude-sonnet-4-20250514`** (the model v2 currently uses) — so adopting this means moving v2 to a 4.5/4.6-class model.
- **Request:**
  ```json
  {
    "output_config": {
      "format": {
        "type": "json_schema",
        "schema": { "type": "object", "properties": {...}, "required": [...], "additionalProperties": false }
      }
    }
  }
  ```
- **Response:** valid JSON matching the schema in `content[0].text` (constrained decoding — no `JSON.parse` errors).
- **TS SDK helpers:** `zodOutputFormat()` for Zod schemas, or `jsonSchemaOutputFormat()`. The SDK auto-strips unsupported constraints (`minLength`, `minimum`, etc.), adds `additionalProperties:false`, and validates the response against your *original* Zod schema. This is exactly the "generate simple, validate strict" pattern — built in.
- **Pros:** guaranteed schema compliance, no retries, type-safe.
- **Cons:** same complexity limits as strict tools (§4); first-use grammar-compilation latency (cached 24h); not compatible with prefill or citations; injects a small system prompt (slightly higher input tokens).
- **Recommendation for TextOS:** this is the right long-term answer for v2's app content — *once v2 moves to a supporting model*. It replaces both the fragile plain-text-parse and the hang-prone forced-tool approach. Track as a backlog item.

### Decision guide
| Situation | Use |
|---|---|
| Small/medium JSON, any model, ship today | §2.1 plain-text + Zod validate + retry-once |
| Need the model to call real functions in a loop | §2.2 tool use (keep schemas SIMPLE — see §4) |
| Need *guaranteed* JSON and on a 4.5/4.6+ model | §2.3 structured outputs (`output_config.format`) |
| Large/deeply-nested output of any kind | Prefer §2.1 or §2.3 + **`stream: true`** (§5); avoid forced complex tool schemas |

---

## 3. Models — IDs, context, output limits, capabilities

Source of truth: query the Models API (`GET /v1/models/{id}`) or read
`anthropics/skills/.../shared/models.md`. Snapshot verified 2026-05-28:

| Model ID | Context (input) | Max output tokens | Structured outputs? | Notes |
|---|---|---|---|---|
| `claude-opus-4-7` | 200K | 128K (streaming for large) | ✅ | Most capable; agentic coding. |
| `claude-opus-4-6` | 1M | 128K (streaming for large) | ✅ | Prev-gen Opus. |
| `claude-sonnet-4-6` | 1M | 64K | ✅ | Best speed/intelligence balance. Adaptive thinking. |
| `claude-haiku-4-5-20251001` | 200K | (smaller) | ✅ | Fastest, cheapest. |
| `claude-sonnet-4-20250514` | 200K | **8,192** (synchronous) | ❌ **not supported** | **The model v2 currently uses.** Older Sonnet 4. No structured outputs. |

**Pricing (per million tokens, snapshot — verify before relying):** Haiku ~$1/$5, Sonnet ~$3/$15, Opus ~$5/$25. Prompt caching cuts input cost up to 90%; Batch API cuts 50%.

**Deprecation note:** Claude Sonnet 4 and Opus 4 are scheduled to retire from the API on **June 15, 2026.** `claude-sonnet-4-20250514` is a Sonnet-4-class ID — **confirm its exact deprecation status before building anything new on it.** This is another reason to plan v2's move to Sonnet 4.6 / structured outputs.

> **TextOS action item:** our `MODEL_IDS` map (in `src/agent/model-router.ts`) currently points the `sonnet` tier at `claude-sonnet-4-20250514`. Decide deliberately whether to move to `claude-sonnet-4-6` (1M context, 64K output, structured-outputs support) before June 15, 2026.

---

## 4. Hard limits that cause silent failures (READ BEFORE BUILDING SCHEMAS)

These come straight from the Structured Outputs docs and apply to **both** strict tool use and `output_config.format` (and, empirically, to forced tool_use with complex schemas):

| Limit | Value | Why it matters |
|---|---|---|
| Strict tools per request | 20 | — |
| **Optional parameters (total, across all strict schemas)** | **24** | Each non-`required` field counts. "Each optional parameter roughly doubles a portion of the grammar's state space." |
| **Parameters with union types (`anyOf` / type arrays)** | **16** | "Especially expensive — exponential compilation cost." v2's `step: anyOf[number, enum]` was one of these. |
| **Grammar-compilation timeout** | **180 seconds** | Schemas that pass all explicit checks but compile to a huge grammar hit this. **In Cloudflare Workers this presents as a silent multi-minute hang, killed by the `waitUntil` ~5-min cap — exactly our 2026-05-28 bug.** |
| "Schema too complex" | 400 error | Returned when combined complexity is too high *before* timeout. |

**Practical rules for TextOS schemas:**
1. **Avoid `anyOf`/union types.** v2's `step` field used `z.union([z.number(), z.enum([...])])` → `anyOf`. Pick one type.
2. **Minimize optional fields.** Make fields `required` where reasonable; flatten deep nesting.
3. **Don't send `additionalProperties: true` everywhere.** Structured outputs want `additionalProperties: false`.
4. **Keep nesting shallow.** Deep `array → object → array → object` chains compound grammar size.
5. **If the shape is genuinely large/rich, do NOT force it through a tool schema.** Use plain-text JSON (§2.1) or structured outputs on a supporting model (§2.3), and prefer streaming (§5).

---

## 5. Streaming & Cloudflare Workers (the environment-specific gotcha)

- **`stream: false`** waits for the *entire* response before the worker can continue. For large/slow generations this can stall at the Workers subrequest/runtime limit and **hang silently**, then die at the `waitUntil` ~5-minute cap with `waitUntil() tasks did not complete within the allowed time`.
- **`stream: true`** (or SDK `client.messages.stream(...)`) delivers incremental `content_block_delta` events, keeping the connection live. **This is the documented recommendation for large outputs and is already proven working in TextOS** (`chatWithClaude` in `src/services/anthropic.ts` streams the dashboard chat panel).
- **SDK `timeout` option and AbortController/setTimeout are unreliable in Workers** for cancelling a blocked non-streaming call — confirmed empirically 2026-05-28. Do not rely on them as the primary guard. Prefer streaming + keeping outputs/schemas within limits.

**Streaming response event types** (accumulate text from `content_block_delta`):
`message_start` → `content_block_start` → `content_block_delta` (`text_delta` / `input_json_delta`) → `content_block_stop` → `message_delta` → `message_stop`. Use `stream.finalMessage()` (TS SDK) to get the assembled message with `usage` and `stop_reason`.

---

## 6. Response shape — non-streaming

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [ { "type": "text", "text": "..." } ],
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 6 }
}
```

### `stop_reason` values (always check this)
| Value | Meaning | What to do |
|---|---|---|
| `end_turn` | Natural completion | Normal. |
| `max_tokens` | Hit the `max_tokens` ceiling | Output likely truncated/invalid JSON — retry with higher `max_tokens`. |
| `tool_use` | Wants to call a tool | Read the `tool_use` block, run it, send `tool_result`. |
| `stop_sequence` | Hit a custom stop string | — |
| `refusal` | Safety refusal | Returns 200, you're billed, output won't match schema. Handle gracefully (TextOS content policy: surface a structured user-facing message, never a 500). |
| `pause_turn` | Long-running server tool turn paused | Continue per docs. |

### `usage` — always logged for cost/diagnostics
`input_tokens`, `output_tokens`, plus `cache_creation_input_tokens` / `cache_read_input_tokens` when prompt caching is used.

---

## 7. THE 2026-05-28 INCIDENT — canonical post-mortem (so we never repeat it)

**Symptom:** `generate-business-app-v2` hung exactly ~5 minutes, status `failed`, `error=timeout_5min`, work_log stopped after `v2_llm_call_started`.

**What it actually was:** the v2 request forced a tool (`tool_choice: {type:"tool"}`) with a large, deeply-nested `input_schema` containing an `anyOf` union (`step`) and `additionalProperties: true` throughout. That schema compiles into a constraining grammar; the official docs document a **180-second grammar-compilation timeout** and call union types "exponentially expensive." In Cloudflare Workers the blocked compile/generation never returned and was killed by the `waitUntil` ~5-min cap — a *silent* hang with no error surfaced to us.

**Why we chased it for 6 hours (and the lessons):**
- Wrong hypotheses we burned time on: SDK `timeout` option, `Promise.race`, AbortController, wrong client instance, `max_tokens` 4000→2000. None were the cause; some (timeouts/abort) don't even fire reliably in Workers.
- The fix that shipped: drastically shrank the prompt (7,815 → ~677 chars), dropped the formal schema from the wire (plain-text JSON, §2.1), and added a code-side transformation layer to rebuild the rich structure. Works in ~20s.
- The deeper lessons, now rules:
  1. **Read the API limits doc FIRST** (this file, §4) before designing a schema. The 180s/union-type limit was documented all along.
  2. **Compare against a known-working call in the same codebase** before theorizing about infrastructure (the working landing-page call was right there).
  3. **Prefer plain-text JSON or structured-outputs over forced complex tool schemas.**
  4. **Stream large outputs in Workers** (§5).
  5. **Log full request+response JSON** so the wire content is always visible (the work_log payload logging is what finally exposed the request).

**Open follow-ups (backlog):**
- Move v2 to a structured-outputs-capable model (Sonnet 4.6) and adopt `output_config.format` with a *simplified* schema, replacing the plain-text+transform stopgap.
- Audit all `tools`/`input_schema` usages in `textos-agent` for union types, deep nesting, and `additionalProperties:true`.
- Run a controlled "prompt-limits" sweep (vary prompt size / nesting / schema-on-wire / max_tokens, hold path constant) to establish our own safe ceilings empirically.

---

# PART 2 — OTHER APIS (to be researched next)

Placeholders. Each will get the same treatment: required headers, request body shape, response shape, error/limit gotchas, links to (and local copies of) official docs, and TextOS-specific notes.

## fal.ai (image generation — Flux)
_TODO: research https://docs.fal.ai — request shape for image gen, polling/webhook response, rate limits, error shapes._

## SendGrid (transactional + cold email)
_TODO: research Mail Send v3 API request body, sandbox mode, event webhook payloads, error shapes._

## Stripe (subscriptions + Connect + token top-ups)
_TODO: Checkout Session create, webhook event payloads (idempotency via `stripe_events`), Connect Express onboarding, error shapes._

## Hunter.io (email finding/outreach)
_TODO: domain-search / email-finder request + response, rate limits._

## Blotato (social publishing, MCP at mcp.blotato.com)
_TODO: per-platform publish request/response, the per-user-account vs single-account architecture decision (open backlog item)._

---

## Appendix — maintenance

- **Re-verify** each API section against its official docs quarterly, or whenever a call starts failing unexpectedly. Update the "last verified" date.
- **Local doc copies** live in `/docs/api-docs/<provider>/`. Re-download when versions change.
- This file is referenced from `CLAUDE.md`; every session must review it before API work (see the CLAUDE.md instruction block).

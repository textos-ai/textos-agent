# Anthropic — Structured Outputs (saved copy)

**Source:** https://platform.claude.com/docs/en/build-with-claude/structured-outputs
**Saved:** 2026-05-28
**Why saved:** This page documents the schema-complexity / grammar-compilation limits
(including the 180-second compilation timeout and union-type cost) that were the root
cause of the 2026-05-28 `generate-business-app-v2` 5-minute hang.

---

Structured outputs constrain Claude's responses to follow a specific schema, ensuring valid,
parseable output for downstream processing. Two complementary features:

- **JSON outputs** (`output_config.format`): Claude's response in a specific JSON format.
- **Strict tool use** (`strict: true`): guarantee schema validation on tool names and inputs.

Usable independently or together.

**Availability (GA):** Claude Mythos Preview, Opus 4.7, Opus 4.6, Sonnet 4.6, Sonnet 4.5,
Opus 4.5, Haiku 4.5. (Bedrock/Vertex/Foundry coverage varies — see source page.)

**Migration note:** `output_format` moved to `output_config.format`; beta headers no longer
required. Old beta header `structured-outputs-2025-11-13` and `output_format` work for a
transition period.

## Why use it
Without it, Claude can emit malformed JSON, missing fields, inconsistent types, schema
violations. Structured outputs guarantee schema compliance via constrained decoding: always
valid (no `JSON.parse()` errors), type-safe, no retries for schema violations.

## JSON outputs — quick start (request)
```python
response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Extract key info from this email: ..."}],
    output_config={
        "format": {
            "type": "json_schema",
            "schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "email": {"type": "string"},
                    "plan_interest": {"type": "string"},
                    "demo_requested": {"type": "boolean"}
                },
                "required": ["name", "email", "plan_interest", "demo_requested"],
                "additionalProperties": False
            }
        }
    },
)
# Valid JSON matching the schema in response.content[0].text
```

## SDK helpers
- **Python:** Pydantic + `client.messages.parse()`
- **TypeScript:** Zod via `zodOutputFormat()`, or typed JSON Schema literals via `jsonSchemaOutputFormat()`
- SDKs auto-transform schemas: remove unsupported constraints (`minimum`, `maximum`,
  `minLength`, `maxLength`), move them into descriptions, add `additionalProperties: false`,
  filter string formats, and **validate the response against your original schema**.

## Important considerations
- **Grammar compilation & caching:** first use of a schema has extra latency while the grammar
  compiles; compiled grammars cached 24h from last use; cache invalidated if the schema
  structure or the set of tools changes (changing only `name`/`description` does not).
- **Prompt modification:** structured outputs inject an extra system prompt (slightly higher
  input tokens; invalidates prompt cache for the thread when `output_config.format` changes).

### JSON Schema complexity limits (THE KEY SECTION)
| Limit | Value | Description |
|---|---|---|
| Strict tools per request | 20 | Non-strict tools don't count. |
| Optional parameters | 24 | Total optional params across all strict tool schemas + JSON output schemas. Each non-`required` field counts. |
| Parameters with union types | 16 | Total params using `anyOf` or type arrays (e.g. `["string","null"]`). **Especially expensive — exponential compilation cost.** |

Beyond these explicit limits there are **additional internal limits on compiled grammar size**
(optional params, union types, nested objects, and tool count interact). Exceeding them →
**400 "Schema is too complex for compilation."** As a final stop-gap, the API enforces a
**compilation timeout of 180 seconds**; schemas that pass explicit checks but produce very large
compiled grammars can hit this timeout.

#### Tips for reducing complexity (in order)
1. Mark only critical tools as strict.
2. Reduce optional parameters — make them `required` where possible (each optional param roughly
   doubles a portion of the grammar's state space).
3. Simplify/flatten nested structures.
4. Split into multiple requests / sub-agents.

### Property ordering
Required properties appear first (in schema order), then optional properties (in schema order).
If output order matters, mark all properties required or account for reordering when parsing.

### Invalid outputs despite structured outputs
- **Refusal** (`stop_reason: "refusal"`): 200 status, billed for tokens, output may not match schema.
- **Token limit** (`stop_reason: "max_tokens"`): output may be incomplete/non-conforming — retry
  with higher `max_tokens`.

## Feature compatibility
- **Works with:** Batch processing (50% discount), token counting, **streaming**, and combined
  JSON outputs + strict tool use.
- **Incompatible with:** Citations (400 error if combined with `output_config.format`), and
  message prefilling.
- **Grammar scope:** applies only to Claude's direct output, not tool_use calls, tool_results, or
  thinking tags.

## Data retention
Prompts/responses processed with ZDR; JSON schema cached up to 24h for optimization. HIPAA: do
**not** put PHI in schema property names, enum/const values, or pattern regexes.

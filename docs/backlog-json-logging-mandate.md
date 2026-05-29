# Backlog: Mandatory JSON Logging for All Service Calls

**Captured:** 2026-05-28 (during v2 timeout diagnostic)
**Priority:** High — schedule AFTER next prod release
**Owner:** TBD

## The mandate

Every external service call — **request and response** — must be logged in full JSON to durable storage. No exceptions. No "we have token counts, that's enough." No "we have stop_reason, that's enough."

The full payloads, both ways, every time.

## Why

The v2 timeout debug burned hours of session time chasing a 5-minute hang because we couldn't see what was actually being sent and received. The moment we wired full payload logging to `task_runs.work_log`, the answer fell out in one curl: Anthropic SDK call hung with no per-call timeout, no exception thrown, no observability into the failure.

This pattern repeats. Every time an external service misbehaves — slow response, malformed payload, schema validation drift, rate-limit response not properly handled — we have to choose between "guess and redeploy" or "instrument and redeploy." Instrumentation should already be there. By default. For everything.

Rob's words: "We need to log EVERY json call we make or receive. PERIOD. This is too important for debugging and helps me understand what the system is doing."

## Scope

All outbound calls to external services:

- **Anthropic API** (Messages create, tool_use, vision, anything)
- **fal.ai** (image generation, model inference)
- **SendGrid** (email send + bounce/error webhooks)
- **Stripe** (Checkout, Connect, Subscriptions, webhooks received)
- **Hunter.io** (email finder)
- **Blotato** (social publishing, when wired)
- **Cloudflare APIs** (DNS, Workers KV, R2, Queues — anywhere we make a fetch)
- **Supabase** (probably not full payloads — too noisy — but log mutation queries with table + operation)
- **Google APIs** (OAuth token exchange, Gmail, Calendar, Drive — if/when wired)
- **Telegram Bot API** (when wired)

All inbound webhooks:

- Stripe webhook payloads (already deduped in `stripe_events`, but log the full body too)
- SendGrid event webhooks (deliveries, bounces, opens)
- Blotato callbacks (when wired)
- OAuth callback responses (when wired)
- Any other third-party callback

## Architecture (proposed — refine when prioritized)

**Single helper:** `logExternalCall(service, direction, payload, context)` writes to a new `external_call_log` table.

Schema (subject to refinement):
```
external_call_log
  id                  uuid PK
  service             text         -- 'anthropic', 'fal_ai', 'stripe', etc.
  direction           text         -- 'outbound_request', 'outbound_response', 'inbound_webhook'
  endpoint            text         -- e.g., '/v1/messages', '/checkout/sessions'
  business_id         uuid nullable FK
  user_id             uuid nullable FK
  task_run_id         uuid nullable FK
  http_status         int nullable
  elapsed_ms          int nullable
  request_body        jsonb nullable
  response_body       jsonb nullable
  error               text nullable
  context             jsonb           -- caller-supplied: which handler, which step, etc.
  created_at          timestamptz
```

**Env-conditional truncation:** Same pattern as v2's work-log truncation. Test env stores full bodies. Prod truncates to a configurable size (default 4-8KB), keeping the head of the JSON which is usually where the interesting stuff is.

**Sensitive-field redaction:** API keys, JWTs, OAuth tokens, Stripe secret keys are sanitized before logging. Maintain a redaction allowlist of header/field names per service.

**Storage retention:** TBD. 30-90 days for prod, indefinite for test. Older rows archived to R2 if we care about long-term forensics. Schema-degraded for now.

## Implementation notes

- Build the helper as middleware around `fetch`-style calls where possible, so it's automatic rather than opt-in
- For SDK-mediated calls (Anthropic, Stripe), wrap the SDK methods at the point of construction with a logging proxy
- Pattern: every place that currently directly calls `anthropic.messages.create(...)`, `fal.run(...)`, `stripe.checkout.sessions.create(...)`, etc., goes through a logged wrapper
- The v2 work-log payload logging we just built is a **good local example** — it logged what we needed in one cycle and gave us the answer. Generalize the pattern.

## Why "after prod release"

This is foundation work that touches every external integration. Doing it mid-launch-sprint risks regressions. Better to ship the current launch, then come back and instrument everything systematically before the system grows beyond what can be retrofitted easily.

## Definition of done

- `external_call_log` table created and indexed
- `logExternalCall` helper landed in shared lib
- Every existing outbound external service call routes through it (Anthropic, fal.ai, SendGrid, Stripe, Hunter.io, Blotato, Cloudflare APIs)
- Every inbound webhook handler logs the inbound payload
- Sensitive-field redaction allowlist tested
- Env-conditional truncation tested in both test + prod modes
- Documentation: a single page in /docs explaining where logs live, how to query them, redaction rules

## Related items already in backlog

- v1 paid-task observability (genAppLog → no durable destination for paid tasks; same problem as v2 had before this session)
- task_runs.work_log unification for v1 + v2 (post-launch refactor)
- app_bug_log column reconciliation (v2 wrote against expected columns that don't exist; either rename in code or migrate the table)

# Agent / Task Architecture Manifesto

**Read this before touching anything related to how agents (tasks) are run, queued, timed out, or
batched. Every architecture or coding session that designs, creates, or modifies agent execution
starts here.**

This file exists because we have hit the same class of problem more than once: agents are
**long-running LLM jobs**, and the platform we run on (Cloudflare Workers) is built for
**short request/response work**. That mismatch causes silent failures, orphaned jobs, mass
timeouts, and wasted money. This document is the hard-won set of rules that keep us out of that hole.

---

## 0. The one-sentence version

**An agent run is a long background job (often 20–90 seconds). Cloudflare Workers cannot reliably run
long background jobs inside `ctx.waitUntil()`. Long agent work must run on a primitive built for it
(Queues, Workflows, or Durable Objects) — never fire-and-forget on `waitUntil`.**

If you remember nothing else, remember that.

---

## 1. The platform truth (Cloudflare Workers — verified from docs)

These are the real constraints. Do not reason from memory or assumption about them — they are the
source of the bugs.

- **`ctx.waitUntil()` only extends execution ~30 seconds after the response is returned.** After the
  HTTP handler returns, the isolate begins shutting down. Background promises get roughly 30 seconds,
  then they are **orphaned and killed**. They do NOT run to completion in the background like a normal
  server process would.
- **CPU time ≠ wall-clock time.** `cpu_ms` (configurable up to 300,000 = 5 min) measures *active CPU
  cycles only*. **Time spent waiting on a `fetch()` — including every LLM API call — does NOT count
  as CPU time.** Therefore: **raising `cpu_ms` does NOTHING to let a slow LLM call finish.** This is
  the single most common false fix. An LLM call is network I/O; the limit that kills it is isolate
  lifetime, not CPU budget.
- **Wall-clock time is "unlimited" only while the client stays connected.** Once the response is sent
  (or the client disconnects), outstanding work is on borrowed time (~30s via waitUntil).
- **Subrequest limit:** default 10,000 per invocation (as of Feb 2026), was 1,000 before. Fine for
  our scale, but know it exists for fan-out.
- **Six simultaneous outbound connections** per invocation waiting for response headers. Matters if a
  single invocation fans out many parallel fetches.
- **Orphaned background work is the signature failure:** the caller gets a success response (e.g. a
  202), but the background job silently dies. No error surfaces to the user. The database row is left
  in a non-terminal state ("running") forever until a watchdog reaps it. **If you are relying on a
  watchdog to clean up "stuck running" rows as normal operation, your execution model is leaking —
  the watchdog is mopping up orphaned jobs.**

---

## 2. The rules (non-negotiable)

1. **Never run a long agent job on `ctx.waitUntil()`.** waitUntil is for fire-and-forget side effects
   that finish in well under 30 seconds: logging, analytics, a single quick write. It is NOT for
   running an LLM-backed agent to completion.

2. **A synchronous HTTP handler must return in well under 30 seconds.** Cloudflare's edge cuts the
   HTTP response around 30s → you get a 502. Any operation that polls/loops/waits for long work
   inside the request handler will 502. The handler's job is to *start* work and return, not to *wait
   for it*.

3. **Long fan-out work (run N agents) belongs on Queues.** This is the default correct primitive for
   "run many independent long jobs." `/start` enqueues one message per job and returns immediately.
   A queue **consumer** processes each message in **its own fresh invocation** with its own budget —
   no shared dying isolate, no orphaning. Concurrency is controlled by consumer config (batch size /
   max concurrency), not hand-rolled semaphores inside a dying isolate.

4. **Raising `cpu_ms` is never the fix for a slow LLM call.** If something is "timing out" and it's
   waiting on an API/LLM/network, `cpu_ms` is irrelevant. Diagnose the real limit (isolate lifetime,
   client disconnect, watchdog) before changing any timeout config.

5. **Every agent run must reach a terminal state by itself.** It either completes (writes success) or
   fails loudly (writes failed + reason). It must NOT depend on a watchdog to notice it died. The
   watchdog is a rare backstop for genuine crashes, not the normal path.

6. **Timestamps mean exactly one thing each.** Separate `enqueued_at` (when the job was queued) from
   `execution_started_at` (when the agent actually began running). A timeout/watchdog MUST measure
   against *execution* start, never enqueue time — otherwise jobs waiting in a queue look "stuck" and
   get killed before they ever run. (This was a real bug: all rows got the same `started_at` at bulk
   insert, so queued tasks were reaped at T+timeout before executing.)

7. **Per-agent hard timeout lives at the execution layer and is real.** Use `AbortController` passed
   to the SDK/`fetch` so the call is cancelled at the network layer. A `Promise.race` + `setTimeout`
   does NOT reliably fire when a fetch hangs inside a Worker — the event loop is blocked and the timer
   never runs. (Verified: this is why an earlier `withTimeout` "fix" did nothing.)

8. **No silent fallbacks.** If an agent can't produce real output, it FAILS LOUDLY with a recorded
   reason. Never substitute canned/placeholder content and mark the run "completed." Capture the raw
   response + `stop_reason` on failure so the cause is diagnosable.

9. **Fast or fail fast.** Target: every agent completes in under ~60 seconds. Anything that can't is
   either re-scoped (smaller prompt/output) or killed at the ceiling and reported with WHY. Users do
   not wait minutes.

10. **Token cost is real and metered.** Running all agents spends real money. Any "run all" path must
    have concurrency limits and a hard per-agent timeout so a runaway or thundering-herd run can't
    burn the balance. Confirm token balance before a full sweep; deduct should gate work, not trail
    it.

---

## 3. Choosing the right primitive (decision guide)

| You need to… | Use | Why |
|---|---|---|
| Return a quick response, do a tiny side effect after | `ctx.waitUntil()` | Only safe for <30s fire-and-forget |
| Run N independent long jobs (fan-out, e.g. "test all agents") | **Cloudflare Queues** | Each message = its own fresh invocation + budget; built-in concurrency control; no orphaning |
| Run a long multi-step job that must survive restarts / take minutes-to-an-hour | **Workflows** | Durable, resumable, up to 1 hour; steps each get budget |
| Coordinate stateful long-running work, real-time coordination | **Durable Objects** | 5-min CPU budget per request, stateful, resets timer per incoming request |
| Wait for a single agent inside one request and stream back | Keep the client connected + stream | Wall-clock is unlimited *while connected*; but fragile, avoid for fan-out |

**Default for "run many agents": Queues.** Reach for anything else only with a specific reason.

---

## 4. Required checklist for any agent-execution change

Before building, confirm (recon, with evidence — never assume):

- [ ] What primitive runs the agent today? (`waitUntil`? queue? sync handler?) Is it the *right* one
      per §3, or is it `waitUntil` masquerading as a job runner?
- [ ] Does the HTTP entry point **return immediately** and delegate the long work elsewhere?
- [ ] Where does each agent reach a **terminal state** (success/failed), and does it do so on its own
      without the watchdog?
- [ ] Is there a **real per-agent timeout** via `AbortController`, not `Promise.race`/`setTimeout`?
- [ ] Are `enqueued_at` and `execution_started_at` **separate**, and does the timeout measure against
      execution start?
- [ ] Is there a **concurrency cap** so a "run all" can't fire a thundering herd?
- [ ] On failure, is the **reason recorded** (raw response, `stop_reason`, error) — no silent
      fallback?
- [ ] Has anyone confirmed **token balance / cost guardrails** before a full sweep?
- [ ] Does any existing queue/workflow pattern in the codebase already solve this? **Mirror it; don't
      reinvent.**

---

## 5. False fixes we have already tried (do not repeat)

- ❌ Raising `cpu_ms` to let a slow LLM call finish. (CPU time ≠ wait time. Did nothing.)
- ❌ `withTimeout` using `Promise.race` + `setTimeout` to abort a hung Anthropic call. (Timer never
      fires when the fetch blocks the event loop. Use `AbortController`.)
- ❌ Firing all 36 agents at once via `waitUntil`. (Thundering herd + isolate-shutdown orphaning.
      All died at the watchdog timeout simultaneously.)
- ❌ Relying on the 5-minute watchdog as the normal completion path. (It's a backstop, not a runner.
      Needing it constantly = the model is leaking.)
- ❌ Bulk-inserting all task rows with the same `started_at`, then timing out against it. (Queued
      jobs reaped before they ran.)
- ❌ A synchronous handler that polls until the run finishes. (502 at the edge ~30s.)

---

## 6. Diagnosis discipline (when an agent run "hangs" or "fails")

1. **Evidence before theory.** Pull the actual DB row state (status, error, started/completed) and a
   `wrangler tail` before hypothesizing. Do not grep code on a hunch.
2. **Check the layer, not the symptom.** "Stuck running" → is it orphaned (isolate died) or genuinely
   executing? Same `completed_at` millisecond across many rows = one watchdog timer reaped them all
   (orphaning signature).
3. **Distinguish the timeout that fired.** Edge 502 (handler too slow) vs. isolate shutdown (waitUntil
   orphan) vs. watchdog sweep (backstop) vs. real AbortController abort — these are different layers
   with different fixes.
4. **Confirm against this doc's §1 platform truths** before "fixing" a timeout. Most timeout "fixes"
   target the wrong layer.

---

*Maintained as the standing reference for agent execution architecture. Update it whenever we learn a
new platform constraint or retire a false fix — so we never re-derive a painful lesson twice.*

# Task Execution Architecture — how a task runs, and why long tasks need a Queue

**Permanent record. Read this before touching run timeouts.** This exists so the
"just give long tasks a bigger timeout" idea doesn't get re-litigated a third
time. It won't work, and this explains why.

## The rule (Rob, standing)

- **No per-task timeouts.** A task's budget is not a per-task knob. We tried a
  `tasks.timeout_seconds` column (2026-07); it was reverted because it treats the
  symptom, not the cause.
- **Tasks run to completion.** The execution model should let a task finish, not
  race a clock that marks it failed while it's still working.
- **One platform ceiling, not per-task tuning.** There is a single execution
  ceiling (the runtime budget of wherever the task runs). Individual heavy tasks
  can be moved onto a longer-budget path (the Queue) when they need it — but that
  is a *placement* decision, not a per-task timeout number.
- **Big tasks are adjusted individually, later** — by routing them through the
  Queue, not by inventing a budget column.

## The real killer: the `waitUntil` request lifecycle silently kills long work

The customer run path (`POST /api/businesses/:slug/tasks/:taskSlug/run` in
`src/routes/business-task-run.ts`) returns `202` immediately and runs the task in
`c.executionCtx.waitUntil(runTaskInBackground(...))`. That background work has a
Cloudflare wall-clock ceiling (Worker `cpu_ms = 300000` / ~5 min in
`wrangler.toml`), and in practice **long Anthropic streams inside the
`waitUntil`/`SELF.fetch` request lifecycle get silently terminated well before a
task finishes** — no completion write, no error, the row just stays `running`.

This is not theory. It is the documented reason `generate-business-app-html` was
moved off that path (see below), and it was reproduced again in 2026-07:

- `mission-document` (~9 s generation) → completes cleanly on the `waitUntil`
  path, asset written.
- `ideal-customer-profile-generator` and `investor-deck` (large multi-section
  documents) → **never complete** on the `waitUntil` path: `model=null`, no
  asset, no completion or error log, across 4+ attempts and a 210 s observation
  window. The background invocation is reclaimed before the generation finishes.

**The pattern is: short tasks finish, long tasks are silently killed.** A bigger
timeout number cannot fix this — the work isn't being marked failed too early,
it's being *terminated* by the platform before it can finish.

## The three timeout *layers* (all symptom-level, none extend execution)

These exist today. Understand that **not one of them makes a task run longer** —
they only decide when a stuck `task_runs` row is *marked* `failed`:

1. **Inline poll-sweep** — `business-task-run.ts`, inside the `GET
   /:slug/task_runs/:id` poll. On each ~2 s frontend poll, any run still
   `running` past a cutoff is flipped to `failed, error='timeout_*'`. Two-tier:
   60 s default; 300 s for a hardcoded slug allowlist
   (`generate-business-app%`, `public-business-website`, `customer-understanding`).
   **Marks the row. Does not stop the background work.**
2. **Watchdog cron** — `src/cron/heartbeatWatchdog.ts`, same two-tier logic on a
   timer. Runs **only on the prod worker** (`[env.test.triggers] crons = []`), so
   on the shared DB the prod watchdog governs test runs too.
3. **Admin harness `AbortController`** — `src/routes/admin.ts` (`/harness/run`),
   a fixed 60 s abort that *genuinely* aborts the LLM call. Harness-only; the
   customer path passes no abort signal.

Because layers 1–2 only mark the row (they don't abort execution), a run that
finishes *after* being swept writes its asset but reads `failed` — an **orphan**.
Evidence (2026-07 scan): **6 real, non-harness documents** (`investor-deck`,
`executive-summary`, `market-research-report`, `personal-landing-page`,
`mentor-identification`, `accelerator-match`) sit in `business_assets` behind a
`timeout_*`-failed run. That orphaning is a side effect of racing a clock against
work that the platform will kill anyway — another reason the timeout approach is
wrong.

## The fix: Cloudflare Queues — and one task already uses it

A **Queue consumer gets its own ~15-minute wall-clock budget**, separate from the
request `waitUntil` lifecycle. `generate-business-app-html` was moved onto this
path precisely to escape the silent-kill. From the consumer header
(`src/queues/app-gen-html-consumer.ts`, verbatim):

> "Each consumer invocation gets a 15-minute wall-clock budget — replacing the
> Service Binding chain trigger fixes the silent-kill problem that hit
> generate-business-app-html on long streaming responses inside the
> waitUntil-driven request lifecycle."

The proven pattern (producer → queue → consumer):

1. **Producer** pre-creates the `task_runs` row in `status='queued'`
   (`started_at` null), then `env.APP_GEN_HTML_QUEUE.send({ ... })`
   (`src/lib/tasks/generate-business-app-design.ts` ~L459-516). A `SELF.fetch`
   fallback exists if the queue binding is absent.
2. **Queue** — one per env: `textos-app-gen-html-prod` / `-test`,
   `max_batch_size=1`, `max_retries=3` (`wrangler.toml`).
3. **Consumer** (`app-gen-html-consumer.ts`, dispatched from `index.ts`
   `async queue()`) applies an **idempotency contract** (completed/running →
   skip; queued/failed → atomic `UPDATE … WHERE status IN ('queued','failed')`
   claim), then `await runTaskInBackground(...)` **inline** — the shared runner,
   no `waitUntil`, inside the 15-min budget. On failure it throws so CF retries
   (≤3); each retry re-claims via the idempotency check, so no double-charge or
   duplicate asset.

Crucially, **`runTaskInBackground` is the same runner both paths use** — it
already routes by task (dedicated handlers, `genericDocumentRunner`, retrieval).
So moving a task onto the Queue is a *dispatch/placement* change, not a rewrite of
how the task runs. `task_runs.status` already includes `queued`; the frontend
poll (`task_runs/:id`) is unchanged because it just reads status.

## What this means for long document tasks (ICP, investor-deck, …)

They fail today for the same reason `generate-business-app-html` used to: the
`waitUntil` path silently kills their long generation. The fix is to route them
through the **same Queue pattern** — pre-create `queued`, enqueue, consume with a
15-min budget, reuse `runTaskInBackground`. Not a timeout column. Design recon for
this lives with the 2026-07 work; build it by extending the existing queue path,
not by inventing a parallel one.

## History

- **2026-05-25** — `generate-business-app-html` moved onto `APP_GEN_HTML_QUEUE`
  to fix the `waitUntil`/`SELF.fetch` silent-kill on long Anthropic streams.
- **2026-07** — `ideal-customer-profile-generator` observed failing the same way.
  A per-task `tasks.timeout_seconds` column was built, then reverted on Rob's call
  (symptom, not cause). Migration 083's additive columns
  (`tasks.timeout_seconds`, `task_runs.finished_after_timeout`) were left on the
  DB as inert (nothing reads them); dropping them is optional cleanup. The real
  fix — routing long tasks through the Queue — is the standing direction.

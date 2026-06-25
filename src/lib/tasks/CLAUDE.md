# CLAUDE.md — task handlers (`src/lib/tasks/`)

You are in `textos-agent/src/lib/tasks/`. Each file here is one task
handler that runs inside the free-build / task-run pipeline. This file
documents the handler contract, the no-fallbacks discipline, and the
schema gotchas that have bitten us.

> Layer note: task handlers do **NOT** touch the Hono request context.
> They receive a plain `TaskCtx` struct. The `c.get("auth")` →
> `{ user_id, email }` pattern is a **route-handler** concern (see
> `src/routes/*`, e.g. `me.ts`), not a task-handler concern. If a doc
> ever tells you a task handler reads `c.get("auth")`, it's conflating
> the two layers — the handler reads `tc.user` (a `UserRow`).

---

## The contract (`types.ts`)

```ts
export type TaskFn = (taskCtx: TaskCtx) => Promise<TaskResult>;

interface TaskCtx {
  env;  supabase;  anthropic;        // clients
  business: BusinessRow;             // the business being built
  ctx: BusinessContextRow;           // accumulated business_context
  user: UserRow;                     // tc.user.id — NOT c.get("auth")
  runId; taskRunId;                  // populated by the orchestrator
  nextSeq: () => number;             // monotonic seq for stream events
  emit: (evt) => Promise<void>;      // SSE narrative/cmd, persisted to stream_events
  cfLocation?;
}

interface TaskResult {
  output_data: Record<string, unknown>;
  context_updates?: Partial<BusinessContextRow>;  // merged into business_context
}
```

A handler **returns data**; it does not write `task_runs` or
`business_context` itself. The orchestrator owns those writes
(`createTaskRunForBuild` / `completeTaskRun` / `failTaskRun` /
`upsertBusinessContext`). Return `output_data` (+ optional
`context_updates`) and let the orchestrator persist.

Use `emit()` for live progress — `{ type: "narrative" | "cmd", ... }`.
Every emit is streamed to the browser AND persisted to `stream_events`.

---

## Model selection in custom handlers — non-negotiable
Every custom handler must resolve its model via `resolveFeatureModel('feature-key',
featureConfig, models)`. Import `resolveFeatureModel` from `'../non-task-model-config'`.
The feature key must be registered in `FEATURE_REGISTRY` and have an `external_apis` DB row
(via migration). Never write `models.sonnet`, `models.haiku`, or `models.opus` directly —
that bypasses admin control. Run `npm run check:models` from the repo root to audit.

---

## Registering a task (the only acceptable hardcoded map)

`src/lib/free-build-orchestrator.ts` holds `FREE_BUILD_TASK_HANDLERS:
Record<string, TaskFn>` — a slug → handler map. This is the *one*
sanctioned constant (it maps slug → execution logic, not DB data).
Tasks **without** a dedicated handler fall through to
`genericDocumentRunner`.

**Which tasks run, in what order, is DB-driven** — never hardcoded:
```
tasks WHERE is_default = true AND status = 'active' ORDER BY execution_order
```
Adding/removing a free-build task is a DB write. The only code change
is registering a handler in the map IF the task needs bespoke logic.

### Minimal new handler
```ts
// src/lib/tasks/my-task.ts
import type { TaskCtx, TaskResult } from "./types";

export async function runMyTask(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit } = tc;
  await emit({ type: "narrative", text: `Working on ${business.name}…`, ts: Date.now() });
  // ...do work, validate hard (see below)...
  return { output_data: { /* ... */ }, context_updates: { /* ... */ } };
}
```
Then add `"my-task": runMyTask` to `FREE_BUILD_TASK_HANDLERS`, and add
the `tasks` row in the DB (a migration). No pipeline array edits.

---

## Token deduction

Paid tasks are wrapped by `runTaskWithDeduction(step, taskCtx)` in
`src/lib/withTokenDeduction.ts` (note: the file is `withTokenDeduction.ts`
but the exported function is **`runTaskWithDeduction`**). It:
- short-circuits free tasks (`token_cost === 0`) with no DB writes,
- treats a retry within the same run as free,
- requires an active/trialing `business_subscriptions` row,
- debits atomically via the `debit_tokens` RPC,
- throws `InsufficientTokensError` / `SubscriptionRequiredError` on
  failure — never silently proceeds.

Your handler does not call this — the orchestrator wraps your `fn`.

---

## NO FALLBACKS — halt loudly on missing load-bearing data

Workspace rule, enforced here: if a required field is missing, **throw**
with a clear message. Never substitute a default. `research-strategy.ts`
is the reference implementation:
- declares its own `REQUIRED_FIELDS`
  (`industry, business_model, business_summary, target_customer,
  value_proposition, competitors, market_trends`),
- rejects a generic `industry` (`"General Business"`, `"Other"`, `""`…),
- retries the LLM up to 3× for valid structured JSON, then
  **fails loudly** — no partial/placeholder result is ever saved.

Each task validates the fields IT needs. Don't assume an upstream task
populated `ctx` — check, and halt if a field you depend on is absent.

---

## Schema gotchas (verified — do not guess column names)

- **`businesses.name`** is the business name. Read it as `business.name`.
  Business *naming* is owned by the `find-a-unique-business-name` task;
  `research-strategy` deliberately does **not** write `businesses.name`.
- **There is no `business_context.business_name` column.** Don't write
  to it. `business_context` accumulates research fields (`industry`,
  `business_model`, `business_summary`, `value_proposition`,
  `brand_voice`, `competitors`, `market_trends`, `positioning_statement`,
  `key_differentiators`, …) via `context_updates`.
- **`task_runs` has NO `created_at` column** — only `started_at`
  (verified in `migrations/006_add_task_states.sql`). Other columns:
  `completed_at`, `status` (`task_run_status`: queued/running/completed/
  failed), `state` (`task_state`: proposed/running/complete/failed),
  `work_log` (jsonb), `error`. Querying `task_runs.created_at` returns
  nothing / errors.

---

The repo-root `textos-agent/CLAUDE.md` owns deploy, logging, and the
broader backend rules. This file owns the task-handler contract.

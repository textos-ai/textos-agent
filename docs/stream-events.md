# `stream_events` — the platform logging table

Relocated from the root `CLAUDE.md`. This is the durable, queryable log
of platform activity per business. Every significant background
operation writes to it — the free-build orchestrator, the
generate-business-app chain (`event_type LIKE 'gen_app_%'`), and future
async work. New background work follows the same pattern.

---

## Schema (read-only invariant)

| Column | Type | Meaning |
|---|---|---|
| `run_id` | uuid | the `task_run_id` (or build `run_id` for the orchestrator) |
| `business_id` | uuid | scope for owner-filtered queries |
| `seq` | int | monotonic per `run_id`, used to order replays |
| `event_type` | text | namespaced string (e.g. `gen_app_html_anthropic_call_start`) |
| `event_data` | jsonb | caller payload (no need to repeat ids/ts) |
| `created_at` | timestamptz default `now()` | |

## Conventions

- **Namespace `event_type` by feature prefix** (`gen_app_*`,
  `free_build_*`, …) so per-feature queries stay clean.
- **Frontend reads go through an owner-scoped agent route** that
  filters by prefix (e.g. `GET /api/businesses/:slug/app-logs` filters
  `gen_app_%`). Never query `stream_events` directly from the browser.
- **`task_runs.work_log`** (jsonb array) holds the per-task structured
  log snapshot for the run in flight / most recently completed.
  `genAppLog` writes it as a full-buffer idempotent snapshot on every
  fire, so a single `task_runs` read returns the whole trace without
  joining `stream_events`.

## vs `wrangler tail`

`wrangler tail` is **development only** — it captures only future
events, only while the subscription is live, and dies on Worker
redeploys. The two durable lanes above (`stream_events`,
`task_runs.work_log`) survive redeploys and stay queryable from the UI.
See the "Diagnose by logs" rule in the root `CLAUDE.md`.

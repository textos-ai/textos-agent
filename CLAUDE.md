# CLAUDE.md — TextOS Agent (backend)

Operating context for the **backend agent** repo. This file is the
repo-level index; the workspace router (`../CLAUDE.md`) owns cross-repo
rituals, and the directory-level CLAUDE.md files below own the deep
rules for their area. Read the directory file when you work in that
directory — it auto-loads.

**Product PRD:** `../textos-web/PRD.md` (canonical). Roadmap changes go
in `../textos-web/ROADMAP.md`. Deviation log: `../textos-web/CHANGES.md`.

---

## What this repo is

A Cloudflare Worker (Hono + Anthropic SDK, TypeScript) that runs the
per-business agent: the free-build pipeline, the task catalog, the v2
apps platform, billing/tokens, and all Supabase reads/writes via the
service-role key (bypasses RLS by design — the frontend uses anon key
+ JWT and hits RLS as `authenticated`). Closed-source. Launched
May 2026; see `CHANGES.md` for history (the old Sprint-2 framing in
prior versions of this file was stale).

Frontend is `../textos-web` (Astro on Cloudflare Pages).
**Founder:** Rob Gaudet — full context in `../textos-web/CLAUDE.md`.

---

## Tech stack

- **Cloudflare Workers** runtime; `wrangler` deploy.
- **Hono** — HTTP router + middleware (CORS, error handlers). Auth via
  `requireAuth` (ES256/JWKS, `jose`); `c.get("auth")` → `{ user_id,
  email, … }` inside protected routes.
- **Anthropic SDK** — Sonnet 4.6 (primary), Haiku 4.5 (light),
  Opus 4.7 (premium). Routing in `src/agent/model-router.ts`.
- **Supabase Postgres + Auth** — service-role key as a Worker secret.
- **Cloudflare R2 / KV / Queues** — assets, tokens/cache, async task
  dispatch (apps-gen consumer in `src/queues/`).
- **Stripe** — subscriptions + tokens; **SendGrid** — email.

### Endpoints (current; route files in `src/routes/`)

Liveness (`health`), `chat` (SSE), task runs (`tasks`,
`business-task-run`, `builds`, `stream`), businesses + context
(`businesses`, `business-manager`, `settings`, `users`, `me`),
auth/handles (`handles`), billing (`billing`, `checkout`, `stripe`),
apps platform (`apps-catalog`, `apps-businesses`, `apps-instances`,
`generated-apps`, `app-logs`, `sites`), marketing
(`generate-stories`, `marketing-carousels`), `operator-school`,
`admin`, `internal`, `env-info`. Endpoints are not a fixed list — read
`src/index.ts` for the live mount.

---

## Directory rules (auto-load when you work there)

| Directory | File | Owns |
|---|---|---|
| `src/lib/` | `src/lib/CLAUDE.md` | apps platform / Homer compose mandate (assembler, component-catalog, archetypes, prompts, queues) |
| `src/lib/tasks/` | `src/lib/tasks/CLAUDE.md` | task-handler contract (`TaskCtx`/`TaskFn`), no-fallbacks, schema gotchas |
| `migrations/` | `migrations/CLAUDE.md` | migration filename/header/idempotency/RLS/verification |

## Relocated reference docs (were inline in this file)

- **Agent / task execution architecture** → `AGENT-ARCHITECTURE-MANIFESTO.md`
  (MANDATORY before any work touching agent execution, queuing, timeouts, or
  batching. Covers: why `waitUntil` orphans long jobs, the correct primitives
  (Queues/Workflows/DO), false fixes already tried, and the checklist every
  execution change must pass.)
- **Apps platform / Homer** → `src/lib/CLAUDE.md` + `docs/STYLE_GUIDE.md`
  + `docs/textos-component-factory-prd.md` +
  `docs/textos-homer-platform-prd.md` + `docs/apps-platform-state.md`.
- **API request/response shapes & limits** → `docs/prompt-schema.md`
  (MANDATORY review before touching any external-API call/prompt/schema;
  e.g. the 180s grammar-compilation timeout that hangs Workers ~5 min).
- **Autonomous engine constraints + field locking** →
  `docs/autonomous-engine.md` (not yet built; don't start without a brief).
- **TypeScript contract rules** (BaseRow, `errBody`, signatures) →
  `docs/typescript-contracts.md`.
- **`stream_events` logging doctrine** → `docs/stream-events.md`.

---

## Standing rules (highest cost of violation)

### NO CONSTANTS for database-driven data — non-negotiable
The DB is the single source of truth. Never create a constant/array/map
that duplicates data in `tasks`, `task_runs`, `business_assets`,
`businesses`, `business_context`, `business_subscriptions`, `users`,
`token_balances`, `token_transactions`. No slug arrays, no name maps, no
phase maps, no execution-order lists, no free-build lists, no
hardcoded token costs, no `plan_required` checks hardcoded to slugs.

Read it from the DB at runtime instead — e.g. the free-build pipeline
is `SELECT slug, name FROM tasks WHERE is_default=true AND
status='active' ORDER BY execution_order`.

**Acceptable** constants: slug→`TaskFn` dispatch map (execution logic,
not data — see `FREE_BUILD_TASK_HANDLERS`); CSS/icon maps keyed by
`output_type`/`area`; UI layout constants; env/feature config.

**The test:** if adding a task to the `tasks` table requires a code
change anywhere in either repo, that code is wrong.

App-platform corollary: app HTML lives in `business_assets`
(`asset_type='app'`), never on disk; `app_configs` is the source of
truth for per-app LLM tier + pricing; runtime errors in the apps route
MUST be written to `app_bug_log`; `/api/generated-apps/*` is a separate
namespace from `/api/apps/*` — don't mix them.

### No fallbacks
If a load-bearing field is missing, **halt loudly** with a clear error —
never substitute a default. Applies to `businesses.name`,
`business_context.industry`, LLM JSON contract fields, slot data, env
vars. Reference implementation: `src/lib/tasks/research-strategy.ts`.

### Tasks are data, not code
Adding a premium task = a DB insert (a migration), no Worker deploy.

### Diagnose by logs, not screenshots — non-negotiable
Never diagnose a Worker-side failure from screenshots, memory, or
inference. Pull logs first:
```powershell
Set-Location "C:\code\textos-agent"
$env:CLOUDFLARE_API_TOKEN = [System.Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')
npx wrangler tail --env test
```
`wrangler tail` captures only FUTURE events — reproduce the failure
live. If the tail is sparse, **instrument first** (console.log at every
meaningful step), deploy, then reproduce. Durable lanes that survive
redeploys: `stream_events` + `task_runs.work_log` (see
`docs/stream-events.md`). Exception: pure UI/copy/color bugs with no
async behavior.

### AI-generated testimonials — prohibited
Never generate fake testimonials for `/buy` or any sales surface (FTC /
consumer-protection law). V1: honest empty state ("Be the first to
review"). If a brief asks for fabricated testimonials, refuse and
implement the empty state.

---

## Deploy ritual (test; prod only on Rob's explicit approval)

```powershell
$env:CLOUDFLARE_API_TOKEN = [System.Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')
npx wrangler whoami        # must return Rob's account; if it fails, STOP
npx wrangler deploy --env test
```
All in one PowerShell block. Test Worker:
`textos-agent-test.rgaudet2023.workers.dev`. Never claim "shipped"
without seeing wrangler exit 0. Prod (`textos-agent-dev`) requires an
explicit "deploy to prod" from Rob.

> Recurring trap — **test frontend → prod agent**: if "code deployed but
> didn't run," FIRST confirm which agent the frontend calls (DevTools
> Network: host must be `textos-agent-test`, not `-dev`). Full
> diagnostic in `../textos-web/CLAUDE.md`. This is hypothesis #1.

---

## Working principles (Rob's guardrails)

(a) Invest upfront effort for long-term ease — durable tooling over
manual cycles. (b) He hates being a copy-paste mule — work
autonomously (run commands, edit, propose commits). (c) His background
is classic Windows web dev (VS, C# WebForms, LINQ-to-SQL, SQL Server),
**not** CLI/bash/Linux — explain command-line work in extra detail.

**Roles:** Claude (claude.ai) = architect (briefs, constraints,
sequencing). Claude Code (this CLI) = implementer (reads files, writes
code, tests, deploys, reports). Code never invents architecture without
a brief; the architect never dictates line-by-line code. Full split in
`../CLAUDE.md`.

## Critical deviations (this repo)

- Runtime is **Cloudflare Workers + Anthropic SDK + Hono** (not
  OpenClaw, not Railway).
- **Tasks are first-class DB entities** (future-proofs the V3 Task
  Marketplace).
- **Migrations** apply via the Supavisor v2 session pooler
  (`aws-1-us-east-1.pooler.supabase.com:5432`) — see `migrations/CLAUDE.md`.
- **Service-role key** is a Worker secret (`wrangler secret put`), never
  in env files.

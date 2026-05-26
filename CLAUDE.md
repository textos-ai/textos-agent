# CLAUDE.md — TextOS Agent

Operating context for Claude when working in this repo. Keep this
file current as the project evolves. **Source PRD:**
`../textos-web/PRD.md` (canonical, locked for the duration of
Sprint 2; future product changes go in `../textos-web/ROADMAP.md`).

> **PRD is LOCKED for the duration of Sprint 2.** Future product
> changes go in `../textos-web/ROADMAP.md`, not `PRD.md`.

---


## CRITICAL: POWERSHELL ENCODING FOR ASTRO FILES

NEVER use Set-Content with -Encoding UTF8 on .astro files.
NEVER use Set-Content with any -Encoding flag on .astro files.
UTF8 BOM corrupts special characters to garbage like:
  �" instead of �
  · instead of �
  � instead of emojis

THE ONLY SAFE WRITE COMMANDS FOR .astro FILES:

Option A � line array (no encoding flag):
  Set-Content "path\to\file.astro" $lines

Option B � raw string (no BOM UTF8):
  [System.IO.File]::WriteAllText(
    "path\to\file.astro",
    $content,
    [System.Text.UTF8Encoding]::new($false)
  )

Use Option A for line-number replacements.
Use Option B for raw string regex replacements.

TO FIX ENCODING CORRUPTION WITHOUT LOSING CHANGES:
  $content = Get-Content "path\to\file.astro" -Raw
  [System.IO.File]::WriteAllText(
    "path\to\file.astro",
    $content,
    [System.Text.UTF8Encoding]::new($false)
  )

NEVER restore from git just to fix encoding � that loses
all recent changes. Always fix encoding in place first.

---

## Project Mission

TextOS is an AI personal operating system delivered through text.
This repo is the **backend agent** — a Cloudflare Worker built on
Anthropic Agent SDK + Hono (TypeScript) that:

1. Runs the per-business agent loop that builds the user's business
   and delivers the 9 free + 8 paid-bundle + 13 premium tasks.
2. Hosts the four MVP HTTP endpoints (`/healthz`, `/version`,
   `/chat`, `/tasks/run`).
3. Owns Supabase reads/writes via the service-role key (bypasses RLS
   by design — frontend reads use anon key + JWT and hit RLS as
   `authenticated`).
4. Will host Stripe webhooks (Sprint 6), DayCycle cron generation
   (Sprint 8), and SendGrid magic-link issuance (Sprint 3).

Frontend lives in `textos-web` (Astro on Cloudflare Pages). The
agent is closed-source; the frontend is also closed-source.

**Founder:** Rob Gaudet — see `../textos-web/CLAUDE.md` for full
context (background, customer, surfaces, design system).

---

## Tech Stack

- **Cloudflare Workers** — runtime; `wrangler` for deploy.
- **Hono** — HTTP router + middleware (CORS, error handlers).
- **Anthropic Agent SDK** — Claude Sonnet 4.6 (primary), Haiku 4.5
  (lightweight), Opus 4.7 (premium). Routing in
  `src/agent/model-router.ts`.
- **Supabase Postgres + Auth** — `users`, `businesses`, `tasks`,
  `task_runs`, `subscription_plans`, `user_subscriptions`,
  `task_purchases`.
- **Cloudflare D1** — per-business activity logs + cache. Sprint 3+;
  commented placeholder in `wrangler.toml`.
- **Cloudflare Queues** — long-running task dispatch. Sprint 5+.
- **Cloudflare KV** — rate limits, magic-link tokens, agent prompt
  cache. Sprint 3+.
- **Cloudflare R2** — generated documents, hero images, exports.
  Sprint 7+.
- **Stripe** — subscriptions + Stripe Connect. Sprint 6.
- **SendGrid** — magic links + outbound email. Sprint 3+.

### Endpoints (Sprint 2)

- `GET  /healthz` and `GET /version` — liveness, JSON payload.
- `POST /chat` — Zod-validated body `{message, model?}`. Streams
  Anthropic SSE events end-to-end.
- `POST /tasks/run` — Zod-validated `{taskSlug, businessId?, inputs?}`.
  Looks up task in Supabase, returns row + Sprint 2 stub. Real
  execution lands in Sprint 5.

### Tasks-as-data architecture

The catalog of tasks (default, paid-bundle, premium) lives in the
`tasks` Supabase table. Columns:

- `slug` (unique), `name`, `description_short`, `description_long`
- `area` — `business_builder` | `daycycle` | `personal_website` |
  `public_business_website` | `business_manager`
- `is_default` — runs automatically during free build
- `plan_required` — `free` | `core_paid` | `premium_only` |
  `premium_inactive`
- `visibility` — `hidden` | `teaser_locked` | `fully_locked` |
  `always_visible`
- `price_cents`, `prompt_template`, `output_type`, `inputs_required`,
  `status`

**Adding a task is a database write — no Worker code change.** This
future-proofs the V3 Task Marketplace where users author tasks and
earn revenue when others run them.

### Source layout

```
src/
├── index.ts          ← Hono app, CORS, route mount, 404 + onError
├── env.ts            ← Env interface (secrets + bindings)
├── routes/
│   ├── health.ts     ← /healthz, /version
│   ├── chat.ts       ← /chat (SSE)
│   └── tasks.ts      ← /tasks/run
├── services/
│   ├── anthropic.ts  ← createAnthropicClient + chatWithClaude
│   └── supabase.ts   ← createSupabaseClient + getTaskBySlug + getActivePlans
├── agent/
│   ├── loop.ts       ← Sprint 2 stub; expanded in Sprint 5
│   └── model-router.ts ← MODEL_IDS + pickModel(taskType?, complexity?)
└── lib/
    ├── errors.ts     ← Typed ErrorBody helpers
    └── logger.ts     ← Structured JSON logger

supabase/
└── migrations/
    ├── 20260429120000_initial_schema.sql ← 7 tables, 8 enums, RLS
    └── 20260429120001_seed_data.sql      ← 4 plans, 30 tasks
```

---

## 9-Sprint Plan (mirrors `../textos-web/PRD.md`)

- **Sprint 1 — Astro scaffold ✅** (in `textos-web`) — closed 2026-04-28
- **Sprint 2 — TextOS Agent foundation + tasks data model ✅**
  (this repo) — closed 2026-04-29
- **Sprint 3 — Supabase Auth + handle DNS** (next)
  Google Sign-In + magic link via Supabase Auth, handle picker,
  Cloudflare DNS API for `{handle}.app.textos.ai`, JWT round-trip
  frontend ↔ Worker.
- **Sprint 4 — Business Builder dashboard shell**
  5-column layout reads from real `tasks` table.
- **Sprint 5 — Free build flow + existing-business entry path**
  Three entry paths (idea / find-me-one / I-have-a-business). Real
  agent loop replaces the Sprint 2 stub.
- **Sprint 6 — Stripe + four-tier paywall**
  Webhook handler, Founders cohort counter (1,000 cap), à la carte
  purchase flow.
- **Sprint 7 — 8 paid-bundle tasks**
  Competitive analysis, market research, mission dashboard, public
  business website (with OG/schema/`llms.txt`), cold email, social
  plan, investor room, Stripe Connect setup.
- **Sprint 8 — DayCycle Concierge**
  Profile, blur paywall, cron-based daily generation, Gmail +
  Calendar pulls.
- **Sprint 9 — Soft launch**
  Rob + 5-10 alpha users, 2 weeks of bug-fixing, then public.

---

## NO CONSTANTS FOR DATABASE-DRIVEN DATA — NON-NEGOTIABLE

The TextOS database is the single source of truth for all
application data. Never create a JavaScript/TypeScript constant,
array, or map that duplicates or represents data that exists
in any of the following core tables:

  tasks              — task names, slugs, descriptions, order
  task_runs          — run state, output, status
  business_assets    — asset types, subtypes, content
  businesses         — business names, slugs, metadata
  business_context   — agent name, industry, summary, market data
  business_subscriptions — subscription status, plan details
  users              — user data, tier, handle
  token_balances     — token counts, periods
  token_transactions — transaction history

VIOLATIONS — NEVER DO ANY OF THESE:
  const FREE_BUILD_PIPELINE = [{ slug: '...', fn: ... }]
  const FREE_BUILD_SLUGS = ['welcome-email', ...]
  const taskNameMap = { 'research-strategy': 'Market Analyzed' }
  const assetTypeMap = { 'welcome_email': { name: '...' } }
  const LIFECYCLE_PHASE_ORDER = [{ slug: 'idea', ... }]
  const TASK_TO_PHASE = { 'research-strategy': 'idea', ... }
  const DOC_META = { 'mission-document': { title: '...' } }
  Any array, map, or constant whose contents would need to
  change when a task is added or modified in the tasks table.

THE RULE: ZERO hardcoded task data. No slug arrays. No name maps.
No phase maps. No execution order lists. No free build lists.
No token cost constants. No plan_required checks hardcoded to
specific slug values. If it lives in the tasks table (or any
related table), it must be read from the DB at runtime.

WHAT TO DO INSTEAD:
  free build pipeline → SELECT slug, name FROM tasks
                         WHERE is_default=true AND status='active'
                         ORDER BY execution_order
  task names          → read tasks.name from DB join
  task order          → read tasks.execution_order from DB
  document names      → read tasks.name via asset.task_run_id join
  lifecycle phases    → read tasks.lifecycle_phase_id join
  asset display names → read tasks.name from matching task_run
  plan gate checks    → read task.plan_required from DB response

ACCEPTABLE CODE CONSTANTS (not task data):
  slug → TaskFn dispatch map (maps slug to handler function)
         This is execution logic, not DB data.
  CSS class maps keyed by output_type or area
         (e.g. which icon to show for 'document' vs 'report')
  UI layout constants (breakpoints, animation timings)
  Environment configuration (API URLs, feature flags)

THE TEST: if adding a new task to the tasks table requires
a code change anywhere in either repo, that code is wrong.

APP PLATFORM RULES (generate-business-app + /api/generated-apps/*):
  - App HTML is stored in business_assets (asset_type='app'), never
    on disk. Read it from there at serve time.
  - app_configs is the source of truth for per-business LLM tier,
    paid_tier_price_cents, free_tier_enabled. Never hardcode these
    values in the worker; read them per request.
  - Visitor token flow: Stripe checkout.session.completed →
    /api/generated-apps/webhook/stripe → credit app_visitor_tokens
    row → /api/generated-apps/:businessId/verify-token decrements
    on each use and writes to app_usage_log.
  - All runtime errors in the apps route MUST be written to
    app_bug_log (open status). The admin queue at /admin/app-bugs
    is the recovery surface; do not silently swallow errors.
  - /api/generated-apps/* lives in a SEPARATE namespace from
    /api/apps/* (the pre-built app catalog). Don't mix them.

---

## Non-Negotiable Rules

See `../textos-web/CLAUDE.md` § Non-Negotiable Rules. All 13 apply
to this repo too. The agent-specific implications:

- **No password ever stored.** Auth is Supabase Auth + JWT only. The
  Worker validates the JWT on every authenticated route (Sprint 3+).
- **Every meaningful user action calls `txTrack(action, params)`** on
  the frontend AND the Worker logs a structured `task_runs` /
  activity row to Supabase (Sprint 5+).
- **Tasks are data, not code.** Adding a premium task = database
  insert; no Worker deploy.
- **Service-role key bypasses RLS by design.** Worker is the only
  place it lives. Frontend reads use anon key + JWT and hit RLS as
  `authenticated`.

---

## My Working Principles

These are Rob's guardrails. Apply them to every interaction.

(a) **Always willing to invest more upfront effort for long-term
ease — prefer proper tooling and durable solutions over manual
cycles.**

(b) **Hates being a copy-paste mule — Claude should do as much work
autonomously as possible, including running commands, editing
files, committing, and pushing.**

(c) **Background is classic Windows web dev (Visual Studio, C#
WebForms, LINQ-to-SQL, SQL Server) — NOT a CLI/bash/Linux user.
Always explain command-line work in extra detail: what each command
does, expected output, where to run it, what failure looks like and
the likely fix.**

---

## Critical Deviations

Authoritative log lives at `../textos-web/CHANGES.md` (append-only,
newest first). Deviations specifically affecting this repo:

- **Cloudflare Workers + Anthropic Agent SDK + Hono** for the agent
  runtime (NOT OpenClaw, NOT Railway). See `CHANGES.md` 2026-04-29
  for full reasoning.
- **Tasks are first-class database entities** — catalog is data, not
  code. Future-proofs the V3 Task Marketplace.
- **Migrations apply via Supavisor v2 session pooler** at
  `aws-1-us-east-1.pooler.supabase.com:5432` (NOT `aws-0-...`, NOT
  direct `db.<ref>.supabase.co` which is IPv6-only on free tier).
- **Supabase service-role key** stored as Cloudflare Worker secret;
  never in env files. Set via `wrangler secret put`.

---

## Sprint 2 Acceptance (closed 2026-04-29)

- ✅ Cloudflare Worker `textos-agent-dev` deployed
- ✅ Live URL: `https://textos-agent-dev.rgaudet2023.workers.dev`
- ✅ 4 endpoints (`/healthz`, `/version`, `/chat`, `/tasks/run`)
- ✅ Supabase schema + seeds applied (4 plans + 30 tasks)
- ✅ `tsc --noEmit` passes with zero errors
- ✅ All smoke tests green:
  - `/healthz` → HTTP 200, ~290ms
  - `/version` → HTTP 200, ~120ms
  - `/chat` (Haiku stream) → HTTP 200, TTFB ~100ms
  - `/tasks/run welcome-email` → HTTP 200, ~980ms
  - `/tasks/run does-not-exist` → HTTP 404
- ✅ Closed-source private repo on GitHub

---

## ROLES — CLAUDE vs CLAUDE CODE

Claude (claude.ai) is the ARCHITECT.
Claude Code is the IMPLEMENTER.

Claude's job:
- Write briefs that specify WHAT to build and WHY
- Define constraints, patterns to follow, files to touch
- Reference existing working code as the pattern
- Define how to verify success
- Never write specific code implementations

Claude Code's job:
- Figure out HOW to implement the brief
- Write the actual code
- Run, test, and verify the implementation
- Deploy and report results

Claude should NEVER write specific function bodies,
line-by-line fixes, or copy-paste code blocks.
Claude Code should NEVER implement without understanding
the existing architecture first.

---

## DAILY ARCHITECTURE REVIEW (once per 24 hours)

At the start of each day or new session, Claude Code must:

1. Read CLAUDE.md in both repos (this file)
2. Review these areas of the codebase for changes:
   - Reusable components (src/components/)
   - Shared scripts (src/scripts/)
   - Layout patterns (src/layouts/)
   - API patterns (src/routes/ in agent)
   - Data access patterns (Supabase queries)
   - Auth patterns (how session is read)
   - Navigation patterns (BaseLayout, Nav.astro)
   - _redirects routing rules (public/_redirects)
   - Environment variables (.env, wrangler.toml)

3. Before writing ANY new code, ask:
   - Does a component already exist for this?
   - Does a function already exist for this?
   - What is the established pattern for this type of page?
   - What is the routing pattern for this page type?
   - Are there shared styles I should use?
   - Is there an existing data access pattern?
   - Is there an existing auth pattern?

4. If uncertain about any pattern, READ the existing
   working implementation BEFORE writing new code.
   Never assume. Always verify.

---

## DIAGNOSE BY LOGS, NOT SCREENSHOTS — NON-NEGOTIABLE

Never diagnose a Worker-side failure by reading screenshots, by
guessing, or by inferring from prior conversation. Always pull
Worker logs first. Every fix must be grounded in actual log data —
not inference, not memory, not "this is probably the issue."

How to pull logs (test environment shown; swap to prod for prod
diagnoses):
  Set-Location "C:\code\textos-agent"
  $env:CLOUDFLARE_API_TOKEN = [System.Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')
  npx wrangler tail --env test

Then trigger the failure live. wrangler tail only captures FUTURE
events from when it started — past failures are not visible. The
operator (or you, via API call) must reproduce the failure with
the tail active.

If the tail shows nothing useful — sparse handler logs, "request
arrived" but no detail — INSTRUMENT FIRST. Add console.log
calls at every meaningful step (handler entry, external API
call start/complete, DB writes, error throws), deploy, then
reproduce. Logs that say "function entered" and "function
returned with X" are worth more than a clever guess at root
cause.

Prefix conventions for filterable tails:
  [GEN-APP]   generated-business-app chain (design + html)
  [task-run]  shared runTaskInBackground in business-task-run.ts
  Other features use their own [PREFIX] strings.

Exception: pure UI/copy/color bugs that involve no runtime async
behavior. Read the source, fix, ship — logs aren't needed for
"the button color is wrong."

---

## stream_events is the platform logging table

Every significant background operation writes to stream_events. It's
the durable, queryable log of platform activity per business — used
by the free-build orchestrator, by the generate-business-app chain
(rows with event_type LIKE 'gen_app_%'), and by future async
features. New background work should follow the same pattern.

Schema (read-only invariant):
  run_id      uuid    — the task_run_id (or build run_id for orchestrator)
  business_id uuid    — scope for owner-filtered queries
  seq         int     — monotonic per run_id, used for ordering replays
  event_type  text    — namespaced string (e.g. 'gen_app_html_anthropic_call_start')
  event_data  jsonb   — caller-supplied payload (no need to repeat ids/ts)
  created_at  timestamptz default now()

Writer convention: namespace event_type by feature prefix
('gen_app_*', 'free_build_*', etc.) so per-feature queries stay
clean. Frontend reads via a per-feature route that filters by
prefix (e.g. GET /api/businesses/:slug/app-logs filters
'gen_app_%').

task_runs.work_log (jsonb array) holds the per-task structured log
snapshot for the run currently in flight or most recently completed.
genAppLog writes it as a full-buffer idempotent snapshot on every
fire so a single read of task_runs returns the entire trace without
joining stream_events.

wrangler tail is for development only. It captures only future
events, only while the subscription is live, and dies on Worker
redeploys. The two durable lanes above survive redeploys and
remain queryable from the UI.

---

## CODE CONFIDENCE RULE

NEVER make assumptions about code. Before recommending
any change, read the current file first. If you do not
have 100% confidence in what the current code does and
exactly what needs to change, stop and ask Rob. Do not
guess. Do not infer from memory. Do not assume a
previous version of a file matches the current one.
Rob has 30 years of development experience — if you
are uncertain, ask him. He would rather answer a
question than waste time on a wrong fix.

---

## RESEARCH BEFORE CODE — NON-NEGOTIABLE

Before writing code for ANY new feature:

STEP 1 — Search for existing patterns
  Does a similar feature already exist in the codebase?
  Read it fully before writing anything new.

STEP 2 — Understand the architecture constraints
  Read public/_redirects before creating new pages
  Read wrangler.toml before touching worker config
  Read CLAUDE.md before starting any task

STEP 3 — Identify reusable elements
  Components, functions, styles, API calls, auth patterns
  If it exists, use it. Never reinvent.

STEP 4 — Only then write code
  Implementing without researching = wasted time.
  Rob's time is the most valuable resource.

---

## KEY ARCHITECTURE RULES (memorize these)

ROUTING — NON-NEGOTIABLE:
All /business/{slug}/* pages use this pattern:
1. Static prerendered page at /business/pagename.astro
2. Rewrite in public/_redirects:
   /business/*/pagename    /business/pagename/    200
3. Page reads slug from localStorage:
   textos_last_biz_{userId}

NEVER use dynamic [slug] routes under /business/
NEVER use prerender = false under /business/
NEVER use _routes.json includes for /business/* patterns

SCRIPT PATTERN for standalone pages:
- Supabase CDN via is:inline script in <head>
- Env vars via define:vars block → expose as window globals
- Main script as plain <script> (not type="module")
- No ES module imports inside define:vars blocks

DEPLOY PATTERN:

STEP 1 — Load the Cloudflare API token:
  $env:CLOUDFLARE_API_TOKEN = [System.Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')

STEP 2 — Confirm token loaded:
  npx wrangler whoami
  Expected: your Cloudflare account name and email.
  If it fails: stop and report to Rob. Do not proceed.

STEP 3 — Deploy to TEST:
  Set-Location "C:\code\textos-web"
  npm run deploy:test

All three steps must run in the SAME PowerShell block.

STEP 4 — Verify on TEST:
- Frontend: https://textos-web-test.pages.dev
- Never report hash preview URLs
- Never deploy to prod without Rob's explicit approval

TOKEN SECURITY:
- Read token from .env file silently
- Never display token values in output
- Show first 4 chars max to confirm loading

## VERIFICATION — NON-NEGOTIABLE

After every deploy report ONLY:
  1. Build passed or failed (with error if failed)
  2. Deploy succeeded or failed (with error if failed)
  3. The canonical test URL

NEVER run Invoke-WebRequest or any PowerShell command
that requires Rob to approve a security prompt.
NEVER use $() subexpressions in verification commands.
NEVER check the deployed page via PowerShell.
Rob verifies in the browser. That is his job, not yours.

---

## QUICK CONTENT CHANGES

When asked to change text, copy, or images only:
- Edit the file
- Deploy to test only
- Stop and wait for approval
- Do NOT deploy to prod
- Do NOT git commit
- Do NOT run the full release pipeline

A text change is not a release.

---

## DAILY CHECKLIST (run at start of every session)

[ ] Read CLAUDE.md in both repos
[ ] Check for new components in src/components/
[ ] Check for new scripts in src/scripts/
[ ] Check public/_redirects for current routing rules
[ ] Check wrangler.toml for current env/binding config
[ ] Confirm CLOUDFLARE_API_TOKEN is loadable from User environment variable
[ ] Run npx wrangler whoami before any deploy

---

## POST-LAUNCH INFRASTRUCTURE (V1.1)

These three improvements are planned after May 19 launch.
Do NOT implement before launch.

1. LOCAL CLAUDE.md FILES
   Add per-module context files for complex areas:
   - src/pages/business/CLAUDE.md (routing rules)
   - src/routes/auth/ CLAUDE.md (auth patterns)
   - src/lib/tasks/CLAUDE.md (task execution patterns)
   Start with business routing — caused 7 hours of pain on May 16.

2. .claude/skills/ FOLDER
   Reusable expert workflows for repeated tasks:
   - deploy.md (the full deploy ritual)
   - debug.md (the debugging brief formula)
   - new-page.md (the static prerender + _redirects pattern)
   Write one skill at a time. Test for one week before adding more.

3. .claude/hooks/ GUARDRAILS
   Automated protection for critical files.
   Implement only when codebase is stable (V1.1+).
   Protected zones: auth, billing, migrations.
   Risk: misconfigured hooks can block emergency hotfixes.
   Do NOT add before the codebase stabilizes post-launch.

================================================================
## PROJECT CONTEXT — WHAT WE ARE BUILDING
================================================================

TextOS is a fully autonomous AI-powered business operating system.
It builds and operates complete online businesses without ongoing
human involvement. The activator sets a mission and a monthly ad
budget. TextOS handles everything else — forever.

THE ACTIVATOR'S ENTIRE JOB:
  1. Set a mission (business idea)
  2. Connect Stripe (one-time)
  3. Set monthly ad budget
  4. That's it. TextOS runs the business from this point forward.

The activator is NOT a manager. They receive reports and metrics.
They do not approve content, review campaigns, or make operational
decisions. Every operational decision is made autonomously by TextOS.

WHAT TEXTOS DOES AUTONOMOUSLY:
  - Generates brand, mission, strategy from a single idea
  - Builds and deploys the business website
  - Creates the digital product (PDF guide/template/checklist)
  - Deploys a live paywall (Stripe checkout on the business site)
  - Generates all ad creative (copy, images, video scripts)
  - Publishes campaigns to Meta, Google, TikTok, LinkedIn
  - Ingests performance data and optimizes campaigns nightly
  - Improves the product based on user behavior and feedback
  - Reports metrics to the activator: sales, ROAS, LTV, CAC, CVR

WHAT IS BUILT AND WORKING:
  ✓ Authentication (Google OAuth + magic link, no passwords)
  ✓ Business Builder (10-task free build pipeline, SSE streaming)
  ✓ Generated business websites (static, deployed to {slug}.app.textos.ai)
  ✓ Token economy (30 tokens/period, top-up bundles, ledger)
  ✓ Stripe subscriptions ($49.99/mo Founders, $29.99/mo Standard)
  ✓ Stripe Connect schema (businesses table has stripe_connect_* fields)
  ✓ Operator School (6 badges, 12 lessons)
  ✓ Business Manager V1 (goals, charge windows, milestones)
  ✓ Business Live page (/business/live — operations view)
  ✓ Admin portal (Phase 1+2)
  ✓ Marketing: carousel generator, cold email, social content plan

WHAT IS COMING NEXT (Autonomous Business Engine):
  → DIGITAL_PRODUCT generation pipeline (PDF via Claude + R2 storage)
  → Stripe paywall on business website (/buy + /download pages)
  → Ad creative generation (Meta first, then Google, TikTok)
  → Ad platform API integrations
  → Nightly optimization loop (Cron Trigger at 2am UTC)
  → Event-driven threshold workers (Cloudflare Queues)
  → Ad wallet funding flow (Stripe → TextOS → platforms)
  → Performance reporting dashboard (metrics to activator)

NET NEW TABLES FOR AUTONOMOUS ENGINE (not yet created):
  business_products     — digital product assets, R2 file location, pricing
  ad_campaigns          — campaign config, platform, status, daily budget
  ad_creatives          — creative assets, platform format, performance data
  ad_wallets            — activator balance, disbursement history, fee ledger
  performance_snapshots — daily metrics: revenue, ROAS, CVR, ad spend

DO NOT create these tables until the sprint brief instructs it.
DO NOT start any autonomous engine work until Rob says go.

================================================================
## TYPESCRIPT CONTRACT RULES
================================================================

### BaseRow interface (use for all new row types)

All new row interfaces must extend BaseRow or MutableRow.
Add to src/services/supabase.ts before adding any new row type.

  export interface BaseRow {
    id: string;           // uuid
    created_at: string;   // timestamptz
  }

  export interface MutableRow extends BaseRow {
    updated_at: string;   // timestamptz
  }

All existing row types (BusinessRow, UserRow, etc.) should be
migrated to extend BaseRow in a separate cleanup pass.
Do NOT do this migration mid-feature — do it as a standalone task.

### Route handler error shape (use errBody() everywhere)

Every route handler must return errBody() on error paths.
Never return ad-hoc JSON on error. Never throw without catching.

Import from: src/lib/errors.ts
  import { errBody } from '../lib/errors.js';

Error response pattern:
  return c.json(errBody('not_found', 'Business not found'), 404);
  return c.json(errBody('bad_request', 'Slug is required'), 400);
  return c.json(errBody('internal', 'Database write failed'), 500);

ErrorCode values: bad_request, not_found, conflict, internal,
  upstream_error, unauthorized, forbidden, rate_limited, not_configured

### Function signature consistency

Agent service functions follow this pattern:
  export async function doThing(
    client: SupabaseClient,
    param1: string,
    param2: number,
  ): Promise<ThingRow> {
    const { data, error } = await client.from('things')...
    if (error) throw error;
    return data as ThingRow;
  }

Rules:
  - First param is always SupabaseClient
  - Return typed promises, never any
  - Throw on error — never return error objects
  - Named exports only — no default exports from service files

================================================================
## FIELD LOCKING SYSTEM (for Autonomous Engine content fields)
================================================================

Any content field that the AI generates AND the activator can edit
must implement the locking system. This applies to business_products
and any future content tables touched by the optimization loop.

Three properties per content field:
  content:  the current value
  source:   "ai_generated" | "human_edited" | "ai_optimized"
  locked:   true | false

Rules (non-negotiable):
  - Field starts as source="ai_generated", locked=false
  - Activator manually edits field → source="human_edited", locked=true
  - Optimization loop reads locked BEFORE any write
  - locked=true → skip this field, write recommendation to dashboard
  - locked=false → optimization loop may update, source="ai_optimized"
  - Activator can toggle locked from dashboard at any time

When querying for optimization targets:
  WHERE locked = false AND source != 'human_edited'

When writing a recommendation for a locked field:
  INSERT INTO recommendation_queue (business_id, field_path, 
    current_value, suggested_value, expected_impact, created_at)

================================================================
## AUTONOMOUS ENGINE — ARCHITECTURE CONSTRAINTS
================================================================

PDF GENERATION:
  Headless browsers (Puppeteer/Chrome) CANNOT run in Cloudflare
  Workers — no DOM environment. Use an external PDF API called
  via HTTP from the Worker. Options: Gotenberg, PDFMonkey,
  WeasyPrint. One HTTP call: structured HTML in, PDF bytes out,
  store to R2.

  DO NOT attempt to generate PDFs inside the Worker directly.
  DO NOT use puppeteer or playwright in textos-agent.

R2 STORAGE PATHS:
  Products:   /businesses/{business_id}/products/v{version}/{filename}.pdf
  Creatives:  /businesses/{business_id}/creatives/{platform}/{filename}

SIGNED DOWNLOAD URLS:
  Generated on payment_intent.succeeded webhook
  Stored in KV: key=download:{session_id}  TTL=86400 (24 hours)
  Invalidated on charge.refunded

AD WALLET CONSTRAINT:
  The ad wallet funding flow (Stripe → TextOS → platforms) requires
  legal clearance before enabling real money movement.
  Build the schema, UI, and disbursement logic — but gate actual
  fund movement behind a feature flag (AD_WALLET_LIVE=false in env)
  until legal structure is confirmed.

META ADS CONSTRAINT:
  Design Meta Business Manager account structure BEFORE writing
  any Meta API code. A misconfigured Business Manager can result
  in account suspension affecting ALL businesses simultaneously.
  One mistake = all customers affected.

QUALITY GATES (enforce before any campaign publishes):
  All of the following must pass before ads go live:
  - Real $1 test transaction completed end-to-end
  - Download URL confirmed working after payment
  - /buy page loads < 3 seconds, Lighthouse > 80
  - /buy renders correctly at 390px mobile
  - No placeholder text on any page
  - Privacy policy and terms linked from footer
  - Ad platform credentials verified (test API call 200)
  - Ad wallet has 7+ days of budget remaining
  - All creative assets uploaded to platform libraries
  - Pixel/conversion tracking confirmed firing

CRON TRIGGERS:
  Nightly optimization:      2:00 AM UTC daily
  Creative learning loop:    Sunday 3:00 AM UTC
  Product improvement loop:  1st of month 4:00 AM UTC

EVENT-DRIVEN TRIGGERS (Cloudflare Queues, fire immediately):
  payment_intent.succeeded    → generate signed URL, send email
  ad_spend_threshold breach   → pause ALL campaigns immediately
  roas_critical (< 0.5/48h)  → pause campaign, queue new creative
  conversion_rate_drop > 50%  → check technical, flag for nightly
  wallet_low (< 20% budget)   → alert activator, pause if < $10

================================================================
## AI-GENERATED TESTIMONIALS — PROHIBITED
================================================================

Do NOT generate fake testimonials for /buy pages or any
sales surface. FTC guidelines and consumer protection laws
in most jurisdictions prohibit fabricated testimonials.

For V1: Show an honest empty state ("Be the first to review")
After launch: Add real testimonials from real customers only.

If a brief asks for AI-generated testimonials, refuse and
explain this constraint. Implement the empty state instead.

================================================================

---

## Claude + Code Working Agreement

### Role Split (Non-Negotiable)
- **Claude (Architect):** Owns architecture, roadmap,
  data models, API contracts, and strategic decisions.
  Writes code ONLY when it has better context than Code
  (e.g. when reasoning about a full spec not yet in files).
- **Code (Agent):** Owns all file editing, reading,
  building, deploying, and debugging. Code can see the
  full file — trust it to write better implementation
  code than Claude can produce through blind PowerShell.

### When Code Should Own the Solution
- Any file edit — Code reads the file first, reasons
  about it, fixes it. Claude does not dictate line numbers.
- Any bug fix — Code reads the error, traces the code
  path, proposes and applies the fix.
- Any feature implementation — Claude describes WHAT
  and WHY. Code figures out HOW.

### When Claude Should Write Code
- New architecture patterns not yet in the codebase
- Complex data model decisions
- API contract definitions
- When Code has repeatedly failed and Claude has
  specific insight into why

### CLAUDE.md Reminder
Claude must re-read CLAUDE.md at the start of every
session and every hour during long sessions.
This ensures architectural rules, deploy commands,
and working agreements stay fresh.
Last updated: May 2026

---

================================================================

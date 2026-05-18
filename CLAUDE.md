# CLAUDE.md — TextOS Agent

Operating context for Claude when working in this repo. Keep this
file current as the project evolves. **Source PRD:**
`../textos-web/PRD.md` (canonical, locked for the duration of
Sprint 2; future product changes go in `../textos-web/ROADMAP.md`).

> **PRD is LOCKED for the duration of Sprint 2.** Future product
> changes go in `../textos-web/ROADMAP.md`, not `PRD.md`.

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

VIOLATIONS (never do these):
  const taskNameMap = { 'research-strategy': 'Market Analyzed', ... }
  const assetTypeMap = { 'welcome_email': { name: '...', icon: '...' } }
  const FREE_BUILD_SLUGS = ['welcome-email', 'research-strategy', ...]
  const LIFECYCLE_PHASE_ORDER = [{ slug: 'idea', label: '...' }, ...]
  const TASK_TO_PHASE = { 'research-strategy': 'idea', ... }
  const DOC_META = { 'mission-document': { title: '...', icon: '...' } }
  Any map keyed by task slug whose values duplicate tasks.name

WHAT TO DO INSTEAD:
  - task names → read tasks.name from the DB join
  - task order → read tasks.execution_order from the DB
  - document names → read tasks.name via asset.task_run_id join
  - lifecycle phases → read tasks.lifecycle_phase_id join
  - free build tasks → query tasks WHERE is_default = true
  - asset display names → read tasks.name from matching task_run

BEFORE CREATING ANY CONSTANT LIST:
  1. Check the database schema — is this data already in a table?
  2. If yes: query it. Never hardcode it.
  3. If unsure: ASK ROB before creating any constant.
     Do not assume. Do not create first and ask later.

ACCEPTABLE CONSTANTS (not DB data):
  - CSS class names / rendering discriminator maps
    (e.g. slug → which CSS template to apply for modal rendering)
  - Environment configuration (API URLs, feature flags)
  - UI layout constants (breakpoints, animation timings)
  - Pure presentation logic that has no DB equivalent

The test: if the constant would need to be updated when a new
task is added to the tasks table, it is a DB-data constant
and must not exist in code.

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
- Test first: npm run deploy:test
- Verify at: https://textos-web-test.pages.dev
- Never report hash preview URLs
- Never deploy to prod without Rob's explicit approval

TOKEN SECURITY:
- Read token from .env file silently
- Never display token values in output
- Show first 4 chars max to confirm loading

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
[ ] Confirm CLOUDFLARE_API_TOKEN is loadable from .env
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

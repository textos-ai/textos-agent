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

## DAILY CHECKLIST (run at start of every session)

[ ] Read CLAUDE.md in both repos
[ ] Check for new components in src/components/
[ ] Check for new scripts in src/scripts/
[ ] Check public/_redirects for current routing rules
[ ] Check wrangler.toml for current env/binding config
[ ] Confirm CLOUDFLARE_API_TOKEN is loadable from .env
[ ] Run npx wrangler whoami before any deploy

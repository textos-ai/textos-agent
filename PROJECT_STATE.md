# TextOS — Project State Document
**Last updated:** May 17, 2026  
**Author:** Rob Gaudet, New Orleans LA  
**Status:** Post-V1 launch, autonomous engine planning

---

## What TextOS Is

TextOS is a fully autonomous AI-powered business operating system for solo founders. The platform autonomously generates and operates a complete online business — brand, website, strategy, content, marketing, paywall, order fulfillment, continuous product improvement, and continuous campaign optimization — from a single idea input. It then reports back to the activator: sales, customers, views, improvements, iterations, LTV, CAC, ROAS, and other critical business metrics.

The activator's only job is to set a mission and a monthly ad budget. TextOS handles everything else autonomously — indefinitely.

The next major capability being built is the full autonomous business execution pipeline — everything that happens after the mission is defined:
- Building the product and deploying it with a live paywall
- Generating all ad creative automatically (copy, images, video scripts)
- Publishing ads via API to Meta, Google, TikTok, LinkedIn, and others
- Ingesting performance data and optimizing campaigns without human input
- Improving the product over time based on user behavior, error logs, and feedback

**Core promise:** Set a mission. Set a budget. TextOS builds and runs the business.

**Live at:** https://app.textos.ai  
**Frontend repo:** textos-ai/textos-web (Astro, Cloudflare Pages)  
**Backend repo:** textos-ai/textos-agent (Cloudflare Worker, Hono, TypeScript)  
**Closed-source. Forever.**

---

## What Is Built and Working Today

### Authentication
- Google OAuth via Supabase
- Magic link (passwordless email) via Supabase + SendGrid
- JWT session in localStorage, 30-day TTL
- Auto-handle generation on first sign-in
- No passwords. Ever.

### Business Builder (primary feature)
- Two entry paths: "I have an idea" or "Find one for me"
- 10-task free build pipeline runs autonomously after activation:
  1. research-strategy
  2. welcome-email
  3. mission-document
  4. tam-sam-som
  5. daycycle-connect (stub)
  6. personalized-pitch-email
  7. launch-tweet
  8. personal-landing-page
  9. task-queue-built
  10. dashboard-briefing
- SSE streaming UX during build (narrative + CMD streams)
- Business Builder page at /business/{slug}/builder
- 33 total tasks in catalog (10 free + 23 paid/locked)

### Generated Business Website
- Full static site generated and deployed to {slug}.app.textos.ai
- Hero section, ICP section, pain points, why us, metrics, founder section
- SEO-ready: schema.org, og tags, twitter cards, sitemap, robots.txt, llms.txt
- Brandable: accent color, font, layout, eyebrow vocabulary

### Token Economy (fully built)
- 30 tokens included per subscription period
- Top-up bundles purchasable via Stripe
- Token deduction on task execution
- Tables: token_balances, token_purchases, token_transactions

### Stripe Integration
- Platform subscription: $49.99/mo (Founders, 1000-cap) and $29.99/mo (Standard)
- Stripe Connect schema ready: businesses.stripe_connect_account_id/status/onboarded_at
- Webhook handler for subscription events
- Token purchase flow

### Operator School (live)
- 6 task badges, 12 lessons (2 per task)
- All free in V1
- Badges: Strategist, Analyst, Founder, Web Operator, Publisher, Outreach Operator
- CEO master badge earnable

### Business Manager (live, V1)
- Operations & sales view
- Goals tracking
- Charge windows
- Milestones
- Task catalog with lifecycle phase grouping

### Business Live Page (new, live)
- /business/live — real-time operations view
- Bulletin feed from task_runs
- Metrics: views, revenue, built count
- Marketing task status
- Documents section
- Console/terminal

### Admin Portal (Phase 1+2 built)
- User management
- Task catalog management
- Email queue review
- Revenue events and usage logs

### Marketing Tools
- Carousel generator (built, live)
- Cold email outreach task
- Social content plan task

---

## Tech Stack (Confirmed)

| Layer | Technology |
|---|---|
| Frontend | Astro (static output), Cloudflare Pages |
| Backend | Cloudflare Workers (Hono, TypeScript) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| File storage | Cloudflare R2 |
| Queue | Cloudflare Queues |
| Cache/state | Cloudflare KV |
| AI | Anthropic Claude Sonnet (primary), Haiku (lightweight) |
| Images | fal.ai (Flux model) |
| Email | SendGrid |
| Payments | Stripe (subscriptions + Connect) |
| Social | Blotato (pending architecture decision) |
| DNS/CDN | Cloudflare |

**Frontend live:** https://app.textos.ai  
**Worker live:** https://textos-agent-dev.rgaudet2023.workers.dev  
**Test frontend:** https://textos-web-test.pages.dev  
**Test worker:** https://textos-agent-test.rgaudet2023.workers.dev

---

## Database — 33 Tables (as of May 17, 2026)

### Identity & Auth
- `users` — platform accounts (email, handle, tier, stripe_customer_id)
- `admin_users` — admin flag table
- `admin_actions` — audit log of admin operations
- `email_change_requests` — verified email change flow

### Businesses
- `businesses` — core business record (slug, name, all website content fields, Stripe Connect fields, page_views)
- `business_context` — AI research accumulator (market data, competitors, positioning, brand voice)
- `business_goals` — per-business goal tracking
- `charge_windows` — Charge mode sessions
- `milestones` — business timeline events

### Task System
- `tasks` — task catalog (slug, name, kind, plan_required, token_cost, lifecycle_phase_id)
- `task_runs` — execution records (status, state, work_log, is_current, retry_count)
- `task_apis` — task-to-API bindings
- `task_edits` — audit log for task catalog changes
- `task_purchases` — à la carte task purchases
- `lifecycle_phases` — task categorization (idea, business-creation, product-creation, product-marketing, success-measurement)
- `external_apis` — registered API providers

### Subscriptions & Tokens
- `subscription_plans` — plan catalog
- `business_subscriptions` — per-business subscription records
- `user_subscriptions` — legacy user-level subscriptions
- `token_balances` — current token state per business
- `token_purchases` — top-up purchase records
- `token_transactions` — token debit/credit ledger

### Build Pipeline
- `free_build_runs` — orchestrator run state
- `stream_events` — SSE event log per run
- `business_assets` — generated artifacts (documents, images, websites)
- `anonymous_snapshots` — pre-auth market research snapshots

### Operator School
- `badges` — badge catalog
- `badge_earnings` — user badge completions
- `lessons` — curriculum content
- `lesson_completions` — user lesson progress

### Marketing
- `marketing_carousels` — generated carousel content

### Infrastructure
- `email_queue` — outbound email staging and approval
- `stripe_events` — Stripe webhook dedup log
- `app_errors` — application error log

---

## What Is NOT Yet Built (Autonomous Engine)

The following 5 tables and their associated pipelines do not yet exist.  
These are the net-new additions for the Autonomous Business Engine:

| Table | Purpose | Phase |
|---|---|---|
| `business_products` | Digital product assets, file location, pricing, versioning | Phase 1 |
| `ad_campaigns` | Campaign config, platform, status, daily budget | Phase 2 |
| `ad_creatives` | Creative assets, platform format, performance data | Phase 2 |
| `ad_wallets` | Activator balance, disbursement history, fee ledger | Phase 2 |
| `performance_snapshots` | Daily metrics per business (revenue, ROAS, CVR, ad spend) | Phase 3 |

---

## Autonomous Business Engine — Roadmap

### What it adds to TextOS
Three gaps the engine closes:

**GAP 1 — Product:** Website exists but nothing to sell. Engine generates a DIGITAL_PRODUCT (PDF guide/template/checklist) using Claude, stores in R2, delivers via signed URL after Stripe payment.

**GAP 2 — Paywall:** No checkout exists on the business website. Engine injects /buy and /download pages, configures Stripe one-time payment, wires download delivery.

**GAP 3 — Customer acquisition:** No ads running. Engine generates full creative suite (headlines, body copy, images, video scripts) and publishes campaigns via Meta, Google, TikTok APIs. Activator sets monthly budget once.

**GAP 4 — Optimization loop:** Nightly Cron Trigger (2am UTC) ingests performance data and optimizes campaigns, budget, and product. Event-driven Queue workers handle financial emergencies (overspend, ROAS collapse, zero balance) immediately.

### Business model
- Platform subscription: $49.99/mo
- Ad management fee: 15-20% of activator monthly ad spend
- TextOS holds ad wallet float, pays platforms directly, deducts fee at disbursement

### Activator touchpoints (intentionally minimal — this is the entire job)
1. Enter business idea (or accept TextOS suggestion)
2. Connect Stripe account via Stripe Connect (one-time)
3. Fund Ad Wallet minimum $300
4. Set monthly budget cap
5. That is all. TextOS runs the business from this point forward autonomously.

The activator is not a manager. They do not approve content, review campaigns, or make operational decisions. They receive reports. They adjust budget if they choose. Everything else is handled by TextOS without human input.

### Field locking system (conflict resolution)
Every content field has three properties:
- `content` — current value
- `source` — "ai_generated" | "human_edited" | "ai_optimized"  
- `locked` — true | false

Human edits lock the field. AI skips locked fields and queues recommendations instead.

### Build sequence
- **Week 1:** DIGITAL_PRODUCT generation + R2 storage + Stripe paywall + email delivery
- **Week 2:** Ad Wallet + Meta Ads API + creative generation pipeline
- **Week 3:** Google Ads + nightly optimization worker + event-driven Queue workers
- **Week 4:** TikTok + weekly creative learning loop + monthly product improvement loop

### Critical pre-build decisions needed
1. PDF generation approach (headless browser can't run in CF Worker — use external PDF API)
2. Legal clearance on ad wallet float before enabling real money movement
3. Meta Business Manager account structure before writing any Meta API code
4. Replace AI-generated testimonials with honest empty state for V1
5. Ad creative policy review gate before any campaign publishes

---

## Architecture Principles (Permanent)

1. **Tasks are 100% database-driven.** No hardcoded task arrays anywhere. The `tasks` table is the single source of truth.

2. **No fallbacks, anywhere.** If required data is missing or null, halt, throw, and log loudly. No placeholder strings, no default values. Silent fallback in production is worse than a crash.

3. **Trace + grep + logs before fix.** Every bug must trace the actual code path before proposing any fix. A fix isn't shipped until logs prove the code executed.

4. **Research before every brief.** The answer is almost always already in the codebase. Read CLAUDE.md and existing patterns before writing any code.

5. **Test before prod.** Deploy to textos-web-test.pages.dev and verify with your own eyes before any production deploy.

---

## Vocabulary Rules (Non-Negotiable)

**Never use:** AI, agent (in role context), task, automation, tool, bot, execute, process, prompt, generate  
**Always use:** operator vocabulary — your business, your COO, run the play, authorize, brief, command center, operator

**Agent names (approved):** Iris, Linnea, Theia, Mira, Solène, Atlas, Orin, Soren, Caspian, Aldo, Sage, Wren  
**Never:** "Cap" or "CAP" anywhere in the codebase

---

## Known Debt (Do Not Fix Mid-Sprint)

- Manager V1 schema: `business_goals` missing phase/kind/label/target/current/due_at
- Manager V1 schema: `charge_windows` has `rule_text` not `must_win_text`
- Manager V1 schema: `milestones` missing `kind`
- `task_runs` missing `user_action_*` columns (requires_user_action, user_action_title, etc.)
- No formal `BaseRow` TypeScript interface — implicit id/created_at convention not enforced
- Route handler error shapes inconsistent — some return `errBody()`, some throw raw errors
- Frontend has 4 different data access patterns (BusinessLiveData, apiCall(), direct Supabase, raw fetch)

Backlog: "Manager schema reconciliation V1.5" post-launch.

---

## Key People

**Rob Gaudet** — Founder, New Orleans LA  
30-year web dev (first site 1995). Classic Windows stack (C# WebForms, LINQ-to-SQL, SQL Server). Not CLI/bash native — all terminal instructions need full explanation. Uses PowerShell, not bash.

**Credentials:** Stored in Bitwarden. Never paste API keys or secrets into chat. Read from .env files only.

**Emails:**  
- `admin@textos.ai` — working inbox, Microsoft 365  
- `auth@textos.ai` — planned for Supabase magic-link sends  
- `robertkgaudet@gmail.com` — OAuth/prod testing  
- `rgaudet+test@gmail.com` — test env only
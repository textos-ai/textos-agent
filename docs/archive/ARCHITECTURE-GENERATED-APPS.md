# TextOS Generated Apps — Architecture

**Status:** draft for review · current state as of 2026-05-24
**Scope:** the AI-generated, per-business mini-app feature
**Audience:** Rob + reviewing agents

> Reviewer brief: please critique both the **current implementation** and the **forward-path proposals**. Specifically wanted: failure modes I've missed, simpler designs I'm overcomplicating, places where I'm conflating current-state with proper-architecture, and any pieces that should be ripped out instead of refactored.

---

## 1. What this is

A single AI-generated mini-app per TextOS business — a small interactive tool (quiz, calculator, recommender, intake form, etc.) that lives on the business's public site at `/sites/{slug}/app` and converts visitors into paying customers. The user picks "Let TextOS decide" or supplies a description; TextOS generates the entire HTML/CSS/JS file via Claude and serves it inside a sandboxed iframe. Visitors can use a free tier (teaser results) and pay via Stripe to unlock the full result; tokens are decremented per use.

The TextOS operator pays for **generation** (in TextOS tokens). The visitor pays for **usage** (in dollars, via Stripe Checkout, with proceeds going to TextOS — Stripe Connect to operators is on the V1.1 roadmap, not built).

This is distinct from the **pre-built apps catalog** at `/api/apps/*` (voice-receptionist etc), which is a separate product surface. The generated-apps feature lives at `/api/generated-apps/*`.

---

## 2. Current state (as deployed)

**Test agent:** `https://textos-agent-test.rgaudet2023.workers.dev`
**Prod agent:** `https://textos-agent-dev.rgaudet2023.workers.dev` (deployed 2026-05-24)
**Test web:** `https://textos-web-test.pages.dev`

**Repos:**
- `textos-web` — Astro static site on Cloudflare Pages, frontend only
- `textos-agent` — Cloudflare Worker (Hono + Anthropic SDK + Supabase), backend

**Files (textos-agent):**
- `src/lib/tasks/generate-business-app-design.ts` — Step 1: design JSON spec
- `src/lib/tasks/generate-business-app-html.ts` — Step 2: HTML generation
- `src/routes/generated-apps.ts` — public runtime routes
- `src/routes/internal.ts` — Service-Binding-only chain trigger
- `src/routes/business-task-run.ts` — user-facing task dispatch (shared with all paid tasks)

**Files (textos-web):**
- `src/pages/business/apps.astro` — operator-facing create/manage page
- `src/pages/business/app.astro` — public app shell (iframe host)
- `src/pages/sites/[slug]/index.astro` — public business site (renders the "Business App" teaser)

**Live runtime is currently broken** — see § 9 Known Issues. The generation pipeline hits Cloudflare Workers' wall-clock cap on `waitUntil` work (~5 min). Some runs complete; many don't.

---

## 3. Data model

### Existing tables, new uses

```
business_assets
  - asset_type='app_draft'   (transient, written by Design step, deleted by HTML step on success)
  - asset_type='app'         (the final app — html, app_type, app_title, design spec, llm_tier)
  - asset_subtype='mini_app' (only used for asset_type='app')
  - asset_url                = '{frontend}/sites/{slug}/app'
  - asset_data jsonb         = { html, app_type, app_title, app_tagline, design, llm_tier, generated_at }
```

The asset is the **serving** record. Everything render-time reads from here.

### New tables

```
app_configs
  business_id PK, asset_id FK, llm_tier, free_tier_enabled,
  paid_tier_price_cents, token_cost_per_use, is_published
  (per-business app config — one row per business)

app_visitor_tokens
  visitor_token (DB-generated random hex), business_id,
  stripe_session_id, tokens_purchased, tokens_remaining,
  amount_cents, expires_at
  (created at Stripe Checkout start with tokens_remaining=0;
   filled by Stripe webhook on payment success)

app_usage_log
  business_id, asset_id, visitor_token, interaction_type,
  llm_tier, tokens_used, error
  (append-only, one row per visitor request to verify-token)

app_bug_log
  business_id, asset_id, error_type, error_message,
  stack_trace, status ∈ ('open','in_review','resolved')
  (for runtime errors only today; admin queue not yet built)
```

### Existing tables touched

```
tasks
  + new rows: 'generate-business-app' (token_cost=5, visible),
              'generate-business-app-html' (token_cost=0, hidden, internal)

task_runs
  + new column: config jsonb
    (added so the user's form input — description, llm_tier —
     can reach the task handler)
```

---

## 4. Generation pipeline

The chain pattern. Two task_runs, two Worker invocations, joined by a Service Binding self-call.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Worker invocation A: design step                                       │
│                                                                        │
│   POST /api/businesses/{slug}/tasks/generate-business-app/run          │
│        body: { config: { description, llm_tier } }                     │
│     → creates task_runs row (config saved, status='running')           │
│     → 202 returned to client                                           │
│     → c.executionCtx.waitUntil(runTaskInBackground(...))               │
│                                                                        │
│   runTaskInBackground dispatches to runGenerateBusinessAppDesign(tc):  │
│     1. Read task_runs.config → description, llm_tier                   │
│     2. anthropic.messages.create({                                     │
│          model: 'claude-sonnet-4-20250514',  ← HARDCODED — see issues  │
│          max_tokens: 2000,                                             │
│          stream: false,                                                │
│        }) — wrapped in Promise.race(45s timeout)                       │
│     3. Insert business_assets row asset_type='app_draft'               │
│        (asset_data = { design, llm_tier })                             │
│     4. POST env.SELF /api/internal/run-task                            │
│        body: { businessId, userId, taskSlug='...html' }                │
│        header: x-internal-secret                                       │
│     5. Return → task_run completes (status='completed')                │
│        output_data.next_task_run_id = the HTML run's id                │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  Service Binding (env.SELF.fetch)
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Worker invocation B: html step                                         │
│                                                                        │
│   POST /api/internal/run-task (validated by x-internal-secret)         │
│     → creates task_runs row for slug='generate-business-app-html'      │
│     → c.executionCtx.waitUntil(runTaskInBackground(...))               │
│     → 202 returned to invocation A                                     │
│                                                                        │
│   runTaskInBackground dispatches to runGenerateBusinessAppHtml(tc):    │
│     1. Read most recent business_assets WHERE asset_type='app_draft'   │
│        — extract design, llm_tier                                      │
│     2. anthropic.messages.create({                                     │
│          model: 'claude-sonnet-4-20250514',  ← HARDCODED               │
│          max_tokens: 4000,                                             │
│          stream: false,                                                │
│        }) — wrapped in Promise.race(90s timeout)                       │
│     3. Insert business_assets asset_type='app' (placeholder html)      │
│     4. Substitute {{BUSINESS_ID}}, {{ASSET_ID}}, {{API_BASE}}          │
│     5. Update the asset with final html                                │
│     6. Upsert app_configs (price, tier, published=true)                │
│     7. Delete the app_draft row                                        │
│     8. Return → task_run completes                                     │
└────────────────────────────────────────────────────────────────────────┘
```

**Why split:** the original combined handler (Sonnet x2 + 8000 max_tokens) regularly busted the 2-minute task_run sweep AND ran up against the Worker invocation wall-clock. Splitting gives each step its own invocation budget. The Service Binding is needed because Cloudflare blocks Worker → same-Worker public-URL fetches (returns 1042).

**Frontend visibility during generation:** the operator's `/apps` page POSTs the task, gets the design `task_run_id`, polls `GET /api/businesses/{slug}/task_runs/{id}` every 2s. When design completes, it reads `output_data.next_task_run_id` and polls the HTML run. UI shows two states: "Designing your app…" then "Building your app interface…" then reloads to show the finished card.

---

## 5. Runtime serving

```
Visitor lands on: app.textos.ai/sites/{slug}/app

Cloudflare Pages rewrite: /sites/*/app → /business/app/
Static page src/pages/business/app.astro:
  1. reads slug from URL
  2. fetch /api/sites/{slug} → businessId
  3. fetch /api/generated-apps/{businessId}/app-html → { html }
  4. <iframe srcdoc={html} sandbox="allow-scripts allow-forms
       allow-same-origin allow-popups
       allow-popups-to-escape-sandbox
       allow-top-navigation-by-user-activation">

Inside the iframe, the generated HTML contains:
  window.TXAPP = {
    businessId, assetId, apiBase,
    visitorToken: localStorage.getItem('tx_vt_{{BUSINESS_ID}}'),
    purchase() → navigates to {apiBase}/api/generated-apps/{businessId}/purchase
    checkToken() → fetch {apiBase}/api/generated-apps/{businessId}/verify-token
  }

Free-tier flow:
  visitor answers questions → submit → checkToken() → false →
  show teaser result + paywall overlay

Paid-tier flow:
  visitor clicks Unlock → /purchase creates Stripe Checkout Session
    + creates app_visitor_tokens row (tokens_remaining=0, stripe_session_id)
  Stripe redirects to /sites/{slug}/app?vt={visitor_token} on success
  iframe reads ?vt= on load → localStorage → TXAPP.visitorToken
  Stripe webhook fires checkout.session.completed →
    /api/generated-apps/webhook/stripe (signature-verified)
    → updates app_visitor_tokens.tokens_remaining = tokens_purchased
  visitor re-submits → checkToken() → true → full result, no paywall
```

The visitor never authenticates with TextOS. Identity is just the random `visitor_token` in localStorage + the matched DB row.

---

## 6. Token economy (two-sided)

**Operator side (generation):**
- `tasks` row 'generate-business-app' has `token_cost=5`. User burns 5 TextOS tokens to kick off the chain. Charged AFTER design step completes successfully (existing `runTaskInBackground` token-debit pattern).
- The chained `generate-business-app-html` task has `token_cost=0` so the user isn't double-charged.
- HTML failures DO NOT refund the operator. (Open question — see § 10.)

**Visitor side (usage):**
- Default $5.00 (`paid_tier_price_cents=500`) for 10 tokens at 1 token per use. Operator can change in `app_configs` (PATCH /config, owner-only).
- One token deducted per `verify-token` call (one per visitor "unlock" event).
- Stripe collects 100% of the revenue to the platform Stripe account. **No Stripe Connect / operator revenue split yet.** This is a substantive product question — see § 10.

---

## 7. Routes

### Operator-facing (require auth, owner-only)
```
POST   /api/businesses/{slug}/tasks/generate-business-app/run
GET    /api/businesses/{slug}/task_runs/{id}                    (poll)
PATCH  /api/generated-apps/{businessId}/config                  (price, tier)
```

### Visitor-facing (no auth)
```
GET    /api/generated-apps/{businessId}/app-html
POST   /api/generated-apps/{businessId}/purchase
POST   /api/generated-apps/{businessId}/verify-token            (x-visitor-token header)
```

### Webhook
```
POST   /api/generated-apps/webhook/stripe                       (signature-verified)
```

### Internal (Service Binding only)
```
POST   /api/internal/run-task                                   (x-internal-secret header)
```

---

## 8. Security posture (current)

**Internal trigger:** shared secret (`INTERNAL_TRIGGER_SECRET`) in header, validated against env var. Routed via Cloudflare Service Binding so the request never traverses the public internet. Worth noting: the secret is only a defense-in-depth — the Service Binding alone restricts the route to same-Worker fetches.

**Stripe webhook:** standard HMAC-SHA256 signature verification using `STRIPE_WEBHOOK_SECRET`. Idempotency by visitor_token (the UPDATE is gated on `tokens_remaining=0` so duplicate webhook deliveries can't double-credit).

**Visitor tokens:** 64-character hex generated by Postgres `gen_random_bytes(32)`. Stored in plaintext in DB and visitor's localStorage. Treated as bearer tokens — anyone with the string can decrement that row.

**Iframe sandbox:** uses `allow-scripts allow-forms allow-same-origin`. The `allow-same-origin` flag is a known footgun: combined with `allow-scripts`, code inside the iframe can read/write localStorage of the parent origin and access the parent's cookies/document. This is intentional today because the TXAPP global needs localStorage access for the visitor token — but it means a buggy generated app can read other localStorage keys on `app.textos.ai`. Per-origin isolation (host each app at a unique subdomain) is the proper fix; not implemented.

**RLS:** the public endpoints use the service-role Supabase key, which bypasses RLS by design. Authorization is enforced at the route level (slug ownership check, header validation).

---

## 9. Known issues / tech debt

Listed in roughly priority order. Some affect production; others are surfaces that will bite later.

### Generation reliability (active P0)
1. **HTML step times out near 5 min.** Cloudflare Workers Standard `waitUntil` wall-clock cap is ~5 min. Sonnet at 4000 max_tokens often takes 60-180s but tails to 4+ min. When it does, the invocation is killed by the runtime; the task_run row stays `running` until the next poll sweeps it. Frontend shows generic "Building your app…" until then.
2. **`Promise.race` doesn't cancel the underlying fetch.** The `withTimeout` wrapper around `anthropic.messages.create` rejects the await, but the SDK's fetch keeps running until Anthropic responds or Cloudflare's per-subrequest timeout. We don't pass an `AbortSignal`.
3. **LLM tier hardcoded.** Form lets the user pick Haiku/Sonnet/Opus; the value is recorded in DB but the actual Anthropic call always uses `claude-sonnet-4-20250514` in both Design and HTML steps. Haiku would be 3-5x faster and would likely solve issue #1 for most runs.
4. **`emit()` is a no-op for paid tasks.** All progress emits in both handlers go nowhere — `business-task-run.ts` builds the TaskCtx with `emit: async () => {}`. The frontend never sees intermediate progress.

### Data + lifecycle
5. **`app_draft` orphans.** If the HTML step fails, the draft row stays. The Design step on retry inserts a new draft; the HTML step picks "most recent" so works, but old drafts pile up.
6. **One app per business is implicit.** No slot system. Regenerating overwrites the singleton `asset_type='app'` row. No history, no rollback.
7. **`app_bug_log` is unused by generation.** Only the runtime `verify-token` route writes to it. Generation failures go to `task_runs.error` only. The admin queue at `/admin/app-bugs` was specified but never built (Part 9 of the original brief was deferred).
8. **Stale error labels.** Fixed today: `'timeout_2min'` → `'timeout_5min'` after the threshold was raised. Same drift will recur next time someone changes a threshold.
9. **`task_runs.config` is a free-form jsonb.** No schema, no validation beyond "is it an object." Handlers cast and hope.
10. **No frontend retry-with-preserved-input.** When a step fails, the create form is re-rendered fresh; the user's mode + tier + description are wiped.

### Monetization
11. **No operator revenue share.** All Stripe revenue flows to the platform. Stripe Connect schema exists on `businesses` but isn't wired. This is the central V1.1 product gap.
12. **No refunds.** Stripe `charge.refunded` event isn't handled by the generated-apps webhook (it IS handled by the platform Stripe webhook for subscriptions; the apps webhook is a separate URL).
13. **Pricing is per-business and uniform.** No app-type-based pricing, no A/B, no dynamic pricing.

### Routes / observability
14. **Two Stripe webhook URLs to configure.** The existing platform webhook + this new one. Stripe Dashboard needs both registered.
15. **No rate limiting** on `/purchase` or `/verify-token`. Abuse vector: someone could spam create-checkout-sessions to clutter `app_visitor_tokens`.
16. **No structured logs from generation handlers.** Errors are stringified into `task_runs.error`. Looking up "why did Bob's app fail" requires SQL + Worker tail.

### Frontend / UX
17. **Iframe parent never knows when the app finishes.** No `postMessage` channel from inside the iframe back to the host page. Once the iframe is rendered, the parent is blind.
18. **No SEO for apps.** Search engines see only the iframe shell with a loading message.
19. **No mobile-vs-desktop preview before publish.** The generated HTML is mobile-first per the prompt, but the operator can't preview before paying 5 tokens.

---

## 10. Open architectural questions

The questions I want second opinions on:

### Q1. Where should generation actually run?
Today: in-Worker via `c.executionCtx.waitUntil` + Service Binding chain. Hits Worker wall-clock cap.

Candidates:
- **(A)** Cloudflare Queues. Producer enqueues, consumer Worker picks up, runs in a fresh invocation with native retries.
- **(B)** External long-running service (Cloud Run, Lambda) called from Worker; only the entry is in CF.
- **(C)** Durable Object that owns the generation lifecycle, can stream progress, can survive across short Worker restarts.
- **(D)** Stay in-Worker but actually fix the cancellation: AbortController + honor llm_tier (Haiku for speed) + true streaming. Mid-effort.

Trade-offs: A is the standard "long task on Workers" answer but introduces a new product surface to operate. B externalizes a piece of infra that we've kept inside Cloudflare on purpose. C is overkill for two LLM calls but right if we add iterative refinement, A/B variants, or any stateful workflow. D is cheapest now but doesn't help if Anthropic itself takes >5 min on the tail.

**My current lean: D for V1.1 (Haiku + AbortSignal solves most timeouts); A when we add additional app generators or want a durable retry surface.**

### Q2. One app per business, or many?
Today: singleton. The `business_assets` row with `asset_type='app'` is implicitly the latest+only.

Proper: multiple apps per business (e.g., a quiz AND a calculator AND a recommender), each at its own URL slot. Requires:
- Multiple URL slots (`/sites/{slug}/apps/{appSlug}` instead of singleton `/sites/{slug}/app`)
- A way to list them on the operator page
- Per-app `app_configs` (currently keyed on business_id alone)
- A way to surface them on the public site (which gets featured?)

**Lean: singleton for V1. Multi-app is a product question, not just architectural.**

### Q3. Storage: JSONB for HTML, or R2?
Today: full HTML in `business_assets.asset_data.html`. Postgres jsonb can hold this but it's not what jsonb is for.

R2 alternative: store HTML in `/businesses/{business_id}/apps/v{n}.html`. asset_data keeps only metadata + URL pointer.

R2 buys: cheaper at scale; CDN cacheable; versioning natural via path; serving doesn't hit Postgres.

R2 costs: extra fetch round-trip per render; needs signed URLs for private apps (or public bucket).

**Lean: stay in jsonb until apps exceed ~10MB or read volume justifies CDN. Probably never for V1.**

### Q4. Where does the iframe live?
Today: iframe with `srcdoc=` containing inline HTML, hosted at the platform domain. `allow-same-origin` is set, which means generated code can read platform localStorage.

Proper: host each app at a unique subdomain (`{slug}.apps.textos.ai/app`) so the sandbox `allow-same-origin` is scoped to the app's own origin, not the platform's. Eliminates the localStorage cross-talk risk and lets apps use cookies if needed.

**Lean: must do before public launch. Real security concern.** The DNS / Pages routing pattern is the same complexity as the existing wildcard handle subdomain question (see textos-web CLAUDE.md § Known Decisions Deferred).

### Q5. How should LLM-tier choice actually work?
Today: ignored. Always Sonnet.

If wired:
- Haiku design + Haiku HTML: fast (15-30s), low quality
- Haiku design + Sonnet HTML: medium (60s), good quality
- Sonnet both: slow (90-180s), highest quality
- Opus both: very slow, premium

User-facing question: do we expose this choice, or auto-pick based on app_type? A quote calculator probably doesn't need Sonnet HTML; a recommender with rich result text probably does.

**Lean: honor the user's choice in V1 (cheap fix), auto-pick in V1.1 based on app_type heuristics.**

### Q6. Token accounting: who pays for a failure?
Today: operator is charged 5 tokens when Design step succeeds, regardless of whether HTML succeeds. If HTML fails after Design completes, the operator paid but got nothing useful.

Options:
- Charge only after HTML completes (move the debit to the HTML step).
- Charge after Design, refund automatically on HTML failure.
- Keep current behavior, document it, let the user retry HTML without re-paying (currently they can't — retry runs Design again).

**Lean: move debit to HTML step. Operationally simpler than refunds.**

### Q7. Revenue split / Stripe Connect
This is the big one. Today, all visitor revenue goes to the TextOS platform. The product positioning implies operators run businesses — they should keep the money.

Options:
- **Direct charges** via Stripe Connect: Stripe Checkout Session is created on the operator's connected account; TextOS takes a platform fee.
- **Destination charges**: TextOS receives, then transfers to operator. Simpler tax-wise for TextOS.
- **Separate charges + transfers**: most flexible, most complex.

Plus: who handles refunds, chargebacks, payouts? Operator's Stripe dashboard or TextOS's?

**Lean: destination charges. Most familiar pattern. Build operator-side reporting later.**

### Q8. Should the entire feature be PostMessage-driven instead of REST?
Today: iframe → fetch to public REST endpoints. Means the iframe needs `apiBase` baked in, and any infra change requires regenerating apps.

Alternative: iframe → window.parent.postMessage; parent page makes the fetch. Decouples generated code from infrastructure URLs. Generated HTML never needs to know `apiBase`.

Trade-off: more glue code in the parent; harder to embed apps off-platform (which is fine — we don't want that today).

**Lean: REST is fine. PostMessage if we later want apps embeddable on third-party sites.**

### Q9. Versioning
Today: regenerating an app overwrites the singleton row. No history.

Should each generation be a new version row? Useful for: A/B testing, rollback, debugging "this used to work."

**Lean: yes. asset_data.version + retain previous N versions. Low-cost. Worth doing before V1 launch.**

### Q10. Observability for ops
Today: failures are a string in `task_runs.error`. Diagnosing a production failure means SQL + `wrangler tail`. No dashboard, no aggregation.

Minimum for V1: an admin queue UI listing `app_bug_log` open rows with one-click Mark Resolved (originally specified in Part 9 of the brief). Generation handlers should write structured errors to `app_bug_log` on every failure, not just runtime errors.

---

## 11. Proposed forward path (V1.1)

Ranked by effort × leverage. None of these are committed; this is the recommendation for the agent reviewers to challenge.

| # | Change                                         | Effort | Leverage | Why                                          |
|---|------------------------------------------------|--------|----------|----------------------------------------------|
| 1 | Honor `llm_tier` from form (wire to model)     | XS     | High     | Solves most timeouts; user already asked     |
| 2 | AbortController on Anthropic calls             | XS     | Medium   | Returns Worker budget; cleaner failure       |
| 3 | Move token debit to HTML step                  | XS     | Medium   | No more pay-for-broken-result                |
| 4 | Log generation failures to `app_bug_log`       | S      | High     | Makes the admin queue actually useful        |
| 5 | Admin app-bug queue UI (Part 9 of brief)       | M      | High     | Recovery surface                             |
| 6 | Versioning: keep last N generations            | S      | Medium   | Rollback, debugging                          |
| 7 | Frontend preserves form input on retry         | XS     | Low      | UX papercut                                  |
| 8 | Streaming HTML generation + progress emit      | M      | Medium   | Better UX, also addresses subrequest timeout |
| 9 | Stripe Connect destination charges             | L      | Critical | Operators keep their money — the product    |
| 10| Per-subdomain hosting `{slug}.apps.textos.ai`  | L      | High     | Closes the same-origin sandbox hole          |
| 11| Cloudflare Queues for generation               | M      | Medium   | Only if Workers wall-clock keeps biting      |
| 12| Multi-app per business                         | L      | Variable | Product decision pending                     |

**Things I'd skip for V1.1:** Durable Objects (Q1c), R2 for HTML storage (Q3), PostMessage rewrite (Q8). All real options; none earn their complexity yet.

---

## 12. How to verify any claim in this doc

For reviewers who want to confirm:

**Database state:**
```sql
-- Recent generation attempts
SELECT tr.id, t.slug, tr.status, tr.started_at, tr.completed_at, tr.error
FROM task_runs tr JOIN tasks t ON t.id = tr.task_id
WHERE t.slug LIKE 'generate-business-app%'
ORDER BY tr.started_at DESC LIMIT 20;

-- Live apps
SELECT business_id, asset_subtype, asset_data->>'app_type' AS app_type,
       asset_data->>'app_title' AS title, created_at
FROM business_assets WHERE asset_type='app' ORDER BY created_at DESC;

-- Orphan drafts (HTML step failed)
SELECT business_id, created_at FROM business_assets
WHERE asset_type='app_draft' AND created_at < NOW() - INTERVAL '1 hour';
```

**Code:**
- Design handler: `textos-agent/src/lib/tasks/generate-business-app-design.ts`
- HTML handler: `textos-agent/src/lib/tasks/generate-business-app-html.ts`
- Runtime routes: `textos-agent/src/routes/generated-apps.ts`
- Internal trigger: `textos-agent/src/routes/internal.ts`
- Operator UI: `textos-web/src/pages/business/apps.astro`
- Public app shell: `textos-web/src/pages/business/app.astro`
- Site teaser section: `textos-web/src/pages/sites/[slug]/index.astro` (look for `.site-app-section`)

**Worker bindings (wrangler.toml):**
- `SELF` service binding (top-level for prod, `[env.test.services]` for test)
- `INTERNAL_TRIGGER_SECRET` (set via `wrangler secret put`)
- `STRIPE_WEBHOOK_SECRET` (existing)

---

## 13. Specific things I want the reviewing agents to push back on

1. Is **chain-pattern-via-Service-Binding** the right answer, or am I reinventing a queue? Be specific about when Queues earn their cost vs Service Binding.
2. Is the **iframe + `allow-same-origin` + platform-domain hosting** acceptable until V1.1, or is this a launch blocker?
3. Is **`Promise.race` without `AbortSignal`** acceptable defense-in-depth, or do I need to refactor every long-running task in the codebase?
4. Is the **two-table model (`app_configs` + reused `business_assets`)** correct, or should generated-apps have its own first-class entity table (`generated_apps`) with `business_assets` referencing it?
5. Am I missing a layer in the **token economy** — should the operator's per-generation cost vary with chosen tier (Haiku=2 tokens, Sonnet=5, Opus=10)?
6. Is **anonymous visitor identity** (random token in localStorage) sufficient, or should we capture email at purchase for receipt + refund flow?
7. Is putting **HTML in jsonb** going to bite us at the 1,000-business or 10,000-business mark? If yes, what's the threshold to migrate to R2?
8. Should the **operator be able to edit the generated HTML directly** (text-controllable field on the asset, like other content tables), or is regenerate-only the right policy?

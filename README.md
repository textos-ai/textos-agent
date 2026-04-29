# textos-agent

The TextOS Agent backend — a Cloudflare Worker built on the Anthropic
Agent SDK (TypeScript) + Hono. Multi-tenant entry point for the
textos.ai product. Frontend lives in `textos-web` (Astro on Cloudflare
Pages); this repo holds the backend that orchestrates LLM calls,
tasks, Stripe webhooks, and Supabase reads/writes.

## Stack

- **Cloudflare Workers** — runtime, deployed via `wrangler`
- **Hono** — HTTP router + middleware
- **Anthropic Agent SDK** — Claude Sonnet 4.6 (primary), Haiku 4.5
  (lightweight), Opus 4.7 (premium). Routing in
  `src/agent/model-router.ts`.
- **Supabase Postgres** — `users`, `businesses`, `tasks` (catalog),
  `task_runs`, `subscription_plans`, `user_subscriptions`,
  `task_purchases`. Auth = Supabase Auth.
- **Cloudflare D1 / Queues / KV / R2** — wired in Sprint 3+. Currently
  commented placeholders in `wrangler.toml`.

## Local dev

Prereqs: Node 20.17+ recommended (20.13 works with engine warnings).
No Docker required for migrations.

```bash
npm install
npm run dev          # wrangler dev — local Worker on :8787
```

For local secrets, create a gitignored `.dev.vars` file (same names as
production secrets):

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://gnpohaxkwbvoscqhdezu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ENVIRONMENT=dev
```

## Endpoints

Live dev URL: `https://textos-agent-dev.rgaudet2023.workers.dev`

### `GET /healthz` and `GET /version`

```bash
curl https://textos-agent-dev.rgaudet2023.workers.dev/healthz
# → {"ok":true,"service":"textos-agent","version":"0.1.0-sprint2","environment":"dev","ts":"..."}
```

### `POST /chat`

Streams Anthropic SSE events. Body: `{"message": "...", "model"?: "haiku"|"sonnet"|"opus"}`.

```bash
curl -N -X POST https://textos-agent-dev.rgaudet2023.workers.dev/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hi","model":"haiku"}'
```

### `POST /tasks/run`

Looks up a task by slug. **Sprint 2:** returns the task row only — real
execution lands in Sprint 5. Body:
`{"taskSlug": "...", "businessId"?: uuid, "inputs"?: object}`.

```bash
curl -X POST https://textos-agent-dev.rgaudet2023.workers.dev/tasks/run \
  -H "Content-Type: application/json" \
  -d '{"taskSlug":"welcome-email"}'
```

Returns `{task: {...}, status: "found", taskSlug, taskId, note}` or
`{error: "not_found", message: "..."}` (HTTP 404).

## Adding a task

The task catalog is **data, not code** — adding a task is a database
write, no Worker deploy needed.

```sql
INSERT INTO public.tasks
  (slug, name, description_short, area, is_default, plan_required,
   visibility, price_cents, output_type, prompt_template)
VALUES
  ('my-new-task', 'My New Task',
   'One-line description.',
   'business_builder', false, 'premium_only', 'fully_locked', 1499, 'document',
   'Prompt template — what Claude does when this task runs.');
```

Once the row exists with `status='active'`, `POST /tasks/run` finds it
immediately. Real execution wires up in Sprint 5.

## Migrations

Migrations live in `supabase/migrations/`. Push to remote:

```bash
DB_URL='postgresql://postgres.<ref>:<password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
npx supabase db push --db-url "$DB_URL"
```

The session pooler `aws-1-us-east-1.pooler.supabase.com:5432` is what
works for free-tier projects from external machines — direct
`db.<ref>.supabase.co` is IPv6-only and most CLIs can't reach it.

## Secrets

**All credentials are Cloudflare Wrangler secrets. Never put keys in
env files committed to the repo.** Set or rotate via:

```bash
npx wrangler secret put ANTHROPIC_API_KEY        # paste at prompt
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

List with `npx wrangler secret list`. Local dev uses `.dev.vars`
(gitignored) with the same names.

## Deploy

```bash
npm run deploy      # wrangler deploy → textos-agent-dev
```

The Worker name is set in `wrangler.toml`. Production deploy lives in
the (commented) `[env.prod]` section there — uncomment + create a
`textos-agent-prod` Worker when we're ready to cut over.

## See also

- `CLAUDE.md` — operating context for AI coding assistants
- `../textos-web/PRD.md` — full product PRD (locked for Sprint 2)
- `../textos-web/CHANGES.md` — architectural deviation log
- `../textos-web/ROADMAP.md` — V2/V3 features deferred from V1

# TextOS Schema Notes
**Source-of-truth:** `/supabase/migrations/` + `/migrations/` in textos-agent.  
**Last updated:** After Sprint 5 Phase 1 (2026-05-01).  
**Purpose:** Prevent Claude from guessing column names when writing SQL or seeds.

---

## Critical Gotchas (Read First)

1. **`businesses.user_id`, NOT `owner_id`** — the single most common mistake.
2. **`task_runs` has NO `name`, `description`, or `tier` columns.** Those live on `tasks` (catalog). Join via `task_id` to get them.
3. **`agent_name` is on `business_context`, NOT `businesses`.**
4. **`business_context` primary key is `id` (UUID), NOT `business_id`.** The `business_id` column has a UNIQUE constraint.
5. **`business_context.mission` does NOT exist** — use `business_summary`.
6. **`business_context.target_audience` does NOT exist** — use `target_customer` (JSONB).
7. **Locked/paid tasks have NO `task_runs` rows** — the API layer synthesizes their locked state by comparing the tasks catalog against existing `task_runs`. Never insert rows for locked tasks.
8. **`task_runs.state` is required for new inserts** (no implicit default that matches intent — always set explicitly to `'proposed'`, `'complete'`, etc.).
9. **`task_runs.started_at` has `DEFAULT NOW()`** in the original schema, so it was NOT added by migration 006. Migration 006's `ADD COLUMN IF NOT EXISTS started_at` is always a no-op.
10. **`businesses.kind` is a required NOT NULL enum.** Valid values: `'new_idea'`, `'find_for_me'`, `'existing'` — nothing else.

---

## How to Verify Before Writing SQL

Always run this in Supabase SQL editor before inserting:
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'TABLE_NAME'
ORDER BY ordinal_position;
```

---

## `users`
**Migration:** `20260429120000_initial_schema.sql`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK, `uuid_generate_v4()` |
| `email` | text | NOT NULL | UNIQUE |
| `handle` | text | NULL | UNIQUE; set during onboarding |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |

**RLS:** User reads own row only (`id = auth.uid()`).  
**Worker write path:** `upsertUser()` in `src/services/supabase.ts` — upserts by `id`.  
**Note:** `handle` is NULL until onboarding completes. `has_handle` in auth callback checks `user?.handle`. If NULL → redirect to `/onboarding`.

---

## `businesses`
**Migration:** `20260429120000_initial_schema.sql`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK |
| `user_id` | uuid | NOT NULL | FK → `users.id` ON DELETE CASCADE |
| `slug` | text | NOT NULL | URL-safe identifier; UNIQUE with `user_id` |
| `name` | text | NOT NULL | Display name |
| `kind` | business_kind | NOT NULL | Enum: `new_idea`, `find_for_me`, `existing` |
| `existing_business_url` | text | NULL | Only for `kind='existing'` |
| `existing_business_data` | jsonb | NULL | Scraped data for `kind='existing'` |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |

**Unique constraint:** `(user_id, slug)` — same slug can belong to different users.  
**What is NOT here:** `agent_name`, `avatar`, `owner_id`, `updated_at`.  
**RLS:** Owner-only read + write (`user_id = auth.uid()`).

---

## `business_context`
**Migrations:** `20260430120000_business_context.sql` + `20260430170000_add_agent_name.sql`

The central research accumulator. One row per business. Every agent task reads from and writes to this table.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK (NOT the lookup key — use `business_id`) |
| `business_id` | uuid | NOT NULL | FK → `businesses.id`; UNIQUE (one row per business) |
| `user_id` | uuid | NOT NULL | FK → `users.id` |
| `agent_name` | text | NULL | **Added in Sprint 4.5** via `20260430170000_add_agent_name.sql` |
| `user_profile` | jsonb | NOT NULL | DEFAULT `{}` |
| `user_research_log` | jsonb | NOT NULL | DEFAULT `[]` |
| `business_summary` | text | NULL | ⚠️ NOT `mission` |
| `industry` | text | NULL | |
| `business_model` | text | NULL | |
| `target_customer` | jsonb | NOT NULL | DEFAULT `{}`; ⚠️ NOT `target_audience` |
| `value_proposition` | text | NULL | |
| `market_size` | jsonb | NOT NULL | DEFAULT `{}`; typically `{tam_usd, sam_usd, som_usd, ...}` |
| `competitors` | jsonb | NOT NULL | DEFAULT `[]`; array of objects |
| `market_trends` | jsonb | NOT NULL | DEFAULT `[]`; array of strings |
| `positioning_statement` | text | NULL | |
| `brand_voice` | text | NULL | |
| `key_differentiators` | jsonb | NOT NULL | DEFAULT `[]`; array of strings |
| `financial_snapshot` | jsonb | NOT NULL | DEFAULT `{}`; V2 via Plaid |
| `customer_signals` | jsonb | NOT NULL | DEFAULT `{}`; V2 |
| `open_questions` | jsonb | NOT NULL | DEFAULT `[]` |
| `telegram_chat_id` | text | NULL | V1 schema-ready; bot integration Sprint 8 |
| `last_research_run_at` | timestamptz | NULL | |
| `research_confidence_score` | integer | NOT NULL | DEFAULT 0; CHECK 0–100 |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `updated_at` | timestamptz | NOT NULL | DEFAULT NOW(); auto-updated via trigger |

**RLS:** Owner-only read + update (`user_id = auth.uid()`).  
**Upsert pattern:** `ON CONFLICT (business_id) DO UPDATE SET ...`

---

## `tasks` (catalog)
**Migration:** `20260429120000_initial_schema.sql`

Defines every task in the system. Rows are written by engineers (seeds/migrations), not users.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK |
| `slug` | text | NOT NULL | UNIQUE; used to look up tasks in seeds |
| `name` | text | NOT NULL | Display name |
| `description_short` | text | NULL | |
| `description_long` | text | NULL | |
| `area` | task_area | NOT NULL | Enum: `business_builder`, `daycycle`, `personal_website`, `public_business_website`, `business_manager` |
| `is_default` | boolean | NOT NULL | DEFAULT false; default tasks run for free users |
| `plan_required` | task_plan_required | NOT NULL | Enum: `free`, `core_paid`, `premium_only`, `premium_inactive` |
| `visibility` | task_visibility | NOT NULL | Enum: `hidden`, `teaser_locked`, `fully_locked`, `always_visible` |
| `price_cents` | integer | NOT NULL | DEFAULT 0; for à la carte tasks |
| `prompt_template` | text | NULL | |
| `output_type` | task_output_type | NOT NULL | Enum: `document`, `dashboard_view`, `report`, `structured_data`, `generated_site` |
| `inputs_required` | jsonb | NOT NULL | DEFAULT `{}` |
| `creator_id` | uuid | NULL | FK → `users.id`; NULL for system tasks |
| `status` | task_status | NOT NULL | Enum: `draft`, `active`, `deprecated` |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `updated_at` | timestamptz | NOT NULL | DEFAULT NOW() |

**RLS:** Any authenticated user can SELECT where `status = 'active'`.  
**Locked tasks pattern:** The API checks `task_runs` for a business, then overlays all `tasks` with `plan_required='core_paid'` that have no matching run — those are the "locked" tasks shown in the dashboard. No task_runs row is inserted for them.

---

## `task_runs`
**Migrations:** `20260429120000_initial_schema.sql` (base) + `006_add_task_states.sql` (Sprint 5 Phase 1)

Records every execution of a task against a business. One row per run.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK |
| `user_id` | uuid | NOT NULL | FK → `users.id` ON DELETE CASCADE |
| `business_id` | uuid | NULL | FK → `businesses.id` ON DELETE SET NULL |
| `task_id` | uuid | NOT NULL | FK → `tasks.id`; join here for name/description/tier |
| `status` | task_run_status | NOT NULL | Enum: `queued`, `running`, `completed`, `failed`; DEFAULT `queued` |
| `state` | task_state | NOT NULL | Enum: `proposed`, `running`, `complete`, `failed`; **⚠️ set explicitly on insert** |
| `proposed_at` | timestamptz | NULL | DEFAULT NOW(); added in 006 |
| `started_at` | timestamptz | NOT NULL | DEFAULT NOW() (in original schema) |
| `completed_at` | timestamptz | NULL | |
| `failed_at` | timestamptz | NULL | Added in 006 |
| `output_data` | jsonb | NULL | The artifact — task-specific structure |
| `work_log` | jsonb | NOT NULL | DEFAULT `[]`; added in 006; per-step agent log |
| `paid_amount_cents` | integer | NOT NULL | DEFAULT 0 |
| `error` | text | NULL | Error message if `status='failed'` |

**Columns that do NOT exist:** `name`, `description`, `tier`, `created_at`.  
**RLS:** Owner-only SELECT (`user_id = auth.uid()`). Worker (service role) writes.  
**Seed pattern:** Look up `task_id` from `tasks` catalog by `slug`:
```sql
SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'research-strategy' LIMIT 1;
INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
VALUES (v_user_id, v_biz_id, v_task_id, 'completed', 'complete', v_now, v_now, v_now, '[]'::jsonb, '{...}'::jsonb)
ON CONFLICT DO NOTHING;
```

---

## `admin_users`
**Migration:** `007_email_queue.sql` (Sprint 5 Phase 1)

Gates access to `/admin` routes on the Worker.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `user_id` | uuid | NOT NULL | PK; FK → `users.id` ON DELETE CASCADE |
| `added_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `notes` | text | NULL | |

**Seeded with:** `robertkgaudet@gmail.com` and `rgaudet2023@gmail.com`.

---

## `email_queue`
**Migration:** `007_email_queue.sql` (Sprint 5 Phase 1)

Cold email approval queue. Emails generated by agent tasks flow here; admin approves before SendGrid dispatch.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK |
| `business_id` | uuid | NOT NULL | FK → `businesses.id` |
| `user_id` | uuid | NOT NULL | FK → `users.id` |
| `task_run_id` | uuid | NULL | FK → `task_runs.id` ON DELETE SET NULL |
| `to_email` | text | NOT NULL | |
| `to_name` | text | NULL | |
| `to_company` | text | NULL | |
| `to_role` | text | NULL | |
| `from_email` | text | NOT NULL | DEFAULT `'yourbusiness@textos.ai'` |
| `subject` | text | NOT NULL | |
| `body` | text | NOT NULL | |
| `status` | text | NOT NULL | CHECK: `pending`, `approved`, `rejected`, `sent`, `failed`; DEFAULT `'pending'` |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `approved_at` | timestamptz | NULL | |
| `approved_by` | uuid | NULL | FK → `users.id` |
| `sent_at` | timestamptz | NULL | |
| `sendgrid_message_id` | text | NULL | |
| `rejection_reason` | text | NULL | |
| `edited` | boolean | NOT NULL | DEFAULT false |
| `edited_subject` | text | NULL | |
| `edited_body` | text | NULL | |

**Auto-approve logic:** `shouldAutoApprove()` in `src/lib/email-queue.ts` — counts active `user_subscriptions`. Returns false (queue for review) until count ≥ threshold (env var, default 100).

---

## `business_assets`
**Migration:** `008_business_assets.sql` (Sprint 5 Phase 1)

Tracks artifacts produced by agent tasks (images, documents, websites, tweets, etc.).

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | uuid | NOT NULL | PK |
| `business_id` | uuid | NOT NULL | FK → `businesses.id` |
| `task_run_id` | uuid | NULL | FK → `task_runs.id` ON DELETE SET NULL |
| `asset_type` | text | NOT NULL | CHECK: `document`, `image`, `website`, `email`, `tweet`, `lean_canvas`, `mission_dashboard`, `daycycle_locations` |
| `asset_subtype` | text | NULL | e.g. `'hero_image'`, `'cold_email_1'` |
| `asset_url` | text | NULL | For deployed/R2 assets |
| `asset_text` | text | NULL | For inline text (tweet, email body) |
| `asset_data` | jsonb | NULL | For structured assets (lean canvas, etc.) |
| `created_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `updated_at` | timestamptz | NOT NULL | DEFAULT NOW() |
| `metadata` | jsonb | NOT NULL | DEFAULT `{}`; generation cost, model, prompt, etc. |

**RLS:** Users see assets for businesses they own.

---

## `subscription_plans`
**Migration:** `20260429120000_initial_schema.sql`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `slug` | text | UNIQUE: `free`, `founders`, `standard`, `pro` |
| `name` | text | |
| `monthly_cents` | integer | |
| `one_time_cents` | integer | DEFAULT 0 |
| `business_quota` | integer | |
| `includes_premium_tasks` | boolean | |
| `is_grandfathered` | boolean | Founders tier only |
| `cohort_limit` | integer | NULL = unlimited |
| `is_active` | boolean | |
| `created_at` | timestamptz | |

---

## `user_subscriptions`
**Migration:** `20260429120000_initial_schema.sql`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | FK → `users.id` |
| `plan_id` | uuid | FK → `subscription_plans.id` |
| `started_at` | timestamptz | |
| `current_period_end` | timestamptz | NULL |
| `stripe_subscription_id` | text | UNIQUE |
| `status` | subscription_status | Enum: `active`, `past_due`, `canceled`, `trialing` |
| `created_at` | timestamptz | |

---

## `task_purchases`
**Migration:** `20260429120000_initial_schema.sql`

À la carte task purchases (Tier 1/2 users buying individual premium tasks).

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | FK → `users.id` |
| `task_id` | uuid | FK → `tasks.id` |
| `business_id` | uuid | NULL; FK → `businesses.id` |
| `amount_cents` | integer | |
| `stripe_payment_intent` | text | UNIQUE |
| `created_at` | timestamptz | |

---

## Enum Reference

```
business_kind:        new_idea | find_for_me | existing
subscription_status:  active | past_due | canceled | trialing
task_area:            business_builder | daycycle | personal_website
                      | public_business_website | business_manager
task_plan_required:   free | core_paid | premium_only | premium_inactive
task_visibility:      hidden | teaser_locked | fully_locked | always_visible
task_output_type:     document | dashboard_view | report
                      | structured_data | generated_site
task_status:          draft | active | deprecated
task_run_status:      queued | running | completed | failed
task_state:           proposed | running | complete | failed
```

---

## Worker Auth Pattern

The Cloudflare Worker uses `SUPABASE_SERVICE_ROLE_KEY` — it **bypasses RLS entirely**. All RLS policies exist for frontend (Astro/SPA) access using the anon key + user JWT.

JWT validation: ES256 (ECDSA P-256) verified via Supabase's JWKS endpoint using the `jose` library. **Do NOT use HS256 or `SUPABASE_JWT_SECRET`** for Worker auth code.

Auth middleware extracts `c.get("auth")` → `{ user_id: string, email: string }`.

---

## Key Table Relationships

```
users
  ├── businesses (user_id)
  │     ├── business_context (business_id, user_id)
  │     ├── task_runs (business_id, user_id)
  │     │     └── tasks (task_id)  ← catalog join
  │     ├── business_assets (business_id)
  │     └── email_queue (business_id, user_id)
  ├── user_subscriptions (user_id)
  │     └── subscription_plans (plan_id)
  ├── task_purchases (user_id)
  └── admin_users (user_id)
```

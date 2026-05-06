# Live Schema Snapshot

**Generated:** 2026-05-05 · After: Business Manager V1 ship

**Source:** Supabase production, public schema

This is a raw column dump for all tables in the public schema. Use this as a reference when writing SQL or reasoning about table relationships.

Compare against:
- `/migrations/` (source-of-truth migration files)
- `SCHEMA_NOTES.md` (curated gotchas + relationships)

Re-upload to Claude Project knowledge after each sprint phase that adds tables or columns.

---

## What changed since May 3

### New tables (7)

| Table | Added by |
|---|---|
| `anonymous_snapshots` | Sprint 4/5 (anonymous free-build flow) |
| `business_goals` | Manager V1 (per-business goal tracking) |
| `charge_windows` | Manager V1 (Charge mode sessions) |
| `free_build_runs` | Sprint 4/5 (orchestrator run state) |
| `lessons` | Manager V1 (Operator School curriculum, 12 rows seeded) |
| `milestones` | Manager V1 (business timeline) |
| `stream_events` | Sprint 4/5 (SSE event log per run) |

### New columns on existing tables

| Table | Column | Notes |
|---|---|---|
| `business_assets` | `is_current` | boolean NOT NULL default true |
| `businesses` | `phase` | text NOT NULL default 'founding' |
| `businesses` | `mode` | text NOT NULL default 'cruise' |
| `task_runs` | `is_current` | boolean NOT NULL default true |
| `task_runs` | `retry_count` | integer NOT NULL default 0 |
| `task_runs` | `max_retries` | integer NOT NULL default 3 |

### ⚠ Migrations NOT yet run

The Manager V1 brief called for `task_runs` user-action columns — these do **not** exist in the live schema:
- `requires_user_action` (boolean)
- `user_action_title` (text)
- `user_action_subtitle` (text)
- `user_action_why` (text)
- `user_action_cta` (text)

Run these before any feature that surfaces user-action prompts from task runs.

---

## Full schema dump

### admin_users

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| user_id | uuid | NO | null |
| added_at | timestamp with time zone | NO | now() |
| notes | text | YES | null |

### anonymous_snapshots ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| token | text | NO | null |
| created_at | timestamp with time zone | NO | now() |
| source | text | NO | null |
| kind | USER-DEFINED | NO | null |
| input | jsonb | NO | null |
| output | jsonb | YES | null |
| ip_address | inet | YES | null |
| user_agent | text | YES | null |
| generation_ms | integer | YES | null |
| status | text | NO | 'pending'::text |
| is_bot_suspected | boolean | NO | false |
| claimed_at | timestamp with time zone | YES | null |
| claimed_user_id | uuid | YES | null |
| claimed_business_id | uuid | YES | null |

### business_assets

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | null |
| task_run_id | uuid | YES | null |
| asset_type | text | NO | null |
| asset_subtype | text | YES | null |
| asset_url | text | YES | null |
| asset_text | text | YES | null |
| asset_data | jsonb | YES | null |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| metadata | jsonb | NO | '{}'::jsonb |
| is_current | boolean | NO | true |

### business_context

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | null |
| user_id | uuid | NO | null |
| user_profile | jsonb | NO | '{}'::jsonb |
| user_research_log | jsonb | NO | '[]'::jsonb |
| business_summary | text | YES | null |
| industry | text | YES | null |
| business_model | text | YES | null |
| target_customer | jsonb | NO | '{}'::jsonb |
| value_proposition | text | YES | null |
| market_size | jsonb | NO | '{}'::jsonb |
| competitors | jsonb | NO | '[]'::jsonb |
| market_trends | jsonb | NO | '[]'::jsonb |
| positioning_statement | text | YES | null |
| brand_voice | text | YES | null |
| key_differentiators | jsonb | NO | '[]'::jsonb |
| financial_snapshot | jsonb | NO | '{}'::jsonb |
| customer_signals | jsonb | NO | '{}'::jsonb |
| open_questions | jsonb | NO | '[]'::jsonb |
| telegram_chat_id | text | YES | null |
| last_research_run_at | timestamp with time zone | YES | null |
| research_confidence_score | integer | NO | 0 |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| agent_name | text | YES | null |

### business_goals ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | null |
| goal_text | text | NO | null |
| created_at | timestamp with time zone | NO | now() |

### businesses

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | null |
| slug | text | NO | null |
| name | text | NO | null |
| kind | USER-DEFINED | NO | null |
| existing_business_url | text | YES | null |
| existing_business_data | jsonb | YES | null |
| created_at | timestamp with time zone | NO | now() |
| phase | text | NO | 'founding'::text |
| mode | text | NO | 'cruise'::text |

### charge_windows ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | null |
| opened_at | timestamp with time zone | NO | now() |
| closes_at | timestamp with time zone | NO | null |
| closed_at | timestamp with time zone | YES | null |
| rule_text | text | NO | null |

### email_queue

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | null |
| user_id | uuid | NO | null |
| task_run_id | uuid | YES | null |
| to_email | text | NO | null |
| to_name | text | YES | null |
| to_company | text | YES | null |
| to_role | text | YES | null |
| from_email | text | NO | 'yourbusiness@textos.ai'::text |
| subject | text | NO | null |
| body | text | NO | null |
| status | text | NO | 'pending'::text |
| created_at | timestamp with time zone | NO | now() |
| approved_at | timestamp with time zone | YES | null |
| approved_by | uuid | YES | null |
| sent_at | timestamp with time zone | YES | null |
| sendgrid_message_id | text | YES | null |
| rejection_reason | text | YES | null |
| edited | boolean | NO | false |
| edited_subject | text | YES | null |
| edited_body | text | YES | null |

### free_build_runs ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | null |
| user_id | uuid | NO | null |
| status | text | NO | 'pending'::text |
| tasks_total | integer | NO | 0 |
| tasks_completed | integer | NO | 0 |
| started_at | timestamp with time zone | NO | now() |
| completed_at | timestamp with time zone | YES | null |
| failed_at | timestamp with time zone | YES | null |
| error | text | YES | null |
| created_at | timestamp with time zone | NO | now() |
| last_heartbeat_at | timestamp with time zone | NO | now() |

### lessons ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| phase | text | NO | null |
| lesson_num | integer | NO | null |
| title | text | NO | null |
| body | text | NO | null |

### milestones ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | null |
| label | text | NO | null |
| occurred_at | timestamp with time zone | NO | now() |

### stream_events ⭐ NEW

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| run_id | uuid | NO | null |
| business_id | uuid | NO | null |
| seq | integer | NO | null |
| event_type | text | NO | null |
| event_data | jsonb | NO | '{}'::jsonb |
| created_at | timestamp with time zone | NO | now() |

### subscription_plans

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| slug | text | NO | null |
| name | text | NO | null |
| monthly_cents | integer | NO | null |
| one_time_cents | integer | NO | 0 |
| business_quota | integer | NO | 1 |
| includes_premium_tasks | boolean | NO | false |
| is_grandfathered | boolean | NO | false |
| cohort_limit | integer | YES | null |
| is_active | boolean | NO | true |
| created_at | timestamp with time zone | NO | now() |

### task_purchases

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | null |
| task_id | uuid | NO | null |
| business_id | uuid | YES | null |
| amount_cents | integer | NO | null |
| stripe_payment_intent | text | YES | null |
| created_at | timestamp with time zone | NO | now() |

### task_runs

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | null |
| business_id | uuid | YES | null |
| task_id | uuid | NO | null |
| status | USER-DEFINED | NO | 'queued'::task_run_status |
| started_at | timestamp with time zone | NO | now() |
| completed_at | timestamp with time zone | YES | null |
| output_data | jsonb | YES | null |
| paid_amount_cents | integer | NO | 0 |
| error | text | YES | null |
| state | USER-DEFINED | NO | 'proposed'::task_state |
| proposed_at | timestamp with time zone | YES | now() |
| failed_at | timestamp with time zone | YES | null |
| work_log | jsonb | NO | '[]'::jsonb |
| is_current | boolean | NO | true |
| retry_count | integer | NO | 0 |
| max_retries | integer | NO | 3 |

### tasks

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| slug | text | NO | null |
| name | text | NO | null |
| description_short | text | YES | null |
| description_long | text | YES | null |
| area | USER-DEFINED | NO | null |
| is_default | boolean | NO | false |
| plan_required | USER-DEFINED | NO | 'free'::task_plan_required |
| visibility | USER-DEFINED | NO | 'always_visible'::task_visibility |
| price_cents | integer | NO | 0 |
| prompt_template | text | YES | null |
| output_type | USER-DEFINED | NO | 'document'::task_output_type |
| inputs_required | jsonb | NO | '{}'::jsonb |
| creator_id | uuid | YES | null |
| status | USER-DEFINED | NO | 'active'::task_status |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| execution_order | integer | YES | 99 |

### user_subscriptions

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | null |
| plan_id | uuid | NO | null |
| started_at | timestamp with time zone | NO | now() |
| current_period_end | timestamp with time zone | YES | null |
| stripe_subscription_id | text | YES | null |
| status | USER-DEFINED | NO | 'active'::subscription_status |
| created_at | timestamp with time zone | NO | now() |

### users

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| email | text | NO | null |
| handle | text | YES | null |
| created_at | timestamp with time zone | NO | now() |
| handle_confirmed_at | timestamp with time zone | YES | null |
| stripe_customer_id | text | YES | null |
| tier | text | NO | 'free'::text |
| tier_updated_at | timestamp with time zone | YES | null |

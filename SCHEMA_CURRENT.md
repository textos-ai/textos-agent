# TextOS — Current Schema
**Generated:** May 17, 2026  
**Source:** Supabase production, public schema  
**Tables:** 33  

This is the definitive current schema. It supersedes:
- `LATEST DB TEXTOS SCHEMA.txt`
- `textos_db_schema_51526.txt`  
- `docs/live-schema-snapshot.md`

Re-generate after any sprint that adds tables or columns.

---

## BaseRow Pattern (implicit, not yet enforced in TypeScript)

Most tables follow this convention. Not all have `updated_at`.

```typescript
// Proposed BaseRow — add to src/services/supabase.ts
export interface BaseRow {
  id: string;           // uuid
  created_at: string;   // timestamptz
}
export interface MutableRow extends BaseRow {
  updated_at: string;   // timestamptz — tables that track mutations
}
```

---

## Tables

### admin_actions
Audit log for admin operations on user accounts.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| admin_user_id | uuid | NO | — |
| target_user_id | uuid | NO | — |
| action_kind | text | NO | — |
| metadata | jsonb | YES | — |
| created_at | timestamptz | NO | now() |

### admin_users
Simple flag table — users in this table have admin access.

| column | type | nullable | default |
|---|---|---|---|
| user_id | uuid | NO | — |
| added_at | timestamptz | NO | now() |
| notes | text | YES | — |

### anonymous_snapshots
Pre-auth market research snapshots. Claimed at sign-up via KV token.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| token | text | NO | — |
| created_at | timestamptz | NO | now() |
| source | text | NO | — |
| kind | USER-DEFINED | NO | — |
| input | jsonb | NO | — |
| output | jsonb | YES | — |
| ip_address | inet | YES | — |
| user_agent | text | YES | — |
| generation_ms | integer | YES | — |
| status | text | NO | 'pending' |
| is_bot_suspected | boolean | NO | false |
| claimed_at | timestamptz | YES | — |
| claimed_user_id | uuid | YES | — |
| claimed_business_id | uuid | YES | — |

### app_errors
Application error log.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| level | text | NO | — |
| source | text | NO | — |
| message | text | NO | — |
| context | jsonb | YES | — |
| created_at | timestamptz | NO | now() |

### badge_earnings
Records when a user earns a badge.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| badge_id | uuid | NO | — |
| earned_at | timestamptz | NO | now() |

### badges
Operator School badge catalog.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| slug | text | NO | — |
| tier | text | NO | — |
| task_slug | text | YES | — |
| lesson_id | uuid | YES | — |
| name | text | NO | — |
| description | text | NO | — |
| icon_emoji | text | YES | — |
| created_at | timestamptz | NO | now() |
| display_order | integer | YES | — |

### business_assets
Generated artifacts from task runs (documents, images, websites).

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| task_run_id | uuid | YES | — |
| asset_type | text | NO | — |
| asset_subtype | text | YES | — |
| asset_url | text | YES | — |
| asset_text | text | YES | — |
| asset_data | jsonb | YES | — |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |
| metadata | jsonb | NO | '{}' |
| is_current | boolean | NO | true |
| is_editable | boolean | YES | — |

### business_context
AI research accumulator. Every task reads from and writes to this. Central knowledge store per business.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| user_profile | jsonb | NO | '{}' |
| user_research_log | jsonb | NO | '[]' |
| business_summary | text | YES | — |
| industry | text | YES | — |
| business_model | text | YES | — |
| target_customer | jsonb | NO | '{}' |
| value_proposition | text | YES | — |
| market_size | jsonb | NO | '{}' |
| competitors | jsonb | NO | '[]' |
| market_trends | jsonb | NO | '[]' |
| positioning_statement | text | YES | — |
| brand_voice | text | YES | — |
| key_differentiators | jsonb | NO | '[]' |
| financial_snapshot | jsonb | NO | '{}' |
| customer_signals | jsonb | NO | '{}' |
| open_questions | jsonb | NO | '[]' |
| telegram_chat_id | text | YES | — |
| last_research_run_at | timestamptz | YES | — |
| research_confidence_score | integer | NO | 0 |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |
| agent_name | text | YES | — |

### business_goals
Per-business goal tracking for Business Manager.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| goal_text | text | NO | — |
| created_at | timestamptz | NO | now() |

**⚠ Schema debt:** Missing phase, kind, label, target, current, due_at — fix in V1.5

### business_subscriptions
Per-business subscription records (Stripe-backed).

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| plan_slug | text | NO | 'standard_monthly' |
| status | text | NO | — |
| trial_started_at | timestamptz | YES | — |
| trial_ends_at | timestamptz | YES | — |
| current_period_start | timestamptz | YES | — |
| current_period_end | timestamptz | YES | — |
| cancel_at_period_end | boolean | NO | false |
| canceled_at | timestamptz | YES | — |
| stripe_customer_id | text | YES | — |
| stripe_subscription_id | text | YES | — |
| stripe_price_id | text | YES | — |
| payment_source | text | NO | 'card' |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |

### businesses
Core business record. Includes all website content fields and Stripe Connect fields.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| slug | text | NO | — |
| name | text | NO | — |
| kind | USER-DEFINED | NO | — |
| existing_business_url | text | YES | — |
| existing_business_data | jsonb | YES | — |
| created_at | timestamptz | NO | now() |
| phase | text | NO | 'founding' |
| mode | text | NO | 'cruise' |
| show_credentials_publicly | boolean | NO | false |
| hero_layout | text | YES | — |
| hero_font | text | YES | — |
| hero_image_url | text | YES | — |
| hero_image_credit | text | YES | — |
| accent_color | text | YES | — |
| eyebrow_vocab | text | YES | 'editorial' |
| seo_title | text | YES | — |
| seo_description | text | YES | — |
| seo_keywords | jsonb | NO | '[]' |
| calendly_url | text | YES | — |
| accent_color_override | text | YES | — |
| og_image_url | text | YES | — |
| og_image_hash | text | YES | — |
| og_image_generated_at | timestamptz | YES | — |
| stripe_connect_account_id | text | YES | — |
| stripe_connect_account_status | text | YES | — |
| stripe_connect_onboarded_at | timestamptz | YES | — |
| is_active | boolean | NO | true |
| hero_css_pattern | text | YES | — |
| hero_eyebrow | text | YES | — |
| hero_headline | text | YES | — |
| hero_headline_accent | text | YES | — |
| hero_subhead | text | YES | — |
| hero_cta_label | text | YES | — |
| hero_cta_type | text | YES | — |
| icp_headline | text | YES | — |
| icp_description | text | YES | — |
| icp_signals | jsonb | NO | '[]' |
| pain_points | jsonb | NO | '[]' |
| metrics | jsonb | NO | '[]' |
| palate_cleanser | jsonb | NO | '{}' |
| why_us | jsonb | NO | '[]' |
| nav_links | jsonb | NO | '[]' |
| what_we_do_eyebrow | text | YES | — |
| what_we_do_headline | text | YES | — |
| what_we_do_body | text | YES | — |
| founder_eyebrow | text | YES | — |
| founder_headline | text | YES | — |
| founder_body | text | YES | — |
| page_views | integer | NO | 0 |

### charge_windows
Business Manager Charge mode sessions.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| opened_at | timestamptz | NO | now() |
| closes_at | timestamptz | NO | — |
| closed_at | timestamptz | YES | — |
| rule_text | text | NO | — |

**⚠ Schema debt:** Should be `must_win_text` not `rule_text`. Missing opened_by, outcome.

### email_change_requests
Verified email address change flow.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| old_email | text | NO | — |
| new_email | text | NO | — |
| verification_token | text | NO | — |
| expires_at | timestamptz | NO | — |
| verified_at | timestamptz | YES | — |
| created_at | timestamptz | NO | now() |

### email_queue
Outbound email staging with admin approval workflow.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| task_run_id | uuid | YES | — |
| to_email | text | NO | — |
| to_name | text | YES | — |
| to_company | text | YES | — |
| to_role | text | YES | — |
| from_email | text | NO | 'yourbusiness@textos.ai' |
| subject | text | NO | — |
| body | text | NO | — |
| status | text | NO | 'pending' |
| created_at | timestamptz | NO | now() |
| approved_at | timestamptz | YES | — |
| approved_by | uuid | YES | — |
| sent_at | timestamptz | YES | — |
| sendgrid_message_id | text | YES | — |
| rejection_reason | text | YES | — |
| edited | boolean | NO | false |
| edited_subject | text | YES | — |
| edited_body | text | YES | — |

### external_apis
Registered API providers used by tasks.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| slug | text | NO | — |
| name | text | NO | — |
| provider | text | NO | — |
| endpoint_url | text | YES | — |
| auth_kind | text | NO | — |
| output_kind | text | YES | — |
| status | text | NO | 'active' |
| metadata | jsonb | NO | '{}' |
| created_at | timestamptz | NO | now() |

### free_build_runs
Orchestrator run state for the 10-task free build pipeline.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| status | text | NO | 'pending' |
| tasks_total | integer | NO | 0 |
| tasks_completed | integer | NO | 0 |
| started_at | timestamptz | NO | now() |
| completed_at | timestamptz | YES | — |
| failed_at | timestamptz | YES | — |
| error | text | YES | — |
| created_at | timestamptz | NO | now() |
| last_heartbeat_at | timestamptz | NO | now() |
| failure_reason | text | YES | — |

### lesson_completions
Operator School lesson progress per user.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| lesson_id | uuid | NO | — |
| completed_at | timestamptz | NO | now() |
| action_completed | boolean | NO | false |

### lessons
Operator School curriculum content (12 lessons seeded in V1).

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| phase | text | NO | — |
| lesson_num | integer | NO | — |
| title | text | NO | — |
| body | text | NO | — |
| task_slug | text | YES | — |
| sort_order | integer | NO | 0 |
| tier | text | NO | 'free' |
| action_prompt | text | YES | — |
| min_minutes | integer | NO | 5 |
| slug | text | YES | — |

### lifecycle_phases
Task categorization phases.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| slug | text | NO | — |
| name | text | NO | — |
| sort_order | integer | NO | — |

**Active phases:** idea, business-creation, product-creation, product-marketing, success-measurement  
**Reserved (no tasks yet):** product-fulfillment

### marketing_carousels
Per-user generated social carousel content.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| topic | text | YES | — |
| card_count | integer | NO | 8 |
| cards | jsonb | NO | — |
| created_at | timestamptz | YES | now() |
| saved_at | timestamptz | YES | — |
| is_locked | boolean | YES | false |

### milestones
Business timeline events.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| business_id | uuid | NO | — |
| label | text | NO | — |
| occurred_at | timestamptz | NO | now() |

**⚠ Schema debt:** Missing `kind` column.

### stream_events
SSE event log per orchestrator run.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| run_id | uuid | NO | — |
| business_id | uuid | NO | — |
| seq | integer | NO | — |
| event_type | text | NO | — |
| event_data | jsonb | NO | '{}' |
| created_at | timestamptz | NO | now() |

### stripe_events
Stripe webhook deduplication log.

| column | type | nullable | default |
|---|---|---|---|
| event_id | text | NO | — |
| event_type | text | NO | — |
| received_at | timestamptz | NO | now() |
| processed_at | timestamptz | YES | — |
| error | text | YES | — |

### subscription_plans
Plan catalog.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| slug | text | NO | — |
| name | text | NO | — |
| monthly_cents | integer | NO | — |
| one_time_cents | integer | NO | 0 |
| business_quota | integer | NO | 1 |
| includes_premium_tasks | boolean | NO | false |
| is_grandfathered | boolean | NO | false |
| cohort_limit | integer | YES | — |
| is_active | boolean | NO | true |
| created_at | timestamptz | NO | now() |

### task_apis
Task-to-API bindings (which AI/API each task calls).

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| task_id | uuid | NO | — |
| api_id | uuid | NO | — |
| role | text | NO | 'primary' |
| invocation_params | jsonb | NO | '{}' |
| created_at | timestamptz | NO | now() |

### task_edits
Audit log for admin task catalog changes.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| task_id | uuid | NO | — |
| edited_by | uuid | NO | — |
| field_name | text | NO | — |
| old_value | text | YES | — |
| new_value | text | YES | — |
| edited_at | timestamptz | NO | now() |

### task_purchases
À la carte task purchases (non-subscription).

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| task_id | uuid | NO | — |
| business_id | uuid | YES | — |
| amount_cents | integer | NO | — |
| stripe_payment_intent | text | YES | — |
| created_at | timestamptz | NO | now() |

### task_runs
Task execution records. Central to the entire task pipeline.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| business_id | uuid | YES | — |
| task_id | uuid | NO | — |
| status | USER-DEFINED (task_run_status) | NO | 'queued' |
| started_at | timestamptz | NO | now() |
| completed_at | timestamptz | YES | — |
| output_data | jsonb | YES | — |
| paid_amount_cents | integer | NO | 0 |
| error | text | YES | — |
| state | USER-DEFINED (task_state) | NO | 'proposed' |
| proposed_at | timestamptz | YES | now() |
| failed_at | timestamptz | YES | — |
| work_log | jsonb | NO | '[]' |
| is_current | boolean | NO | true |
| retry_count | integer | NO | 0 |
| max_retries | integer | NO | 3 |

**⚠ Schema debt:** Missing user_action_* columns (requires_user_action, user_action_title, user_action_subtitle, user_action_why, user_action_cta)

### tasks
Task catalog. Single source of truth. 33 tasks as of V1.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| slug | text | NO | — |
| name | text | NO | — |
| description_short | text | YES | — |
| description_long | text | YES | — |
| area | USER-DEFINED | NO | — |
| is_default | boolean | NO | false |
| plan_required | USER-DEFINED | NO | 'free' |
| visibility | USER-DEFINED | NO | 'always_visible' |
| price_cents | integer | NO | 0 |
| prompt_template | text | YES | — |
| output_type | USER-DEFINED | NO | 'document' |
| inputs_required | jsonb | NO | '{}' |
| creator_id | uuid | YES | — |
| status | USER-DEFINED | NO | 'active' |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |
| execution_order | integer | YES | 99 |
| surface | text | NO | 'builder' |
| token_cost | integer | NO | 0 |
| lifecycle_phase_id | uuid | YES | — |
| is_regeneratable | boolean | NO | true |
| asset_user_editable | boolean | NO | false |
| kind | USER-DEFINED (task_kind) | NO | 'autonomous' |
| config_page_path | text | YES | — |
| is_featured | boolean | NO | false |
| text_controllable | boolean | NO | false |
| is_long_running | boolean | NO | false |

**task_kind values:** autonomous, configured, guide, system  
**is_default=true tasks (10 free build):** research-strategy, welcome-email, mission-document, tam-sam-som, daycycle-connect, personalized-pitch-email, launch-tweet, personal-landing-page, task-queue-built, dashboard-briefing

### token_balances
Current token state per business per period.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| period_tokens_included | integer | NO | 30 |
| period_tokens_used | integer | NO | 0 |
| period_started_at | timestamptz | NO | now() |
| period_ends_at | timestamptz | YES | — |
| topup_tokens_remaining | integer | NO | 0 |
| lifetime_tokens_used | integer | NO | 0 |
| lifetime_topups_purchased | integer | NO | 0 |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |

### token_purchases
Token top-up purchase records.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| bundle_slug | text | NO | — |
| tokens_purchased | integer | NO | — |
| amount_cents | integer | NO | — |
| stripe_payment_intent_id | text | YES | — |
| stripe_checkout_session_id | text | YES | — |
| status | text | NO | — |
| created_at | timestamptz | NO | now() |
| succeeded_at | timestamptz | YES | — |
| refunded_at | timestamptz | YES | — |

### token_transactions
Token debit/credit ledger.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| business_id | uuid | NO | — |
| user_id | uuid | NO | — |
| kind | text | NO | — |
| tokens | integer | NO | — |
| task_slug | text | YES | — |
| task_run_id | uuid | YES | — |
| topup_id | uuid | YES | — |
| description | text | YES | — |
| metadata | jsonb | NO | '{}' |
| created_at | timestamptz | NO | now() |

### user_subscriptions
Legacy user-level subscription records.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| user_id | uuid | NO | — |
| plan_id | uuid | NO | — |
| started_at | timestamptz | NO | now() |
| current_period_end | timestamptz | YES | — |
| stripe_subscription_id | text | YES | — |
| status | USER-DEFINED (subscription_status) | NO | 'active' |
| created_at | timestamptz | NO | now() |

### users
Platform accounts.

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() |
| email | text | NO | — |
| handle | text | YES | — |
| created_at | timestamptz | NO | now() |
| handle_confirmed_at | timestamptz | YES | — |
| stripe_customer_id | text | YES | — |
| tier | text | NO | 'free' |
| tier_updated_at | timestamptz | YES | — |
| is_admin | boolean | NO | false |
| name | text | YES | — |
| stripe_customer_id_test | text | YES | — |

---

## Net New Tables — Autonomous Engine (not yet created)

### business_products *(Phase 1)*
Digital product assets, file location, pricing, versioning. Field locking system (content/source/locked).

### ad_campaigns *(Phase 2)*
Campaign configuration per platform (Meta, Google, TikTok). Status, daily budget, ROAS.

### ad_creatives *(Phase 2)*
Creative assets per platform format. Performance data, winning_patterns tag.

### ad_wallets *(Phase 2)*
Activator balance, disbursement history, management fee ledger.

### performance_snapshots *(Phase 3)*
Daily metrics per business: revenue, ROAS, CVR, ad spend, refund_rate.

---

## Enum Types

| enum | values |
|---|---|
| task_run_status | queued, running, completed, failed, cancelled |
| task_state | proposed, running, complete, locked, failed |
| task_kind | autonomous, configured, guide, system |
| subscription_status | active, canceled, past_due, trialing |

---

## Key Relationships

```
users (1) → (many) businesses
businesses (1) → (1) business_context
businesses (1) → (many) task_runs
businesses (1) → (many) business_assets
businesses (1) → (1) token_balances
businesses (1) → (many) token_transactions
businesses (1) → (1) business_subscriptions
task_runs (many) → (1) tasks
tasks (1) → (many) task_apis
task_apis (many) → (1) external_apis
users (many) → (many) badges  [via badge_earnings]
users (many) → (many) lessons [via lesson_completions]
```
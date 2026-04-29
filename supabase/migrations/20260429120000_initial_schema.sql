-- TextOS Agent — Sprint 2 initial schema
--
-- Tables: users, businesses, subscription_plans, user_subscriptions,
-- tasks, task_runs, task_purchases.
--
-- Notes:
--   * Supabase Auth manages auth.users; we mirror minimal app-side fields
--     in public.users so other tables can foreign-key to it. The
--     auth.users → public.users upsert trigger is added in Sprint 3.
--   * The Cloudflare Worker uses the service role key and bypasses RLS
--     by design. Frontend reads (Astro/SPA with anon key + JWT) hit RLS
--     as the 'authenticated' role.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- =====================================================================
-- Enums
-- =====================================================================
create type business_kind as enum ('new_idea', 'find_for_me', 'existing');

create type subscription_status as enum ('active', 'past_due', 'canceled', 'trialing');

create type task_area as enum (
    'business_builder',
    'daycycle',
    'personal_website',
    'public_business_website',
    'business_manager'
);

create type task_plan_required as enum (
    'free',
    'core_paid',
    'premium_only',
    'premium_inactive'
);

create type task_visibility as enum (
    'hidden',
    'teaser_locked',
    'fully_locked',
    'always_visible'
);

create type task_output_type as enum (
    'document',
    'dashboard_view',
    'report',
    'structured_data',
    'generated_site'
);

create type task_status as enum ('draft', 'active', 'deprecated');

create type task_run_status as enum ('queued', 'running', 'completed', 'failed');

-- =====================================================================
-- users
-- =====================================================================
create table public.users (
    id          uuid primary key default uuid_generate_v4(),
    email       text unique not null,
    handle      text unique,
    created_at  timestamptz not null default now()
);
create index users_handle_idx on public.users (handle);

-- =====================================================================
-- businesses
-- =====================================================================
create table public.businesses (
    id                      uuid primary key default uuid_generate_v4(),
    user_id                 uuid not null references public.users(id) on delete cascade,
    slug                    text not null,
    name                    text not null,
    kind                    business_kind not null,
    existing_business_url   text,
    existing_business_data  jsonb,
    created_at              timestamptz not null default now(),
    unique (user_id, slug)
);
create index businesses_user_id_idx on public.businesses (user_id);
create index businesses_slug_idx    on public.businesses (slug);

-- =====================================================================
-- subscription_plans
-- =====================================================================
create table public.subscription_plans (
    id                      uuid primary key default uuid_generate_v4(),
    slug                    text unique not null,
    name                    text not null,
    monthly_cents           integer not null,
    one_time_cents          integer not null default 0,
    business_quota          integer not null default 1,
    includes_premium_tasks  boolean not null default false,
    is_grandfathered        boolean not null default false,
    cohort_limit            integer,
    is_active               boolean not null default true,
    created_at              timestamptz not null default now()
);

-- =====================================================================
-- user_subscriptions
-- =====================================================================
create table public.user_subscriptions (
    id                      uuid primary key default uuid_generate_v4(),
    user_id                 uuid not null references public.users(id) on delete cascade,
    plan_id                 uuid not null references public.subscription_plans(id),
    started_at              timestamptz not null default now(),
    current_period_end      timestamptz,
    stripe_subscription_id  text unique,
    status                  subscription_status not null default 'active',
    created_at              timestamptz not null default now()
);
create index user_subs_user_id_idx on public.user_subscriptions (user_id);
create index user_subs_plan_id_idx on public.user_subscriptions (plan_id);
create index user_subs_stripe_idx  on public.user_subscriptions (stripe_subscription_id);

-- =====================================================================
-- tasks  (the catalog — see CLAUDE.md "Tasks-as-data architecture")
-- =====================================================================
create table public.tasks (
    id                  uuid primary key default uuid_generate_v4(),
    slug                text unique not null,
    name                text not null,
    description_short   text,
    description_long    text,
    area                task_area not null,
    is_default          boolean not null default false,
    plan_required       task_plan_required not null default 'free',
    visibility          task_visibility not null default 'always_visible',
    price_cents         integer not null default 0,
    prompt_template     text,
    output_type         task_output_type not null default 'document',
    inputs_required     jsonb not null default '{}'::jsonb,
    creator_id          uuid references public.users(id) on delete set null,
    status              task_status not null default 'active',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index tasks_slug_idx on public.tasks (slug);
create index tasks_area_idx on public.tasks (area);
create index tasks_plan_idx on public.tasks (plan_required);

-- =====================================================================
-- task_runs
-- =====================================================================
create table public.task_runs (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null references public.users(id) on delete cascade,
    business_id         uuid references public.businesses(id) on delete set null,
    task_id             uuid not null references public.tasks(id) on delete restrict,
    status              task_run_status not null default 'queued',
    started_at          timestamptz not null default now(),
    completed_at        timestamptz,
    output_data         jsonb,
    paid_amount_cents   integer not null default 0,
    error               text
);
create index task_runs_user_id_idx     on public.task_runs (user_id);
create index task_runs_business_id_idx on public.task_runs (business_id);
create index task_runs_task_id_idx     on public.task_runs (task_id);
create index task_runs_status_idx      on public.task_runs (status);

-- =====================================================================
-- task_purchases
-- =====================================================================
create table public.task_purchases (
    id                      uuid primary key default uuid_generate_v4(),
    user_id                 uuid not null references public.users(id) on delete cascade,
    task_id                 uuid not null references public.tasks(id) on delete restrict,
    business_id             uuid references public.businesses(id) on delete set null,
    amount_cents            integer not null,
    stripe_payment_intent   text unique,
    created_at              timestamptz not null default now()
);
create index task_purchases_user_idx on public.task_purchases (user_id);
create index task_purchases_task_idx on public.task_purchases (task_id);

-- =====================================================================
-- Row-Level Security
-- =====================================================================
alter table public.users              enable row level security;
alter table public.businesses         enable row level security;
alter table public.user_subscriptions enable row level security;
alter table public.task_runs          enable row level security;
alter table public.task_purchases     enable row level security;
alter table public.tasks              enable row level security;
alter table public.subscription_plans enable row level security;

-- users: a user reads their own row only.
create policy users_select_own on public.users
    for select to authenticated
    using (id = auth.uid());

-- businesses: owner-only read + write.
create policy businesses_select_own on public.businesses
    for select to authenticated
    using (user_id = auth.uid());
create policy businesses_modify_own on public.businesses
    for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- user_subscriptions: owner-only read; Worker (service role) writes.
create policy user_subs_select_own on public.user_subscriptions
    for select to authenticated
    using (user_id = auth.uid());

-- task_runs: owner-only read; Worker writes.
create policy task_runs_select_own on public.task_runs
    for select to authenticated
    using (user_id = auth.uid());

-- task_purchases: owner-only read; Worker writes.
create policy task_purchases_select_own on public.task_purchases
    for select to authenticated
    using (user_id = auth.uid());

-- tasks (catalog): any authenticated user reads active rows.
create policy tasks_select_active on public.tasks
    for select to authenticated
    using (status = 'active');

-- subscription_plans: any authenticated user reads active rows.
create policy plans_select_active on public.subscription_plans
    for select to authenticated
    using (is_active = true);

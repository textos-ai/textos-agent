-- TextOS Agent — Sprint 3.5: business_context table
--
-- The central knowledge accumulator for TextOS's research-first posture.
-- Every research action writes here; every downstream task reads from here.
-- This is what makes TextOS produce compounding intelligence rather than
-- isolated artifacts.
--
-- Notes:
--   * The Worker uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS
--     by design. The policies below govern frontend (anon + JWT) access.
--   * financial_snapshot and customer_signals are V2-populated via Plaid
--     or user upload. Columns exist now so no future migration is needed.
--   * telegram_chat_id is V1 schema-ready; bot integration ships Sprint 8.

-- =====================================================================
-- business_context
-- =====================================================================
create table public.business_context (
    id           uuid primary key default uuid_generate_v4(),
    business_id  uuid not null references public.businesses(id) on delete cascade,
    user_id      uuid not null references public.users(id) on delete cascade,

    -- User research findings (populated during entry path 3+4 and from
    -- email/LinkedIn/name parsing on paths 1+2)
    user_profile       jsonb not null default '{}',
    user_research_log  jsonb not null default '[]',

    -- Business research findings (populated continuously by agent tasks)
    business_summary   text,
    industry           text,
    business_model     text,
    target_customer    jsonb not null default '{}',
    value_proposition  text,

    -- Market intelligence
    market_size     jsonb not null default '{}',
    competitors     jsonb not null default '[]',
    market_trends   jsonb not null default '[]',

    -- Strategic positioning
    positioning_statement  text,
    brand_voice            text,
    key_differentiators    jsonb not null default '[]',

    -- Operational signals (V2 populated via Plaid / user upload)
    financial_snapshot  jsonb not null default '{}',
    customer_signals    jsonb not null default '{}',

    -- Open questions the agent flagged for follow-up
    open_questions      jsonb not null default '[]',

    -- Telegram pairing (V1 schema-ready; bot integration Sprint 8)
    telegram_chat_id    text,

    -- Provenance
    last_research_run_at       timestamptz,
    research_confidence_score  integer not null default 0
                               check (research_confidence_score between 0 and 100),

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (business_id)   -- one context record per business
);

create index idx_business_context_user_id     on public.business_context (user_id);
create index idx_business_context_business_id on public.business_context (business_id);

-- updated_at trigger
create or replace function public.update_business_context_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger business_context_updated_at
    before update on public.business_context
    for each row
    execute function public.update_business_context_updated_at();

-- =====================================================================
-- Row-Level Security
-- (Service role bypasses RLS automatically — no policy needed for Worker)
-- =====================================================================
alter table public.business_context enable row level security;

-- Authenticated users read their own business contexts
create policy business_context_select_own on public.business_context
    for select to authenticated
    using (user_id = auth.uid());

-- Authenticated users can update their own business contexts
create policy business_context_update_own on public.business_context
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

comment on table public.business_context is
    'Per-business knowledge accumulator. Every research action writes here; every task reads from here. The substrate of TextOS''s research-first posture.';

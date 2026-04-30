-- TextOS Agent — Sprint 4.5/A: Per-business agent name
--
-- Adds agent_name to business_context so each business has its own
-- named agent. Default is assigned at creation time by the Worker
-- from AGENT_NAME_POOL. Users can rename in V2.
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

ALTER TABLE public.business_context ADD COLUMN IF NOT EXISTS agent_name TEXT;

COMMENT ON COLUMN public.business_context.agent_name IS
  'Per-business agent name. Randomly selected from AGENT_NAME_POOL at creation time. Users can rename in V2.';

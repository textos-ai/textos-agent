-- =====================================================================
-- Migration 115: coldcall module — internal-only cold-calling tool
-- =====================================================================
-- Source: "CONSOLIDATED GO-AHEAD: coldcall module" brief, 2026-08-14.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / trigger guard.
--
-- Three tables, all prefixed coldcall_ so the whole module greps as one unit.
-- INTERNAL ONLY. These tables hold third-party prospect PII (names, phone
-- numbers, addresses) and are NOT part of any client-facing query path.
--
-- NAMING NOTE: `leads` and `connection_leads` are both already taken —
-- `leads` is the voice-receptionist call-capture feature, `connection_leads`
-- is the external-retrieval lead finder (see 079_leads.sql). This module's
-- table is coldcall_leads and is unrelated to both.
--
-- ACCESS MODEL: RLS is enabled on all three tables with NO permissive policy
-- for anon or authenticated. Deny-by-default. Every read and write flows
-- through the Worker's service-role key, gated by requireColdcaller
-- (src/lib/coldcall-auth.ts). The frontend NEVER talks to Supabase directly
-- for this module.
-- =====================================================================

-- =====================================================================
-- coldcall_callers — the access list. Membership IS the role; there is no
-- separate roles table or enum. A row here (active=true) grants access to
-- /api/coldcall/*; the absence of a row is a 403.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.coldcall_callers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The provisioning key. Access is granted by email BEFORE the person has
  -- ever touched Victora, so this — not user_id — is what the auth gate
  -- matches on. Stored lowercased; the CHECK makes that a DB-level invariant
  -- so a manually-inserted mixed-case row fails loudly instead of silently
  -- never matching the gate's lower(email) lookup.
  email       TEXT        NOT NULL UNIQUE CHECK (email = lower(email)),
  name        TEXT,       -- admin-entered, nullable
  -- NULLABLE ON PURPOSE. Backfilled automatically on the caller's first
  -- authenticated request (requireColdcaller self-heals). It is an
  -- informational "has signed in yet" marker, NEVER a gate — access is
  -- granted by email alone.
  user_id     UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One caller row per Victora user. Partial so the many not-yet-signed-in
-- rows (user_id NULL) don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_callers_user_id_uniq
  ON public.coldcall_callers (user_id) WHERE user_id IS NOT NULL;

-- =====================================================================
-- coldcall_leads — the prospect list.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.coldcall_leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dedupe key. Nullable: a known gap in the source data. See the partial
  -- unique index below — rows WITHOUT a place_id are not deduped at all.
  place_id          TEXT,
  name              TEXT        NOT NULL,
  phone             TEXT,
  address           TEXT,
  address_flag      TEXT,
  category          TEXT,
  category_raw      TEXT,
  parish            TEXT,       -- FILTER ONLY, never a sort key
  market            TEXT,       -- FILTER ONLY, never a sort key
  -- NULLABLE ON PURPOSE. NULL means "no reviews yet" — a real, distinct
  -- state that is NOT the same as a rating of 0. Never coerce this to 0.
  rating            NUMERIC,
  review_count      INTEGER,
  call_score        NUMERIC     NOT NULL,  -- PRIMARY SORT for the worklist
  adoption_mindset  NUMERIC,
  digital_gap       NUMERIC,
  callable          BOOLEAN     NOT NULL DEFAULT true,
  opening_angle     TEXT,
  assigned_to       UUID        REFERENCES public.coldcall_callers(id) ON DELETE SET NULL,
  -- Where the lead sits NOW. Distinct from call_activity.outcome, which
  -- records what happened on one specific attempt.
  status            TEXT        NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','callback','meeting',
                                        'not_interested','bad_number')),
  followup_at       TIMESTAMPTZ,
  last_touched_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe on place_id where present. Partial: rows with a NULL place_id can
-- multiply freely, so the CSV import must REPORT the null-place_id count
-- rather than assume it is small.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_leads_place_id_uniq
  ON public.coldcall_leads (place_id) WHERE place_id IS NOT NULL;

-- The worklist query: a caller's own un-worked leads, best score first.
CREATE INDEX IF NOT EXISTS coldcall_leads_worklist
  ON public.coldcall_leads (assigned_to, status, call_score DESC)
  WHERE callable = true;

-- The followups-due query.
CREATE INDEX IF NOT EXISTS coldcall_leads_followups
  ON public.coldcall_leads (assigned_to, followup_at)
  WHERE followup_at IS NOT NULL;

-- The admin assign-split query: unassigned callable leads.
CREATE INDEX IF NOT EXISTS coldcall_leads_unassigned
  ON public.coldcall_leads (call_score DESC)
  WHERE assigned_to IS NULL AND callable = true;

-- =====================================================================
-- coldcall_call_activity — append-only history, one row per attempt.
-- Never updated, never overwritten. ON DELETE RESTRICT on caller_id so the
-- audit trail cannot be erased by removing a caller.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.coldcall_call_activity (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID        NOT NULL REFERENCES public.coldcall_leads(id)   ON DELETE CASCADE,
  caller_id   UUID        NOT NULL REFERENCES public.coldcall_callers(id) ON DELETE RESTRICT,
  -- Deliberately a DIFFERENT vocabulary from coldcall_leads.status. status is
  -- where the lead sits now; outcome is what happened on one specific attempt.
  -- A caller can log 'no_answer' five times without status ever leaving 'new'.
  outcome     TEXT        NOT NULL
                CHECK (outcome IN ('no_answer','voicemail_left','gatekeeper',
                                   'not_interested','interested_followup',
                                   'meeting_booked','wrong_number','do_not_call')),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lead-detail history, newest first.
CREATE INDEX IF NOT EXISTS coldcall_call_activity_lead
  ON public.coldcall_call_activity (lead_id, created_at DESC);

-- =====================================================================
-- updated_at triggers — repo convention (public.set_updated_at, see
-- 061_business_integrations.sql / 065_platforms.sql).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_callers_updated_at
    BEFORE UPDATE ON public.coldcall_callers
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_leads_updated_at
    BEFORE UPDATE ON public.coldcall_leads
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- coldcall_call_activity is append-only and has no updated_at by design.

-- =====================================================================
-- RLS — deny-by-default. Enabled with NO policies at all, so anon and
-- authenticated can read nothing and write nothing. The Worker's
-- service-role key bypasses RLS by design and is the ONLY access path.
-- The REVOKEs are belt-and-braces on top of Supabase's default public-schema
-- grants; RLS alone already denies every row.
-- =====================================================================
ALTER TABLE public.coldcall_callers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coldcall_leads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coldcall_call_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.coldcall_callers       FROM anon, authenticated;
REVOKE ALL ON public.coldcall_leads         FROM anon, authenticated;
REVOKE ALL ON public.coldcall_call_activity FROM anon, authenticated;

-- No caller rows are seeded here. Callers are granted access through
-- /admin/coldcall-callers (POST /api/admin/coldcall-callers).

-- == Verify (paste after applying) =============================================
-- Tables + columns:
--   SELECT table_name, column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name LIKE 'coldcall_%'
--    ORDER BY table_name, ordinal_position;
--
-- RLS on, and ZERO policies (deny-by-default):
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename LIKE 'coldcall_%';
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname='public' AND tablename LIKE 'coldcall_%';   -- expect 0 rows
--
-- Indexes:
--   SELECT tablename, indexname, indexdef FROM pg_indexes
--    WHERE schemaname='public' AND tablename LIKE 'coldcall_%' ORDER BY tablename;
--
-- CHECK constraints (status, outcome, lowercased email):
--   SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname LIKE 'coldcall_%' AND con.contype = 'c';
--
-- FK delete behavior (expect: SET NULL, SET NULL, CASCADE, RESTRICT):
--   SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname LIKE 'coldcall_%' AND con.contype = 'f';
--
-- Triggers:
--   SELECT event_object_table, trigger_name, action_timing, event_manipulation
--     FROM information_schema.triggers
--    WHERE event_object_table LIKE 'coldcall_%';
--
-- Row counts (expect 0,0,0 on a fresh apply):
--   SELECT (SELECT count(*) FROM public.coldcall_callers)       AS callers,
--          (SELECT count(*) FROM public.coldcall_leads)         AS leads,
--          (SELECT count(*) FROM public.coldcall_call_activity) AS activity;

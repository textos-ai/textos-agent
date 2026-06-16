-- =====================================================================
-- Migration 044: Plan / Playbook data model
-- =====================================================================
-- Source: VICTORA Phase 1 brief — Plan/Playbook schema (2026-06-10)
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / guarded DO blocks / DROP POLICY IF
--   EXISTS. The legacy-retirement block (TRUNCATE + repoint + DROP
--   free_build_runs) is guarded on free_build_runs still existing, so a
--   second run is a no-op for it (and will NOT re-truncate live logs).
--
-- Creates six new tables (plan, plan_phase, phase_milestone, playbook,
-- playbook_runs, playbook_task), adds task_runs.run_id, repoints
-- stream_events.run_id off free_build_runs onto playbook_runs, and
-- retires free_build_runs.
--
-- DESTRUCTIVE (explicitly approved in the Phase 1 recon by Rob):
--   * TRUNCATE public.stream_events  (4079 orchestrator rows — zero real users)
--   * TRUNCATE public.free_build_runs (93 rows — zero real users)
--   * DROP TABLE public.free_build_runs (after repointing every reference)
-- New-table standard: gen_random_uuid() PKs, timestamptz, CHECK on status,
-- intentional ON DELETE, RLS + owner SELECT policy on every table.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. plan — one phased plan per business (one ACTIVE at a time)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plan (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  horizon_days  int         NOT NULL,
  start_date    date        NULL,
  status        text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','active','archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One active plan per business.
CREATE UNIQUE INDEX IF NOT EXISTS plan_business_active_idx
  ON public.plan (business_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS plan_business_id_idx
  ON public.plan (business_id);

-- ─────────────────────────────────────────────────────────────────────
-- 2. plan_phase — ordered phases within a plan
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plan_phase (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid        NOT NULL REFERENCES public.plan(id) ON DELETE CASCADE,
  lifecycle_phase_id  uuid        NULL REFERENCES public.lifecycle_phases(id) ON DELETE SET NULL,
  name                text        NOT NULL,
  sort_order          int         NOT NULL,
  start_day_offset    int         NULL,
  end_day_offset      int         NULL,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','active','complete')),
  CONSTRAINT plan_phase_plan_sort_uq UNIQUE (plan_id, sort_order)
);

CREATE INDEX IF NOT EXISTS plan_phase_plan_id_idx
  ON public.plan_phase (plan_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. phase_milestone — ordered milestones within a phase
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.phase_milestone (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_phase_id  uuid        NOT NULL REFERENCES public.plan_phase(id) ON DELETE CASCADE,
  name           text        NOT NULL,
  sort_order     int         NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','complete')),
  completed_at   timestamptz NULL,
  CONSTRAINT phase_milestone_phase_sort_uq UNIQUE (plan_phase_id, sort_order)
);

CREATE INDEX IF NOT EXISTS phase_milestone_plan_phase_id_idx
  ON public.phase_milestone (plan_phase_id);

-- ─────────────────────────────────────────────────────────────────────
-- 4. playbook — a unit of work, optionally tied to a plan/phase
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.playbook (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  plan_id       uuid        NULL REFERENCES public.plan(id) ON DELETE SET NULL,
  plan_phase_id uuid        NULL REFERENCES public.plan_phase(id) ON DELETE SET NULL,
  name          text        NOT NULL,
  description   text        NULL,
  assigned_to   uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','complete','archived')),
  start_date    date        NULL,
  due_date      date        NULL,
  sort_order    int         NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playbook_business_id_idx
  ON public.playbook (business_id);
CREATE INDEX IF NOT EXISTS playbook_plan_id_idx
  ON public.playbook (plan_id);

-- ─────────────────────────────────────────────────────────────────────
-- 5. playbook_runs — thin execution header (generalizes free_build_runs)
--    NO task counters — completed-count is derived from task_runs.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.playbook_runs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_id        uuid        NOT NULL REFERENCES public.playbook(id) ON DELETE CASCADE,
  business_id        uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','running','completed','failed')),
  last_heartbeat_at  timestamptz NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz NULL,
  failed_at          timestamptz NULL,
  failure_reason     text        NULL
);

-- Only one active run per business at a time (mirrors free_build_runs lock).
CREATE UNIQUE INDEX IF NOT EXISTS playbook_runs_business_active_idx
  ON public.playbook_runs (business_id) WHERE status IN ('pending','running');
-- Fast watchdog query: running builds with a stale heartbeat.
CREATE INDEX IF NOT EXISTS playbook_runs_running_heartbeat_idx
  ON public.playbook_runs (status, last_heartbeat_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS playbook_runs_business_id_idx
  ON public.playbook_runs (business_id);
CREATE INDEX IF NOT EXISTS playbook_runs_playbook_id_idx
  ON public.playbook_runs (playbook_id);

-- ─────────────────────────────────────────────────────────────────────
-- 6. playbook_task — a task placed in a playbook (join + manual state)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.playbook_task (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_id     uuid        NOT NULL REFERENCES public.playbook(id) ON DELETE CASCADE,
  task_id         uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  task_run_id     uuid        NULL REFERENCES public.task_runs(id) ON DELETE SET NULL,
  sort_order      int         NOT NULL,
  is_manual       boolean     NOT NULL DEFAULT false,
  manual_done_at  timestamptz NULL,
  manual_done_by  uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_task_playbook_task_uq UNIQUE (playbook_id, task_id)
);

CREATE INDEX IF NOT EXISTS playbook_task_playbook_id_idx
  ON public.playbook_task (playbook_id);

-- ─────────────────────────────────────────────────────────────────────
-- 7. task_runs.run_id — real FK to a playbook_run (replaces the fragile
--    business_id + timing link). Standalone paid runs keep run_id NULL.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS run_id uuid;

DO $$ BEGIN
  ALTER TABLE public.task_runs
    ADD CONSTRAINT task_runs_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES public.playbook_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS task_runs_run_id_idx
  ON public.task_runs (run_id);

-- ─────────────────────────────────────────────────────────────────────
-- 8. Retire free_build_runs (decisions #1 + #4, explicitly approved).
--    Order: TRUNCATE (zero real users) -> repoint stream_events.run_id FK
--    onto playbook_runs -> DROP free_build_runs. Guarded so a re-run after
--    the drop is a no-op and does NOT re-truncate live stream_events.
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'free_build_runs'
  ) THEN
    -- (i) clear the two tables so the FK can be repointed (4079 + 93 rows).
    --     stream_events is listed first/together so truncating the parent
    --     free_build_runs doesn't trip its inbound FK.
    TRUNCATE public.stream_events, public.free_build_runs;

    -- (ii) repoint stream_events.run_id : free_build_runs -> playbook_runs
    --      (keep ON DELETE CASCADE — events die with their run).
    ALTER TABLE public.stream_events DROP CONSTRAINT IF EXISTS stream_events_run_id_fkey;
    ALTER TABLE public.stream_events
      ADD CONSTRAINT stream_events_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES public.playbook_runs(id) ON DELETE CASCADE;

    -- (iii) drop the legacy table (its RLS policies drop with it). All
    --       code references are repointed onto playbook_runs in the same
    --       change set.
    DROP TABLE public.free_build_runs;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 9. RLS — owner SELECT on every new table (Worker uses service-role and
--    bypasses RLS; browser uses anon key + JWT as `authenticated`).
--    Keyed user_id = auth.uid() where present, else scoped up the parent
--    chain to businesses owned by the user.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.plan            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_phase      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_task   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_plan"            ON public.plan;
DROP POLICY IF EXISTS "owner_read_plan_phase"      ON public.plan_phase;
DROP POLICY IF EXISTS "owner_read_phase_milestone" ON public.phase_milestone;
DROP POLICY IF EXISTS "owner_read_playbook"        ON public.playbook;
DROP POLICY IF EXISTS "owner_read_playbook_runs"   ON public.playbook_runs;
DROP POLICY IF EXISTS "owner_read_playbook_task"   ON public.playbook_task;

-- plan — has business_id
CREATE POLICY "owner_read_plan"
  ON public.plan FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

-- plan_phase — scope via plan -> business
CREATE POLICY "owner_read_plan_phase"
  ON public.plan_phase FOR SELECT
  USING (plan_id IN (
    SELECT id FROM public.plan
    WHERE business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid())
  ));

-- phase_milestone — scope via plan_phase -> plan -> business
CREATE POLICY "owner_read_phase_milestone"
  ON public.phase_milestone FOR SELECT
  USING (plan_phase_id IN (
    SELECT pp.id FROM public.plan_phase pp
    JOIN public.plan p ON p.id = pp.plan_id
    WHERE p.business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid())
  ));

-- playbook — has business_id
CREATE POLICY "owner_read_playbook"
  ON public.playbook FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

-- playbook_runs — has user_id
CREATE POLICY "owner_read_playbook_runs"
  ON public.playbook_runs FOR SELECT
  USING (user_id = auth.uid());

-- playbook_task — scope via playbook -> business
CREATE POLICY "owner_read_playbook_task"
  ON public.playbook_task FOR SELECT
  USING (playbook_id IN (
    SELECT id FROM public.playbook
    WHERE business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid())
  ));

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
-- New tables exist (expect 6):
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('plan','plan_phase','phase_milestone',
--                        'playbook','playbook_runs','playbook_task')
--   ORDER BY table_name;
-- task_runs.run_id column + FK:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name='task_runs' AND column_name='run_id';
--   SELECT conname, confrelid::regclass FROM pg_constraint
--   WHERE conrelid='public.task_runs'::regclass AND conname='task_runs_run_id_fkey';
-- stream_events.run_id now points at playbook_runs (expect confrelid=playbook_runs):
--   SELECT conname, confrelid::regclass FROM pg_constraint
--   WHERE conrelid='public.stream_events'::regclass AND contype='f';
-- free_build_runs is gone (expect 0 rows):
--   SELECT count(*) FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='free_build_runs';
-- RLS enabled on the six (expect rowsecurity=t for all):
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public'
--     AND tablename IN ('plan','plan_phase','phase_milestone',
--                       'playbook','playbook_runs','playbook_task');
-- Partial unique / heartbeat indexes present:
--   SELECT indexname FROM pg_indexes WHERE schemaname='public'
--   AND tablename IN ('plan','playbook_runs') ORDER BY indexname;
-- =====================================================================

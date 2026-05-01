-- Migration 010: free_build_runs + stream_events
-- Sprint 5 Phase 3 — persists the agent free-build run state and
-- all SSE events emitted during a run so the frontend can replay on reconnect.
--
-- Apply in: Supabase SQL editor (project: textos-agent)

-- ── free_build_runs ────────────────────────────────────────────────────────
-- One row per business free build. Created when the orchestrator starts;
-- updated as tasks complete or fail.

CREATE TABLE IF NOT EXISTS public.free_build_runs (
  id              uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id         uuid          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status          text          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','running','completed','failed')),
  tasks_total     integer       NOT NULL DEFAULT 0,
  tasks_completed integer       NOT NULL DEFAULT 0,
  started_at      timestamptz   NOT NULL DEFAULT NOW(),
  completed_at    timestamptz   NULL,
  failed_at       timestamptz   NULL,
  error           text          NULL,
  created_at      timestamptz   NOT NULL DEFAULT NOW()
);

-- Only one active run per business at a time
CREATE UNIQUE INDEX IF NOT EXISTS free_build_runs_business_active_idx
  ON public.free_build_runs (business_id)
  WHERE status IN ('pending', 'running');

-- Fast lookup by business
CREATE INDEX IF NOT EXISTS free_build_runs_business_id_idx
  ON public.free_build_runs (business_id);

-- ── stream_events ──────────────────────────────────────────────────────────
-- Persists every SSE event emitted during a free build run.
-- Allows the frontend to replay missed events on reconnect and
-- lets admin inspect what the agent actually said/did.

CREATE TABLE IF NOT EXISTS public.stream_events (
  id              uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id          uuid          NOT NULL REFERENCES public.free_build_runs(id) ON DELETE CASCADE,
  business_id     uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  seq             integer       NOT NULL,  -- monotonically increasing within a run
  event_type      text          NOT NULL,  -- narrative | cmd | task_start | task_complete | task_failed | build_complete | status | error
  event_data      jsonb         NOT NULL DEFAULT '{}',
  created_at      timestamptz   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stream_events_run_id_seq_idx
  ON public.stream_events (run_id, seq);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Worker writes using service role (bypasses RLS).
-- Users can read their own run state + events.

ALTER TABLE public.free_build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_events   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_free_build_runs"   ON public.free_build_runs;
DROP POLICY IF EXISTS "owner_read_stream_events"     ON public.stream_events;

CREATE POLICY "owner_read_free_build_runs"
  ON public.free_build_runs FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "owner_read_stream_events"
  ON public.stream_events FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE user_id = auth.uid()
    )
  );

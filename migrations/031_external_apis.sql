-- =====================================================================
-- Migration 031: External APIs registry + task_apis binding table
-- =====================================================================
-- Adds:
--   external_apis — catalog of third-party APIs used by the orchestrator
--   task_apis     — M:N binding: which task uses which API in what role
--
-- NOTE: The orchestrator does NOT yet read from task_apis in V1.
-- This is documentation-as-data. Execution dispatch via task_apis
-- is a future phase.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- Drop in dependency order (idempotent replay safety)
DROP TABLE IF EXISTS public.task_apis;
DROP TYPE  IF EXISTS api_role;
DROP TABLE IF EXISTS public.external_apis;

-- ── external_apis ─────────────────────────────────────────────────────
CREATE TABLE public.external_apis (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL,
  provider     TEXT        NOT NULL,
  endpoint_url TEXT,
  auth_kind    TEXT        NOT NULL,
  output_kind  TEXT,
  status       TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','deprecated','experimental')),
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_apis_provider ON public.external_apis(provider);
CREATE INDEX IF NOT EXISTS idx_external_apis_status   ON public.external_apis(status);

INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata) VALUES
  ('anthropic-claude-sonnet', 'Claude Sonnet 4',   'anthropic', 'api_key', 'document', 'active',
     '{"model":"claude-sonnet-4-20250514"}'::jsonb),
  ('anthropic-claude-haiku',  'Claude Haiku 4.5',  'anthropic', 'api_key', 'document', 'active',
     '{"model":"claude-haiku-4-5-20251001"}'::jsonb),
  ('falai-flux-image',        'fal.ai Flux Image', 'fal.ai',    'api_key', 'image',    'active',
     '{"model":"fal-ai/flux/dev"}'::jsonb),
  ('sendgrid-email',          'SendGrid Email',    'sendgrid',  'api_key', 'email',    'active',
     '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ── task_apis ─────────────────────────────────────────────────────────
CREATE TABLE public.task_apis (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID        NOT NULL REFERENCES public.tasks(id)         ON DELETE CASCADE,
  api_id            UUID        NOT NULL REFERENCES public.external_apis(id) ON DELETE RESTRICT,
  role              TEXT        NOT NULL DEFAULT 'primary'
                                  CHECK (role IN ('primary','secondary','fallback')),
  invocation_params JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, api_id, role)
);

CREATE INDEX IF NOT EXISTS idx_task_apis_task_id ON public.task_apis(task_id);
CREATE INDEX IF NOT EXISTS idx_task_apis_api_id  ON public.task_apis(api_id);

-- ── Verify ────────────────────────────────────────────────────────────
-- SELECT slug, name, provider, output_kind FROM external_apis ORDER BY slug;
-- SELECT COUNT(*) FROM task_apis;  -- expect 0 until 032 runs

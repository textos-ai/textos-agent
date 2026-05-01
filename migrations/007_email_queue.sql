-- Sprint 5 Phase 1: Admin email approval queue + admin_users table
--
-- Run this via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Run in order:
--   1. admin_users table + seed (section A)
--   2. email_queue table (section B)

-- ══════════════════════════════════════════════════════════════════════════════
-- A. admin_users
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id   UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes     TEXT
);

-- Seed Rob's two accounts (Google OAuth + magic link)
-- Uses email lookup so no hardcoded UUID needed
INSERT INTO public.admin_users (user_id, notes)
SELECT id, 'Rob Gaudet, founder (Google OAuth)'
FROM public.users
WHERE email = 'robertkgaudet@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.admin_users (user_id, notes)
SELECT id, 'Rob Gaudet, founder (magic link)'
FROM public.users
WHERE email = 'rgaudet2023@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════
-- B. email_queue
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.email_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_run_id     UUID REFERENCES public.task_runs(id) ON DELETE SET NULL,

  -- Email content
  to_email        TEXT NOT NULL,
  to_name         TEXT,
  to_company      TEXT,
  to_role         TEXT,
  from_email      TEXT NOT NULL DEFAULT 'yourbusiness@textos.ai',
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,

  -- State machine
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'failed')),

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at     TIMESTAMPTZ,
  approved_by     UUID REFERENCES public.users(id),
  sent_at         TIMESTAMPTZ,
  sendgrid_message_id TEXT,
  rejection_reason TEXT,

  -- Admin edits before approval
  edited          BOOLEAN NOT NULL DEFAULT FALSE,
  edited_subject  TEXT,
  edited_body     TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status
  ON public.email_queue(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_queue_business
  ON public.email_queue(business_id);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending
  ON public.email_queue(created_at DESC)
  WHERE status = 'pending';

-- RLS
ALTER TABLE public.email_queue ENABLE ROW LEVEL SECURITY;

-- Admin: full access to all rows
CREATE POLICY "Admin full access to email_queue" ON public.email_queue
  FOR ALL
  USING (auth.uid() IN (
    SELECT u.id FROM public.users u
    JOIN public.admin_users a ON a.user_id = u.id
    WHERE u.id = auth.uid()
  ));

-- Users: read-only access to their own queued emails
CREATE POLICY "Users read own queued emails" ON public.email_queue
  FOR SELECT
  USING (user_id IN (
    SELECT id FROM public.users WHERE id = auth.uid()
  ));

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT * FROM admin_users;
-- SELECT COUNT(*) FROM email_queue;

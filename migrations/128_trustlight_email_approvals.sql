-- =====================================================================
-- Migration 128: TrustLight per-email approval queue
-- =====================================================================
-- Source: "per-email approval queue" instruction, 2026-09-15.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: CREATE TABLE/INDEX are IF NOT EXISTS, constraints guarded.
--
-- Nothing may be emailed to a real business on a rendered-at-send basis.
-- Every notify email is FROZEN into a row here as pending, showing exactly
-- what would go out, and is sent only after a human approves that specific
-- row. The API refuses to send without an approved row, so approval is not
-- a UI courtesy.
--
-- The body is stored, not re-rendered at send time. If it were re-rendered,
-- an edit to the profile between approval and send would change the words
-- after they were approved — approving a preview would then mean nothing.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.coldcall_email_approvals (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        NOT NULL REFERENCES public.coldcall_leads(id) ON DELETE CASCADE,

  -- The frozen message. What is approved is what is sent.
  to_email      TEXT        NOT NULL,
  from_email    TEXT        NOT NULL,
  subject       TEXT        NOT NULL,
  body_text     TEXT        NOT NULL,
  body_html     TEXT        NOT NULL,
  removal_url   TEXT,
  profile_url   TEXT,

  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','sent','failed')),

  -- Who asked for it.
  requested_by_user_id UUID,
  requested_by_email   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who approved it, and when. The point of the table.
  approved_by_user_id  UUID,
  approved_by_email    TEXT,
  approved_at   TIMESTAMPTZ,

  rejected_at   TIMESTAMPTZ,
  reject_reason TEXT,

  sent_at       TIMESTAMPTZ,
  send_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The queue read: pending first, oldest first.
CREATE INDEX IF NOT EXISTS coldcall_email_approvals_queue
  ON public.coldcall_email_approvals (status, created_at);

CREATE INDEX IF NOT EXISTS coldcall_email_approvals_lead
  ON public.coldcall_email_approvals (lead_id, created_at DESC);

-- At most ONE pending request per lead, so a double-click cannot fill the
-- queue with duplicates of the same email awaiting approval.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_email_approvals_one_pending
  ON public.coldcall_email_approvals (lead_id) WHERE status = 'pending';

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_email_approvals_updated_at
    BEFORE UPDATE ON public.coldcall_email_approvals
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An approval record is evidence that a human authorised a message to a real
-- business. It must not be quietly rewritten after the fact: once a row is
-- sent or rejected it is terminal, and the approver fields cannot be changed
-- once set. Enforced by trigger, because the Worker holds the service-role
-- key and bypasses RLS.
CREATE OR REPLACE FUNCTION public.coldcall_email_approvals_guard()
RETURNS TRIGGER AS $fn$
BEGIN
  IF OLD.status IN ('sent','rejected') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'coldcall_email_approvals: % is terminal, cannot move to %', OLD.status, NEW.status;
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'coldcall_email_approvals: approved_at cannot be rewritten';
  END IF;
  IF OLD.approved_by_email IS NOT NULL AND NEW.approved_by_email IS DISTINCT FROM OLD.approved_by_email THEN
    RAISE EXCEPTION 'coldcall_email_approvals: approver cannot be rewritten';
  END IF;
  -- The frozen message is immutable. Re-rendering after approval would mean
  -- approving a preview guaranteed nothing.
  IF NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.body_html IS DISTINCT FROM OLD.body_html
     OR NEW.to_email IS DISTINCT FROM OLD.to_email THEN
    RAISE EXCEPTION 'coldcall_email_approvals: the approved message is immutable';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_email_approvals_guard
    BEFORE UPDATE ON public.coldcall_email_approvals
    FOR EACH ROW EXECUTE FUNCTION public.coldcall_email_approvals_guard();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RLS deny-by-default, matching every other coldcall_* table. These rows hold
-- a third party's email address and the full message body.
ALTER TABLE public.coldcall_email_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coldcall_email_approvals FROM anon, authenticated;


-- Nothing may be sent from victora.ai. A TrustLight email arriving from an
-- unrelated domain reads as phishing to precisely the audience whose trust
-- the product depends on.
UPDATE public.coldcall_config
   SET value = 'hello@trustlight.com',
       note  = 'From address for TrustLight outbound email. MUST be on trustlight.com — sending from victora.ai is refused in code. Halts until the domain is authenticated in SendGrid.'
 WHERE key = 'trustlight_from_email';

INSERT INTO public.coldcall_config (key, value, note) VALUES
  ('trustlight_from_email', 'hello@trustlight.com',
   'From address for TrustLight outbound email. MUST be on trustlight.com — sending from victora.ai is refused in code. Halts until the domain is authenticated in SendGrid.')
ON CONFLICT (key) DO NOTHING;


-- == Verify (paste after applying) =============================================
-- Table, indexes and the one-pending-per-lead guard:
--   SELECT indexname FROM pg_indexes WHERE tablename='coldcall_email_approvals';
--
-- From address is now trustlight.com (NOT victora.ai):
--   SELECT key, value FROM public.coldcall_config WHERE key='trustlight_from_email';
--
-- The guard really is a guard — each of these must RAISE:
--   -- (after inserting one row and approving it)
--   UPDATE public.coldcall_email_approvals SET subject='changed' WHERE status='approved';
--   UPDATE public.coldcall_email_approvals SET approved_by_email='someone@else' WHERE status='approved';
--
-- RLS on, zero policies:
--   SELECT tablename, rowsecurity FROM pg_tables WHERE tablename='coldcall_email_approvals';
-- =====================================================================

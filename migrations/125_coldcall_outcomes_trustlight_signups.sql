-- =====================================================================
-- Migration 125: coldcall — new call outcomes, Trustlight service, and
--                signed-up-services tracking
-- =====================================================================
-- Source: "Three changes + signed-up tracking" brief, 2026-09-01.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: the outcome CHECK is dropped-by-discovery then re-added;
-- every ADD COLUMN / CREATE TABLE / INDEX is IF NOT EXISTS; seeds use
-- ON CONFLICT DO NOTHING; added constraints are guarded.
--
-- Three independent concerns, shipped as one apply:
--   1. Three new call-attempt outcomes (coldcall_call_activity.outcome CHECK).
--   2. A fourth per-lead service toggle (Trustlight / Vetted Network) with its
--      own YEARLY price, separate from the bundled monthly script price.
--   3. Signed-up tracking: a services catalog + a per-lead signup ledger,
--      distinct from the "interested during the call" svc_* toggles.
-- =====================================================================


-- ── 1. New call outcomes ─────────────────────────────────────────────
-- The three additions are all callback-shaped, so the app maps them to lead
-- status 'callback' (see src/lib/coldcall-log.ts STATUS_FOR_OUTCOME). Kept as
-- a distinct value from the existing 'interested_followup' ("Callback booked"):
-- interested_followup_req is the softer "interested, no firm time" case.
--
-- Postgres can't add a value to a CHECK the way it can to an enum, so the
-- existing outcome CHECK is discovered by name (it was created inline in 115,
-- auto-named coldcall_call_activity_outcome_check) and replaced. Discovery
-- rather than a hardcoded DROP so a differently-named constraint can't leave a
-- stale second CHECK behind that would still reject the new values.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'coldcall_call_activity'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%outcome%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.coldcall_call_activity DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.coldcall_call_activity
  ADD CONSTRAINT coldcall_call_activity_outcome_check
  CHECK (outcome IN (
    -- existing (migration 115), unchanged
    'no_answer','voicemail_left','gatekeeper','not_interested',
    'interested_followup','meeting_booked','wrong_number','do_not_call',
    -- new (this migration)
    'interested_followup_req','will_call_back','call_back_tomorrow'
  ));


-- ── 2. Trustlight (Vetted) Network service + yearly price ────────────
-- Deliberately DEFAULT false: the three original services default true because
-- the script assumes them, but a brand-new upsell must not be presumed on the
-- 15,822 existing leads. Its price is YEARLY and separate from the bundled
-- monthly script_price_monthly (migration 117/119).
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS svc_trustlight          BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trustlight_price_yearly NUMERIC(10,2) NOT NULL DEFAULT 497;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_trustlight_price_chk
    CHECK (trustlight_price_yearly > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 3. Signed-up-services tracking ───────────────────────────────────
-- Two tables, kept extensible so a new service is a catalog INSERT, never a
-- schema change. The svc_* booleans above record INTEREST during the call;
-- these tables record what a lead actually SIGNED UP for and persist after.

-- 3a. Catalog of sellable services. billing_group ties services billed as one
--     line: the three core services share group 'core' and one $297/mo price,
--     so the read side counts the group ONCE (Option A). Trustlight has no
--     group — it bills on its own yearly cycle.
CREATE TABLE IF NOT EXISTS public.coldcall_services (
  slug          TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  billing_cycle TEXT        NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
  default_price NUMERIC(10,2) NOT NULL CHECK (default_price > 0),
  -- Services sharing a non-null billing_group are billed together at one price
  -- (the group's price). A null group bills individually.
  billing_group TEXT,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.coldcall_services (slug, name, billing_cycle, default_price, billing_group, sort_order) VALUES
  ('website',       'Website',                     'monthly', 297, 'core', 1),
  ('ai_automation', 'AI Automation',               'monthly', 297, 'core', 2),
  ('fb_ads',        'FB Ads',                      'monthly', 297, 'core', 3),
  ('trustlight',    'Trustlight (Vetted) Network', 'yearly',  497, NULL,   4)
ON CONFLICT (slug) DO NOTHING;

-- 3b. Per-lead signup ledger. One row per service a lead signed up for. Price
--     and cycle are SNAPSHOT at signup so a later catalog price change never
--     rewrites what a lead was actually sold. Cancelling is a soft status flip,
--     so re-signups keep the history — hence the partial unique on status.
CREATE TABLE IF NOT EXISTS public.coldcall_lead_signups (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        NOT NULL REFERENCES public.coldcall_leads(id)    ON DELETE CASCADE,
  service_slug  TEXT        NOT NULL REFERENCES public.coldcall_services(slug) ON DELETE RESTRICT,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  price_amount  NUMERIC(10,2) NOT NULL CHECK (price_amount > 0),
  billing_cycle TEXT        NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
  signed_up_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_up_by  UUID        REFERENCES public.coldcall_callers(id) ON DELETE SET NULL,
  cancelled_at  TIMESTAMPTZ,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most ONE active signup per (lead, service). Cancelled rows may pile up.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_lead_signups_active_uniq
  ON public.coldcall_lead_signups (lead_id, service_slug) WHERE status = 'active';

-- The per-lead management read.
CREATE INDEX IF NOT EXISTS coldcall_lead_signups_lead
  ON public.coldcall_lead_signups (lead_id, status);

-- updated_at trigger (public.set_updated_at defined in migration 115).
DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_lead_signups_updated_at
    BEFORE UPDATE ON public.coldcall_lead_signups
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RLS deny-by-default, matching every other coldcall_* table. The Worker's
-- service-role key is the only access path; anon/authenticated read nothing.
ALTER TABLE public.coldcall_services      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coldcall_lead_signups  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coldcall_services      FROM anon, authenticated;
REVOKE ALL ON public.coldcall_lead_signups  FROM anon, authenticated;


-- == Verify (paste after applying) =============================================
-- Outcome CHECK now lists 11 values (expect the 3 new ones present):
--   SELECT pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname='coldcall_call_activity' AND con.contype='c';
--
-- Trustlight columns exist, default false / 497:
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name='coldcall_leads'
--      AND column_name IN ('svc_trustlight','trustlight_price_yearly');
--
-- Catalog seeded (expect 4 rows; the three core share group 'core'):
--   SELECT slug, billing_cycle, default_price, billing_group, sort_order
--     FROM public.coldcall_services ORDER BY sort_order;
--
-- Signups table + partial unique index exist:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename='coldcall_lead_signups';
--
-- RLS on, zero policies, on the two new tables:
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE tablename IN ('coldcall_services','coldcall_lead_signups');
--
-- Node probe (asserts all three concerns) — expect row 125 -> APPLIED:
--   node scripts/migration-state.mjs
-- =====================================================================

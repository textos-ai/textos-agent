-- =====================================================================
-- Migration 131: fields the contractor application collects
-- =====================================================================
-- Source: TrustLight build brief, step 11 (POST /api/application), 2026-09-16
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS throughout.
-- =====================================================================
--
-- Five nullable columns. No existing row changes, no constraint added to
-- anything already populated.
--
--   contact_name        WHO applied. chk_contact verifies contact details, and
--                       an email plus a phone with no named person behind them
--                       is not something you can verify against a licence or a
--                       business filing.
--
--   year_established    Preferred over the existing years_in_business, which
--                       silently becomes wrong every January. A year is a fact;
--                       a duration is a fact with an expiry date. Both columns
--                       stay — years_in_business keeps whatever is already in it.
--
--   google_profile_url  chk_reviews is a review AUDIT. Being handed the profile
--                       is the difference between auditing the right business
--                       and auditing one with a similar name in the next parish.
--
--   application_note    What the form did not think to ask. Free text.
--
--   applied_at          When they applied, so the admin can work the queue in
--                       order. Distinct from created_at, which is when the LEAD
--                       row appeared — usually the scrape, years earlier.
--
-- INTERNAL ONLY, alongside contact_email from 127: contact_name and
-- application_note are operational contact data and must never reach the public
-- API. lib/trustlight-public.ts whitelists columns explicitly and never selects
-- *, so they are excluded by construction; the public harness asserts it.
-- =====================================================================

ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS contact_name       TEXT,
  ADD COLUMN IF NOT EXISTS year_established   INTEGER,
  ADD COLUMN IF NOT EXISTS google_profile_url TEXT,
  ADD COLUMN IF NOT EXISTS application_note   TEXT,
  ADD COLUMN IF NOT EXISTS applied_at         TIMESTAMPTZ;

COMMENT ON COLUMN public.coldcall_leads.contact_name IS
  'INTERNAL ONLY. Named person who submitted the application. Never published.';
COMMENT ON COLUMN public.coldcall_leads.application_note IS
  'INTERNAL ONLY. Free text from the applicant. Never published.';
COMMENT ON COLUMN public.coldcall_leads.applied_at IS
  'When the contractor applied at trustlight.com/start. Distinct from created_at, which is when the lead row first appeared.';

-- Matching an application to an existing lead reads by licence, then by
-- normalised phone digits. Neither is indexed today; at 15,822 rows a
-- sequential scan is fine, but these are the two lookups the endpoint makes on
-- every submission, so they are indexed now rather than after it is slow.
CREATE INDEX IF NOT EXISTS coldcall_leads_license_lookup
  ON public.coldcall_leads (license_state, license_number)
  WHERE license_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS coldcall_leads_phone_digits_lookup
  ON public.coldcall_leads (phone_e164_digits)
  WHERE phone_e164_digits IS NOT NULL;

CREATE INDEX IF NOT EXISTS coldcall_leads_applied_at
  ON public.coldcall_leads (applied_at DESC)
  WHERE applied_at IS NOT NULL;

-- ── Verify after applying ────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'coldcall_leads'
--      AND column_name IN ('contact_name','year_established','google_profile_url',
--                          'application_note','applied_at');
-- Expected: 5 rows, all is_nullable = YES.
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'coldcall_leads'
--      AND indexname IN ('coldcall_leads_license_lookup',
--                        'coldcall_leads_phone_digits_lookup',
--                        'coldcall_leads_applied_at');
-- Expected: 3 rows.
-- =====================================================================

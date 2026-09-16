-- =====================================================================
-- Migration 127: TrustLight campaign config
-- =====================================================================
-- Source: "Free-vetting campaign" brief (section 6 / build step 7),
--         2026-09-15.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: every INSERT is ON CONFLICT DO NOTHING.
--
-- ONE COLUMN plus config rows.
--
-- contact_email did not exist. coldcall_leads carries phone, address,
-- website and domain for all 15,822 leads, but no email address of any
-- kind — so the notify-before-publish email had nobody to send to. It is
-- INTERNAL: captured by an operator during the chk_contact check, and
-- never returned by the public API.
--
-- Otherwise config rows only. Every other column the campaign needs
-- (is_comped, comp_reason, comp_offer_status, comp_offered_at,
-- comp_decided_at, listing_consent, notified_at, removal_token,
-- removal_requested_at) already landed in migration 126.
--
-- These live in coldcall_config rather than in code because they are
-- operational settings, not logic — the same reason comp_grace_days does.
-- They are LOAD-BEARING: the notify email halts loudly if any is missing,
-- because a wrong site URL means shipping someone an opt-out link that
-- does not work.
-- =====================================================================

ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- Shape guard only. The real check is chk_contact, done by a human against
-- the business's own published details.
DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_contact_email_chk
    CHECK (contact_email IS NULL OR contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


INSERT INTO public.coldcall_config (key, value, note) VALUES
  ('trustlight_site_url', 'https://trustlight.com',
   'Public base URL used to build listing and one-click-removal links in outbound email. Must be the live site — a wrong value ships a broken opt-out.'),

  ('trustlight_from_email', 'hello@victora.ai',
   'From address for TrustLight outbound email. MUST be a domain verified as a SendGrid sender. Defaults to the already-verified victora.ai address; change to a trustlight.com address only once that domain is verified in SendGrid, or delivery will fail.'),

  ('trustlight_from_name', 'TrustLight',
   'Display name on outbound TrustLight email.')
ON CONFLICT (key) DO NOTHING;

-- DELIBERATELY NOT SEEDED: trustlight_email_enabled.
--
-- lib/trustlight-campaign.ts refuses to send unless this key exists and is
-- exactly 'true'. Its ABSENCE is the off switch, so email cannot be sent in
-- any environment until someone adds it on purpose. Do not add it here — that
-- would make "sending is on" the default that ships with the migration.
--
-- To enable, after the content and test plan are signed off:
--   INSERT INTO public.coldcall_config (key, value, note)
--   VALUES ('trustlight_email_enabled', 'true', 'Outbound TrustLight email enabled');
-- To disable again:
--   DELETE FROM public.coldcall_config WHERE key = 'trustlight_email_enabled';


-- == Verify (paste after applying) =============================================
-- The new column exists and is nullable:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name='coldcall_leads' AND column_name='contact_email';
--
-- Expect four rows: comp_grace_days (from 126) plus the three above.
--   SELECT key, value FROM public.coldcall_config ORDER BY key;
--
-- The grace period seeded in 126 is 30 days:
--   SELECT value FROM public.coldcall_config WHERE key = 'comp_grace_days';
-- =====================================================================

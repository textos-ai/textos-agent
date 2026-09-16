-- =====================================================================
-- Migration 130: the re-verification window
-- =====================================================================
-- Source: TrustLight build brief, step 10 (re-verification dashboard), 2026-09-16
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- =====================================================================
--
-- How far ahead the re-verification dashboard looks. The brief says 60 days,
-- and 60 is also what verificationStamps() subtracts from expires_at to set
-- reverify_due — but this is a business decision about how much runway the
-- renewal pipeline gets, so it is config rather than a literal in the route.
--
-- ON CONFLICT DO NOTHING so re-running never overwrites a value somebody has
-- since tuned in the dashboard. A migration that silently resets an operator's
-- setting is worse than one that fails loudly.
--
-- Its ABSENCE is not a default. The route refuses and names this migration
-- rather than assuming 60, because a dashboard quietly looking at the wrong
-- window is how a verification lapses without anyone seeing it coming.
-- =====================================================================

INSERT INTO public.coldcall_config (key, value, note) VALUES
  ('reverify_window_days', '60',
   'How many days ahead the re-verification dashboard looks. Records with reverify_due inside this window are listed, soonest first. Already-expired records are always shown regardless of the window.')
ON CONFLICT (key) DO NOTHING;

-- ── Verify after applying ────────────────────────────────────────────
--   SELECT key, value FROM public.coldcall_config
--    WHERE key = 'reverify_window_days';
-- Expected: one row, value '60'.
-- =====================================================================

-- =====================================================================
-- Migration 134: backfill coldcall_leads.trade from coldcall_leads.category
-- =====================================================================
-- Source: Rob, 2026-09-17 — "fix the whole table now"
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: the WHERE clause makes a second run a no-op.
--
-- ALREADY APPLIED on 2026-09-17 via service-role script, 15,813 rows.
-- This file is the durable record and the reproduction, not a pending task.
-- =====================================================================
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- The two public tiers read different columns. shapeUnvetted() reads
-- `category`, which every scraped row has. shapeVerified() reads `trade`,
-- which 11 rows had. Verifying a business therefore moved it from a
-- populated column to an empty one and made it LESS visible — it
-- vanished from the directory at the exact moment it started paying.
-- That hit four businesses before anyone traced it.
--
-- Migration-less half of the fix (commit c68cff4): verification now fills
-- `trade` from `category` when `trade` is blank, and both the verify and
-- publish gates refuse a record missing any of REQUIRED_PUBLIC_FIELDS.
-- That stops the bug at the moment of verification. This backfill removes
-- the latent version of it from the 15,813 rows that had not been
-- verified yet, so it cannot bite one record at a time for months.
--
-- ── THE COPY IS VERBATIM ─────────────────────────────────────────────
-- No canonicalisation, no synonym mapping. `trade := category`, exactly.
-- The verification auto-fill does the same thing, and if this migration
-- normalised while that one copied, the two paths would disagree about
-- what a category means and the drift would be invisible until it wasn't.
-- The scraped vocabulary is already clean: all 54 distinct values are
-- lowercase and trimmed, with zero case or whitespace variants.
--
-- ── OUT-OF-VOCABULARY VALUES ─────────────────────────────────────────
-- 11,669 of these rows carry a category that is NOT one of the 16 in
-- HOME_TRADE_CATEGORIES — 1,242 auto repair shops, 866 beauty salons,
-- 672 dentists, and so on. They get their category written to `trade`
-- like everything else. This changes nothing a visitor can see: the
-- public unvetted list filters on `category` against the allow-list, so
-- a dentist was unreachable before and is unreachable after (verified
-- 7, unvetted 4,144 both before and after, and /search?q=dentist returns
-- nothing).
--
-- The one real consequence, recorded so it is not discovered later: a
-- non-null `trade` satisfies the new publish gate. Before this, a dentist
-- could not be verified without the gate objecting. Now the nine manual
-- checks are the only thing standing in the way. That was always the
-- primary guard — the gate is a backstop for missing data, not a
-- category police — but the backstop no longer covers this case.
--
-- ── EXCLUSION ────────────────────────────────────────────────────────
-- One row is deliberately left out: the duplicate 'Trinity Home
-- Services' (f00c2764-60ba-40c4-a40c-f0a26d806579, status 'lead'), which
-- is on the protected list that must not be written to. The script wrote
-- it and it was reverted to NULL. Keep the exclusion here so a re-run
-- does not reintroduce it.
-- =====================================================================

UPDATE public.coldcall_leads
SET    trade = category
WHERE  trade IS NULL
  AND  category IS NOT NULL
  AND  btrim(category) <> ''
  AND  id <> 'f00c2764-60ba-40c4-a40c-f0a26d806579'::uuid;

-- Expected after a first run on the 2026-09-17 data:
--   15813 rows updated, 1 row remaining with trade IS NULL (the exclusion).
--
-- Verify:
--   SELECT count(*) FILTER (WHERE trade IS NULL)              AS still_null,
--          count(*) FILTER (WHERE trade IS DISTINCT FROM category) AS diverged
--   FROM   public.coldcall_leads;

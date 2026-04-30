-- TextOS Agent — Sprint 4/E: Normalize handles to lowercase
--
-- The Sprint 3b handle uniqueness check was case-sensitive, so
-- "Robert" (Google OAuth) and "rob" (magic link) could both exist.
-- This migration:
--   1. Detects any existing conflicts (same lowercase, different case)
--   2. For non-conflicting handles, lowercases them in-place
--   3. Leaves conflicting handles untouched (manual resolution required)
--
-- SAFE TO RE-RUN: uses DO $$ block with conflict detection.
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

DO $$
DECLARE
  r RECORD;
  conflict_count INTEGER := 0;
BEGIN
  -- Find handles that would conflict after lowercasing
  FOR r IN
    SELECT handle, LOWER(handle) as lower_handle, COUNT(*) OVER (PARTITION BY LOWER(handle)) as dupe_count
    FROM public.users
    WHERE handle IS NOT NULL AND handle <> LOWER(handle)
  LOOP
    IF r.dupe_count > 1 THEN
      RAISE NOTICE 'CONFLICT: handle "%" would clash after lowercase — skipping', r.handle;
      conflict_count := conflict_count + 1;
    ELSE
      UPDATE public.users SET handle = LOWER(handle) WHERE handle = r.handle;
      RAISE NOTICE 'Normalized: "%" -> "%"', r.handle, LOWER(r.handle);
    END IF;
  END LOOP;

  IF conflict_count > 0 THEN
    RAISE NOTICE '% handle(s) skipped due to conflicts. Resolve manually before re-running.', conflict_count;
  ELSE
    RAISE NOTICE 'All handles normalized successfully.';
  END IF;
END $$;

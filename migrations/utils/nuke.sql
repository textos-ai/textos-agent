-- ============================================================================
-- TEXTOS NUKE UTILITY
-- Last updated: Sprint 5 / Phase 3.5
--
-- ⚠️  DESTRUCTIVE. Always run the SELECT preview BEFORE the DELETE block.
--     Always verify in Supabase preview environment before production.
--
-- Three sections:
--   Section 1: Nuke a single business by slug
--   Section 2: Nuke all businesses for a user by email
--   Section 3: Nuke everything except seeded demos
--
-- Usage: copy the section you need into Supabase SQL editor, edit the slug
--        or email value, run the preview, then run the DELETE block.
-- ============================================================================


-- ── SECTION 1: SINGLE BUSINESS BY SLUG ─────────────────────────────────────

-- 1a. PREVIEW: see what will be deleted (replace 'YOUR_SLUG' with target)
SELECT
  b.id AS business_id,
  b.slug,
  b.name,
  b.created_at,
  (SELECT COUNT(*) FROM public.task_runs WHERE business_id = b.id) AS task_runs,
  (SELECT COUNT(*) FROM public.business_assets WHERE business_id = b.id) AS assets,
  (SELECT COUNT(*) FROM public.free_build_runs WHERE business_id = b.id) AS builds,
  (SELECT COUNT(*) FROM public.stream_events WHERE business_id = b.id) AS events,
  (SELECT COUNT(*) FROM public.business_context WHERE business_id = b.id) AS contexts,
  (SELECT COUNT(*) FROM public.email_queue WHERE business_id = b.id) AS emails
FROM public.businesses b
WHERE b.slug = 'YOUR_SLUG';

-- 1b. DELETE: only run after preview confirms expected counts
BEGIN;
DELETE FROM public.stream_events
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.free_build_runs
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.business_assets
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.email_queue
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.task_runs
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.business_context
  WHERE business_id = (SELECT id FROM public.businesses WHERE slug = 'YOUR_SLUG');
DELETE FROM public.businesses WHERE slug = 'YOUR_SLUG';
COMMIT;


-- ── SECTION 2: ALL BUSINESSES FOR A USER BY EMAIL ──────────────────────────

-- 2a. PREVIEW: see all businesses for a user (replace 'USER_EMAIL')
SELECT
  u.id AS user_id,
  u.email,
  u.handle,
  b.slug,
  b.name,
  b.created_at
FROM public.users u
LEFT JOIN public.businesses b ON b.user_id = u.id
WHERE u.email = 'USER_EMAIL'
ORDER BY b.created_at;

-- 2b. DELETE: deletes all businesses + descendants for the user. User row stays.
BEGIN;
WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.stream_events WHERE business_id IN (SELECT id FROM target_businesses);

WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.free_build_runs WHERE business_id IN (SELECT id FROM target_businesses);

WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.business_assets WHERE business_id IN (SELECT id FROM target_businesses);

WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.email_queue WHERE business_id IN (SELECT id FROM target_businesses);

WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.task_runs WHERE business_id IN (SELECT id FROM target_businesses);

WITH target_businesses AS (
  SELECT b.id FROM public.businesses b
  JOIN public.users u ON b.user_id = u.id
  WHERE u.email = 'USER_EMAIL'
)
DELETE FROM public.business_context WHERE business_id IN (SELECT id FROM target_businesses);

DELETE FROM public.businesses
  WHERE user_id = (SELECT id FROM public.users WHERE email = 'USER_EMAIL');
COMMIT;


-- ── SECTION 3: NUKE EVERYTHING EXCEPT SEEDED DEMOS ─────────────────────────

-- 3a. PREVIEW: list businesses that would be wiped (NOT in the seeded set)
SELECT slug, name, created_at
FROM public.businesses
WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
ORDER BY created_at;

-- 3b. DELETE: wipe all non-demo businesses + their descendants
BEGIN;
DELETE FROM public.stream_events
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.free_build_runs
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.business_assets
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.email_queue
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.task_runs
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.business_context
  WHERE business_id IN (
    SELECT id FROM public.businesses
    WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot')
  );
DELETE FROM public.businesses
  WHERE slug NOT IN ('beatpilot', 'camille-at-the-roosevelt', 'coachpilot');
COMMIT;


-- ── HOW TO VERIFY AFTER ANY NUKE ───────────────────────────────────────────

SELECT slug, name, created_at FROM public.businesses ORDER BY created_at DESC;
-- Should show only the businesses you expected to keep.

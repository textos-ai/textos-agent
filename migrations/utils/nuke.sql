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


-- ── SECTION 4: NUKE ALL EXCEPT ADMIN-OWNED BUSINESSES ─────────────────────
-- Preserves every business whose owner is in admin_users.
-- Safe to run on prod during testing — keeps Rob's data, wipes everyone else.

-- 4a. PREVIEW: businesses that would be wiped (non-admin owned)
SELECT
  b.slug,
  b.name,
  u.email AS owner,
  b.created_at
FROM public.businesses b
JOIN public.users u ON b.user_id = u.id
WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
ORDER BY b.created_at;

-- 4b. DELETE: wipe all non-admin businesses + their descendants
BEGIN;
DELETE FROM public.stream_events
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.free_build_runs
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.business_assets
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.email_queue
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.task_runs
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.business_context
  WHERE business_id IN (
    SELECT b.id FROM public.businesses b
    WHERE b.user_id NOT IN (SELECT user_id FROM public.admin_users)
  );
DELETE FROM public.businesses
  WHERE user_id NOT IN (SELECT user_id FROM public.admin_users);
COMMIT;


-- ── SECTION 5: FULL USER DELETION (user row + all their data) ──────────────
-- Nukes the user row itself. Use when a test account needs to be fully reset
-- so they can re-register. Replace 'USER_EMAIL' with the target.
-- ⚠️  This also deletes Supabase auth.users — see note below.

-- 5a. PREVIEW: confirm who you're deleting
SELECT
  u.id AS user_id,
  u.email,
  u.handle,
  u.created_at,
  (SELECT COUNT(*) FROM public.businesses WHERE user_id = u.id) AS businesses
FROM public.users u
WHERE u.email = 'USER_EMAIL';

-- 5b. DELETE: all businesses + descendants + user row
--     Note: auth.users row (Supabase Auth) must be deleted separately via
--     the Supabase Dashboard → Authentication → Users → Delete, OR via:
--     DELETE FROM auth.users WHERE email = 'USER_EMAIL';
BEGIN;
WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.stream_events WHERE business_id IN (SELECT id FROM bids);

WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.free_build_runs WHERE business_id IN (SELECT id FROM bids);

WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.business_assets WHERE business_id IN (SELECT id FROM bids);

WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.email_queue WHERE business_id IN (SELECT id FROM bids);

WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.task_runs WHERE business_id IN (SELECT id FROM bids);

WITH uid AS (SELECT id FROM public.users WHERE email = 'USER_EMAIL'),
     bids AS (SELECT id FROM public.businesses WHERE user_id = (SELECT id FROM uid))
DELETE FROM public.business_context WHERE business_id IN (SELECT id FROM bids);

DELETE FROM public.businesses
  WHERE user_id = (SELECT id FROM public.users WHERE email = 'USER_EMAIL');

DELETE FROM public.profiles
  WHERE user_id = (SELECT id FROM public.users WHERE email = 'USER_EMAIL');

DELETE FROM public.users WHERE email = 'USER_EMAIL';
-- Then manually delete from auth.users via Dashboard or:
-- DELETE FROM auth.users WHERE email = 'USER_EMAIL';
COMMIT;


-- ── SECTION 6: ZOMBIE CLEANUP ──────────────────────────────────────────────
-- Fixes rows stuck in state='running' or status='running' after a Worker crash.
-- Safe to run any time — only touches rows that have been running > 10 minutes.

-- 6a. PREVIEW: see all stuck rows
SELECT
  'task_runs' AS tbl,
  id,
  business_id,
  slug,
  state,
  status,
  started_at,
  NOW() - started_at AS running_for
FROM public.task_runs
WHERE state = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes'
UNION ALL
SELECT
  'free_build_runs' AS tbl,
  id,
  business_id,
  NULL AS slug,
  NULL AS state,
  status,
  started_at,
  NOW() - started_at AS running_for
FROM public.free_build_runs
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes'
ORDER BY running_for DESC;

-- 6b. FIX: mark stuck rows as failed
BEGIN;
UPDATE public.task_runs
SET
  state  = 'failed',
  status = 'failed',
  output_data = COALESCE(output_data, '{}') || '{"error":"zombie: Worker died mid-task"}'::jsonb
WHERE state = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';

UPDATE public.free_build_runs
SET
  status       = 'failed',
  error        = 'zombie: Worker died mid-build',
  completed_at = NOW()
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';
COMMIT;


-- ── HOW TO VERIFY AFTER ANY NUKE ───────────────────────────────────────────

SELECT slug, name, created_at FROM public.businesses ORDER BY created_at DESC;
-- Should show only the businesses you expected to keep.

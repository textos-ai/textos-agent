-- =====================================================================
-- Migration 032: Task categorization data
-- =====================================================================
-- Populates the columns added in 030 and bindings added in 031:
--   tasks.lifecycle_phase_id   — all 33 tasks categorized
--   tasks.is_regeneratable     — 5 tasks → FALSE (one-time setup/formation tasks)
--   tasks.asset_user_editable  — 27 tasks → TRUE; 6 → FALSE
--   task_apis                  — API binding rows for all 33 tasks
--
-- 33 tasks total:
--   30 from 20260429120001_seed_data.sql
--    1 from migration 012 (daycycle-connect)
--    2 orchestrator-only rows (logo, business-landing-page)
--
-- asset_user_editable FALSE (6):
--   logo, banking-setup-guide, stripe-connect-setup,
--   llc-ccorp-registration, task-queue-built, daycycle-connect
--
-- is_regeneratable FALSE (5):
--   banking-setup-guide, stripe-connect-setup, llc-ccorp-registration,
--   task-queue-built, daycycle-connect
--
-- Apply AFTER migrations 030 and 031.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── 1. Lifecycle phase assignments ───────────────────────────────────

UPDATE public.tasks t SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'idea'
  AND t.slug IN (
    'research-strategy',
    'lean-canvas',
    'mentor-identification',
    'personal-landing-page'
  );

UPDATE public.tasks t SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'business-creation'
  AND t.slug IN (
    'mission-document',
    'tam-sam-som',
    'competitive-analysis',
    'market-research-report',
    'investor-data-room',
    'pitch-deck',
    'investor-alignment',
    'accelerator-match',
    'banking-setup-guide',
    'cpa-bookkeeper',
    'llc-ccorp-registration',
    'executive-summary',
    'investor-deck',
    'task-queue-built',
    'dashboard-briefing'
  );

UPDATE public.tasks t SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'product-creation'
  AND t.slug IN (
    'logo',
    'stripe-connect-setup',
    'business-partners',
    'mission-dashboard'
  );

UPDATE public.tasks t SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'product-marketing'
  AND t.slug IN (
    'launch-tweet',
    'public-business-website',
    'business-landing-page',
    'cold-email-outreach',
    'social-content-plan',
    'personalized-pitch-email',
    'marketing-channels',
    'welcome-email'
  );

UPDATE public.tasks t SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'success-measurement'
  AND t.slug IN (
    'exit-strategy',
    'daycycle-connect'
  );

-- NOTE: 'product-fulfillment' has no V1 tasks assigned — reserved for future.

-- ── 2. is_regeneratable: 5 one-time setup tasks → FALSE ──────────────
-- All others retain default TRUE (already set by migration 030 default).
UPDATE public.tasks SET is_regeneratable = false
WHERE slug IN (
  'banking-setup-guide',
  'stripe-connect-setup',
  'llc-ccorp-registration',
  'task-queue-built',
  'daycycle-connect'
);

-- ── 3. asset_user_editable: 27 tasks → TRUE ──────────────────────────
-- 6 tasks stay FALSE (logo, banking-setup-guide, stripe-connect-setup,
-- llc-ccorp-registration, task-queue-built, daycycle-connect).
UPDATE public.tasks SET asset_user_editable = true
WHERE slug IN (
  -- idea phase
  'research-strategy',
  'lean-canvas',
  'mentor-identification',
  'personal-landing-page',
  -- business-creation phase
  'mission-document',
  'tam-sam-som',
  'competitive-analysis',
  'market-research-report',
  'investor-data-room',
  'pitch-deck',
  'investor-alignment',
  'accelerator-match',
  'cpa-bookkeeper',
  'executive-summary',
  'investor-deck',
  'dashboard-briefing',
  -- product-creation phase
  'business-partners',
  'mission-dashboard',
  -- product-marketing phase
  'launch-tweet',
  'public-business-website',
  'business-landing-page',
  'cold-email-outreach',
  'social-content-plan',
  'personalized-pitch-email',
  'marketing-channels',
  'welcome-email',
  -- success-measurement phase
  'exit-strategy'
);

-- ── 4. task_apis: API binding rows ───────────────────────────────────

-- All 33 tasks get anthropic-claude-sonnet as primary
INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE a.slug = 'anthropic-claude-sonnet'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- logo: primary = falai-flux-image (not claude-sonnet), secondary = claude-haiku
-- Remove the claude-sonnet primary that was just inserted for logo
DELETE FROM public.task_apis
WHERE task_id = (SELECT id FROM public.tasks WHERE slug = 'logo')
  AND api_id  = (SELECT id FROM public.external_apis WHERE slug = 'anthropic-claude-sonnet')
  AND role    = 'primary';

INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t, public.external_apis a
WHERE t.slug = 'logo' AND a.slug = 'falai-flux-image'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'secondary'
FROM public.tasks t, public.external_apis a
WHERE t.slug = 'logo' AND a.slug = 'anthropic-claude-haiku'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- public-business-website + business-landing-page: add falai-flux-image as secondary
INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'secondary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug IN ('public-business-website', 'business-landing-page')
  AND a.slug = 'falai-flux-image'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- cold-email-outreach + welcome-email + personalized-pitch-email: add sendgrid as secondary
INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'secondary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug IN ('cold-email-outreach', 'welcome-email', 'personalized-pitch-email')
  AND a.slug = 'sendgrid-email'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────
-- SELECT slug, name, sort_order FROM lifecycle_phases ORDER BY sort_order;
--
-- SELECT t.slug, lp.name AS phase, t.is_regeneratable, t.asset_user_editable
-- FROM tasks t LEFT JOIN lifecycle_phases lp ON lp.id = t.lifecycle_phase_id
-- ORDER BY t.execution_order;
--
-- SELECT t.slug, a.slug AS api, ta.role
-- FROM task_apis ta
-- JOIN tasks t ON t.id = ta.task_id
-- JOIN external_apis a ON a.id = ta.api_id
-- ORDER BY t.execution_order, ta.role;
--
-- SELECT COUNT(*) FILTER (WHERE asset_user_editable = false) AS false_count,
--        COUNT(*) FILTER (WHERE asset_user_editable = true)  AS true_count
-- FROM tasks;   -- expect: false=6, true=27

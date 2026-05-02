-- Migration 013: add execution_order to tasks
-- Controls the display and pipeline ordering of tasks in the dashboard.
-- Default = 99 so unknown tasks sort to the bottom.

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS execution_order integer DEFAULT 99;

-- Free build pipeline order
UPDATE public.tasks SET execution_order = 1 WHERE slug = 'research-strategy';
UPDATE public.tasks SET execution_order = 2 WHERE slug IN (
  'mission-document', 'welcome-email', 'tam-sam-som',
  'daycycle-connect', 'personalized-pitch-email'
);
UPDATE public.tasks SET execution_order = 3 WHERE slug IN (
  'launch-tweet', 'personal-landing-page', 'task-queue-built'
);
UPDATE public.tasks SET execution_order = 4 WHERE slug = 'dashboard-briefing';

-- Paid + premium tasks sort after free build tasks
UPDATE public.tasks SET execution_order = 10 WHERE plan_required IN ('core_paid', 'premium_only');

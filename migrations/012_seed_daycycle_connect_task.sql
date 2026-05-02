-- Migration 012: Add daycycle-connect to the tasks catalog
-- This is the 10th default task in the free build pipeline (V1 stub).
-- Full Google Places integration ships Sprint 8.

INSERT INTO public.tasks
    (slug, name, description_short, area, is_default, plan_required,
     visibility, price_cents, output_type, prompt_template)
VALUES
    ('daycycle-connect',
     'DayCycle Setup',
     'Stage your DayCycle profile — your daily concierge for work, health, and life.',
     'daycycle', true, 'free', 'always_visible', 0, 'structured_data',
     'V1 stub: reserves the DayCycle locations asset slot. Full Google Places API location discovery ships Sprint 8.')
ON CONFLICT (slug) DO NOTHING;

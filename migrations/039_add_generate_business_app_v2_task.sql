-- =====================================================================
-- Migration 039: Add generate-business-app-v2 task
-- =====================================================================
-- Adds the new v2 archetype-driven app generation task to the catalog.
-- This task uses the Homer assembler foundation to generate apps via
-- structured LLM content + archetype assembly, versus v1's direct HTML
-- generation approach.
--
-- Task characteristics:
--   kind:             configured (no config page, picker UI handles archetype selection)
--   plan_required:    core_paid (same as other premium generation tasks)
--   token_cost:       5 (same tier as business-website-rebuild)
--   area:             business_builder (logical grouping with other app tasks)
--   visibility:       always_visible (available to all subscribed operators)
-- =====================================================================

INSERT INTO public.tasks
    (slug, name, description_short, area, is_default, plan_required,
     visibility, price_cents, output_type, prompt_template, status,
     kind, config_page_path, token_cost)
VALUES
    ('generate-business-app-v2',
     'Generate Mini-App (v2 / Homer)',
     'Generates a Homer-styled mini-app from one of three archetypes (Strategy, Assessment, Calculator). Operator selects archetype + describes intent.',
     'business_builder', false, 'core_paid', 'always_visible', 0, 'app',
     'Archetype-driven app generation via structured LLM content + assembler. See src/lib/tasks/generate-business-app-v2.ts for implementation.',
     'active', 'configured', null, 5)
ON CONFLICT (slug) DO NOTHING;
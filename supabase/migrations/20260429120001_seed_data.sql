-- TextOS Agent — Sprint 2 seed data
--
-- 4 subscription plans + 30 tasks (9 free defaults, 8 paid-bundle,
-- 13 premium / à la carte).
--
-- Prompt templates here are intentional placeholders — production-quality
-- prompt engineering happens in Sprint 5. Each one is a 2-3 sentence
-- non-empty description so the catalog is well-formed.

-- =====================================================================
-- subscription_plans
-- =====================================================================
insert into public.subscription_plans
    (slug, name, monthly_cents, one_time_cents, business_quota,
     includes_premium_tasks, is_grandfathered, cohort_limit, is_active)
values
    ('free',     'Free',              0,    0,  1, false, false, null, true),
    ('founders', 'Founders Lock-In', 999, 4999, 10, false, true,  1000, true),
    ('standard', 'Standard',        2999,    0, 10, false, false, null, true),
    ('pro',      'Pro',             9999,    0, 10, true,  false, null, true);

-- =====================================================================
-- tasks — 9 free defaults (run automatically during the free build)
-- =====================================================================
insert into public.tasks
    (slug, name, description_short, area, is_default, plan_required,
     visibility, price_cents, output_type, prompt_template)
values
    ('research-strategy',
     'Research + Strategy',
     'Web search the user''s background and the market context for the new business.',
     'business_builder', true, 'free', 'always_visible', 0, 'report',
     'Sprint 2 placeholder. Run web_search on the user background and market. Produce a 1-page strategy document covering audience, positioning, and immediate next moves.'),

    ('welcome-email',
     'Welcome Email',
     'Send a personalized welcome email from yourbusiness@textos.ai.',
     'business_builder', true, 'free', 'always_visible', 0, 'document',
     'Sprint 2 placeholder. Compose a 4-paragraph welcome email referencing the user''s name, the new business name, and the next three actions TextOS will take. Tone: warm, founder-to-founder.'),

    ('launch-tweet',
     'Launch Tweet',
     'Draft a launch tweet announcing the new business.',
     'business_builder', true, 'free', 'always_visible', 0, 'document',
     'Sprint 2 placeholder. Draft a single tweet (max 280 chars) introducing the new business, its primary value prop, and a CTA to the public website. Match the user''s voice from prior content.'),

    ('personal-landing-page',
     'Personal Landing Page',
     'Generate the user''s public Personal Website at {handle}.app.textos.ai.',
     'personal_website', true, 'free', 'always_visible', 0, 'generated_site',
     'Sprint 2 placeholder. Produce a single-page Personal Website with bio, photo placeholder, links, schema.org Person markup, llms.txt, and OG/Twitter cards.'),

    ('mission-document',
     'Mission Document',
     'Save the business mission statement, problem framing, and 90-day plan.',
     'business_builder', true, 'free', 'always_visible', 0, 'document',
     'Sprint 2 placeholder. Produce a 1-page mission document: problem statement, target customer, north-star metric, 90-day plan. Filed under the business in the user''s account.'),

    ('task-queue-built',
     'Task Queue Built',
     'Populate the paid-bundle task list (locked until subscription).',
     'business_builder', true, 'free', 'always_visible', 0, 'structured_data',
     'Sprint 2 placeholder. Insert task_runs rows for the 8 paid-bundle tasks in status=''queued'' so the Business Builder dashboard renders them as locked.'),

    ('dashboard-briefing',
     'Dashboard Briefing',
     'Agent summarizes what it learned during the free build.',
     'business_builder', true, 'free', 'always_visible', 0, 'document',
     'Sprint 2 placeholder. Produce a 5-bullet briefing summarizing what was learned in research-strategy and what the 8 paid-bundle tasks will accomplish if unlocked. Surface in Col 1 of the dashboard.'),

    ('personalized-pitch-email',
     'Personalized Pitch Email',
     'Compose a pitch email that references the user''s real background.',
     'business_builder', true, 'free', 'always_visible', 0, 'document',
     'Sprint 2 placeholder. Compose a personalized pitch email the user can send to their first 5 prospects. Reference real background details from research-strategy.'),

    ('tam-sam-som',
     'Market Size: TAM / SAM / SOM',
     'Compute total, serviceable, and obtainable market — TAM visible free; SAM/SOM blurred until paid.',
     'business_builder', true, 'free', 'teaser_locked', 0, 'report',
     'Sprint 2 placeholder. Compute TAM, SAM, and SOM with a one-line method note for each. Frontend renders TAM open and blurs SAM/SOM until the user is on Tier 1/2/3.');

-- =====================================================================
-- tasks — 8 paid-bundle (unlock on Tier 1/2/3 subscription)
-- =====================================================================
insert into public.tasks
    (slug, name, description_short, area, is_default, plan_required,
     visibility, price_cents, output_type, prompt_template)
values
    ('competitive-analysis',
     'Competitive Analysis',
     'Identify direct + adjacent competitors with a side-by-side comparison.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'report',
     'Sprint 2 placeholder. Identify 5-10 competitors, build a comparison table (offering, price, differentiator, weakness), output a 1-page narrative.'),

    ('market-research-report',
     'Market Research Report',
     'Detailed market sizing, segment breakdown, growth trends, regulatory notes.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'report',
     'Sprint 2 placeholder. Produce a 3-5 page market research report with TAM/SAM/SOM detail, segment breakdown, growth trends, and regulatory considerations.'),

    ('mission-dashboard',
     'Mission Dashboard',
     'Live dashboard at /dashboard with KPI cards.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'dashboard_view',
     'Sprint 2 placeholder. Render KPI cards (signups, revenue, content posted, outreach sent) sourced from the business''s task_runs and downstream services.'),

    ('public-business-website',
     'Public Business Website',
     'Full marketing site with fal.ai hero, OG/Twitter cards, schema.org, llms.txt.',
     'public_business_website', false, 'core_paid', 'fully_locked', 0, 'generated_site',
     'Sprint 2 placeholder. Generate a multi-section marketing site at {businessSlug}.app.textos.ai. Includes hero (fal.ai image), value props, social proof block, contact form, schema.org Organization/LocalBusiness/Product, llms.txt, sitemap.xml, robots.txt, OG + Twitter cards.'),

    ('cold-email-outreach',
     'Cold Email Outreach',
     'Hunter.io + Claude + SendGrid pipeline.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'document',
     'Sprint 2 placeholder. Find target prospects with Hunter.io, draft personalized emails (subject [benefit]—[pain saved], 3 short paragraphs, one-question CTA), schedule sends through SendGrid. Footer: This company runs autonomously · textos.ai.'),

    ('social-content-plan',
     'Social Content Plan',
     '30-day calendar + Buffer queue.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'document',
     'Sprint 2 placeholder. Produce a 30-day social calendar (mix of educational, social proof, behind-the-scenes, CTA) and queue posts via Buffer.'),

    ('investor-data-room',
     'Investor Data Room',
     'Auto-filed documents at /investor.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'document',
     'Sprint 2 placeholder. Compile mission, market research, competitive analysis, financials, and team bios into a /investor route with permission-gated download links.'),

    ('stripe-connect-setup',
     'Stripe Connect Setup',
     'Guided Express onboarding for the user''s business.',
     'business_builder', false, 'core_paid', 'fully_locked', 0, 'document',
     'Sprint 2 placeholder. Walk the user through Stripe Express onboarding for the business so revenue routes to their account. Persist the connected_account_id under the business row.');

-- =====================================================================
-- tasks — 13 premium / à la carte (purchased individually OR included in
-- Tier 3 Pro)
-- =====================================================================
insert into public.tasks
    (slug, name, description_short, area, is_default, plan_required,
     visibility, price_cents, output_type, prompt_template)
values
    ('exit-strategy',
     'Exit Strategy',
     'Plan acquisition, IPO, or asset-sale paths with realistic comps.',
     'business_builder', false, 'premium_only', 'fully_locked', 1999, 'report',
     'Sprint 2 placeholder. Draft an exit strategy document: target acquirer profiles, comparable exits, valuation range, prep checklist.'),

    ('pitch-deck',
     'Pitch Deck',
     'Auto-generate a pitch deck from accumulated business data.',
     'business_builder', false, 'premium_only', 'fully_locked', 2999, 'document',
     'Sprint 2 placeholder. Auto-generate a 12-slide investor pitch deck pulling from mission, market research, competitive analysis, and traction.'),

    ('lean-canvas',
     'Lean Canvas',
     'One-page business model canvas.',
     'business_builder', false, 'premium_only', 'fully_locked', 999, 'document',
     'Sprint 2 placeholder. Fill out a Lean Canvas (problem, customer segments, UVP, solution, channels, revenue, costs, key metrics, unfair advantage) using business data on file.'),

    ('investor-alignment',
     'Investor Alignment Report',
     'Match the business to investor profiles likely to invest.',
     'business_builder', false, 'premium_only', 'fully_locked', 1499, 'report',
     'Sprint 2 placeholder. Match the business stage, sector, and geography against investor profiles. Output ranked list with rationale and warm-intro paths.'),

    ('accelerator-match',
     'Accelerator / Incubator Match',
     'Identify accelerators that fit the business stage and sector.',
     'business_builder', false, 'premium_only', 'fully_locked', 1499, 'report',
     'Sprint 2 placeholder. Identify 5-10 accelerators/incubators matching stage, sector, and geography. Output ranked list with deadlines and application strategy.'),

    ('mentor-identification',
     'Mentor Identification',
     'Surface subject-matter experts in the user''s space.',
     'business_builder', false, 'premium_only', 'fully_locked', 1999, 'report',
     'Sprint 2 placeholder. Identify subject-matter experts in the user''s sector. Output ranked list with contact paths and an outreach template.'),

    ('marketing-channels',
     'Marketing Channel Recommendations',
     'Rank acquisition channels by fit, cost, and time-to-result.',
     'business_builder', false, 'premium_only', 'fully_locked', 1499, 'report',
     'Sprint 2 placeholder. Rank acquisition channels (SEO, paid social, partnerships, cold outreach, content) by fit, expected CAC, and time-to-result for this business.'),

    ('business-partners',
     'Potential Business Partners',
     'Named partners with contact paths.',
     'business_builder', false, 'premium_only', 'fully_locked', 1999, 'report',
     'Sprint 2 placeholder. Identify potential business partners (suppliers, distributors, integration partners, co-marketing partners). Output named list with contact paths.'),

    ('banking-setup-guide',
     'Banking Setup Guide',
     'Walkthrough for opening a business bank account.',
     'business_builder', false, 'premium_only', 'fully_locked', 999, 'document',
     'Sprint 2 placeholder. Produce a step-by-step guide for opening a business bank account: ranked bank list, required docs, account-feature comparison.'),

    ('cpa-bookkeeper',
     'CPA / Bookkeeper Recommendations',
     'Match the business to a CPA or bookkeeper.',
     'business_builder', false, 'premium_only', 'fully_locked', 999, 'report',
     'Sprint 2 placeholder. Recommend CPAs and bookkeepers fitting the business size, sector, and geography. Output ranked list with intro template.'),

    ('llc-ccorp-registration',
     'LLC / C-Corp Registration Guide',
     'Decide LLC vs C-Corp and walk through registration.',
     'business_builder', false, 'premium_only', 'fully_locked', 1499, 'document',
     'Sprint 2 placeholder. Recommend LLC vs C-Corp based on the business model and goals. Walk the user through registration steps for the chosen structure in their state.'),

    ('executive-summary',
     'Executive Summary',
     'One-pager for partners, investors, or press.',
     'business_builder', false, 'premium_only', 'fully_locked', 1999, 'document',
     'Sprint 2 placeholder. Produce a 1-page executive summary suitable for partners, investors, or press inquiries. Pulls from mission, market, traction.'),

    ('investor-deck',
     'Investor Deck',
     'Long-form deck for serious fundraising.',
     'business_builder', false, 'premium_only', 'fully_locked', 2999, 'document',
     'Sprint 2 placeholder. Produce a 20-slide investor deck (longer than pitch-deck): problem, market, product, traction, business model, competition, team, financials, ask, use of funds.');

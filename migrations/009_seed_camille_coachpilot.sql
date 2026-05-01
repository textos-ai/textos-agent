-- Sprint 5 Seed: Camille at the Roosevelt + CoachPilot
--
-- Creates two demo businesses with full business_context + 9 completed
-- task_runs per business. Paid bundle tasks (locked) appear automatically
-- from the tasks catalog — no task_runs needed for them.
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- PRECONDITION: Both users must already exist in public.users.
-- Run first to verify:
--   SELECT id, email FROM public.users
--   WHERE email IN ('cgaudet2023@gmail.com', 'rgaudet2023@gmail.com');

DO $$
DECLARE
  camille_uid  UUID;
  rob_alt_uid  UUID;
  cam_biz_id   UUID;
  coach_biz_id UUID;
  v_task_id    UUID;
  v_now        TIMESTAMPTZ := NOW();
BEGIN

  -- ── Resolve user IDs ─────────────────────────────────────────────────────
  SELECT id INTO camille_uid FROM public.users WHERE email = 'cgaudet2023@gmail.com';
  SELECT id INTO rob_alt_uid FROM public.users WHERE email = 'rgaudet2023@gmail.com';

  IF camille_uid IS NULL THEN
    RAISE EXCEPTION 'User cgaudet2023@gmail.com not found — sign in first to create the user row.';
  END IF;
  IF rob_alt_uid IS NULL THEN
    RAISE EXCEPTION 'User rgaudet2023@gmail.com not found — sign in first to create the user row.';
  END IF;

  -- ── Set handles (only if not already set) ───────────────────────────────
  -- Without a handle, has_handle=false → auth callback sends user to /onboarding
  -- instead of /, so the business redirect never fires.
  UPDATE public.users SET handle = 'camille'
  WHERE id = camille_uid AND handle IS NULL;

  UPDATE public.users SET handle = 'rgaudet2'
  WHERE id = rob_alt_uid AND handle IS NULL;

  -- ══════════════════════════════════════════════════════════════════════════
  -- A. CAMILLE AT THE ROOSEVELT — children's book author
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.businesses (user_id, slug, name, kind, created_at)
  VALUES (camille_uid, 'camille-at-the-roosevelt', 'Camille at the Roosevelt', 'new_idea',
          v_now - INTERVAL '3 hours')
  ON CONFLICT (user_id, slug) DO NOTHING;

  SELECT id INTO cam_biz_id FROM public.businesses
  WHERE user_id = camille_uid AND slug = 'camille-at-the-roosevelt';

  INSERT INTO public.business_context (
    business_id, user_id,
    agent_name,
    business_summary, industry, business_model,
    market_size, target_customer, positioning_statement,
    key_differentiators, competitors, market_trends,
    research_confidence_score, last_research_run_at,
    created_at, updated_at
  ) VALUES (
    cam_biz_id, camille_uid,
    'Bramble',
    'A children''s book author building a direct publishing business — writing picture books that meet children where they are and selling direct to parents, schools, and libraries.',
    'Children''s Book Publishing',
    'creative_services',
    '{"tam_usd":4200000000,"sam_usd":380000000,"som_usd":12000000,"currency":"USD","notes":"US children''s book market, ages 4-8 picture book segment"}'::jsonb,
    '{"primary":"Parents and caregivers of children ages 4-10","secondary":"Librarians and educators seeking high-quality picture books","tertiary":"Grandparents buying gifts for young readers"}'::jsonb,
    'Books that feel like they already belong on a child''s shelf — warm, honest, and alive with possibility.',
    '["Direct author-to-reader relationship with personal story","Multicultural representation woven in naturally, never forced","Pricing positioned between mass-market and indie premium"]'::jsonb,
    '[{"name":"Penguin Random House","strength":"Distribution and marketing scale","weakness":"Author share and speed-to-market"},{"name":"Usborne Books","strength":"Home party sales model","weakness":"Limited digital direct"},{"name":"Barefoot Books","strength":"Multicultural focus","weakness":"Smaller catalog"}]'::jsonb,
    '["Self-publishing removing gatekeeping barriers","TikTok BookTok driving indie author discovery","Direct-to-consumer shifting revenue back to creators","AI tools compressing production timelines for small publishers"]'::jsonb,
    82,
    v_now - INTERVAL '3 hours',
    v_now - INTERVAL '3 hours', v_now - INTERVAL '3 hours'
  )
  ON CONFLICT (business_id) DO UPDATE SET
    agent_name = EXCLUDED.agent_name,
    business_summary = EXCLUDED.business_summary,
    industry = EXCLUDED.industry,
    business_model = EXCLUDED.business_model,
    market_size = EXCLUDED.market_size,
    updated_at = NOW();

  -- 9 completed task_runs for Camille
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'research-strategy' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '3 hours',
      v_now - INTERVAL '3 hours',
      v_now - INTERVAL '2 hours 58 minutes',
      '[]'::jsonb,
      '{"strategy":"Direct Publishing","reasoning":"Children''s book market is shifting toward direct-to-consumer as self-publishing tools mature and BookTok drives discovery. Author-owned catalog with direct school/library relationships is the durable competitive position.","confidence":0.82,"key_insights":["BookTok drives 40%+ of indie children''s book discovery","School and library direct sales bypass Amazon margin compression","Print-on-demand eliminates inventory risk for new titles"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'welcome-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 58 minutes',
      v_now - INTERVAL '2 hours 58 minutes',
      v_now - INTERVAL '2 hours 56 minutes',
      '[]'::jsonb,
      '{"sent_to":"cgaudet2023@gmail.com","from":"camilleattheroo@textos.ai","subject":"Welcome to Camille at the Roosevelt — your book business is ready","preview":"I''ve set up your publishing business. Here''s what I built while we were getting acquainted: market research, a mission document, and your first task queue ready to go.","sent_at":"2026-05-01T10:02:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'launch-tweet' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 56 minutes',
      v_now - INTERVAL '2 hours 56 minutes',
      v_now - INTERVAL '2 hours 54 minutes',
      '[]'::jsonb,
      '{"tweet":"Children''s books that feel like they were already on the shelf. Writing stories that meet kids where they actually are — not where adults wish they were. New chapter starting. camille-at-the-roosevelt.app.textos.ai","character_count":218,"suggested_at":"2026-05-01T10:04:00Z","status":"drafted_ready_to_post"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'mission-document' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 54 minutes',
      v_now - INTERVAL '2 hours 54 minutes',
      v_now - INTERVAL '2 hours 51 minutes',
      '[]'::jsonb,
      '{"mission":"Spark imagination and wonder in young readers through storytelling that meets them where they are — at the breakfast table, on the bus, at bedtime.","vision":"By 2028, Camille at the Roosevelt has 12 published titles in 800+ school libraries, a direct subscriber list of 4,000 families, and generates $180K/yr from books alone.","values":["Honest characters over perfect ones","Wonder over didacticism","The child''s perspective, always","Stories that parents re-read by choice"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'task-queue-built' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 51 minutes',
      v_now - INTERVAL '2 hours 51 minutes',
      v_now - INTERVAL '2 hours 50 minutes',
      '[]'::jsonb,
      '{"proposed_count":3,"paid_bundle_count":8,"premium_count":13,"message":"I''ve outlined 3 immediate tasks and 21 paid-bundle tasks ready to execute on subscription. The first three are the highest-leverage starting points for a new children''s book business."}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'dashboard-briefing' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 50 minutes',
      v_now - INTERVAL '2 hours 50 minutes',
      v_now - INTERVAL '2 hours 48 minutes',
      '[]'::jsonb,
      '{"briefing":"The children''s book market is $4.2B with real gaps in the 4-8 age range for multicultural picture books with strong voice. BookTok is your acquisition channel. School and library direct sales are your revenue backbone. No AI-native competitor has entered this space. Bramble is ready to build.","confidence_score":82}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personalized-pitch-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 48 minutes',
      v_now - INTERVAL '2 hours 48 minutes',
      v_now - INTERVAL '2 hours 45 minutes',
      '[]'::jsonb,
      '{"recipient":"cgaudet2023@gmail.com","subject":"Why Camille at the Roosevelt has the right story for right now","body_summary":"The shift toward direct-to-consumer publishing and the BookTok discovery engine have opened a real window for author-owned children''s book brands. The gap in authentic multicultural picture books for ages 4-8 is measurable and monetizable. I think you''re positioned to fill it.","sent_at":"2026-05-01T10:15:00Z","status":"delivered"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'tam-sam-som' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 45 minutes',
      v_now - INTERVAL '2 hours 45 minutes',
      v_now - INTERVAL '2 hours 43 minutes',
      '[]'::jsonb,
      '{"tam":{"value_usd":4200000000,"label":"$4.2B","description":"US children''s book market, all ages and formats"},"sam":{"value_usd":380000000,"label":"$380M","description":"Picture books ages 4-8, independent and small-press segment"},"som":{"value_usd":12000000,"label":"$12M","description":"Direct-to-consumer author brands via school/library and DTC channels over 5 years"}}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personal-landing-page' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (camille_uid, cam_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours 43 minutes',
      v_now - INTERVAL '2 hours 43 minutes',
      v_now - INTERVAL '2 hours 40 minutes',
      '[]'::jsonb,
      '{"url":"https://camille.app.textos.ai/","deployed":true,"hero_headline":"Camille Gaudet","hero_subheadline":"Children''s book author. Building Camille at the Roosevelt — stories that meet kids where they actually are.","deployed_at":"2026-05-01T10:20:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- B. COACHPILOT — AI coaching for rgaudet2023@gmail.com
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.businesses (user_id, slug, name, kind, created_at)
  VALUES (rob_alt_uid, 'coachpilot', 'CoachPilot', 'new_idea',
          v_now - INTERVAL '2 hours')
  ON CONFLICT (user_id, slug) DO NOTHING;

  SELECT id INTO coach_biz_id FROM public.businesses
  WHERE user_id = rob_alt_uid AND slug = 'coachpilot';

  INSERT INTO public.business_context (
    business_id, user_id,
    agent_name,
    business_summary, industry, business_model,
    market_size, target_customer, positioning_statement,
    key_differentiators, competitors, market_trends,
    research_confidence_score, last_research_run_at,
    created_at, updated_at
  ) VALUES (
    coach_biz_id, rob_alt_uid,
    'Tweed',
    'An AI coaching platform that helps ambitious solopreneurs and mid-career professionals work through stuck moments — available at 2am when the breakthrough hits, not just during scheduled sessions.',
    'AI Coaching & Personal Development',
    'saas_subscription',
    '{"tam_usd":15600000000,"sam_usd":1200000000,"som_usd":35000000,"currency":"USD","notes":"Global personal coaching market shifting toward AI-augmented services; $15.6B total, AI-native segment growing 40% YoY"}'::jsonb,
    '{"primary":"Solopreneurs and founders in early-stage businesses (1-3 years in)","secondary":"Mid-career professionals navigating pivots or promotions","tertiary":"Ambitious individuals who can''t afford $300/hr human coaches"}'::jsonb,
    'The coach that''s actually there — not just for the weekly check-in, but for the 2am breakthrough and the Tuesday afternoon spiral.',
    '["Available at the exact moment the user needs it, not by appointment","Remembers everything across all sessions unlike human coaches","Fraction of human coaching cost with compounding context","No judgment, no agenda, no upsell"]'::jsonb,
    '[{"name":"BetterUp","strength":"Enterprise distribution and brand","weakness":"High price point, corporate focus"},{"name":"Noom","strength":"Behavior change methodology at scale","weakness":"Health-only, no business/career coaching"},{"name":"CoachHub","strength":"Corporate B2B","weakness":"$500+/session, not accessible to individuals"}]'::jsonb,
    '["AI replacing transactional coaching tasks while human coaches move upmarket","Solopreneur economy growing — more people need coaching, fewer can afford traditional rates","Voice and asynchronous AI creating new coaching modalities","Enterprise coaching shifting toward AI-augmented hybrid models"]'::jsonb,
    79,
    v_now - INTERVAL '2 hours',
    v_now - INTERVAL '2 hours', v_now - INTERVAL '2 hours'
  )
  ON CONFLICT (business_id) DO UPDATE SET
    agent_name = EXCLUDED.agent_name,
    business_summary = EXCLUDED.business_summary,
    industry = EXCLUDED.industry,
    business_model = EXCLUDED.business_model,
    market_size = EXCLUDED.market_size,
    updated_at = NOW();

  -- 9 completed task_runs for CoachPilot
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'research-strategy' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '2 hours',
      v_now - INTERVAL '2 hours',
      v_now - INTERVAL '1 hour 58 minutes',
      '[]'::jsonb,
      '{"strategy":"AI-Augmented Coaching","reasoning":"The $15.6B coaching market is structurally inaccessible to most individuals due to price. AI removes that barrier while the solopreneur economy creates a massive underserved segment that needs coaching more than ever.","confidence":0.79,"key_insights":["40M+ solopreneurs in the US, fewer than 5% can afford regular coaching","Coaching effectiveness research shows availability at moment-of-need is more predictive of outcomes than session frequency","No AI-native coaching product has achieved significant consumer traction yet — market is wide open"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'welcome-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 58 minutes',
      v_now - INTERVAL '1 hour 58 minutes',
      v_now - INTERVAL '1 hour 56 minutes',
      '[]'::jsonb,
      '{"sent_to":"rgaudet2023@gmail.com","from":"coachpilot@textos.ai","subject":"Welcome to CoachPilot — your coaching business is ready","preview":"I''ve built CoachPilot. Market research filed, mission locked, task queue live. The AI coaching space has no dominant player yet. That''s the window.","sent_at":"2026-05-01T11:02:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'launch-tweet' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 56 minutes',
      v_now - INTERVAL '1 hour 56 minutes',
      v_now - INTERVAL '1 hour 54 minutes',
      '[]'::jsonb,
      '{"tweet":"Most people can''t afford a $300/hr coach. But the moments that need coaching don''t wait for your Wednesday 4pm slot. CoachPilot is the coach that''s actually there. coachpilot.app.textos.ai","character_count":199,"suggested_at":"2026-05-01T11:04:00Z","status":"drafted_ready_to_post"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'mission-document' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 54 minutes',
      v_now - INTERVAL '1 hour 54 minutes',
      v_now - INTERVAL '1 hour 51 minutes',
      '[]'::jsonb,
      '{"mission":"Help ambitious people work through stuck moments — not by replacing human coaches, but by being available at 2am when the breakthrough hits.","vision":"By 2028, CoachPilot has 10,000 active users generating $3M ARR, and a 5-year study showing measurably better outcomes than scheduled-only coaching.","values":["Availability over appointment","Context over generic advice","Honest pushback over validation","The user''s agenda, not ours"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'task-queue-built' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 51 minutes',
      v_now - INTERVAL '1 hour 51 minutes',
      v_now - INTERVAL '1 hour 50 minutes',
      '[]'::jsonb,
      '{"proposed_count":3,"paid_bundle_count":8,"premium_count":13,"message":"Task queue built. 3 immediate execution tasks proposed; 21 paid-bundle tasks staged. First priority: cold outreach to 10 solopreneurs who''ve publicly complained about coaching costs."}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'dashboard-briefing' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 50 minutes',
      v_now - INTERVAL '1 hour 50 minutes',
      v_now - INTERVAL '1 hour 48 minutes',
      '[]'::jsonb,
      '{"briefing":"The AI coaching space has no dominant consumer player. BetterUp owns enterprise, Noom owns health, but the solopreneur and career-pivoter segment is wide open. The $1,200/yr price point (equivalent to one session per month with a human coach) is the entry wedge. Tweed is ready to build.","confidence_score":79}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personalized-pitch-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 48 minutes',
      v_now - INTERVAL '1 hour 48 minutes',
      v_now - INTERVAL '1 hour 45 minutes',
      '[]'::jsonb,
      '{"recipient":"rgaudet2023@gmail.com","subject":"Why CoachPilot has a real window right now","body_summary":"You''ve built community infrastructure before — the Cajun Navy is proof you understand how to make help available at the moment people need it most, not when it''s convenient for the helper. CoachPilot is the same insight applied to professional development. The AI coaching market is wide open and you''re better positioned to build it than most.","sent_at":"2026-05-01T11:15:00Z","status":"delivered"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'tam-sam-som' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 45 minutes',
      v_now - INTERVAL '1 hour 45 minutes',
      v_now - INTERVAL '1 hour 43 minutes',
      '[]'::jsonb,
      '{"tam":{"value_usd":15600000000,"label":"$15.6B","description":"Global personal coaching market, all formats"},"sam":{"value_usd":1200000000,"label":"$1.2B","description":"AI-augmented and digital-first coaching, solopreneur and career segments"},"som":{"value_usd":35000000,"label":"$35M","description":"Direct consumer AI coaching subscriptions, US market, 5-year achievable"}}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personal-landing-page' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, state, proposed_at, started_at, completed_at, work_log, output_data)
    VALUES (rob_alt_uid, coach_biz_id, v_task_id, 'completed', 'complete',
      v_now - INTERVAL '1 hour 43 minutes',
      v_now - INTERVAL '1 hour 43 minutes',
      v_now - INTERVAL '1 hour 40 minutes',
      '[]'::jsonb,
      '{"url":"https://rob.app.textos.ai/","deployed":true,"hero_headline":"Rob Gaudet","hero_subheadline":"Founder. Builder of TextOS and CoachPilot. Previously: Cajun Navy, HomeWrite.com. Always working on the thing that shouldn''t exist yet.","deployed_at":"2026-05-01T11:20:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'Seed complete. Camille biz_id=%, CoachPilot biz_id=%', cam_biz_id, coach_biz_id;

END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT slug, name, user_id FROM public.businesses
WHERE slug IN ('camille-at-the-roosevelt', 'coachpilot')
ORDER BY slug;

SELECT b.slug, tr.state, COUNT(*) AS count
FROM public.task_runs tr
JOIN public.businesses b ON b.id = tr.business_id
WHERE b.slug IN ('camille-at-the-roosevelt', 'coachpilot')
GROUP BY b.slug, tr.state
ORDER BY b.slug, tr.state;

SELECT b.slug, bc.industry, bc.agent_name
FROM public.business_context bc
JOIN public.businesses b ON b.id = bc.business_id
WHERE b.slug IN ('camille-at-the-roosevelt', 'coachpilot')
ORDER BY b.slug;

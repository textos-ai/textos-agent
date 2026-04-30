-- TextOS Agent — Sprint 4/B: BeatPilot demo business seed
--
-- Creates the BeatPilot demo business + rich business_context + completed
-- task_runs for all 9 default tasks, keyed to robertkgaudet@gmail.com.
--
-- Safe to run multiple times: uses INSERT ... ON CONFLICT DO NOTHING or
-- conditional WHERE EXISTS blocks throughout.
--
-- Apply via Supabase SQL editor:
-- https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

-- =====================================================================
-- 1. Resolve user_id for robertkgaudet@gmail.com
-- =====================================================================
-- We'll use a CTE-based approach so everything runs in one statement.
-- If the user row doesn't exist yet, nothing inserts (safe no-op).

DO $$
DECLARE
  v_user_id   uuid;
  v_biz_id    uuid;
  v_ctx_id    uuid;
  v_task_id   uuid;
  v_now       timestamptz := now();
BEGIN

  -- 1. Find user
  SELECT id INTO v_user_id
  FROM public.users
  WHERE email = 'robertkgaudet@gmail.com'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'User robertkgaudet@gmail.com not found — seed skipped. Sign in first.';
    RETURN;
  END IF;

  -- 2. Create business (skip if already exists for this user+slug)
  INSERT INTO public.businesses (user_id, slug, name, kind, created_at)
  VALUES (v_user_id, 'beatpilot', 'BeatPilot', 'new_idea', v_now - interval '5 minutes')
  ON CONFLICT (user_id, slug) DO NOTHING;

  SELECT id INTO v_biz_id
  FROM public.businesses
  WHERE user_id = v_user_id AND slug = 'beatpilot';

  -- 3. Create business_context (skip if already exists)
  INSERT INTO public.business_context (
    business_id, user_id,
    business_summary, industry, business_model,
    target_customer, value_proposition,
    market_size, competitors, market_trends,
    positioning_statement, brand_voice, key_differentiators,
    last_research_run_at, research_confidence_score
  )
  VALUES (
    v_biz_id, v_user_id,
    'BeatPilot is an AI booking agent for independent DJs. It handles venue outreach, track promotion, and career growth autonomously — so DJs can focus on the music instead of the hustle.',
    'Music & Entertainment Services',
    'saas_marketplace',
    '{"description":"Independent DJs, music producers, and electronic music artists with 500-10K SoundCloud followers seeking to grow their booking opportunities","demographics":"Age 22-45, primarily urban, English-speaking","geography":"US, EU, UK metropolitan markets","psychographics":"Career-focused but creatively-protective; want growth without compromising artistic identity"}'::jsonb,
    'An always-on booking agent for DJs who don''t have managers. We do the outreach, you make the music.',
    '{"tam_usd":4200000000,"sam_usd":380000000,"som_usd":12000000,"methodology":"TAM: global music services market for independent artists, US Census + IFPI 2024 data. SAM: US/UK/EU markets only. SOM: 1% capture in years 1-3 of TAM-eligible DJs.","sources":["IFPI Global Music Report 2024","RIAA mid-year report 2024","DJ TechTools market data 2023"]}'::jsonb,
    '[{"name":"Groover","url":"https://groover.co","strengths":["Established curator network","Brand recognition"],"weaknesses":["Requires DJ to do all submission work manually"],"pricing":"$2-5/track per submission","positioning":"Track promotion, not booking"},{"name":"Gigwell","url":"https://gigwell.com","strengths":["Established booking workflow"],"weaknesses":["Built for established agents, not DIY DJs"],"pricing":"$50-100/mo","positioning":"Agency tooling"},{"name":"Vampr","url":"https://vampr.me","strengths":["Music networking community"],"weaknesses":["No booking automation"],"pricing":"Freemium","positioning":"Networking platform"}]'::jsonb,
    '["Independent music sector grew 5.2% in 2024 vs major labels'' 0.8%","70% of working DJs now self-promote via social media","AI agents in creative industries: 200% adoption growth in 2024","Streaming has decentralized music discovery, creating opportunity for booking platforms"]'::jsonb,
    'BeatPilot is the only AI booking agent built specifically for independent DJs.',
    'Confident, technical, irreverent. Talks like a producer talks. Doesn''t condescend.',
    '["Fully autonomous — DJs don''t manage outreach","Specialized for booking AND promotion","Direct integration with SoundCloud, Spotify for context","AI-generated personalized pitch emails per venue"]'::jsonb,
    v_now - interval '3 minutes',
    75
  )
  ON CONFLICT (business_id) DO NOTHING;

  -- ===================================================================
  -- 4. Default task_runs — one per default task, all completed
  -- ===================================================================

  -- research-strategy
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'research-strategy' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '5 minutes', v_now - interval '4 minutes 30 seconds',
      '{"strategy":"Novel Idea","reasoning":"DJ booking automation in independent music sector is underserved with strong tailwinds","confidence":0.78,"key_insights":["Independent music sector is the fastest growing segment","DJs spend 10-15 hrs/week on booking outreach with low conversion","AI booking agents have proven workflow in adjacent verticals (venue side)"]}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- welcome-email
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'welcome-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '4 minutes 30 seconds', v_now - interval '2 minutes',
      '{"sent_to":"robertkgaudet@gmail.com","from":"yourbusiness@textos.ai","subject":"Welcome to BeatPilot — your business is ready","preview":"I''ve built BeatPilot — an AI booking agent for independent DJs. Here''s what I set up while we were just getting acquainted...","sent_at":"2026-04-30T15:30:00Z"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- launch-tweet
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'launch-tweet' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '4 minutes', v_now - interval '3 minutes',
      '{"tweet":"Most DJs spend more time emailing promoters than making music. BeatPilot fixes that. An AI agent that books gigs, handles outreach, and grows your career while you focus on the mix. beatpilot-7.app.textos.ai","character_count":244,"suggested_at":"2026-04-30T15:28:00Z","status":"drafted_ready_to_post"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- personal-landing-page
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personal-landing-page' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '4 minutes', v_now - interval '3 minutes 30 seconds',
      '{"url":"https://robert.app.textos.ai/","deployed":true,"hero_headline":"Robert Gaudet","hero_subheadline":"Founder. Builder of agents. Currently building BeatPilot — an AI booking agent for independent DJs.","deployed_at":"2026-04-30T15:27:00Z"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- mission-document
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'mission-document' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '3 minutes 30 seconds', v_now - interval '3 minutes',
      '{"mission":"Every DJ deserves a manager. BeatPilot is mission-built to be that manager — autonomous, technical, always-on, and aligned with the artist''s vision rather than the venue''s revenue.","vision":"By 2030, BeatPilot represents over 1,000 working independent DJs with $50M in annual gig revenue routed through autonomous booking agents.","values":["Artistic integrity over engagement metrics","Autonomy over manual hustle","Technical excellence over salesy tactics","DJ-first over venue-first economics"]}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- task-queue-built
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'task-queue-built' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '3 minutes', v_now - interval '2 minutes 30 seconds',
      '{"proposed_count":3,"paid_bundle_count":8,"premium_count":13,"message":"I''ve proposed 3 tasks to start the BeatPilot MVP and outlined 21 more tasks that unlock with subscription. Ready to start the first three immediately on subscription."}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- dashboard-briefing
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'dashboard-briefing' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '2 minutes 30 seconds', v_now - interval '2 minutes',
      '{"briefing":"BeatPilot is positioned as ''the autonomous AI booking agent for independent DJs.'' Initial research suggests strong product-market fit in the 500-10K follower DJ segment, where artists want manager-level service without the cost. I''ve identified 3 immediate competitors (Groover, Gigwell, Vampr) and the differentiation is clear: full autonomy + AI personalization. Mission and brand voice are documented. Landing page is live. Ready for first MVP-build tasks on subscription."}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- personalized-pitch-email
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personalized-pitch-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '2 minutes', v_now - interval '1 minute',
      '{"recipient":"robertkgaudet@gmail.com","subject":"Why I built BeatPilot for you (in particular)","body_summary":"I noticed you''ve worked extensively with crisis response, founded the Cajun Navy, and have a background pulling people together via tech. BeatPilot is a different kind of community — independent DJs who need a manager — but the core insight is the same: people get further when someone autonomously handles the boring work for them. I think you''ll get this immediately.","sent_at":"2026-04-30T15:32:00Z","status":"delivered"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- tam-sam-som
  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'tam-sam-som' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (
      v_user_id, v_biz_id, v_task_id, 'completed',
      v_now - interval '1 minute 30 seconds', v_now - interval '1 minute',
      '{"tam":{"value_usd":4200000000,"label":"$4.2B","description":"Global music services market for independent artists"},"sam":{"value_usd":380000000,"label":"$380M","description":"US/UK/EU independent DJ market","BLURRED":true},"som":{"value_usd":12000000,"label":"$12M","description":"1% of SAM in years 1-3","BLURRED":true},"methodology":"Bottom-up market sizing using IFPI Global Music Report 2024, RIAA mid-year 2024, and DJ TechTools market data 2023."}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'BeatPilot seed complete for user %', v_user_id;
END $$;

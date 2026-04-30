-- TextOS Agent — Sprint 4.5/B: BeatPilot seed for rgaudet2023@gmail.com
--
-- The original seed (20260430150000) targets robertkgaudet@gmail.com (Google OAuth).
-- This migration extends it to rgaudet2023@gmail.com (magic link) so the founder
-- can log in with either account and see BeatPilot populated.
--
-- Safe to re-run: all inserts use ON CONFLICT DO NOTHING.
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

DO $$
DECLARE
  v_user_id   uuid;
  v_biz_id    uuid;
  v_task_id   uuid;
  v_now       timestamptz := now();
BEGIN

  SELECT id INTO v_user_id
  FROM public.users
  WHERE email = 'rgaudet2023@gmail.com'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'User rgaudet2023@gmail.com not found — seed skipped. Sign in with magic link first.';
    RETURN;
  END IF;

  INSERT INTO public.businesses (user_id, slug, name, kind, created_at)
  VALUES (v_user_id, 'beatpilot', 'BeatPilot', 'new_idea', v_now - interval '5 minutes')
  ON CONFLICT (user_id, slug) DO NOTHING;

  SELECT id INTO v_biz_id
  FROM public.businesses
  WHERE user_id = v_user_id AND slug = 'beatpilot';

  INSERT INTO public.business_context (
    business_id, user_id, agent_name,
    business_summary, industry, business_model,
    target_customer, value_proposition,
    market_size, competitors, market_trends,
    positioning_statement, brand_voice, key_differentiators,
    last_research_run_at, research_confidence_score
  )
  VALUES (
    v_biz_id, v_user_id, 'InkThorn',
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

  -- task_runs for all 9 default tasks

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'research-strategy' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '5 minutes', v_now - interval '4 minutes 30 seconds',
      '{"strategy":"Novel Idea","reasoning":"DJ booking automation in independent music sector is underserved with strong tailwinds","confidence":0.78,"key_insights":["Independent music sector is the fastest growing segment","DJs spend 10-15 hrs/week on booking outreach with low conversion","AI booking agents have proven workflow in adjacent verticals (venue side)"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'welcome-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '4 minutes 30 seconds', v_now - interval '2 minutes',
      '{"sent_to":"rgaudet2023@gmail.com","from":"beatpilot@textos.ai","subject":"Welcome to BeatPilot — your business is ready","preview":"I''ve built BeatPilot — an AI booking agent for independent DJs. Here''s what I set up while we were just getting acquainted...","sent_at":"2026-04-30T15:30:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'launch-tweet' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '4 minutes', v_now - interval '3 minutes',
      '{"tweet":"Most DJs spend more time emailing promoters than making music. BeatPilot fixes that. An AI agent that books gigs, handles outreach, and grows your career while you focus on the mix. beatpilot.textos.ai","character_count":220,"suggested_at":"2026-04-30T15:28:00Z","status":"drafted_ready_to_post"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personal-landing-page' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '4 minutes', v_now - interval '3 minutes 30 seconds',
      '{"url":"https://rob.app.textos.ai","template":"minimal_dark","sections":["bio","projects","contact"],"published_at":"2026-04-30T15:27:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'mission-document' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '3 minutes 30 seconds', v_now - interval '3 minutes',
      '{"mission":"BeatPilot exists to give every independent DJ the career infrastructure that only major-label artists used to have access to.","vision":"A world where creative talent is the only limiting factor in an artist''s success.","values":["Artist-first","Radical automation","Transparent AI"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'tam-sam-som' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '3 minutes', v_now - interval '2 minutes 30 seconds',
      '{"tam":{"value":4200000000,"label":"$4.2B","description":"Global music services market for independent artists"},"sam":{"value":380000000,"label":"$380M","description":"US/UK/EU independent DJ & producer services"},"som":{"value":12000000,"label":"$12M","description":"~1% capture in years 1-3"},"blurred":true}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'task-queue-built' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '2 minutes 30 seconds', v_now - interval '2 minutes',
      '{"message":"9 tasks queued. Free build complete.","task_count":9,"proposals":["Build the BeatPilot MVP: DJ profile + venue targeting","Scout the competition: Groover, Gigwell, Vampr deep-dive","Cold outreach to 10 independent DJs on SoundCloud"]}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'dashboard-briefing' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '2 minutes', v_now - interval '1 minute',
      '{"briefing":"BeatPilot is positioned in a $4.2B market with no direct AI-native competitor. The free build is complete: market research filed, mission documented, welcome email sent, launch tweet drafted. Next: activate paid bundle to run competitive deep-dive and cold outreach campaign.","mood":"Celebrating","confidence":0.78}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO v_task_id FROM public.tasks WHERE slug = 'personalized-pitch-email' LIMIT 1;
  IF v_task_id IS NOT NULL THEN
    INSERT INTO public.task_runs (user_id, business_id, task_id, status, started_at, completed_at, output_data)
    VALUES (v_user_id, v_biz_id, v_task_id, 'completed', v_now - interval '1 minute', v_now - interval '30 seconds',
      '{"sent_to":"rgaudet2023@gmail.com","subject":"BeatPilot is ready — here''s your 90-day playbook","body_summary":"Your market has $380M SAM and zero AI-native competitors. I''ve drafted a 90-day playbook: Weeks 1-4 build DJ profiles + venue database, Weeks 5-8 run first outreach campaigns, Weeks 9-12 analyze and optimize. Ready to execute when you are.","sent_at":"2026-04-30T15:32:00Z"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'BeatPilot seed complete for rgaudet2023@gmail.com (user_id: %)', v_user_id;
END $$;

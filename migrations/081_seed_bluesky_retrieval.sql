-- =====================================================================
-- Migration 081: seed the Bluesky retrieval vertical (config-row #1)
-- =====================================================================
-- Proves the external-retrieval ENGINE runs a platform search entirely from
-- config -- there is NO bluesky-specific code. Adds:
--   1. external_apis 'bluesky-search' (endpoint + auth_kind + request/response_map)
--   2. tasks 'bluesky-find-conversations' (output_type='retrieval') bound to it
--   3. tasks 'match-verify-leads' + 'draft-reply' (source-agnostic) + prompts
--   4. task_apis bindings
-- is_default stays FALSE during the proof; flip to true only after verify.
-- Idempotent. Pure ASCII. Apply via the Supabase SQL editor.
-- =====================================================================

-- 1. external_apis: Bluesky search (the whole platform, as data) ---------------
INSERT INTO public.external_apis (slug, name, provider, endpoint_url, auth_kind, output_kind, status, metadata)
VALUES (
  'bluesky-search', 'Bluesky Search', 'bluesky',
  'https://bsky.social/xrpc/app.bsky.feed.searchPosts',
  'atproto_session', 'retrieval', 'active',
  $json$ {
    "request": {
      "method": "GET",
      "query": { "q": "{{config.query}}", "limit": "{{config.limit}}", "sort": "latest" }
    },
    "response_map": {
      "items": "posts",
      "fields": {
        "title": "author.handle",
        "url": "https://bsky.app/profile/{{author.did}}/post/{{uri | after_last:/}}",
        "snippet": "record.text",
        "published_at": "record.createdAt",
        "external_id": "uri"
      }
    },
    "auth": {
      "token_url": "https://bsky.social/xrpc/com.atproto.server.createSession",
      "env": { "identifier": "BLUESKY_IDENTIFIER", "app_password": "BLUESKY_APP_PASSWORD" }
    }
  } $json$::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- 2/3. task rows --------------------------------------------------------------
INSERT INTO public.tasks
  (slug, name, description_short, area, is_default, plan_required, visibility,
   output_type, token_cost, kind, status, surface, progress_verb)
VALUES
  ('bluesky-find-conversations', 'Find Conversations (Bluesky)',
   'Search Bluesky for public conversations from this business''s potential customers.',
   'marketing', false, 'free', 'always_visible',
   'retrieval', 0, 'manual', 'active', 'silent', 'Finding conversations'),
  ('match-verify-leads', 'Verify and Score Leads',
   'Verify each found conversation resolves and is fresh, then score its relevance.',
   'marketing', false, 'free', 'always_visible',
   'structured_data', 0, 'manual', 'active', 'silent', 'Verifying leads'),
  ('draft-reply', 'Draft Replies',
   'Draft a helpful first reply for each verified lead.',
   'marketing', false, 'free', 'always_visible',
   'structured_data', 0, 'manual', 'active', 'silent', 'Drafting replies')
ON CONFLICT (slug) DO NOTHING;

-- 4. task_apis bindings -------------------------------------------------------
-- find-conversations -> bluesky-search (the retrieval engine reads this)
INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug = 'bluesky-find-conversations' AND a.slug = 'bluesky-search'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- match-verify + draft-reply -> sonnet (they call Anthropic to score/draft)
INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug IN ('match-verify-leads', 'draft-reply')
  AND a.slug = 'anthropic-claude-sonnet'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- 5. prompt_definitions (config-driven scoring + drafting) --------------------
UPDATE public.prompt_definitions SET is_active = false
  WHERE task_slug IN ('match-verify-leads', 'draft-reply') AND is_active = true;

INSERT INTO public.prompt_definitions (task_slug, version, system_prompt, user_prompt_template, is_active)
VALUES (
  'match-verify-leads', 1,
  $pd$You score whether a public post is a genuine sales or connection opportunity for a business, given the business's target customer. Be strict: a high score means this author is plausibly a buyer or is having a conversation the business could helpfully join. Return ONLY a JSON object. No markdown fences, no commentary.$pd$,
  $pd$Business: {{business.name}}
Industry: {{ctx.industry}}
Value proposition: {{ctx.value_proposition}}
Target customer: {{ctx.target_customer}}

A public post found online:
Author: {{lead.title}}
Post: {{lead.snippet}}
Link: {{lead.url}}

Score 0-100 how strongly this post's author is a potential customer of the business, or is having a conversation the business could helpfully join. Copy one verbatim phrase from the post that justifies your score. Return ONLY this JSON shape (no fences):
{"match_score": <integer 0-100>, "match_reason": "<one sentence that references the quote>", "quote": "<a verbatim phrase copied exactly from the post above>"}$pd$,
  true
),
(
  'draft-reply', 1,
  $pd$You draft a short, genuinely helpful public reply to a post, on behalf of a business. Lead with relevance and value; never hard-sell. Mention the business only if it is naturally useful. Output plain text only: 2 to 4 sentences, no preamble, no quotes around it.$pd$,
  $pd$Business: {{business.name}}
What we do: {{ctx.value_proposition}}
Brand voice: {{ctx.brand_voice}}

Reply helpfully to this public post:
Post: {{lead.snippet}}
Link: {{lead.url}}

Write only the reply text (2 to 4 sentences).$pd$,
  true
);

-- == Verify ===================================================================
-- SELECT slug, output_type FROM public.tasks WHERE slug LIKE '%conversations%' OR slug IN ('match-verify-leads','draft-reply');
-- SELECT slug, endpoint_url, auth_kind FROM public.external_apis WHERE slug='bluesky-search';

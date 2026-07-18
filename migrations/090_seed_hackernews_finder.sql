-- 090_seed_hackernews_finder.sql
-- Wave 1: Hacker News lead finder on the existing SocialCrawl integration.
--
-- Same envelope + post.* item shape as Reddit (socialcrawl-reddit, migration
-- 081), with two differences confirmed by a live probe:
--   * post.url is ALWAYS null on HN → url is CONSTRUCTED from post.id
--     (https://news.ycombinator.com/item?id={{post.id}})
--   * author_url points at the HN user page.
-- token_cost stays 0 — find-my-customers charges the 5 tokens for the whole run.
--
-- Already applied via service-client DML on the shared DB; this file is the
-- reproducible record. Idempotent (ON CONFLICT / NOT EXISTS guards).
--
-- (Google News was trialed alongside this — socialcrawl-google-news /
-- google-news-find-conversations — but it returns publications, not contactable
-- people, so those rows are seeded 'deprecated' and left out of LEAD_FINDER_SLUGS.)

INSERT INTO public.external_apis (slug, name, provider, endpoint_url, auth_kind, output_kind, status, metadata)
VALUES (
  'socialcrawl-hackernews', 'SocialCrawl Hacker News Search', 'hackernews',
  'https://www.socialcrawl.dev/v1/hackernews/search', 'api_key_get', 'retrieval', 'active',
  '{
    "auth": {"in": "header", "name": "x-api-key", "env": {"key": "SOCIALCRAWL_API_KEY"}},
    "request": {"method": "GET", "query": {"query": "{{config.query}}", "limit": "{{config.limit}}"}},
    "response_map": {
      "items": "data.items",
      "fields": {
        "external_id": "post.id",
        "url": "https://news.ycombinator.com/item?id={{post.id}}",
        "title": "post.content.text",
        "snippet": "post.content.text",
        "author": "post.author.username",
        "author_url": "https://news.ycombinator.com/user?id={{post.author.username}}",
        "published_at": "post.published_at"
      }
    }
  }'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.tasks
  (slug, name, description_short, area, is_default, plan_required, visibility, price_cents,
   output_type, status, execution_order, surface, token_cost, kind, is_long_running,
   progress_verb, timeout_seconds)
VALUES
  ('hackernews-find-conversations', 'Hacker News — Find Conversations',
   'Search Hacker News for public conversations from potential customers of this business.',
   'marketing', false, 'free', 'always_visible', 0,
   'retrieval', 'active', 99, 'silent', 0, 'manual', true,
   'Finding conversations', 300)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.task_apis (task_id, api_id, role, invocation_params)
SELECT t.id, a.id, 'primary', '{}'::jsonb
FROM public.tasks t, public.external_apis a
WHERE t.slug = 'hackernews-find-conversations' AND a.slug = 'socialcrawl-hackernews'
  AND NOT EXISTS (
    SELECT 1 FROM public.task_apis x WHERE x.task_id = t.id AND x.api_id = a.id AND x.role = 'primary'
  );

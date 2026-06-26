-- =====================================================================
-- Migration 067: platforms — publishing rate-limit fields
-- =====================================================================
-- max_posts_per_window:      max posts allowed in a rolling window (NULL = no cap configured)
-- window_seconds:            window size in seconds (86400=1 day, 604800=1 week, 3600=1 hour)
-- min_seconds_between_posts: minimum spacing required between posts (NULL = no spacing rule)
--
-- All values are admin-tunable starting points.
-- Enforcement logic (publish-time checking) is wired in the next brief.
-- =====================================================================

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS max_posts_per_window       INTEGER,
  ADD COLUMN IF NOT EXISTS window_seconds             INTEGER,
  ADD COLUMN IF NOT EXISTS min_seconds_between_posts  INTEGER;

-- Seed conservative known-limit values (all admin-tunable):
UPDATE public.platforms SET max_posts_per_window=300,  window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='bluesky';
UPDATE public.platforms SET max_posts_per_window=50,   window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='x';
UPDATE public.platforms SET max_posts_per_window=100,  window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='linkedin';
UPDATE public.platforms SET max_posts_per_window=25,   window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='instagram';
UPDATE public.platforms SET max_posts_per_window=250,  window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='threads';
UPDATE public.platforms SET max_posts_per_window=190,  window_seconds=604800, min_seconds_between_posts=NULL WHERE slug='facebook';
UPDATE public.platforms SET max_posts_per_window=6,    window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='youtube';
UPDATE public.platforms SET max_posts_per_window=10,   window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='tiktok';
UPDATE public.platforms SET max_posts_per_window=50,   window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='pinterest';
UPDATE public.platforms SET max_posts_per_window=NULL, window_seconds=NULL,   min_seconds_between_posts=600  WHERE slug='reddit';
UPDATE public.platforms SET max_posts_per_window=NULL, window_seconds=NULL,   min_seconds_between_posts=NULL WHERE slug='telegram';
UPDATE public.platforms SET max_posts_per_window=20,   window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='snapchat';
UPDATE public.platforms SET max_posts_per_window=5,    window_seconds=604800, min_seconds_between_posts=NULL WHERE slug='google_business';
UPDATE public.platforms SET max_posts_per_window=NULL, window_seconds=NULL,   min_seconds_between_posts=NULL WHERE slug='discord';
UPDATE public.platforms SET max_posts_per_window=250,  window_seconds=86400,  min_seconds_between_posts=NULL WHERE slug='whatsapp';

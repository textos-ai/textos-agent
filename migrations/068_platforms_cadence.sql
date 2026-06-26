-- =====================================================================
-- Migration 068: platforms — replace rate-limit model with cadence model
-- =====================================================================
-- Drops: max_posts_per_window, window_seconds, min_seconds_between_posts
-- Adds:  recommended_cadence (text), cadence_reason (text),
--        cadence_updated_at (timestamptz — stamped by app on every edit)
-- =====================================================================

ALTER TABLE public.platforms
  DROP COLUMN IF EXISTS max_posts_per_window,
  DROP COLUMN IF EXISTS window_seconds,
  DROP COLUMN IF EXISTS min_seconds_between_posts,
  ADD COLUMN IF NOT EXISTS recommended_cadence TEXT,
  ADD COLUMN IF NOT EXISTS cadence_reason      TEXT,
  ADD COLUMN IF NOT EXISTS cadence_updated_at  TIMESTAMPTZ;

-- Seed researched cadence guidance (admin-tunable):
UPDATE public.platforms SET
  recommended_cadence = '1–3/day',
  cadence_reason      = 'Wide viral spread; volume tolerated',
  cadence_updated_at  = now()
WHERE slug = 'x';

UPDATE public.platforms SET
  recommended_cadence = 'max 1/day, ~5/week',
  cadence_reason      = 'Never 2+/day — 40% reach drop; post most days',
  cadence_updated_at  = now()
WHERE slug = 'linkedin';

UPDATE public.platforms SET
  recommended_cadence = '3–5 feed/week + 1–2 Reels/day',
  cadence_reason      = 'Feed is weekly not daily; Stories/Reels run a separate rhythm',
  cadence_updated_at  = now()
WHERE slug = 'instagram';

UPDATE public.platforms SET
  recommended_cadence = '1–2/day',
  cadence_reason      = 'Reply-driven; keep posts under 500 char for best reach',
  cadence_updated_at  = now()
WHERE slug = 'threads';

UPDATE public.platforms SET
  recommended_cadence = '1–2/day',
  cadence_reason      = 'One strong post usually enough; quality over quantity',
  cadence_updated_at  = now()
WHERE slug = 'facebook';

UPDATE public.platforms SET
  recommended_cadence = '1 video/week + 3–5 Shorts/week',
  cadence_reason      = 'Long-form not daily; Shorts more frequent than long-form',
  cadence_updated_at  = now()
WHERE slug = 'youtube';

UPDATE public.platforms SET
  recommended_cadence = '2–5/week (daily = aggressive)',
  cadence_reason      = 'Volume helps discovery but weekly cadence is the sweet spot',
  cadence_updated_at  = now()
WHERE slug = 'tiktok';

UPDATE public.platforms SET
  recommended_cadence = '5–15/day',
  cadence_reason      = 'High volume normal; more than 50/day hurts reach',
  cadence_updated_at  = now()
WHERE slug = 'pinterest';

UPDATE public.platforms SET
  recommended_cadence = '~1/day per subreddit',
  cadence_reason      = 'Per-subreddit, value-first; rapid posting gets flagged as spam',
  cadence_updated_at  = now()
WHERE slug = 'reddit';

UPDATE public.platforms SET
  recommended_cadence = '3–5/week',
  cadence_reason      = 'Consistency over frequency; daily posting reads as spam',
  cadence_updated_at  = now()
WHERE slug = 'bluesky';

UPDATE public.platforms SET
  recommended_cadence = '1/day',
  cadence_reason      = 'One update per day is the practical max for Google Business Posts',
  cadence_updated_at  = now()
WHERE slug = 'google_business';

UPDATE public.platforms SET
  recommended_cadence = NULL,
  cadence_reason      = 'Not a feed platform — messaging channel; model separately',
  cadence_updated_at  = now()
WHERE slug = 'whatsapp';

UPDATE public.platforms SET
  recommended_cadence = NULL,
  cadence_reason      = 'Not a feed platform — messaging channel; model separately',
  cadence_updated_at  = now()
WHERE slug = 'telegram';

UPDATE public.platforms SET
  recommended_cadence = NULL,
  cadence_reason      = 'Not a feed platform — messaging channel; model separately',
  cadence_updated_at  = now()
WHERE slug = 'discord';

UPDATE public.platforms SET
  recommended_cadence = NULL,
  cadence_reason      = 'Not a feed platform — messaging channel; model separately',
  cadence_updated_at  = now()
WHERE slug = 'snapchat';

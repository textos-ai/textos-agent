-- =====================================================================
-- Migration 065: platforms — social platform catalog with constraints
-- =====================================================================
-- Canonical source of truth for social platform constraints.
-- Replaces all hardcoded PLATFORM_LIMITS / PLATFORM_CHAR_LIMITS maps.
-- Read via GET /api/catalog/platforms (Worker, service-role key).
-- Managed via /admin/platforms CRUD.
-- APPLIED 2026-06-25 directly via Supabase dashboard — 16 rows seeded.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.platforms (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL UNIQUE,
  display_name  TEXT        NOT NULL,
  char_limit    INTEGER,
  hashtag_limit INTEGER,
  constraints   JSONB       NOT NULL DEFAULT '{}',
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platforms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platforms_read_authenticated" ON public.platforms;
CREATE POLICY "platforms_read_authenticated"
  ON public.platforms FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ BEGIN
  CREATE TRIGGER trg_platforms_updated_at
    BEFORE UPDATE ON public.platforms
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO public.platforms
  (slug, display_name, char_limit, hashtag_limit, constraints, is_active, sort_order)
VALUES
  ('bluesky',         'Bluesky',            300,   NULL, '{"format":"text","max_images":4}',                               true,   10),
  ('x',               'X (Twitter)',         280,   NULL, '{"format":"text","max_images":4,"max_video_length_s":140}',      true,   20),
  ('linkedin',        'LinkedIn',           3000,   NULL, '{"format":"text","max_images":9}',                               true,   30),
  ('instagram',       'Instagram',          2200,     30, '{"format":"visual","max_images":10,"max_video_length_s":3600}',  true,   40),
  ('threads',         'Threads',             500,   NULL, '{"format":"text","max_images":10}',                              true,   50),
  ('facebook',        'Facebook',          63206,   NULL, '{"format":"mixed","max_images":1000}',                           true,   60),
  ('youtube',         'YouTube',            5000,   NULL, '{"format":"video","max_video_length_s":43200}',                  true,   70),
  ('tiktok',          'TikTok',             2200,   NULL, '{"format":"video","max_video_length_s":600}',                    true,   80),
  ('pinterest',       'Pinterest',           500,   NULL, '{"format":"visual","max_images":1}',                             true,   90),
  ('reddit',          'Reddit',            40000,   NULL, '{"format":"text"}',                                              true,  100),
  ('telegram',        'Telegram',           4096,   NULL, '{"format":"text","max_images":10}',                              true,  110),
  ('snapchat',        'Snapchat',            250,   NULL, '{"format":"visual","max_video_length_s":60}',                    true,  120),
  ('google_business', 'Google Business',    1500,   NULL, '{"format":"text","max_images":10}',                              true,  130),
  ('discord',         'Discord',            2000,   NULL, '{"format":"text"}',                                              true,  140),
  ('whatsapp',        'WhatsApp',          65536,   NULL, '{"format":"text","max_images":30}',                              true,  150),
  ('twitter',         'Twitter (legacy)',    280,   NULL, '{"format":"text","max_images":4}',                               false, 999)
ON CONFLICT (slug) DO NOTHING;

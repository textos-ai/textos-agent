-- Migration 072: optimal_slots — per-platform/content-type posting windows.
-- Admin-editable source of truth for the "next optimal time" scheduler.
-- Seeded from victora_posting_slots.csv. Platform display names mapped to
-- canonical slugs (X (Twitter) -> twitter, Google Business -> google_business…).
-- No hardcoding in code — the scheduler reads this table.

BEGIN;

CREATE TABLE IF NOT EXISTS optimal_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_slug   text NOT NULL,
  content_type    text NOT NULL,          -- post | story | video | short | pin | update
  day_of_week     text NOT NULL,          -- Mon | Tue | Wed | Thu | Fri | Sat | Sun
  local_time      time NOT NULL,          -- wall-clock in the business timezone
  priority        int  NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  basis           text,
  jitter_minutes  int  NOT NULL DEFAULT 10,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_optimal_slots_lookup
  ON optimal_slots (platform_slug, content_type, is_active);

INSERT INTO optimal_slots (platform_slug, content_type, day_of_week, local_time, priority, basis) VALUES
  ('bluesky','post','Mon','10:00',2,'Monday news/catch-up window'),
  ('bluesky','post','Tue','09:30',1,'Highest-engagement day'),
  ('bluesky','post','Wed','10:00',1,'Strong mid-morning'),
  ('bluesky','post','Thu','13:00',2,'Early-afternoon window'),
  ('bluesky','post','Sun','19:00',3,'Sunday reset (ET-skewed audience)'),
  ('facebook','post','Tue','09:00',2,'Morning peak'),
  ('facebook','post','Wed','09:00',1,'Best day, peak hour'),
  ('facebook','post','Thu','09:00',1,'Second-best day'),
  ('facebook','post','Wed','13:00',3,'Afternoon secondary'),
  ('facebook','post','Fri','11:00',3,'Late-week morning'),
  ('linkedin','post','Tue','10:30',2,'B2B mid-morning'),
  ('linkedin','post','Wed','16:00',1,'2026 afternoon peak'),
  ('linkedin','post','Thu','16:00',1,'Afternoon peak'),
  ('linkedin','post','Thu','10:30',2,'Mid-morning (test vs afternoon)'),
  ('linkedin','post','Fri','11:00',3,'Late-week'),
  ('twitter','post','Mon','10:00',3,'Weekday coverage'),
  ('twitter','post','Tue','10:00',1,'Peak day/hour'),
  ('twitter','post','Tue','13:00',2,'Afternoon push'),
  ('twitter','post','Wed','10:00',1,'Peak day/hour'),
  ('twitter','post','Wed','15:00',2,'Afternoon push'),
  ('twitter','post','Thu','11:00',2,'Late-week morning'),
  ('twitter','post','Fri','11:00',3,'Late-week morning'),
  ('instagram','post','Mon','11:00',3,'Mid-morning'),
  ('instagram','post','Wed','11:00',1,'Best day, peak hour'),
  ('instagram','post','Thu','09:00',1,'Strong morning'),
  ('instagram','post','Wed','18:00',2,'Evening secondary'),
  ('instagram','post','Fri','11:00',3,'Mid-morning'),
  ('instagram','story','Mon','12:00',2,'Daily story for consistency'),
  ('instagram','story','Tue','12:00',2,'Daily story for consistency'),
  ('instagram','story','Wed','12:00',2,'Daily story for consistency'),
  ('instagram','story','Thu','12:00',2,'Daily story for consistency'),
  ('instagram','story','Fri','12:00',2,'Daily story for consistency'),
  ('threads','post','Tue','11:00',2,'Late-morning'),
  ('threads','post','Wed','11:00',1,'Best day, peak hour'),
  ('threads','post','Thu','11:00',1,'Late-morning peak'),
  ('threads','post','Fri','10:00',3,'Late-week'),
  ('youtube','video','Sun','10:00',1,'Top upload slot; ahead of viewing'),
  ('youtube','video','Tue','09:00',2,'Upload before afternoon peak'),
  ('youtube','video','Wed','09:00',2,'Upload before afternoon peak'),
  ('youtube','short','Thu','18:30',2,'Evening couch-scroll'),
  ('youtube','short','Fri','19:00',1,'Peak Shorts evening'),
  ('youtube','short','Sat','19:00',1,'Peak Shorts evening'),
  ('tiktok','video','Tue','19:00',1,'Evening peak'),
  ('tiktok','video','Wed','07:00',2,'Morning peak'),
  ('tiktok','video','Thu','19:00',1,'Evening peak'),
  ('tiktok','video','Sat','09:00',1,'Saturday is TikTok''s strongest day'),
  ('tiktok','video','Sun','13:00',2,'Sunday afternoon'),
  ('pinterest','pin','Tue','11:00',2,'Midday pinning'),
  ('pinterest','pin','Wed','11:00',1,'Best day, midday'),
  ('pinterest','pin','Thu','11:00',2,'Midday pinning'),
  ('pinterest','pin','Wed','21:00',1,'Evening pins strongest'),
  ('pinterest','pin','Fri','21:00',2,'Evening pins strongest'),
  ('reddit','post','Tue','07:00',1,'ET; pre-peak morning (per-subreddit)'),
  ('reddit','post','Wed','07:00',1,'ET; pre-peak morning (per-subreddit)'),
  ('reddit','post','Mon','08:00',2,'ET; Monday traction (per-subreddit)'),
  ('google_business','update','Mon','09:00',2,'Weekday morning'),
  ('google_business','update','Wed','09:00',1,'Weekday morning'),
  ('google_business','update','Fri','09:00',2,'Weekday morning');

COMMIT;

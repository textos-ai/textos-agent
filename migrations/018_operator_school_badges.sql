-- Operator School V1 — badge catalog, lesson completions, public credentials toggle

-- ── lesson_completions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lesson_completions (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          uuid        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  business_id      uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lesson_id        uuid        NOT NULL REFERENCES lessons(id)   ON DELETE CASCADE,
  completed_at     timestamptz NOT NULL DEFAULT now(),
  action_completed boolean     NOT NULL DEFAULT false,
  UNIQUE (user_id, business_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS lesson_completions_user_biz_idx
  ON lesson_completions (user_id, business_id);

-- ── badges (catalog — seeded once, never user-edited) ──────────────────────
CREATE TABLE IF NOT EXISTS badges (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        text        UNIQUE NOT NULL,
  tier        text        NOT NULL CHECK (tier IN ('lesson', 'task', 'master')),
  task_slug   text,                                   -- null for master tier
  lesson_id   uuid        REFERENCES lessons(id) ON DELETE CASCADE,
                                                      -- only for lesson-tier badges
  name        text        NOT NULL,
  description text        NOT NULL,
  icon_emoji  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS badges_task_idx ON badges (task_slug);
CREATE INDEX IF NOT EXISTS badges_tier_idx ON badges (tier);

-- ── badge_earnings (per user, per business) ────────────────────────────────
CREATE TABLE IF NOT EXISTS badge_earnings (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  badge_id    uuid        NOT NULL REFERENCES badges(id)    ON DELETE CASCADE,
  earned_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id, badge_id)
);

CREATE INDEX IF NOT EXISTS badge_earnings_user_biz_idx
  ON badge_earnings (user_id, business_id);

-- ── businesses: public credentials toggle ──────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS show_credentials_publicly boolean NOT NULL DEFAULT false;

-- ── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE lesson_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE badges             ENABLE ROW LEVEL SECURITY;
ALTER TABLE badge_earnings     ENABLE ROW LEVEL SECURITY;

-- lesson_completions: users see and write their own rows only
CREATE POLICY lc_own ON lesson_completions FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- badges: read-only catalog — all authenticated users can read
CREATE POLICY badges_read ON badges FOR SELECT TO authenticated
  USING (true);

-- badge_earnings: users see and write their own rows only
-- Worker service role bypasses RLS for public site reads
CREATE POLICY be_own ON badge_earnings FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

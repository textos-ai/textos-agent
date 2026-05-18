-- Migration 037: Add is_long_running flag to tasks table
-- Allows tasks like business-landing-page to have extended timeouts

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS is_long_running boolean NOT NULL DEFAULT false;

-- Mark business-landing-page as long-running (needs 5min instead of 2min timeout)
UPDATE tasks SET is_long_running = true
WHERE slug = 'business-landing-page';
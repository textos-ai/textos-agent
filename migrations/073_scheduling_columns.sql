-- Migration 073: scheduling columns (additive — immediate publishing unchanged).
-- content_assets gains the schedule fields; 'scheduled' status is ALREADY in the
-- content_assets_status_check constraint, so no constraint change is needed.
-- businesses.timezone added now (non-breaking) for the later audience-tz work;
-- Stage 1 logic uses Central (America/Chicago) regardless.

BEGIN;

ALTER TABLE content_assets
  ADD COLUMN IF NOT EXISTS scheduled_for       timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_timezone  text,
  ADD COLUMN IF NOT EXISTS zernio_scheduled_id text;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS timezone text;

COMMIT;

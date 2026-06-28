-- 070_publish_supported.sql
-- Adds publish_supported flag to the platforms table.
-- FALSE (default) = platform exists in the UI but cannot be published to yet.
-- TRUE            = platform is fully supported end-to-end (connect + publish + disconnect).
-- Admin-editable: flip one row in this column to enable/disable a platform
-- without any code change.
--
-- Also fixes two max_images data bugs found in the gap audit:
--   linkedin: 9 → 20   (Zernio docs: up to 20 images per post)
--   facebook: 1000 → 10 (Zernio docs: up to 10 images per feed post)

-- 1. Add the column (idempotent)
ALTER TABLE platforms
  ADD COLUMN IF NOT EXISTS publish_supported BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Mark text-native platforms as supported
UPDATE platforms
  SET publish_supported = TRUE
  WHERE slug IN (
    'bluesky',
    'x',
    'linkedin',
    'threads',
    'facebook',
    'google_business',
    'telegram',
    'discord'
  );

-- 3. Media-required / wrong-model / structured platforms remain FALSE (the default).
--    Affected: instagram, youtube, tiktok, pinterest, snapchat, reddit, whatsapp

-- 4. Fix max_images data bugs
UPDATE platforms
  SET constraints = jsonb_set(constraints, '{max_images}', '20')
  WHERE slug = 'linkedin';

UPDATE platforms
  SET constraints = jsonb_set(constraints, '{max_images}', '10')
  WHERE slug = 'facebook';

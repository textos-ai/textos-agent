-- Migration 004: add handle_confirmed_at to users
-- Purpose: distinguish auto-assigned handles (null) from explicitly confirmed handles (timestamptz).
-- Run in Supabase SQL editor (Dashboard → SQL Editor → New query).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS handle_confirmed_at timestamptz;

-- Backfill: treat every existing user who already has a handle as confirmed
-- (they went through the handle picker in prior sessions). Sets confirmed_at
-- to their created_at time so the column is non-null and auditable.
UPDATE users
  SET handle_confirmed_at = created_at
  WHERE handle IS NOT NULL
    AND handle_confirmed_at IS NULL;

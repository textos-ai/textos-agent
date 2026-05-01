-- Migration 011: Add is_current boolean to task_runs and business_assets
-- Purpose: enables future regenerate-artifact feature (Sprint 7+)
-- When a task is re-run, set old rows is_current=false, new row is_current=true
-- V1: all rows default true; no regenerate logic yet

ALTER TABLE task_runs
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

ALTER TABLE business_assets
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

-- Indexes for fast "give me current artifacts for business X" queries
CREATE INDEX IF NOT EXISTS idx_task_runs_is_current
  ON task_runs (business_id, is_current)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_business_assets_is_current
  ON business_assets (business_id, is_current)
  WHERE is_current = true;

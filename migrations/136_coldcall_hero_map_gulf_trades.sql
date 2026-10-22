-- =====================================================================
-- Migration 136: coldcall_hero_map — nine Gulf Coast trades
-- =====================================================================
-- Source: "IMPORT BRIEF — Gulf Coast leads into coldcall_leads", section 4,
--         2026-10-21.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: the INSERT is ON CONFLICT (category) DO NOTHING, so a
-- second apply writes nothing and cannot clobber a folder re-point made by
-- hand or by a later migration (the 124 pattern).
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- The Gulf Coast import (2,536 rows, FL/AL/MS) carries fifteen distinct
-- trades after aliasing. Six already resolve: hvac contractor, gutter
-- service, fence contractor, pressure washing, garage door repair and
-- foundation repair. The nine below do not exist in coldcall_hero_map at
-- all, and resolveHeroFolder() in src/lib/coldcall-demo.ts treats an
-- unmapped category as a SEEDING BUG rather than falling back — so demo
-- generation would fail for 1,483 of the new leads until these rows exist.
--
-- This migration is a precondition of the import, not a follow-up to it.
--
-- ── FOLDER CHOICES ───────────────────────────────────────────────────
-- Every target folder already exists in R2 and already has a theme row in
-- coldcall_demo_theme (keyed on folder, migration 122), so no theme rows
-- are added here. Verified before writing: 18 theme folders, and zero
-- hero_map folders without a theme.
--
--   septic service  -> plumber             nearest real trade with its own
--                                          hero set; septic work is drain
--                                          and pipe imagery either way.
--   pool service    -> generic             no plausible existing set. Water
--                                          imagery under a trades theme
--                                          would read as a plumber.
--   the other seven -> general-contractor  windows, flooring, concrete,
--                                          insulation, drywall, handyman
--                                          and tile are all interior/
--                                          exterior build work, which is
--                                          what that folder holds.
--
-- These are deliberately NOT 'generic': general-contractor is a real
-- trades set with its own theme, and seven of the nine are build trades.
-- A dedicated folder per trade is a later images decision, and re-pointing
-- one is a one-line UPDATE (see migration 124) — not a schema change.
--
-- ── NOT IN THIS FILE ─────────────────────────────────────────────────
-- Adding these nine to the PUBLIC vocabulary (HOME_TRADE_CATEGORIES in
-- src/lib/trustlight-public.ts) is a code change in the same commit, not
-- SQL: that list is a TypeScript constant the directory route and the
-- admin trade validator both read. There is no DB CHECK on
-- coldcall_leads.category or .trade to widen.
-- =====================================================================

INSERT INTO public.coldcall_hero_map (category, folder) VALUES
  -- plumbing-adjacent
  ('septic service',        'plumber'),
  -- no dedicated set yet
  ('pool service',          'generic'),
  -- build trades
  ('window installation',   'general-contractor'),
  ('flooring contractor',   'general-contractor'),
  ('concrete contractor',   'general-contractor'),
  ('insulation contractor', 'general-contractor'),
  ('drywall contractor',    'general-contractor'),
  ('handyman',              'general-contractor'),
  ('tile contractor',       'general-contractor')
ON CONFLICT (category) DO NOTHING;


-- == Verify (paste after applying) =============================================
-- All nine exist and point where this file says — expect 9 rows:
--   SELECT category, folder FROM public.coldcall_hero_map
--    WHERE category IN ('septic service','pool service','window installation',
--                       'flooring contractor','concrete contractor',
--                       'insulation contractor','drywall contractor',
--                       'handyman','tile contractor')
--    ORDER BY folder, category;
--
-- Every hero-map folder still has a theme — expect 0 rows:
--   SELECT DISTINCT m.folder
--     FROM public.coldcall_hero_map m
--     LEFT JOIN public.coldcall_demo_theme t ON t.folder = m.folder
--    WHERE t.folder IS NULL;
--
-- The fifteen post-alias Gulf categories ALL resolve — expect 0 rows.
-- Run this BEFORE the import; it is the gate the import depends on:
--   SELECT c.category
--     FROM (VALUES ('hvac contractor'),('window installation'),
--                  ('flooring contractor'),('septic service'),
--                  ('gutter service'),('concrete contractor'),
--                  ('insulation contractor'),('drywall contractor'),
--                  ('fence contractor'),('pool service'),('pressure washing'),
--                  ('handyman'),('garage door repair'),('tile contractor'),
--                  ('foundation repair')) AS c(category)
--     LEFT JOIN public.coldcall_hero_map m ON m.category = c.category
--    WHERE m.category IS NULL;
--
-- Total hero_map size — expect 63 (54 + 9):
--   SELECT count(*) FROM public.coldcall_hero_map;
-- =====================================================================

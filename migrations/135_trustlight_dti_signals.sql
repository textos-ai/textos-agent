-- =====================================================================
-- Migration 135: the seven DTI signals
-- =====================================================================
-- Source: Rob, 2026-09-17 — expand what the Digital Trust Index measures
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: IF NOT EXISTS throughout.
--
-- ── WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT ────────────────
-- The DTI measured four things. Thirteen more were proposed; six were
-- kept and seven were rejected, each for a measured reason:
--
--   contact form      only 11/36 sites have one on the homepage, and
--                     fetching /contact found a form on just 6/22 —
--                     the rest are JS-injected by Wix/Squarespace/
--                     GoDaddy and invisible to an HTML probe.
--   list of services  92% "hit rate" that was 28/33 the bare nav word
--                     "Services". Proves a menu exists, nothing more.
--   photos of work    no HTML signal distinguishes a job photo from
--                     stock imagery.
--   licence number    precise when it fires (3/36, all unambiguous)
--                     but it detects a CLAIM on a website. TrustLight
--                     verifies the licence with the issuing board —
--                     scoring the claim is strictly weaker than the
--                     check, and would dock a verified contractor for
--                     not printing it.
--   insurance shown   same argument. Confirmed with the carrier already.
--   emergency/24-7    prose matching; "we do not offer emergency
--                     service" scores as a hit.
--
-- EVERY COLUMN HERE IS NULLABLE AND NULL MEANS NOT CHECKED. Never
-- false, never zero. The probe writes NULL on every failure path.
-- =====================================================================

ALTER TABLE public.coldcall_leads
  -- Findable
  ADD COLUMN IF NOT EXISTS has_https           BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_viewport        BOOLEAN,
  -- Reachable
  ADD COLUMN IF NOT EXISTS phone_listed        BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_business_hours  BOOLEAN,
  -- Credible
  ADD COLUMN IF NOT EXISTS reviews_linked      BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_faq_or_blog     BOOLEAN,
  -- Service areas. The COUNT is the signal (>=3 means "serves a region"
  -- rather than "has an address"); the array is the evidence, kept so a
  -- contractor disputing their score can be shown exactly what we read.
  ADD COLUMN IF NOT EXISTS service_area_count  INTEGER,
  ADD COLUMN IF NOT EXISTS service_areas       TEXT[];

COMMENT ON COLUMN public.coldcall_leads.service_area_count IS
  'Distinct service-area cities named on the homepage. >=3 scores the signal. NULL = not checked.';
COMMENT ON COLUMN public.coldcall_leads.service_areas IS
  'The cities counted, as evidence. Hand-validated at 100% precision on 36 sites; under-counts rather than inventing.';

-- Reading is "everything for one lead", already covered by the PK. No new
-- index: none of these is filtered on across the table.

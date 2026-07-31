-- =====================================================================
-- Migration 110: business_projects → business_services FK cannot fire
-- =====================================================================
-- Source: found by src/__tests__/facts-round-trip.test.ts, 2026-07-30
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: drops the constraint only IF EXISTS, re-adds it guarded.
-- =====================================================================
--
-- THE FAULT
--
-- Migration 093 states the intent plainly:
--
--   "service_key is a soft FK — (business_id, service_key) references
--    business_services, declared below so deleting a service NULLS THE LINK
--    rather than deleting the project record of work that actually happened."
--
-- That is the right behaviour. The constraint does not implement it:
--
--   FOREIGN KEY (business_id, service_key)
--     REFERENCES business_services (business_id, service_key)
--     ON DELETE SET NULL
--
-- ON DELETE SET NULL nulls EVERY referencing column, not just the one that
-- names the service. business_projects.business_id is NOT NULL, so the
-- cascade always violates that constraint and the delete aborts:
--
--   null value in column "business_id" of relation "business_projects"
--   violates not-null constraint
--
-- CONSEQUENCE, in the operator's terms: deleting a service on the Business
-- Facts page fails with a 500 whenever ANY project references it — and
-- because the facts save is one transaction-ish sequence, the whole save
-- fails, not just the service. The failure names business_projects, a table
-- the operator did not touch, so it reads as a random server error.
--
-- THE FIX
--
-- Postgres 15 added column-scoped SET NULL, which expresses migration 093's
-- stated intent exactly: null the link, keep the row, leave business_id alone.
-- Supabase runs 15+.
--
-- NOT DESTRUCTIVE: no table, column or row is dropped. The only DROP is of
-- the broken constraint itself, which is immediately replaced.

DO $$
BEGIN
  ALTER TABLE public.business_projects
    DROP CONSTRAINT IF EXISTS business_projects_service_fk;

  ALTER TABLE public.business_projects
    ADD CONSTRAINT business_projects_service_fk
    FOREIGN KEY (business_id, service_key)
    REFERENCES public.business_services (business_id, service_key)
    ON DELETE SET NULL (service_key)
    ON UPDATE CASCADE;
EXCEPTION
  -- Same posture as 093: if the referenced unique index is absent the FK
  -- cannot be created. The CHECK on service_key format and the app-level
  -- membership validation in FactsSchema.superRefine still stand, so the
  -- migration reports rather than aborting the whole script.
  WHEN others THEN
    RAISE NOTICE 'business_projects_service_fk not rebuilt: %', SQLERRM;
END $$;

-- ── Verification ─────────────────────────────────────────────────────
--
-- Confirm the constraint exists and is column-scoped (confdelsetcols should
-- be non-empty, naming only service_key):
--   SELECT conname, confdeltype, confdelsetcols
--   FROM pg_constraint
--   WHERE conname = 'business_projects_service_fk';
--   -- expect confdeltype = 'n' (SET NULL), confdelsetcols = {<attnum of service_key>}
--
-- Resolve that attnum to a name:
--   SELECT attname FROM pg_attribute
--   WHERE attrelid = 'public.business_projects'::regclass
--     AND attnum = ANY((SELECT confdelsetcols FROM pg_constraint
--                       WHERE conname='business_projects_service_fk'));
--   -- expect exactly: service_key
--
-- Behavioural check (run in a transaction and roll back):
--   BEGIN;
--     DELETE FROM public.business_services
--     WHERE business_id = '<a business with a referenced service>'
--       AND service_key = '<the referenced key>';
--     SELECT id, business_id, service_key FROM public.business_projects
--     WHERE business_id = '<same business>';
--     -- expect: rows still present, business_id intact, service_key now NULL
--   ROLLBACK;

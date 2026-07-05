-- =====================================================================
-- Migration 080: allow tasks.output_type = 'retrieval'
-- =====================================================================
-- The external-retrieval engine selects on output_type='retrieval'. tasks.
-- output_type is text + CHECK (migration 045). Drop whatever CHECK constrains
-- output_type and re-add it with 'retrieval' included. Idempotent + paste-safe.
-- =====================================================================

DO $mig080$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%output_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.tasks DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_output_type_check
    CHECK (output_type IN (
      'document','configured','image','image_set','structured_data','video','retrieval'
    ));
END
$mig080$;

-- == Verify ====================================================================
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid='public.tasks'::regclass AND conname='tasks_output_type_check';
--   Expect: ... output_type IN (... 'retrieval')

-- =====================================================================
-- Migration 133: contractor funnel events
-- =====================================================================
-- Safe to re-run: IF NOT EXISTS throughout.
--
-- The contractor funnel is the only thing that matters until there are
-- paying customers, and none of it was measurable. This records the five
-- steps between landing and a submitted application so the drop-off is a
-- number rather than a guess:
--
--   claim_view    someone opened /claim
--   claim_search  they typed a business name and searched
--   claim_match   they clicked "Yes, that's us" on a result
--   start_view    /start loaded (claimed = arrived with prefill)
--   start_submit  the application was accepted (202)
--
-- ── WHAT THIS DOES NOT STORE ────────────────────────────────────────
-- No IP, no user agent, no business name, no email, nothing typed into a
-- search box. `visit` is a random id the browser generates per tab and
-- keeps in sessionStorage; it exists only so five rows can be recognised
-- as one person's journey, and it is meaningless the moment the tab
-- closes. `detail` is a short enum-ish label ("claimed"/"cold"), never
-- free text from a visitor.
--
-- This is a funnel counter, not analytics. If it ever needs to answer a
-- question about a PERSON rather than a STEP, that is the signal it has
-- grown into something that needs a privacy policy entry and a retention
-- rule, neither of which it has today.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.coldcall_funnel_events (
  id          BIGSERIAL   PRIMARY KEY,
  step        TEXT        NOT NULL,
  visit       TEXT,
  detail      TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.coldcall_funnel_events
    ADD CONSTRAINT coldcall_funnel_events_step_chk
    CHECK (step IN ('claim_view','claim_search','claim_match','start_view','start_submit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reading is always "how many of each step, over a window".
CREATE INDEX IF NOT EXISTS coldcall_funnel_events_step_time
  ON public.coldcall_funnel_events (step, occurred_at DESC);

CREATE INDEX IF NOT EXISTS coldcall_funnel_events_visit
  ON public.coldcall_funnel_events (visit) WHERE visit IS NOT NULL;

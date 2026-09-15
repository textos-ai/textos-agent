-- =====================================================================
-- Migration 126: TrustLight vetting — status, nine checks, published
--                profile, exclusivity, consent, audit log
-- =====================================================================
-- Source: "TrustLight vetting backend + public directory API" brief,
--         2026-09-15, plus the 1a reconciliation decisions.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: every ADD COLUMN / CREATE TABLE / CREATE INDEX is
-- IF NOT EXISTS, constraints are guarded, and the section-1 retirement is
-- an idempotent scoped UPDATE.
--
-- ---------------------------------------------------------------------
-- NAMING: the brief writes "leads"; the table is public.coldcall_leads.
-- The brief's field list is mapped onto what ALREADY EXISTS rather than
-- duplicated (brief: "do not invent column names; match what is there"):
--
--   brief            ->  existing column        (NOT re-added)
--   county_parish    ->  parish
--   city             ->  city
--   state            ->  state
--   rating           ->  rating
--   review_count     ->  review_count
--
-- Only genuinely absent fields are added below. `trade` IS added despite
-- `category` existing: category is the scraped Google category
-- ('plumber', 'auto repair'), while trade is the curated public display
-- label ('Roofing'). Same for legal_name/trading_name vs the scraped
-- `name`. Publishing a scraped value as a verified claim is exactly the
-- risk this product cannot take.
-- =====================================================================


-- ── 1. Retire Trustlight from the signup ledger (1a decision) ────────
-- svc_trustlight + trustlight_price_yearly STAY: they are the call-time
-- interest toggle that drives the generated call script. Only the paid
-- record moves, so vetting_status/plan below is the single source of
-- truth for "is this business paying for vetting".
--
-- SOFT retirement, not DELETE, deliberately:
--   * coldcall_lead_signups.service_slug is FK ON DELETE RESTRICT, so a
--     catalog DELETE is refused while any signup row references it.
--   * The ledger's whole design is soft-cancel so re-signups keep their
--     history. Hard-deleting the 2026-09-11 signup would destroy real
--     commercial history for no gain.
-- If Rob wants the rows physically gone, that is a separate, explicit
-- instruction — see the note in the report.
UPDATE public.coldcall_lead_signups
   SET status = 'cancelled',
       cancelled_at = COALESCE(cancelled_at, now()),
       note = COALESCE(note, '') ||
              ' [migration 126: vetting moved to coldcall_leads.vetting_status/plan]'
 WHERE service_slug = 'trustlight'
   AND status = 'active';

UPDATE public.coldcall_services
   SET active = false
 WHERE slug = 'trustlight'
   AND active = true;


-- ── 2. Vetting status + public slug ──────────────────────────────────
-- TEXT + CHECK, not a Postgres enum, to match every other coldcall_*
-- status column (migrations 115 / 125). Adding a value stays a CHECK
-- swap rather than an ALTER TYPE.
--
-- DISTINCT FROM coldcall_leads.status, which is call-progress
-- ('new','contacted','callback','meeting','not_interested','bad_number').
-- That column is NOT touched here.
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS vetting_status TEXT NOT NULL DEFAULT 'lead',
  ADD COLUMN IF NOT EXISTS slug           TEXT;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_vetting_status_chk
    CHECK (vetting_status IN (
      'lead','invited','in_verification','verified',
      'failed','suspended','declined','removed'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Public URL segment. Nullable until verified; a partial unique index so
-- the ~15,822 unverified rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_leads_slug_uniq
  ON public.coldcall_leads (slug) WHERE slug IS NOT NULL;


-- ── 3. The nine checks ───────────────────────────────────────────────
-- BRIEF GAP, resolved explicitly: section 1 describes NINE checks and
-- section 5 gates verification on "all nine are pass", but section 3
-- names only EIGHT chk_* columns. Section 1's own list includes "court
-- records", which has no column — so chk_court_records is added as the
-- ninth. Flagged in the report; change it if that reading is wrong.
--
-- Each is nullable so partial progress is visible, and every one carries
-- an INTERNAL note that is never published (see the public API).
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS chk_licensing_board        TEXT,
  ADD COLUMN IF NOT EXISTS chk_licensing_board_note   TEXT,
  ADD COLUMN IF NOT EXISTS chk_license                TEXT,
  ADD COLUMN IF NOT EXISTS chk_license_note           TEXT,
  ADD COLUMN IF NOT EXISTS chk_insurance              TEXT,
  ADD COLUMN IF NOT EXISTS chk_insurance_note         TEXT,
  ADD COLUMN IF NOT EXISTS chk_business_filing        TEXT,
  ADD COLUMN IF NOT EXISTS chk_business_filing_note   TEXT,
  ADD COLUMN IF NOT EXISTS chk_court_records          TEXT,
  ADD COLUMN IF NOT EXISTS chk_court_records_note     TEXT,
  ADD COLUMN IF NOT EXISTS chk_address                TEXT,
  ADD COLUMN IF NOT EXISTS chk_address_note           TEXT,
  ADD COLUMN IF NOT EXISTS chk_years_in_business      TEXT,
  ADD COLUMN IF NOT EXISTS chk_years_in_business_note TEXT,
  ADD COLUMN IF NOT EXISTS chk_contact                TEXT,
  ADD COLUMN IF NOT EXISTS chk_contact_note           TEXT,
  ADD COLUMN IF NOT EXISTS chk_reviews                TEXT,
  ADD COLUMN IF NOT EXISTS chk_reviews_note           TEXT,
  ADD COLUMN IF NOT EXISTS chk_last_run               TIMESTAMPTZ;

-- One guarded CHECK per result column: 'pass' | 'fail' | 'na' | NULL.
DO $$
DECLARE ch TEXT;
BEGIN
  FOREACH ch IN ARRAY ARRAY[
    'chk_licensing_board','chk_license','chk_insurance','chk_business_filing',
    'chk_court_records','chk_address','chk_years_in_business','chk_contact','chk_reviews'
  ] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.coldcall_leads ADD CONSTRAINT %I CHECK (%I IS NULL OR %I IN (''pass'',''fail'',''na''))',
        'coldcall_leads_' || ch || '_chk', ch, ch);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;


-- ── 4. Verification lifecycle timestamps ─────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS verified_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_year INTEGER,
  ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reverify_due  TIMESTAMPTZ,
  -- Publish is deliberately SEPARATE from verified (brief section 5): the
  -- checks can be finished before the profile goes live.
  ADD COLUMN IF NOT EXISTS is_published  BOOLEAN NOT NULL DEFAULT false;


-- ── 5. Published profile fields ──────────────────────────────────────
-- Only what the public API may return. Scraped city/state/parish/rating/
-- review_count are reused (see NAMING above) and are covered by
-- chk_address / chk_reviews before anything is published.
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS legal_name        TEXT,
  ADD COLUMN IF NOT EXISTS trading_name      TEXT,
  ADD COLUMN IF NOT EXISTS trade             TEXT,
  ADD COLUMN IF NOT EXISTS license_number    TEXT,
  ADD COLUMN IF NOT EXISTS license_state     TEXT,
  ADD COLUMN IF NOT EXISTS gl_carrier        TEXT,
  ADD COLUMN IF NOT EXISTS years_in_business INTEGER,
  ADD COLUMN IF NOT EXISTS blurb             TEXT,
  ADD COLUMN IF NOT EXISTS services          TEXT[];

-- Digital Trust Index: overall + five pillars, each 0-100.
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS dti_score          INTEGER,
  ADD COLUMN IF NOT EXISTS dti_findability    INTEGER,
  ADD COLUMN IF NOT EXISTS dti_answerability  INTEGER,
  ADD COLUMN IF NOT EXISTS dti_responsiveness INTEGER,
  ADD COLUMN IF NOT EXISTS dti_completeness   INTEGER,
  ADD COLUMN IF NOT EXISTS dti_compliance     INTEGER;

DO $$
DECLARE cdti TEXT;
BEGIN
  FOREACH cdti IN ARRAY ARRAY[
    'dti_score','dti_findability','dti_answerability',
    'dti_responsiveness','dti_completeness','dti_compliance'
  ] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.coldcall_leads ADD CONSTRAINT %I CHECK (%I IS NULL OR (%I BETWEEN 0 AND 100))',
        'coldcall_leads_' || cdti || '_chk', cdti, cdti);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- 2-char state code on the vetting side. The scraped `state` is left
-- unconstrained: 5,552 leads have it NULL and it is not a published claim.
DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_license_state_chk
    CHECK (license_state IS NULL OR license_state ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 6. Commercial ────────────────────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS plan                   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS is_comped              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comp_reason            TEXT,
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS paid_through           TIMESTAMPTZ,
  -- Comp -> paid conversion pipeline (brief section 6).
  ADD COLUMN IF NOT EXISTS comp_offer_status      TEXT,
  ADD COLUMN IF NOT EXISTS comp_offered_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comp_decided_at        TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_plan_chk
    CHECK (plan IN ('none','verification','exclusive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_comp_offer_status_chk
    CHECK (comp_offer_status IS NULL OR comp_offer_status IN ('offered','accepted','declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 7. Exclusivity ───────────────────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS exclusive_trade  TEXT,
  ADD COLUMN IF NOT EXISTS exclusive_county TEXT,
  ADD COLUMN IF NOT EXISTS exclusive_state  TEXT,
  ADD COLUMN IF NOT EXISTS exclusive_until  TIMESTAMPTZ;

-- CORRECTION TO THE BRIEF'S SQL. The brief writes:
--     ... where plan='exclusive' and vetting_status='verified'
--           and exclusive_until > now()
-- Postgres REJECTS that: an index predicate must be IMMUTABLE, and now()
-- is STABLE ("functions in index predicate must be marked IMMUTABLE",
-- SQLSTATE 42P17). The index would fail to create, and the race the
-- brief calls non-negotiable would be left unguarded.
--
-- The predicate keeps the two immutable conditions, so at most ONE
-- verified exclusive row can hold an area at a time. Expiry is handled
-- by clearing the exclusive_* fields when exclusive_until passes (the
-- sweep in the exclusivity manager), which frees the slot — rather than
-- by a predicate Postgres cannot evaluate.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_leads_one_exclusive_per_area
  ON public.coldcall_leads (exclusive_trade, exclusive_county, exclusive_state)
  WHERE plan = 'exclusive'
    AND vetting_status = 'verified'
    AND exclusive_trade IS NOT NULL
    AND exclusive_county IS NOT NULL
    AND exclusive_state IS NOT NULL;


-- ── 8. Consent / listing control ─────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS listing_consent      TEXT,
  ADD COLUMN IF NOT EXISTS notified_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removal_requested_at TIMESTAMPTZ,
  -- Tokenised one-click removal (brief section 6). Random, unguessable,
  -- and unique so the link identifies exactly one lead without a login.
  ADD COLUMN IF NOT EXISTS removal_token        TEXT;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_listing_consent_chk
    CHECK (listing_consent IS NULL OR listing_consent IN ('pending','granted','declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS coldcall_leads_removal_token_uniq
  ON public.coldcall_leads (removal_token) WHERE removal_token IS NOT NULL;


-- ── 9. Indexes for the public API reads ──────────────────────────────
-- GET /api/directory filters verified rows by state/county/trade, and
-- lists unvetted rows. Both are hot and both are partial.
CREATE INDEX IF NOT EXISTS coldcall_leads_directory_verified
  ON public.coldcall_leads (state, parish, trade)
  WHERE vetting_status = 'verified';

CREATE INDEX IF NOT EXISTS coldcall_leads_directory_unvetted
  ON public.coldcall_leads (state, parish, category)
  WHERE vetting_status = 'lead';

-- Re-verification dashboard: everything due inside 60 days.
CREATE INDEX IF NOT EXISTS coldcall_leads_reverify_due
  ON public.coldcall_leads (reverify_due)
  WHERE vetting_status = 'verified';

-- Vetting queue, oldest first.
CREATE INDEX IF NOT EXISTS coldcall_leads_vetting_status
  ON public.coldcall_leads (vetting_status, updated_at);


-- ── 10. Audit log (append-only) ──────────────────────────────────────
-- Verification decisions need a paper trail (brief section 5). Append-
-- only is enforced by a TRIGGER, not by convention: the Worker uses the
-- service-role key, which bypasses RLS, so RLS alone would not stop an
-- UPDATE or DELETE issued from application code.
CREATE TABLE IF NOT EXISTS public.coldcall_vetting_audit (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        NOT NULL REFERENCES public.coldcall_leads(id) ON DELETE CASCADE,
  actor_user_id UUID,
  actor_email   TEXT,
  field         TEXT        NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coldcall_vetting_audit_lead
  ON public.coldcall_vetting_audit (lead_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.coldcall_vetting_audit_append_only()
RETURNS TRIGGER AS $fn$
BEGIN
  RAISE EXCEPTION 'coldcall_vetting_audit is append-only (attempted %)', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_vetting_audit_no_update
    BEFORE UPDATE OR DELETE ON public.coldcall_vetting_audit
    FOR EACH ROW EXECUTE FUNCTION public.coldcall_vetting_audit_append_only();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 11. Config (grace period etc.) ───────────────────────────────────
-- Brief section 6: "Decide the grace period and make it a config value."
-- A key/value table keeps it out of code, consistent with NO-CONSTANTS.
CREATE TABLE IF NOT EXISTS public.coldcall_config (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.coldcall_config (key, value, note) VALUES
  ('comp_grace_days', '30',
   'Days a comped listing stays live after its comp term ends without converting to paid. After this it drops from the public API automatically.')
ON CONFLICT (key) DO NOTHING;

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_config_updated_at
    BEFORE UPDATE ON public.coldcall_config
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 12. RLS: deny-by-default, matching every other coldcall_* table ──
-- The public directory is served by the Worker via the service-role key,
-- which bypasses RLS. anon/authenticated must read NOTHING directly —
-- coldcall_leads holds third-party PII (phones, call notes) and only the
-- Worker's whitelisted column projection may leave the database.
ALTER TABLE public.coldcall_vetting_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coldcall_config        ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coldcall_vetting_audit FROM anon, authenticated;
REVOKE ALL ON public.coldcall_config        FROM anon, authenticated;


-- == Verify (paste after applying) =============================================
-- 1a retirement — trustlight inactive, no active trustlight signups:
--   SELECT slug, active FROM public.coldcall_services ORDER BY sort_order;
--   SELECT service_slug, status, count(*) FROM public.coldcall_lead_signups
--    GROUP BY 1,2 ORDER BY 1,2;
--   -- svc_trustlight must STILL exist (kept by decision 1a):
--   SELECT count(*) FROM public.coldcall_leads WHERE svc_trustlight;   -- expect 17
--
-- vetting_status present, defaulted, and distinct from status:
--   SELECT vetting_status, count(*) FROM public.coldcall_leads GROUP BY 1;
--   -- expect one row: lead | 15822
--   SELECT status, count(*) FROM public.coldcall_leads GROUP BY 1;  -- unchanged
--
-- All nine check columns + notes exist (expect 19 incl. chk_last_run):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='coldcall_leads' AND column_name LIKE 'chk_%' ORDER BY 1;
--
-- CHECK constraints landed (9 chk_* + 6 dti_* + plan + consent + …):
--   SELECT conname FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
--    WHERE rel.relname='coldcall_leads' AND con.contype='c' ORDER BY 1;
--
-- Exclusivity index exists (and note it has NO now() predicate):
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename='coldcall_leads' AND indexname LIKE '%exclusive%';
--
-- Audit log really is append-only — the INSERT works, the other two RAISE:
--   INSERT INTO public.coldcall_vetting_audit (lead_id, field, new_value)
--     SELECT id, 'test', 'x' FROM public.coldcall_leads LIMIT 1;
--   UPDATE public.coldcall_vetting_audit SET field='nope';  -- expect EXCEPTION
--   DELETE FROM public.coldcall_vetting_audit;              -- expect EXCEPTION
--
-- Config seeded:
--   SELECT key, value FROM public.coldcall_config;
--
-- RLS on, zero policies, on the two new tables:
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE tablename IN ('coldcall_vetting_audit','coldcall_config');
-- =====================================================================

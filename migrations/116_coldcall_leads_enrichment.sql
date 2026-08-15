-- =====================================================================
-- Migration 116: coldcall_leads — LeadScout enrichment columns
-- =====================================================================
-- Source: "IMPORT the LeadScout export into coldcall_leads" brief, 2026-08-14.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: every ADD COLUMN is IF NOT EXISTS, every index is
-- IF NOT EXISTS, and the CHECK constraints are added through a guard block.
--
-- Adds the ranking-audit and digital-footprint columns produced by the
-- victora-leadscout pipeline. ALL NULLABLE — only the top 1,000 leads were
-- enriched; the other 14,822 carry NULL in every enrichment column.
--
-- THE BLANK-vs-FALSE RULE (the single most important thing in this file):
-- every enrichment boolean is NULLABLE and NULL means "we did not look".
--   NULL  = not checked (no website to probe, or robots.txt told us not to)
--   false = checked, and genuinely absent ("none detected" in the source)
--   true  = checked, and present
-- Collapsing NULL into false would turn 15,313 un-probed businesses into
-- 15,313 businesses we falsely claim to have verified. Never do it.
--
-- SCORE COLUMN: the file's `sales_ready_score` loads into the EXISTING
-- `call_score` column from migration 115. They are the same composite score
-- under two names. No second score column is created.
--
-- adoption_mindset, digital_gap and address_flag are intentionally left in
-- place and NULL — the Sales-Ready model does not produce them.
-- =====================================================================

-- ── Ranking audit ────────────────────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS rank                  INTEGER,
  ADD COLUMN IF NOT EXISTS is_unrated            BOOLEAN,
  ADD COLUMN IF NOT EXISTS score_category        NUMERIC,
  ADD COLUMN IF NOT EXISTS score_review          NUMERIC,
  ADD COLUMN IF NOT EXISTS score_rating          NUMERIC,
  ADD COLUMN IF NOT EXISTS score_category_source TEXT,
  ADD COLUMN IF NOT EXISTS is_cap_demoted        BOOLEAN;

-- ── Location detail (blank for the 5,552 non-DMA-sweep rows) ─────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS city              TEXT,
  ADD COLUMN IF NOT EXISTS state             TEXT,
  ADD COLUMN IF NOT EXISTS zip               TEXT,
  ADD COLUMN IF NOT EXISTS phone_e164_digits TEXT,
  ADD COLUMN IF NOT EXISTS business_status   TEXT;

-- ── Enrichment status ────────────────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_wave   TEXT,
  ADD COLUMN IF NOT EXISTS enriched_at       TIMESTAMPTZ;

-- ── Enrichment booleans — NULL means NOT CHECKED. See the rule above. ─
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS has_website         BOOLEAN,
  ADD COLUMN IF NOT EXISTS chat_widget         BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_voice_agent      BOOLEAN,
  ADD COLUMN IF NOT EXISTS booking_tool        BOOLEAN,
  ADD COLUMN IF NOT EXISTS call_tracking       BOOLEAN,
  ADD COLUMN IF NOT EXISTS analytics_pixels    BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_schema_org      BOOLEAN,
  ADD COLUMN IF NOT EXISTS recently_registered BOOLEAN,
  ADD COLUMN IF NOT EXISTS hijack_flag         BOOLEAN;

-- ── Vendor detail behind those booleans ──────────────────────────────
-- The source records WHICH vendor was detected ('["GoHighLevel"]',
-- '["CallRail"]', '["GA4", "GTM"]'), not merely that something was. The
-- brief specifies booleans, and a boolean alone would discard that — which
-- matters here because the CSV is deleted after this import, so anything not
-- loaded is gone for good. The boolean answers "do they have one?"; the
-- _detail column answers "which one?", and a caller can use both.
-- NULL here follows the same rule: not checked.
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS chat_widget_detail      TEXT,
  ADD COLUMN IF NOT EXISTS ai_voice_agent_detail   TEXT,
  ADD COLUMN IF NOT EXISTS booking_tool_detail     TEXT,
  ADD COLUMN IF NOT EXISTS call_tracking_detail    TEXT,
  ADD COLUMN IF NOT EXISTS analytics_pixels_detail TEXT;

-- ── Site + domain detail ─────────────────────────────────────────────
ALTER TABLE public.coldcall_leads
  ADD COLUMN IF NOT EXISTS website_url          TEXT,
  ADD COLUMN IF NOT EXISTS site_state           TEXT,
  ADD COLUMN IF NOT EXISTS site_http_status     INTEGER,
  ADD COLUMN IF NOT EXISTS platform             TEXT,
  ADD COLUMN IF NOT EXISTS domain               TEXT,
  ADD COLUMN IF NOT EXISTS domain_registered_on TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS domain_age_days      INTEGER,
  ADD COLUMN IF NOT EXISTS domain_registrar     TEXT,
  ADD COLUMN IF NOT EXISTS hijack_reason        TEXT,
  ADD COLUMN IF NOT EXISTS signal_confidence    TEXT;

-- ── CHECK constraints on the status-ish text columns ─────────────────
-- Guarded rather than IF NOT EXISTS (Postgres has no such form for ADD
-- CONSTRAINT), so re-running is safe.
DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_business_status_chk
    CHECK (business_status IS NULL OR business_status IN
           ('OPERATIONAL','CLOSED_TEMPORARILY','CLOSED_PERMANENTLY'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_enrichment_status_chk
    CHECK (enrichment_status IS NULL OR enrichment_status IN
           ('fully_enriched','no_website_found','skipped_robots_txt',
            'probe_failed','not_enriched'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_site_state_chk
    CHECK (site_state IS NULL OR site_state IN
           ('alive','dead_http_error','parked_or_lead_gen','unknown','not_probed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────
-- Hijacked domains are a "call today regardless of score" signal, so they get
-- their own tiny partial index rather than a scan of 15,822 rows.
CREATE INDEX IF NOT EXISTS coldcall_leads_hijack
  ON public.coldcall_leads (call_score DESC) WHERE hijack_flag = true;

-- The digital-gap worklist: businesses with no website at all.
CREATE INDEX IF NOT EXISTS coldcall_leads_no_website
  ON public.coldcall_leads (call_score DESC) WHERE has_website = false;

CREATE INDEX IF NOT EXISTS coldcall_leads_rank
  ON public.coldcall_leads (rank);

-- == Verify (paste after applying) =============================================
-- New columns exist and are all nullable:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='coldcall_leads'
--    ORDER BY ordinal_position;
--
-- CHECK constraints:
--   SELECT con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname='coldcall_leads' AND con.contype='c';
--
-- Indexes:
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname='public' AND tablename='coldcall_leads';
--
-- AFTER the import, the blank-vs-false rule should hold — NULL must dominate
-- every enrichment boolean, because only 1,000 leads were enriched:
--   SELECT count(*) FILTER (WHERE chat_widget IS NULL)  AS not_checked,
--          count(*) FILTER (WHERE chat_widget IS FALSE) AS none_detected,
--          count(*) FILTER (WHERE chat_widget IS TRUE)  AS present
--     FROM public.coldcall_leads;      -- expect 15,313 / 460 / 49

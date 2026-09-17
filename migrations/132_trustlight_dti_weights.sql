-- =====================================================================
-- Migration 132: DTI scoring weights in config
-- =====================================================================
-- Safe to re-run: every INSERT is ON CONFLICT DO NOTHING.
--
-- The Digital Trust Index is computed from the LeadScout enrichment signals
-- migration 116 loaded, NOT from the five dti_* pillar columns migration 126
-- added. Those pillars were written for website copy; nothing ever populated
-- them, and three of the five cannot be computed from any data we hold
-- (responsiveness, completeness, compliance). They stay in the table,
-- nullable and unused. See src/lib/trustlight-dti.ts.
--
-- NO HARDCODED WEIGHTS. The scorer reads these rows at call time and throws
-- if one is missing rather than falling back to a number nobody chose. Change
-- a weight here and the next scoring run uses it; no deploy required.
--
-- Weights sum to 100 for readability, but they do NOT have to: a NULL signal
-- is dropped from the denominator rather than scored as zero, so the divisor
-- is whatever weight was actually checked on that row.
-- =====================================================================

INSERT INTO public.coldcall_config (key, value, note) VALUES
  ('dti_weight_site_alive', '30',
   'DTI: the website responds. site_state = alive. The single strongest signal that a business can be reached online at all.'),

  ('dti_weight_schema_org', '25',
   'DTI: the site carries schema.org structured data. The main thing that decides whether search engines and AI assistants can describe a business correctly.'),

  ('dti_weight_domain_age', '20',
   'DTI: domain maturity, scaled linearly to 1095 days (3 years). Storm-chaser domains are registered days before use, and age is the one signal here that cannot be faked quickly.'),

  ('dti_weight_contact_tooling', '15',
   'DTI: any one of chat widget, booking tool or call tracking. An OR, not three weights — a booking tool and a chat widget are the same quality (reachable), and counting both would double-score it.'),

  ('dti_weight_analytics', '10',
   'DTI: analytics pixels present, read as a proxy for a site somebody still maintains. Weakest signal, lowest weight.'),

  ('dti_min_signals', '3',
   'DTI: minimum signals actually checked before a score is published. Below this the score is NULL and the card hides the block. NEVER scored as 0 — see the blank-vs-false rule in migration 116.')
ON CONFLICT (key) DO NOTHING;

-- ── Deliberately NOT weighted ────────────────────────────────────────
-- ai_voice_agent: 0 of the 509 fully_enriched businesses have one. A signal
-- that is false for every row is a constant, and including it would only
-- dilute the weights that do discriminate. Revisit if adoption changes.

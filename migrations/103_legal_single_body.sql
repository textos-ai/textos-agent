-- =====================================================================
-- Migration 103: one body field per legal document, not twelve
-- =====================================================================
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 102.
-- Safe to re-run: idempotent key removal and object merge.
-- =====================================================================
--
-- WHY THIS REPLACES 102's CLAUSE MODEL
--
-- 102 shipped 12 clause headings per instance with a site-authored field behind
-- each one. That was wrong about how the text arrives. Nobody retypes a legal
-- document into twelve labelled boxes — it comes as a finished document from a
-- lawyer or an existing site, and it gets pasted in one go. Worse, the labels
-- ("Clause 5") told an operator nothing about what the box was for, so text went
-- in and disappeared with no way to tell where it had gone.
--
-- So: ONE long text field per document. The field goes away as a concept, not just
-- as a name.
--
--   Terms of Service  -> legal_body_text, whole document
--   Privacy Policy    -> legal_body_text, whole document
--   plus legal_last_updated, unchanged from 102
--
-- Both documents use the SAME field key. Each legal instance has its own
-- legal_body section row, so the two bodies are stored separately with no key
-- collision — the same mechanism that lets every page have its own page_hero copy.
--
-- 102'S PRINCIPLE IS UNCHANGED: no default text, and an empty body renders
-- nothing. The template supplies a section and a heading, never a word of legal
-- prose. Headings INSIDE the pasted text are the author's business, not the
-- schema's — the renderer preserves paragraph breaks and escapes everything else.
--
-- No data migration needed: `SELECT count(*) FROM site_fields WHERE field_key LIKE
-- 'clause_%'` was 0 at the time of writing (the legal pages had not been
-- provisioned), so there is nothing to carry over. The DELETE below is a safety
-- net for any row created between writing and applying.
-- =====================================================================

-- ── 1. drop the 12 clause fields, add the single body field ───────────
UPDATE public.site_templates AS t
SET field_derivation_map = jsonb_set(
      t.field_derivation_map,
      '{site_fields}',
      (
        SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
        FROM jsonb_each(COALESCE(t.field_derivation_map->'site_fields', '{}'::jsonb))
        WHERE key NOT LIKE 'clause_%'
      )
      || jsonb_build_object('legal_body_text', jsonb_build_object('site_authored', true))
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── 2. drop the per-instance clause structure ─────────────────────────
-- The instance keeps its key, route, title and meta_defaults. `clauses` is
-- removed outright: there is no clause list any more, so leaving an unused one
-- would be exactly the mystery cruft a future dev deletes without knowing why.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   jsonb_set(pt, '{instances}', (
                     SELECT jsonb_agg((inst - 'clauses') ORDER BY ord2)
                     FROM jsonb_array_elements(pt->'instances') WITH ORDINALITY AS y(inst, ord2)
                   ))
                 ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── 3. re-word the legal_body section for one field ───────────────────
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT jsonb_agg(
                              CASE WHEN sec->>'section_key' = 'legal_body' THEN
                                sec || jsonb_build_object(
                                  'label', 'Document text',
                                  'description',
                                    'The wording of this document. Paste the whole thing in — '
                                    || 'from your lawyer, or from your existing website. '
                                    || 'Numbered lines become headings and blank lines start new paragraphs. '
                                    || 'Nothing is written here for you, and while it is empty this '
                                    || 'section does not appear on your site at all.',
                                  'field_help', jsonb_build_object(
                                    'legal_body_text',
                                    'Paste the complete text of this document. Formatting that is understood: '
                                    || 'a line starting with a number ("1. Services Provided") becomes a heading; '
                                    || 'so does a short line in CAPITALS. A line starting with - or a bullet '
                                    || 'becomes a list item. A blank line starts a new paragraph. Everything else '
                                    || 'is kept as written. Nothing is added for you.'
                                  ))
                              ELSE sec END
                              ORDER BY (sec->>'order')::int
                            )
                     FROM jsonb_array_elements(pt->'sections') AS sec
                   ))
                 ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── 4. safety net: remove any clause rows created since 102 ───────────
DELETE FROM public.site_fields WHERE field_key LIKE 'clause_%';


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. No clause fields anywhere, and legal_body_text exists:
--   SELECT key FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields')
--   WHERE t.template_key='trades-v1'
--     AND (key LIKE 'clause_%' OR key IN ('legal_body_text','legal_last_updated'))
--   ORDER BY 1;
--   -- expect exactly: legal_body_text, legal_last_updated
--
-- 2. No instance carries a clause list, and both keep route + title + meta:
--   SELECT inst->>'instance_key', inst->>'route', inst->>'title',
--          inst ? 'clauses' AS still_has_clauses,
--          inst->'meta_defaults'->>'title'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'instances') inst
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal';
--   -- expect still_has_clauses = false on both rows
--
-- 3. No clause rows survive:
--   SELECT count(*) FROM public.site_fields WHERE field_key LIKE 'clause_%';
--   -- expect 0
--
-- 4. legal_body still ships no words of legal prose — only a label, a
--    description and field help:
--   SELECT sec->>'label', sec->'field_help'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal'
--     AND sec->>'section_key'='legal_body';
--   -- expect label 'Document text'
-- =====================================================================

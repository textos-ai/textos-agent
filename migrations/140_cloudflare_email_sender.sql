-- =====================================================================
-- Migration 140: Cloudflare Email Service sender config (replaces SendGrid)
-- =====================================================================
-- Source: "move Victora's two transactional emails from SendGrid to
--          Cloudflare Email Service" brief, 2026-11-25.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: INSERT ... ON CONFLICT (slug) DO NOTHING (an edited
-- sender is never overwritten); the UPDATEs are scoped and converge.
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- src/lib/email.ts (the one outbound sender) reads the from-address and
-- from-name from the external_apis row 'cloudflare-email' — the same
-- provider registry that holds the model config (external_apis.metadata).
-- Nothing is hardcoded; if this row, its status or either field is
-- missing, every send throws. Edit metadata here to change the sender.
--
-- 1. Insert external_apis 'cloudflare-email' (provider cloudflare, auth via
--    the Worker's send_email binding, so auth_kind 'none').
-- 2. Mark external_apis 'sendgrid-email' deprecated. Not deleted:
--    task_apis rows reference it (ON DELETE RESTRICT).
-- 3. welcome-email's task_apis binding (role 'secondary') moves from
--    sendgrid-email to cloudflare-email. The cold-email-outreach and
--    personalized-pitch-email bindings are left on the deprecated row:
--    those tasks only queue (email_queue) and send nothing.
--
-- Nothing is deleted. Nothing reads task_apis 'secondary' rows at runtime
-- (resolveModelForTask reads only 'primary'); step 3 keeps the registry
-- accurate.
-- =====================================================================

BEGIN;

-- 1.
INSERT INTO public.external_apis (slug, name, provider, endpoint_url, auth_kind, output_kind, status, metadata)
VALUES (
  'cloudflare-email',
  'Cloudflare Email Service',
  'cloudflare',
  NULL,
  'none',
  'email',
  'active',
  jsonb_build_object('from_email', 'hello@victora.ai', 'from_name', 'Victora')
)
ON CONFLICT (slug) DO NOTHING;

-- 2.
UPDATE public.external_apis
   SET status = 'deprecated'
 WHERE slug = 'sendgrid-email'
   AND status <> 'deprecated';

-- 3.
UPDATE public.task_apis ta
   SET api_id = (SELECT id FROM public.external_apis WHERE slug = 'cloudflare-email')
  FROM public.tasks t
 WHERE ta.task_id = t.id
   AND t.slug = 'welcome-email'
   AND ta.role = 'secondary'
   AND ta.api_id = (SELECT id FROM public.external_apis WHERE slug = 'sendgrid-email')
   AND NOT EXISTS (
     SELECT 1 FROM public.task_apis x
      WHERE x.task_id = t.id AND x.role = 'secondary'
        AND x.api_id = (SELECT id FROM public.external_apis WHERE slug = 'cloudflare-email')
   );

COMMIT;

-- ── VERIFICATION (runs as the last statement so the editor shows it) ──
-- Expected: cloudflare-email active with both fields; sendgrid-email
-- deprecated; welcome-email bound to cloudflare-email (secondary).
SELECT slug, status, metadata->>'from_email' AS from_email, metadata->>'from_name' AS from_name,
       (SELECT string_agg(t.slug || ':' || ta.role, ', ' ORDER BY t.slug)
          FROM public.task_apis ta JOIN public.tasks t ON t.id = ta.task_id
         WHERE ta.api_id = e.id) AS bound_tasks
  FROM public.external_apis e
 WHERE slug IN ('cloudflare-email', 'sendgrid-email')
 ORDER BY slug;

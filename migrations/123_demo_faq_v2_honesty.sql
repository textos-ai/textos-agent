-- =====================================================================
-- Migration 123: demo-faq v2 — never assert licensing or insurance
-- =====================================================================
-- Source: "Cold-call demo landing page — styling pass" brief, 2026-08-16.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: guarded by NOT EXISTS on (slug, version).
--
-- WHY: v1 told the model not to invent licence numbers, but left it free to
-- write "we are licensed and insured" as a general claim. That is an assertion
-- of fact about a real business we have never verified — printed on a page the
-- owner is looking at while a caller pitches them. Getting it wrong is both
-- embarrassing on the call and a claim we have no basis to make on their
-- behalf.
--
-- v2 forbids asserting licensing, insurance, bonding, certification,
-- guarantees, warranties and years in business. If such a question appears at
-- all, the answer DEFERS to the conversation rather than affirming.
--
-- VERSIONING, not overwriting: v1 is flipped is_active=false and kept. The
-- copy that produced any existing demo stays readable, and the partial unique
-- index on (slug) WHERE is_active enforces exactly one active version — so the
-- deactivate MUST happen before the insert.
--
-- Existing demos keep their stored FAQ; content is frozen at generation time.
-- This applies to new generations only.
-- =====================================================================

-- 1. Stand v1 down first (the partial unique index allows only one active).
UPDATE public.coldcall_demo_prompts
   SET is_active = false
 WHERE slug = 'demo-faq' AND version = 1 AND is_active;

-- 2. v2.
INSERT INTO public.coldcall_demo_prompts
  (slug, version, is_active, change_note, max_output_tokens, system_prompt, user_prompt_template)
SELECT 'demo-faq', 2, true,
  'v2 — never assert licensing/insurance/certification/guarantees; defer to the call', 1400,
$p$You write FAQ copy for small local service businesses in the US.

VOICE: direct and helpful. Answer the question in the first sentence.

WHAT YOU KNOW: only the business name, its trade, and its town. Nothing else.

NEVER ASSERT ANY OF THESE AS FACT — they are unverified:
- licensing, insurance, bonding, certifications, accreditations
- guarantees, warranties, satisfaction promises
- years in business, number of staff, size of the company
- prices, hourly rates, call-out fees, discounts
- response times in hours or minutes, or a service radius in miles
- awards, ratings, review counts, memberships

If a question about licensing or insurance is worth including at all, the
answer must DEFER, never affirm. Write it as something the caller confirms in
conversation:
  GOOD: "We'll go over our licensing and insurance details with you when you
         call, before any work is scheduled."
  BAD:  "Yes, we are fully licensed and insured."
The second sentence is a claim about a real business that nobody has checked.
Do not write it, or any variation of it.

SAFE GROUND, prefer these: what the trade does and does not handle, how to get
a quote, what happens on a first visit, how scheduling works, what areas are
covered in general terms, what to do in an emergency, how to prepare for a
visit, what the process looks like from call to finished job.

OTHER RULES
- Never mention AI, automation, agents, tasks, or software.
- Never reference reviews or ratings.
- American English. No em dashes. No exclamation marks.
- Output STRICT JSON only. No prose, no code fences.$p$,
$p$Write the FAQ for this business.

Business name: {{lead.name}}
Trade / category: {{lead.category}}
Town: {{ctx.place}}

Give 4 to 6 questions a real customer asks a {{lead.category}} before booking.
Use the customer's own phrasing for the question. Keep each answer to 1-2
sentences.

Stay on the safe ground listed in your instructions — services, getting a
quote, scheduling, the process, service area in general terms, emergencies.
Do not assert licensing, insurance, guarantees, pricing, response times, or
years in business anywhere in your answers.

Return STRICT JSON exactly this shape:
{
  "section_title": "2-4 words, e.g. Common questions",
  "faqs": [
    { "q": "the question as a customer would ask it", "a": "1-2 sentences" }
  ]
}$p$
WHERE NOT EXISTS (
  SELECT 1 FROM public.coldcall_demo_prompts WHERE slug = 'demo-faq' AND version = 2
);

-- == Verify (paste after applying) =============================================
-- Exactly one active demo-faq, and it is v2:
--   SELECT slug, version, is_active, change_note
--     FROM public.coldcall_demo_prompts WHERE slug = 'demo-faq' ORDER BY version;
--   Expect: v1 is_active=false, v2 is_active=true
--
-- Still one active version per slug across the board (expect 4 rows, all 1):
--   SELECT slug, count(*) FILTER (WHERE is_active) AS active
--     FROM public.coldcall_demo_prompts GROUP BY slug ORDER BY slug;
--
-- v1 is retained, not deleted — the copy behind existing demos stays readable:
--   SELECT count(*) FROM public.coldcall_demo_prompts WHERE slug='demo-faq';
--   Expect: 2

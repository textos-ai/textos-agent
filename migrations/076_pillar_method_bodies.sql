-- =====================================================================
-- Migration 076: Pillar method bodies + prompt v5 (real steering)
-- =====================================================================
-- The fix for "zero pillar voice": pillars now carry an executable METHOD
-- BODY (technique as steps), and prompt v5 makes the method LEAD with business
-- context subordinate + brand voice minimized (value-first).
--   - pillar_templates.method_body / business_pillars.method_body (copied on adopt)
--   - pillar_methods.source_video_url / source_transcript (for "Watch the method"
--     modal + richer source). Left NULL here; set per method when provided.
--   - Seeds method_body for the 5 Wiebe "Market to the Imagination" moves, the 8
--     Victora Core pillars, and the General default (from the approved draft).
--   - generate-social-post prompt v5.
--
-- Dollar-quoted + pure ASCII (paste-safe). Additive / idempotent.
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

ALTER TABLE public.pillar_templates ADD COLUMN IF NOT EXISTS method_body TEXT;
ALTER TABLE public.business_pillars ADD COLUMN IF NOT EXISTS method_body TEXT;
ALTER TABLE public.pillar_methods   ADD COLUMN IF NOT EXISTS source_video_url  TEXT;
ALTER TABLE public.pillar_methods   ADD COLUMN IF NOT EXISTS source_transcript TEXT;

-- ── Attribution wording on the Joanna Wiebe method ───────────────────────────
UPDATE public.pillar_methods SET credential = $q$As taught by Joanna Wiebe - conversion copywriter, founder of Copyhackers$q$
WHERE slug = 'joanna-wiebe';

-- ── SEED method bodies — Wiebe five (Market to the Imagination) ───────────────
UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - take the part of your category people quietly look down on and reframe it as a mark of taste. An inferior product can win on identity alone (Nespresso beat the technically superior Tassimo not by changing the coffee, but by changing the identity of the person drinking it: Clooney, the sleek kitchen, pods sampled like wine).
1. Find what people in your space secretly feel embarrassed about - the part that feels cheap, boring, or lesser.
2. Do not fight that perception - reframe it into a symbol of sophistication; make your version belong to a more elevated conversation entirely.
3. Change the IDENTITY of the person who chooses it, not the product's features.
The reader should finish feeling that choosing this says something flattering about who they are.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='joanna-wiebe' AND t.name='Flip the Status';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - the brain does not adopt new ideas, it adopts new versions of ones it already holds. Attach your brand to a myth already running in the customer's mind (Marlboro did not invent the cowboy - rugged, self-reliant, free - it moved in; the mythology did the heavy lifting because it was already installed).
1. Ask what myth is ALREADY running in the customer's mind - what they already believe about who they are.
2. Attach your brand to that existing archetype or story so it feels familiar, not intrusive.
3. Show the brand belongs inside the story they are already telling themselves.
The reader should feel your brand is shorthand for an identity they already aspire to.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='joanna-wiebe' AND t.name='Hijack the Myth';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - use this when your category has no existing myth to attach to: build one by teaching people something they did not know was there, giving them entry into a world with its own language and standards (Blue Bottle published a free course on brewing the perfect cup - not to sell coffee, but to make people LITERATE in coffee; that literacy changed how they saw themselves).
1. Ask: what does your industry know that most people do not - what would make someone feel smarter, more in-the-know for learning it?
2. Teach it generously and for free - open the door to a world with its own standards and hierarchy of taste.
3. Walk the reader through until they are literate; the generic version is now beneath who they have become.
The reader gains something to share and becomes loyal to whoever gave it to them.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='joanna-wiebe' AND t.name='Open the Hidden Door';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - turn a small, forgettable moment into a small, memorable ceremony, repeated every time, so you live in the customer's life without intruding (Starbucks: your name on the cup, called out, the same sequence in every store - the ritual was the product).
1. Look at the customer's day and find the dull moment - the checkout, the onboarding email, the confirmation page. Each is a missed ceremony.
2. Pick ONE and make it feel personal, repeatable, theirs - not grand or expensive, just a small ceremony.
3. Make it signal familiarity and warmth every time it plays out.
The reader should feel they belong to something.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='joanna-wiebe' AND t.name='Build the Ritual';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - the deepest move: make the customer believe something NEW about themselves, that they are more capable than they knew. Give them a capability that used to require permission, gatekeepers, or enterprise resources (Stripe: accepting payments used to need merchant accounts, bank approvals, weeks of waiting - Stripe's implicit message was "you can build now": no approval, no waiting, no middlemen; users did not just get a tool, they became a different kind of person - a builder, not someone waiting for permission).
1. Name the barrier that used to hold the reader back - the gate, the permission, the resource they did not have.
2. Show that the capability which once required an enterprise contract or a whole team is now available to them.
3. Close on who they BECOME - nimble, capable, an operator of their own business - not on features.
Ask: what could my reader do after finding this that they genuinely believed they could not do before? Sell that new version of who they are - nobody casually walks away from that.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='joanna-wiebe' AND t.name='Give Them a Superpower';

-- ── SEED method bodies — Victora Core eight ──────────────────────────────────
UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - name the reader's pain in their own words, before they can name it themselves.
1. Open on the specific pain the reader lives with - use the customer's REAL language from the Customer Understanding source (their actual phrases, jobs, pains).
2. Show you understand it deeply - the cost of it, the way it actually feels day to day.
3. Validate that it is real and not their fault - the structural reason it happens.
4. Only lightly gesture at resolution - this post is about being SEEN, not sold to.
Register: empathetic, direct. Center the reader's problem; naming the pain accurately IS the value. Do not pitch the product.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Customer Problems';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - share the real, unpolished journey of building so the reader learns from the process.
1. Pick a real, specific moment, decision, or lesson from building (a genuine detail, not a highlight reel).
2. Show the messy middle - the tradeoff, the mistake, the thing that was harder than expected.
3. Extract the transferable lesson the reader can use in their own building.
Register: candid, honest. The value is the transparency and the lesson - the reader should learn something they can apply, not just watch you succeed.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Building in Public';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - let results and real experiences carry the message, humbly.
1. Lead with a specific, concrete result or a real customer's experience (real numbers, real words - details earn trust).
2. Show the before-to-after transformation it represents.
3. Let the proof speak - confident but never boastful.
Register: confident, humble. Grounded in real specifics, never vague "customers love us." If real proof is not available, do not fabricate - do not invent a result.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Social Proof';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - teach one genuinely useful thing the reader can apply immediately.
1. Pick ONE specific, useful thing in your domain the reader would benefit from knowing.
2. Teach it clearly, step by step - actionable, not theoretical.
3. Make it immediately usable - they should be able to do it right after reading.
Register: helpful, instructional, clear. Pure value - give the knowledge freely and ask nothing; the business is absent from this post.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Education / How-To';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - show the human and the process, making the reader feel let in.
1. Reveal a real slice of how the work actually happens - a process, a day, a decision.
2. Show the human side - the person, the care, the real texture.
3. Connect it to something the reader relates to in their own work.
Register: personal, warm. The value is connection and relatability, not a product demo.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Behind the Scenes';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - offer a genuine, specific opinion on the reader's space that sharpens their thinking.
1. Take a clear, specific position on a trend, shift, or question in the industry.
2. Back it with reasoning and specifics, not just a hot take.
3. Give the reader a sharper way to think about their own situation.
Register: opinionated, thought-leadership. The value is a perspective worth considering - earn authority by being genuinely insightful, not contrarian for its own sake.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Industry Takes';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - share news in a way that leads with what it means FOR THE READER.
1. State the news clearly and quickly.
2. Immediately translate it to reader value - what this makes possible for THEM.
3. Give a clear next step if relevant.
Register: energetic, clear. This is the one pillar where the business IS the subject - but even here, lead with reader benefit, not self-congratulation. Use sparingly.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Announcements';

UPDATE public.pillar_templates t SET method_body = $b$TECHNIQUE - tell a real, personal story from the founder's journey that carries a lesson for the reader.
1. Open on a real, specific moment from the founder's journey (a struggle, a turning point, a decision).
2. Tell it honestly - the emotion, the stakes, the human truth.
3. Land on the insight the reader can take for their own journey.
Register: personal, narrative. The value is the human truth and the transferable lesson - a story that resonates, not a humble-brag origin myth.$b$
FROM public.pillar_methods m WHERE t.method_id = m.id AND m.slug='victora-core' AND t.name='Founder Story';

-- ── General default ──────────────────────────────────────────────────────────
UPDATE public.pillar_templates SET method_body = $b$Write a clear, well-rounded post that genuinely serves the reader. Draw on whatever part of the business's story is most relevant for this moment - no single fixed angle. Keep it useful and natural, not a hard pitch. This is the balanced default.$b$
WHERE is_default = true;

-- Backfill any already-adopted business_pillars from their source template.
UPDATE public.business_pillars bp SET method_body = t.method_body
FROM public.pillar_templates t
WHERE bp.source_template_id = t.id AND bp.method_body IS NULL AND t.method_body IS NOT NULL;

-- ── prompt_variables ─────────────────────────────────────────────────────────
INSERT INTO public.prompt_variables (name, description, source) VALUES
  ('pillar.method_body', 'The pillar method body - the executable technique (steps) the post must run. Leads the v5 prompt.', 'pillar.method_body')
ON CONFLICT (name) DO NOTHING;

-- ── generate-social-post prompt v5 (method leads; context subordinate) ───────
UPDATE public.prompt_definitions SET is_active = false
  WHERE task_slug = 'generate-social-post' AND is_active = true;

INSERT INTO public.prompt_definitions (task_slug, version, system_prompt, user_prompt_template, is_active, change_note)
VALUES (
  'generate-social-post', 5,
  $sys$You are an expert marketer who writes social posts by EXECUTING a proven copywriting technique. You are handed one technique (a content pillar) and you run it, step by step. The technique dictates the post's angle, structure, and voice. The business and customer details are only raw material the technique operates on - never the point of the post, and never a reason to write a product pitch. Write VALUE-FIRST: serve the reader using the technique; do not promote the business unless the technique explicitly calls for it. Return ONLY valid JSON - no markdown fences, no commentary, nothing before or after the JSON.$sys$,
  $tmpl$# THE TECHNIQUE TO EXECUTE (this dictates everything)
Pillar: {{pillar.name}}
Write this post by executing the following technique, step by step. This is your PRIMARY instruction. The angle, the structure, and the voice all come from here - not from the business details below, and not from any brand-voice description.

{{pillar.method_body}}

Voice / register: {{pillar.register}}

# HOW TO USE THE MATERIAL BELOW
Everything below is ONLY raw material the technique operates on. Do NOT let it turn this into a product pitch, an announcement, or a feature list. Serve the READER by running the technique. Mention the business only as much as the technique requires - for value techniques, that is little or none. A reader who knows this technique should be able to recognize it running in the post.

{{source.block}}{{direction.block}}# RAW MATERIAL - the business and its customer
Business name: {{business.name}}
What it does: {{ctx.business_summary}}
Who it serves: {{ctx.target_customer}}
What makes it distinct: {{ctx.key_differentiators}}
What it offers: {{ctx.value_proposition}}

# YOUR TASK
Write ONE social media post for {{platform.name}} that visibly EXECUTES the technique above.
- Character limit: {{platform.char_limit}} - the post MUST be under this.
- Native to {{platform.name}} in tone and format.
- Run the technique's steps in order; do NOT write a generic pitch or announcement.

Return ONLY this JSON object (no markdown, no fences, nothing before or after):
{"post":"...","hook":"...","cta":"...","character_count":0}

Fields:
- post: the complete post text, strictly under {{platform.char_limit}} characters
- hook: the opening line that grabs attention
- cta: the closing call-to-action (keep it soft for value techniques)
- character_count: exact character count of the post value$tmpl$,
  true,
  'Stage 3.5: method-body leads; business context subordinate; brand voice dropped; value-first.'
);

-- ── Verify (paste after applying) ─────────────────────────────────────────────
-- SELECT m.slug, t.name, length(t.method_body) AS body_len FROM pillar_templates t
--   JOIN pillar_methods m ON m.id=t.method_id ORDER BY m.display_order, t.display_order;
-- SELECT version, is_active FROM prompt_definitions WHERE task_slug='generate-social-post' ORDER BY version;

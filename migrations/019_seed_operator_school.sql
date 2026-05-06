-- ============================================================
-- BEGIN migration 019_seed_operator_school.sql
-- ============================================================
-- Operator School V1 — seed lessons + badges
-- 6 tasks × 2 lessons = 12 lessons (ALL FREE TIER)
-- 12 lesson badges + 6 task badges + 1 master = 19 badges total
-- Lesson content sourced from operator-school-lessons-v1.md
-- ============================================================

-- ── Task 1: Research & Strategy (FREE tier) ────────────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('research-strategy', 1, 'free', 'positioning-is-a-knife', 'founding', 101,
   'Positioning is a knife, not a paintbrush',
   E'Most people who fail at positioning fail the same way. They try to be appealing to everyone. They smooth the edges off their language so it offends no one. They write copy that says "we help businesses grow" and call it a value proposition.\n\nSharp positioning works the opposite way. It loses customers on purpose — the ones who would never have bought anyway, plus a few who might have but won''t fit. What''s left is a smaller pool of people who instantly know this is for them.\n\nThink of how Patagonia positions. "Don''t buy this jacket." That headline lost every customer who wanted a fast-fashion deal. It earned every customer who wanted to belong to a brand with conviction. Sharp.\n\nOr how a private chef might position: "I cook for six people, twice a month, by referral only." That sentence rejects 95% of the addressable market. The remaining 5% will fight to get on the list.\n\nThe test isn''t whether your positioning sounds nice. The test is whether anyone could read it and immediately say "that''s not for me." If everyone could be your customer, no one is.\n\nYour business has a positioning statement somewhere — generated during your research. Read it. Ask: who does this exclude? If the answer is "no one really," it''s a paintbrush, not a knife. Sharpen it. Pick the customer you want to repel as carefully as the one you want to attract.\n\nThe smaller the pool, the louder the signal.',
   'Mark complete when you''ve rewritten your positioning so it explicitly says no to a category of customer. Even one sentence that begins "This isn''t for…" counts.',
   6),
  ('research-strategy', 2, 'free', 'market-doesnt-care-about-your-idea', 'founding', 102,
   'The market doesn''t care about your idea — it cares about your edge',
   E'Founders fall in love with their ideas. The market falls in love with edges.\n\nThe difference matters. An idea is what you''re doing. An edge is why you, specifically, will do it better than anyone already doing it. Most ideas are fine. Most edges are missing.\n\nIf you''re starting a charcuterie service in New Orleans, the idea is "charcuterie boards." Nobody cares — there are six other people doing this within five miles. The edge might be: you spent ten years working with the Louisiana cheesemonger collective and you can source things nobody else can get. Or: your boards are designed for outdoor weddings in 95-degree humidity and don''t sweat. Or: you only take eight orders a month and every board is hand-assembled the morning of delivery.\n\nEach of those is an edge. Each one answers the question "why this person, instead of the six others?"\n\nMost founders, when pushed, can''t articulate their edge in one sentence. They hand-wave: "We''re more passionate" or "We care about quality." Those aren''t edges. Every business that''s still alive cares about quality. Every founder is passionate. Edges are operational, specific, and ideally hard to copy.\n\nYour free build did real research on you and your market. Look at what came back. Somewhere in there is a candidate edge — something about your background, your network, your geographic position, your obsessive attention to one specific thing. Find it. Sharpen it. Write it as one sentence.\n\nIf you can''t say your edge in one sentence, your customers can''t repeat it to a friend. And word of mouth is how small businesses are built.',
   'Mark complete when you can write your edge in one sentence that starts: "We''re the only ones who…" or "We''re better at X because…" — and a friend who knows your market would agree.',
   6)
ON CONFLICT (slug) DO NOTHING;

-- ── Task 2: Market Size — TAM/SAM/SOM (FREE tier) ──────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('tam-sam-som', 1, 'free', 'tam-is-fiction-sam-is-theory', 'founding', 103,
   'TAM is fiction. SAM is theory. SOM is reality.',
   E'Your free build produced three market-size numbers — TAM, SAM, SOM. Most founders reading those numbers focus on the biggest one. That''s the wrong move.\n\nTAM — Total Addressable Market — is fiction. It''s the answer to "how big could this be if everyone in the universe who could possibly want it bought it from someone." The number is large because it includes everyone you''ll never reach: the wrong country, the wrong demographic, the wrong attention span, the wrong purchase moment. TAM is what you put on a slide to make investors nod. It does not predict anything about your actual business.\n\nSAM — Serviceable Addressable Market — is theory. It''s TAM minus the people you genuinely couldn''t reach (wrong language, wrong region, wrong channel). Closer to reality, but still includes everyone who could buy from someone like you. They probably won''t buy from you, specifically.\n\nSOM — Serviceable Obtainable Market — is the only number that should change your decisions. It''s the slice of SAM you can plausibly reach with the channels and budget you actually have, in the timeframe you''re working in. For a New Orleans charcuterie service in year one, SOM might be 200 households who throw 4+ dinner parties a year and live within delivery range. That''s the number that determines whether your business is a real business.\n\nFounders make a specific mistake here: they confuse TAM with opportunity. "It''s a $2.3 billion market" sounds great until you realize you''ll see 0.0001% of it. Operators do the inverse — they obsess over SOM and forget the bigger numbers exist. SOM is the math that matters: how many real customers, in your real reach, with your real budget, could you serve in twelve months? If the answer is 50 and your business needs 500 to break even, you don''t have a business yet. You have a hypothesis.',
   'Mark complete when you''ve pulled your SOM number from your market research and stared at it for sixty seconds. Ask: at full capacity, can I serve enough of these people to make a living? If yes — proceed. If no — your SOM is too small or your pricing is too low.',
   7),
  ('tam-sam-som', 2, 'free', 'interview-beats-survey', 'founding', 104,
   'The interview beats the survey, every time',
   E'There is one form of market research that is reliably wrong, and one that is reliably right.\n\nSurveys are reliably wrong. Not because survey-takers lie — though they sometimes do — but because surveys ask people to predict their future behavior. Humans are bad at this. Asked "would you buy this product at $40?" people say yes if they like the idea. Then the product launches and they don''t buy. Surveys measure intent. Markets measure money.\n\nInterviews are reliably right, if you do them correctly. The right way: pick five potential customers. Talk to each for thirty minutes. Ask not what they would buy, but what they''re already doing. "How are you currently solving this problem? What did you try before that? What would you change about your current solution?" Past behavior predicts future behavior far better than stated intent does.\n\nA founder running a charcuterie service shouldn''t survey 200 people about whether they''d order. She should call five hosts who already throw dinner parties and ask: "Walk me through the last party you hosted. What did you serve? Where did you buy it? What did it cost? What did you wish was easier?" Five conversations like that produce more usable insight than a thousand-person survey.\n\nThe interview also does something the survey cannot: it builds trust with five people who might become your first five customers. A good interview ends with the interviewee asking "so when can I order from you?" You haven''t sold them anything yet. They''ve sold themselves.\n\nThe instinct to scale research with surveys is the same instinct that produces bad businesses. Real markets are built one conversation at a time. The first ten interviews teach you what to charge, what to fix, and who to reach next. After fifty, statistics start to matter. Before fifty, every interview is gold.',
   'Mark complete when you''ve scheduled three customer interviews this week. Calendar invites sent. Real names attached.',
   6)
ON CONFLICT (slug) DO NOTHING;

-- ── Task 3: Mission Document (FREE tier) ───────────────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('mission-document', 1, 'free', 'mission-is-a-decision-filter', 'founding', 105,
   'A mission isn''t a slogan — it''s a decision filter',
   E'The reason most mission statements are useless is that they''re written for marketing instead of for decisions. "To bring joy and connection through artisan food." That sentence cannot tell you whether to take a corporate catering job that pays well but makes you miserable. It cannot tell you whether to expand to a second city or stay focused on the first. It is decoration.\n\nA real mission is a decision filter. When written well, it produces clear yes-or-no answers in moments where you''d otherwise waver. "We make food that turns strangers into friends, by hand, in New Orleans." That sentence rejects the corporate catering job (it''s not turning strangers into friends; it''s feeding employees who already work together). It rejects the second city (we make food in New Orleans). It tells you what to focus on when an opportunity comes that doesn''t fit. It tells you what to say no to.\n\nFounders without a real mission spend a lot of time saying yes to the wrong things. They take work that doesn''t fit because they don''t have language for why it doesn''t fit. They expand in directions that drain them because they can''t articulate why those directions are wrong. Six months in, they''re working on three things they don''t love and can''t say no to any of them, because they never named what they were actually trying to do.\n\nThe mission test is uncomfortable. Read your mission. Then ask: "What opportunity would I turn down because of this?" If the answer is "nothing, really, it''s pretty broad," your mission isn''t doing its job. Sharpen until it can reject things. The narrower the mission, the more powerful the business.',
   'Mark complete when you''ve named one specific opportunity you would turn down because it doesn''t fit your mission. Write it down. The discipline of naming it is the lesson.',
   5),
  ('mission-document', 2, 'free', 'mission-test-turn-down-money', 'founding', 106,
   'The mission test — would you turn down money to keep it?',
   E'There''s a simple test for whether your mission is real. Would you turn down money to keep it?\n\nIf yes, you have a mission. If no, you have marketing copy.\n\nPatagonia turned down money. They''ve refused to make products that don''t meet their environmental standards. They''ve taken full-page ads telling customers not to buy. They lose revenue every year on the altar of their mission. That''s why people trust them.\n\nMost small businesses say things like "we believe in quality" or "we put customers first" but cannot point to a single instance where they refused money on principle. That''s because their mission isn''t a mission — it''s a marketing line.\n\nYour mission becomes real the first time it costs you something. The wedding venue that won''t book three events on the same weekend because their mission is "every couple gets our full attention." The chef who won''t open a second location because their mission is "food I personally cook." The consultancy that turns down clients in industries they don''t believe in. Each of these decisions costs real money. Each one signals to everyone watching that the mission is operational, not decorative.\n\nThis is also where the founder myth either becomes real or stays fake. Casey can write a mission that says "hand-built boards from local sources only." The first time a Sysco rep offers her wholesale pricing on bulk imported cheese — and she says no — her mission becomes real. To her, to her customers, to her future hires. The refusal is the lesson.\n\nYou don''t need to refuse money this week. But you should know what you would refuse. If you can''t name what your mission would cost you, write a sharper mission.',
   'Mark complete when you''ve written down one specific kind of money your mission would cause you to turn away. The pact is between you and the page; nobody else needs to see it. Clarity comes from the writing.',
   5)
ON CONFLICT (slug) DO NOTHING;

-- ── Task 4: Personal Landing Page (FREE tier) ──────────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('personal-landing-page', 1, 'free', 'hero-is-the-headline', 'founding', 107,
   'The hero is the headline, not the image',
   E'A hero section gets seven seconds of attention before the visitor decides whether to keep reading. In those seven seconds, exactly one thing has to happen: the visitor must understand what this business is and whether it might be for them.\n\nFounders consistently make the wrong bet about what carries those seven seconds. They believe the photo carries the meaning. They commission a beautiful image, position it large, and write a vague headline like "Hand-crafted experiences for discerning customers." The photo is gorgeous. The headline says nothing. The visitor scrolls past in five seconds.\n\nThe headline carries the hero. The photo supports it. Every great landing page proves this — Stripe''s headline tells you exactly what they do; the visual is a graphic, not a glamour shot. Aesop''s product pages put the product name and what it''s for in the largest type; the photo confirms what the words already promised.\n\nA good hero headline does three things in one sentence: it names what you do, hints at who it''s for, and contains a specific word that distinguishes you. "Hand-built charcuterie boards, delivered across New Orleans." That sentence works. The visitor knows what (boards), who (people who order delivery), and where (New Orleans). The word "hand-built" carries the distinguishing edge — these aren''t supermarket platters.\n\nThe mistake to avoid is what copywriters call the summary headline: "Welcome to Gaudet Charcuterie — your premier destination for artisan boards." That sentence is built from words that mean nothing in combination. "Welcome." "Premier destination." "Artisan." Each one is a marketing default that the brain ignores on contact.\n\nRead your hero headline. Ask: could a competitor copy this exact sentence and use it on their site without changing a word? If yes, it''s a summary, not a headline. Rewrite until the sentence could not belong to anyone else.',
   'Mark complete when your hero headline is specific enough that it would not work for any of your competitors without significant edits.',
   6),
  ('personal-landing-page', 2, 'free', 'above-the-fold-for-skeptics', 'founding', 108,
   'Above the fold is for the skeptical, not the convinced',
   E'There are two kinds of visitors landing on your site. The convinced — people who already heard about you from a friend, an article, an Instagram post. And the skeptical — people who clicked because of an ad, a search result, or curiosity.\n\nThe convinced will scroll. They''ll read the whole page if it''s good. They came to confirm a decision they''ve already half-made.\n\nThe skeptical will not scroll. They will read the hero, scan for one specific thing, and leave if they don''t find it. Above the fold is written for the skeptical, because the convinced will read everything anyway. If you write for the convinced, you lose the skeptical.\n\nWhat does the skeptical visitor scan for? Proof that this is a real business with real customers, run by real people, that does the specific thing they''re looking for. Not your origin story. Not your values. Not your team photo. Specifically: what do you do, who else trusts you, and what does it cost.\n\nMost landing pages above the fold are full of self-flattery. "Welcome to our world." "We believe in passion." "Crafted with love." The skeptical reader has scanned twenty sites today that said the same thing. They are looking for evidence that you are not the twenty-first.\n\nStrong above-the-fold content does three things, in this order: states the specific offer (one sentence, names what you do for whom), shows one piece of social proof (a logo, a testimonial fragment, a customer count), and names the next step (book, order, see the menu — not "learn more").\n\nThat''s it. Below the fold you can tell your story. Above the fold, the skeptical visitor has not yet earned access to your story. They want evidence first. Earn the scroll.',
   'Mark complete when you''ve audited your hero section and confirmed it has: a specific offer, one piece of social proof, and a concrete next step. If any of the three is missing, add it.',
   6)
ON CONFLICT (slug) DO NOTHING;

-- ── Task 5: Launch Tweet (FREE tier) ───────────────────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('launch-tweet', 1, 'free', 'launches-are-invitations', 'founding', 109,
   'Launches aren''t announcements, they''re invitations',
   E'The default launch tweet reads like a press release. "Excited to announce that we''ve launched [thing]. Available now at [link]. Please share!" The implicit posture is: we made something; please pay attention.\n\nThat''s an announcement. Announcements compete for attention with every other announcement, and most of them lose.\n\nA launch is an invitation, not an announcement. The difference is whether the reader has a role. An announcement says "look at this thing we did." An invitation says "here''s a thing I made for people like you — does that include you?" Announcements get scrolled past. Invitations get answered.\n\nThe shift is small but operational. Compare:\n\n- Announcement: "We''ve launched Gaudet Charcuterie — hand-built boards delivered across New Orleans."\n- Invitation: "If you''ve ever showed up to a dinner party with a sad cheese plate from Whole Foods, I made something for you. Hand-built charcuterie boards, delivered across New Orleans. The first ten orders this month are at half price."\n\nThe second version names a specific moment from the reader''s life (the sad Whole Foods plate), positions you as the answer, and offers a specific reason to act now. It treats the reader as a participant, not a spectator.\n\nMost launches fail because the founder writes for an audience of investors and friends — people who want to celebrate them. The actual audience for a launch is potential customers, who don''t care about your milestone. They care about whether your existence improves their life. Write the launch for them, not for the milestone.\n\nThe other thing to know about launches: they''re a starting line, not a finish line. The tweet that announces your business is tweet zero. Tweets one through hundred matter more. People who launch loud and then disappear get forgotten. People who launch with one good post and keep showing up get remembered.',
   'Mark complete when you''ve rewritten your launch announcement as an invitation that names a specific moment in the reader''s life and offers a specific reason to act now.',
   5),
  ('launch-tweet', 2, 'free', 'thread-sells-tweet-hooks', 'founding', 110,
   'The thread sells, the tweet hooks',
   E'A single tweet rarely converts. It cannot. Tweets are designed to be skimmed at speed; the reader is gone in three seconds. What converts is a thread — three to seven tweets that take the reader on a small journey from curious to ready-to-click.\n\nFounders typically write the tweet without the thread, posting one paragraph crammed with everything: what they made, who it''s for, why it matters, where to buy. The reader''s eye glazes at "what they made" and never reaches the link. Conversion: zero.\n\nStrong launch threads have a specific shape. Tweet one is the hook — short, specific, almost mysterious. "Six months ago I quit my agency job to make charcuterie boards by hand." No link. No call to action. Just a hook that earns the click into the thread.\n\nTweet two opens the door. "The reason: every charcuterie board I''d ever ordered for an event was either bland (Whole Foods) or expensive in a way that didn''t show up on the plate (caterers). I knew there was a middle path." The reader is now invested. They want to know if the founder found the middle path.\n\nTweets three through five build the answer. Show the boards. Tell one specific story about an event you served. Name the cheesemongers you work with. Give the reader something concrete to anchor on.\n\nTweet six is the invitation. Now, finally, the link. Now the price. Now the next step. By the time the reader reaches it, they are ready — because the previous five tweets earned the moment.\n\nThis shape works because attention compounds. Every tweet that holds the reader''s attention buys you the next one. The tweet itself is just the door. The thread is the room.',
   'Mark complete when you''ve outlined your launch thread — at least four tweets, in order, with a hook that doesn''t include a link.',
   5)
ON CONFLICT (slug) DO NOTHING;

-- ── Task 6: Personalized Pitch Email (FREE tier) ───────────
INSERT INTO lessons (task_slug, sort_order, tier, slug, phase, lesson_num, title, body, action_prompt, min_minutes)
VALUES
  ('personalized-pitch-email', 1, 'free', 'reply-rate-beats-volume', 'founding', 111,
   'Reply rate beats volume every time',
   E'The cold email playbook most founders inherit is wrong. It says: send more emails, get more replies. The math seems obvious — 10% of 1,000 is more than 10% of 100. The math is also fiction.\n\nReply rates do not stay constant as you scale. They collapse. Mass-sent emails feel like spam to the recipient because they are spam — generic, scaled, low-context. The reader scans for personalization signals (their name spelled correctly, a reference to something specific about them, a tone that matches one human writing to another) and when those signals are missing, deletes. Reply rates on truly cold mass outreach hover around 1% on a good day, frequently lower.\n\nPersonalized outreach plays a different game. A hundred emails that reference the recipient''s recent post, their company''s recent announcement, a specific reason this offer fits them — those get reply rates of 15-30% on a good list. The math: 100 emails × 20% = 20 replies. 1,000 mass emails × 1% = 10 replies. Half the work, twice the result, and the replies are warmer because the recipient knows you put in the time.\n\nThe shift is psychological. Volume outreach treats the recipient as a number. Personalized outreach treats them as a specific human you noticed. Recipients can feel the difference in the first sentence. So can spam filters — emails that come from a real domain with a personalized subject and varied body text reach inboxes; mass-templated emails get filtered before a human ever sees them.\n\nThe hard part is that personalization at any scale requires real time. Twenty minutes per email is not unreasonable for high-stakes outreach. Founders who refuse to spend that time end up sending a thousand templated emails to no replies, then concluding that "cold outreach doesn''t work." Cold outreach works. Their cold outreach didn''t work, because they sent at the wrong unit of effort.',
   'Mark complete when you''ve written one cold email that took you fifteen-plus minutes to compose. Reference something specific about the recipient that took five minutes of research to find.',
   6),
  ('personalized-pitch-email', 2, 'free', 'follow-up-is-the-message', 'founding', 112,
   'The follow-up is the message',
   E'Most founders stop after the first email. They send, they hope, they wait. When no reply arrives within a few days, they conclude the recipient isn''t interested and move on.\n\nThis is where most outreach campaigns fail — not in the writing, but in the follow-through. The data is consistent across industries: the second touch produces more replies than the first. The third touch produces more than the second. Many recipients don''t reply until the fourth or fifth contact, and they reply because of the persistence, not despite it.\n\nThe reason is structural. The first email arrives at an unpredictable moment in the recipient''s day. They might be in a meeting. They might be in a bad mood. They might be planning to reply later and forget. None of that is about you or your offer; it''s about the entropy of inboxes. The follow-up exists not to nag but to give the recipient a second chance to be in a state where they can respond.\n\nThe follow-up that works is short. Three sentences, maximum. "Just bumping this up — wanted to check if you saw my note from last week. No pressure, but if you''re the right person to talk to about [specific thing], I''d love a few minutes. If not, no worries — happy to be pointed elsewhere."\n\nWhat that follow-up does well: it acknowledges the previous email without quoting it back, it offers an out (the recipient can say "not me, talk to X"), and it doesn''t repeat the pitch. The pitch was made already. The follow-up''s job is just to surface again at a better moment.\n\nFounders who don''t follow up are leaving most of their replies on the table. The first email is the introduction. The second email is where the conversation actually starts.',
   'Mark complete when you''ve followed up on three specific emails this week that haven''t been replied to yet. Three sentences each, no repetition of the original pitch.',
   6)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Lesson badges (12 rows, lesson_id resolved by slug)
-- ============================================================
DO $$
DECLARE
  l_id uuid;
BEGIN
  -- Task 1
  SELECT id INTO l_id FROM lessons WHERE slug = 'positioning-is-a-knife';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-positioning-is-a-knife', 'lesson', 'research-strategy', l_id,
     'Sharp Cut',
     'You learned that good positioning loses customers on purpose.',
     '🔪')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'market-doesnt-care-about-your-idea';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-market-doesnt-care', 'lesson', 'research-strategy', l_id,
     'Edge Finder',
     'You learned that the market rewards edges, not ideas.',
     '🗡️')
  ON CONFLICT (slug) DO NOTHING;

  -- Task 2
  SELECT id INTO l_id FROM lessons WHERE slug = 'tam-is-fiction-sam-is-theory';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-tam-is-fiction', 'lesson', 'tam-sam-som', l_id,
     'Map Reader',
     'You learned which market number actually matters.',
     '🗺️')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'interview-beats-survey';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-interview-beats-survey', 'lesson', 'tam-sam-som', l_id,
     'Listener',
     'You learned that people lie on surveys and tell the truth in conversation.',
     '👂')
  ON CONFLICT (slug) DO NOTHING;

  -- Task 3
  SELECT id INTO l_id FROM lessons WHERE slug = 'mission-is-a-decision-filter';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-mission-decision-filter', 'lesson', 'mission-document', l_id,
     'Filter Holder',
     'You learned what a mission is actually for.',
     '🪞')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'mission-test-turn-down-money';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-mission-test-money', 'lesson', 'mission-document', l_id,
     'Money Filter',
     'You learned that real missions cost real money.',
     '💸')
  ON CONFLICT (slug) DO NOTHING;

  -- Task 4
  SELECT id INTO l_id FROM lessons WHERE slug = 'hero-is-the-headline';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-hero-headline', 'lesson', 'personal-landing-page', l_id,
     'Headline Writer',
     'You learned what carries a hero section.',
     '✏️')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'above-the-fold-for-skeptics';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-above-the-fold', 'lesson', 'personal-landing-page', l_id,
     'Skeptic Reader',
     'You learned who you are actually writing for above the fold.',
     '🧐')
  ON CONFLICT (slug) DO NOTHING;

  -- Task 5
  SELECT id INTO l_id FROM lessons WHERE slug = 'launches-are-invitations';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-launches-invitations', 'lesson', 'launch-tweet', l_id,
     'Inviter',
     'You learned what a launch is actually for.',
     '🎟️')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'thread-sells-tweet-hooks';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-thread-sells', 'lesson', 'launch-tweet', l_id,
     'Thread Builder',
     'You learned how a launch actually works on social.',
     '🧵')
  ON CONFLICT (slug) DO NOTHING;

  -- Task 6
  SELECT id INTO l_id FROM lessons WHERE slug = 'reply-rate-beats-volume';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-reply-beats-volume', 'lesson', 'personalized-pitch-email', l_id,
     'Reply Hunter',
     'You learned that the right metric is the reply, not the send.',
     '🎯')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO l_id FROM lessons WHERE slug = 'follow-up-is-the-message';
  INSERT INTO badges (slug, tier, task_slug, lesson_id, name, description, icon_emoji) VALUES
    ('lesson-follow-up-is-message', 'lesson', 'personalized-pitch-email', l_id,
     'Follow-Through',
     'You learned where the actual work of outreach happens.',
     '🔁')
  ON CONFLICT (slug) DO NOTHING;
END $$;

-- ============================================================
-- Task badges (6 rows)
-- ============================================================
INSERT INTO badges (slug, tier, task_slug, name, description, icon_emoji) VALUES
  ('strategist',        'task', 'research-strategy',
   'Strategist',
   'Completed the Research & Strategy curriculum. You know what your business is and isn''t.',
   '🧭'),
  ('analyst',           'task', 'tam-sam-som',
   'Analyst',
   'Completed the Market Size curriculum. You can read a market like a map.',
   '🔍'),
  ('founder',           'task', 'mission-document',
   'Founder',
   'Completed the Mission curriculum. You can name what you''re building and why it matters.',
   '🎯'),
  ('web-operator',      'task', 'personal-landing-page',
   'Web Operator',
   'Completed the Landing Page curriculum. You know how a page wins clicks from skeptics.',
   '🌐'),
  ('publisher',         'task', 'launch-tweet',
   'Publisher',
   'Completed the Launch curriculum. You can announce something so it lands.',
   '📣'),
  ('outreach-operator', 'task', 'personalized-pitch-email',
   'Outreach Operator',
   'Completed the Outreach curriculum. You can write a cold email that gets a reply.',
   '📨')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Master badge (1 row)
-- ============================================================
INSERT INTO badges (slug, tier, task_slug, name, description, icon_emoji) VALUES
  ('ceo', 'master', NULL,
   'Chief Executive Operator',
   'Earned all 6 task credentials. You don''t just have a business — you know how to run one.',
   '👑')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- END migration 019_seed_operator_school.sql
-- ============================================================

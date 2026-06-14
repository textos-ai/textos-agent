import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

interface Call1Result {
  hero_layout: string;
  hero_font: string;
  accent_color: string;
  eyebrow_vocab: string;
  hero_css_pattern: string;
  hero_eyebrow: string;
  hero_headline: string;
  hero_headline_accent: string;
  hero_subhead: string;
  hero_cta_label: string;
  cta_type: string;
  metrics: Array<{ value: string; label: string }>;
  icp_headline: string;
  icp_signals: string[];
  pain_points: Array<{ icon: string; headline: string }>;
  why_us: Array<{ headline: string }>;
  palate_cleanser_type: string;
  palate_cleanser_content: string;
  palate_cleanser_attribution: string;
  seo_title: string;
  seo_description: string;
  seo_keywords: string[];
  nav_links: Array<{ label: string; anchor: string }>;
  nav_cta_label: string;
  fal_og_image_prompt: string;
}

interface Call2Result {
  icp_description: string;
  pain_point_bodies: string[];
  what_we_do_eyebrow: string;
  what_we_do_headline: string;
  what_we_do_body: string;
  why_us_bodies: string[];
  founder_eyebrow: string;
  founder_headline: string;
  founder_body: string;
}

export async function runBusinessLandingPage(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, models, emit, supabase, env } = tc;

  const frontendUrl = env.FRONTEND_URL ?? "https://app.textos.ai";
  const plannedUrl = `${frontendUrl}/sites/${business.slug}`;

  await emit({ type: "cmd", text: "Building your website — analyzing your business...", ts: Date.now() });

  // ── 1. Fetch business context for prompt substitution ──────────────────────
  const { data: fullCtx } = await supabase
    .from("business_context")
    .select(
      "industry, business_summary, value_proposition, " +
      "target_customer, brand_voice"
    )
    .eq("business_id", business.id)
    .maybeSingle();

  const enrichedCtx = fullCtx || ctx;

  // ── 2. CALL 1: Design + Structure (45s timeout, 800 tokens) ───────────────
  await emit({ type: "cmd", text: "Designing structure and visual identity...", ts: Date.now() });

  const call1SystemPrompt = `You are a creative director for ${business.name}, a ${enrichedCtx.industry} business. ${enrichedCtx.business_summary}. Value prop: ${enrichedCtx.value_proposition}. Target customer: ${JSON.stringify(enrichedCtx.target_customer)}. Brand voice: ${enrichedCtx.brand_voice}. Return ONLY valid JSON. No preamble. First character must be {.`;

  const call1UserPrompt = `Design the structure and visual identity for this business website. Return a JSON object with:
- hero_layout: "type" or "photo"
- hero_font: one of "fraunces", "playfair", "dm_serif", "manrope", "cormorant", "space_grotesk"
- accent_color: one of "terracotta", "sage", "navy", "charcoal", "sienna", "forest", "brass", "ink"
- eyebrow_vocab: one of "craft", "professional", "editorial"
- hero_css_pattern: Generate a CSS background that is BOLD, UNIQUE, and UNMISTAKABLY tied to this specific business and industry. Think agency-level creative direction. Examples: Food/charcuterie: "repeating-linear-gradient(45deg, #FAF7F1 0px, #FAF7F1 40px, #B8553A 40px, #B8553A 80px)". Tech/SaaS/coaching: "radial-gradient(circle at 20px 20px, #333 1px, transparent 1px), radial-gradient(ellipse 200% 100% at 90% 5%, rgba(accent_color, 0.08) 0%, transparent 50%), #0d0d0d". Wellness/yoga: "radial-gradient(ellipse 400% 200% at 20% 40%, rgba(143, 188, 143, 0.3) 0%, transparent 70%), radial-gradient(ellipse 300% 150% at 70% 60%, rgba(106, 153, 106, 0.2) 0%, transparent 60%), radial-gradient(ellipse 500% 250% at 50% 20%, rgba(85, 107, 85, 0.15) 0%, transparent 80%), #f8f9f8". Legal/finance: "repeating-linear-gradient(0deg, transparent 0px, transparent 23px, rgba(25, 25, 112, 0.12) 23px, rgba(25, 25, 112, 0.12) 24px), white". Creative agency: "linear-gradient(135deg, accent_color 0%, accent_color 40%, white 40%, white 100%)". Construction/trades: "repeating-linear-gradient(0deg, rgba(54, 69, 79, 0.15) 0px, rgba(54, 69, 79, 0.15) 1px, transparent 1px, transparent 16px), repeating-linear-gradient(90deg, rgba(54, 69, 79, 0.15) 0px, rgba(54, 69, 79, 0.15) 1px, transparent 1px, transparent 16px), #f5f5f5". Luxury/fashion: "radial-gradient(circle at 30% 30%, rgba(218, 165, 32, 0.06) 0%, rgba(218, 165, 32, 0.06) 40%, transparent 40%), radial-gradient(circle at 70% 70%, rgba(218, 165, 32, 0.06) 0%, rgba(218, 165, 32, 0.06) 35%, transparent 35%), #faf8f5". DO NOT generate a plain single gradient. DO generate something a designer would be proud of. Must be valid CSS background shorthand only. No url(), no image(), pure CSS only. Can layer multiple gradients with commas.
- hero_eyebrow: 2-4 words all caps
- hero_headline: 4-7 words
- hero_headline_accent: 1-3 accent words from headline
- hero_subhead: one sentence 15-25 words
- hero_cta_label: 3-5 words
- cta_type: "calendly", "email_capture", or "stripe"
- metrics: array of 3 objects with value and label
- icp_headline: 5-8 words
- icp_signals: array of 3 short signals
- pain_points: array of 3 objects with icon (emoji) and headline (4-6 words)
- why_us: array of 3 objects with headline (3-5 words)
- palate_cleanser_type: "pull_quote", "big_number", or "manifesto"
- palate_cleanser_content: under 15 words
- palate_cleanser_attribution: short or empty
- seo_title: under 60 chars
- seo_description: under 160 chars
- seo_keywords: array of 5 keywords
- nav_links: array of 3 objects with label and anchor (anchor should be one of: what-we-do, who, problems, why-us, founder, cta)
- nav_cta_label: 3-5 words
- fal_og_image_prompt: under 80 words`;

  let call1Result: Call1Result;
  try {
    const call1Promise = anthropic.messages.create({
      model: models.sonnet,
      max_tokens: 2000,
      stream: false,
      system: call1SystemPrompt,
      messages: [{ role: "user", content: call1UserPrompt }],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("content_generation_timeout")), 45000)
    );

    const msg1 = await Promise.race([call1Promise, timeoutPromise]);
    const block1 = msg1.content[0];
    const text1 = block1 && block1.type === "text" ? (block1 as { text: string }).text : "";
    const raw1 = stripFences(text1.trim());

    try {
      call1Result = JSON.parse(raw1) as Call1Result;
    } catch (err) {
      throw new Error(`Call 1 returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "content_generation_timeout") {
      throw new Error("content_generation_timeout: Design call exceeded 45 seconds");
    }
    throw err;
  }

  // ── 3. CALL 2: Prose Copy (45s timeout, 1200 tokens) ──────────────────────
  await emit({ type: "cmd", text: "Writing compelling copy...", ts: Date.now() });

  const call2SystemPrompt = `You are writing copy for ${business.name}, a ${enrichedCtx.industry} business. ${enrichedCtx.business_summary}. Value prop: ${enrichedCtx.value_proposition}. Target customer: ${JSON.stringify(enrichedCtx.target_customer)}. Tone: ${enrichedCtx.brand_voice}. The site headline is: ${call1Result.hero_headline}. The ICP headline is: ${call1Result.icp_headline}. The three pain headlines are: ${call1Result.pain_points.map(p => p.headline).join(", ")}. Write copy that matches this established voice and direction. Return ONLY valid JSON. No preamble. First character must be {.`;

  const call2UserPrompt = `Write the prose copy for this business website. Return a JSON object with:
- icp_description: 60-80 words specific paragraph
- pain_point_bodies: array of 3 strings, 20-30 words each
- what_we_do_eyebrow: 2-3 words
- what_we_do_headline: 5-8 words
- what_we_do_body: 80-120 words three paragraphs separated by \\n\\n
- why_us_bodies: array of 3 strings, 25-35 words each
- founder_eyebrow: 2-3 words
- founder_headline: founder name or "About the Founder"
- founder_body: 60-80 words first person`;

  let call2Result: Call2Result;
  try {
    const call2Promise = anthropic.messages.create({
      model: models.sonnet,
      max_tokens: 1500,
      stream: false,
      system: call2SystemPrompt,
      messages: [{ role: "user", content: call2UserPrompt }],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("content_generation_timeout")), 45000)
    );

    const msg2 = await Promise.race([call2Promise, timeoutPromise]);
    const block2 = msg2.content[0];
    const text2 = block2 && block2.type === "text" ? (block2 as { text: string }).text : "";
    const raw2 = stripFences(text2.trim());

    try {
      call2Result = JSON.parse(raw2) as Call2Result;
    } catch (err) {
      throw new Error(`Call 2 returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "content_generation_timeout") {
      throw new Error("content_generation_timeout: Copy call exceeded 45 seconds");
    }
    throw err;
  }

  await emit({ type: "cmd", text: "Saving your website...", ts: Date.now() });

  // ── 4. Merge results and sanitize eyebrow_vocab ───────────────────────────
  const EYEBROW_VOCAB_MAP: Record<string, string> = {
    'craft': 'standard',
    'professional': 'operator',
    'editorial': 'editorial',
  };
  const eyebrowVocab = EYEBROW_VOCAB_MAP[call1Result.eyebrow_vocab] ?? 'standard';

  // Merge pain_point_bodies back into pain_points
  const mergedPainPoints = call1Result.pain_points.map((point, i) => ({
    ...point,
    body: call2Result.pain_point_bodies[i] || "",
  }));

  // Merge why_us_bodies back into why_us
  const mergedWhyUs = call1Result.why_us.map((item, i) => ({
    ...item,
    body: call2Result.why_us_bodies[i] || "",
  }));

  // OG image skipped for now (prevents timeout)
  const ogImageUrl: string | null = null;

  // ── 5. Update businesses table with ALL fields in single call ─────────────
  const updateData = {
    // Design fields
    hero_layout: call1Result.hero_layout,
    hero_font: call1Result.hero_font,
    accent_color: call1Result.accent_color,
    eyebrow_vocab: eyebrowVocab,
    hero_css_pattern: call1Result.hero_css_pattern,
    og_image_url: ogImageUrl,

    // SEO fields
    seo_title: call1Result.seo_title,
    seo_description: call1Result.seo_description,
    seo_keywords: call1Result.seo_keywords,

    // Hero content fields
    hero_eyebrow: call1Result.hero_eyebrow,
    hero_headline: call1Result.hero_headline,
    hero_headline_accent: call1Result.hero_headline_accent,
    hero_subhead: call1Result.hero_subhead,
    hero_cta_label: call1Result.hero_cta_label,
    hero_cta_type: call1Result.cta_type,

    // Structured content fields (JSONB)
    metrics: call1Result.metrics,
    icp_signals: call1Result.icp_signals,
    pain_points: mergedPainPoints,
    palate_cleanser: {
      type: call1Result.palate_cleanser_type,
      content: call1Result.palate_cleanser_content,
      attribution: call1Result.palate_cleanser_attribution,
    },
    why_us: mergedWhyUs,
    nav_links: call1Result.nav_links,

    // ICP fields
    icp_headline: call1Result.icp_headline,
    icp_description: call2Result.icp_description,

    // What We Do fields
    what_we_do_eyebrow: call2Result.what_we_do_eyebrow,
    what_we_do_headline: call2Result.what_we_do_headline,
    what_we_do_body: call2Result.what_we_do_body,

    // Founder fields
    founder_eyebrow: call2Result.founder_eyebrow,
    founder_headline: call2Result.founder_headline,
    founder_body: call2Result.founder_body,
  };

  const { error: updateErr } = await supabase
    .from("businesses")
    .update(updateData)
    .eq("id", business.id);

  if (updateErr) {
    throw new Error(`Failed to update businesses table: ${updateErr.message}`);
  }

  // ── 6. Write to business_assets ───────────────────────────────────────────
  const mergedData = {
    call1: call1Result,
    call2: call2Result,
    merged: updateData,
  };

  const { error: assetErr } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: tc.taskRunId,
      asset_type: "website",
      asset_subtype: "public_business_site",
      asset_url: plannedUrl,
      asset_data: mergedData,
      metadata: {
        model: models.sonnet,
        calls: "2_sequential",
        og_image_url: ogImageUrl,
      },
    });

  if (assetErr) {
    throw new Error(`Failed to write business_assets: ${assetErr.message}`);
  }

  await emit({ type: "cmd", text: "Your website is live →", ts: Date.now() });

  return {
    output_data: {
      url: plannedUrl,
      slug: business.slug,
      title: call1Result.seo_title,
      description: call1Result.seo_description,
      accent_color: call1Result.accent_color,
      hero_font: call1Result.hero_font,
      hero_layout: call1Result.hero_layout,
      og_image_url: ogImageUrl,
    },
  };
}
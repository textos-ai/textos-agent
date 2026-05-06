import type { TaskCtx, TaskResult } from "./types";
import { pickVisualChoices, fetchUnsplashPhoto } from "../pick-visual-choices";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runPersonalLandingPage(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, emit, supabase, taskRunId, env } = tc;

  const plannedUrl = `https://${business.slug}.app.textos.ai`;

  await emit({ type: "cmd", text: `Generating public site for ${business.name}`, ts: Date.now() });

  // ── 1. Pick visual identity ────────────────────────────────────────────────
  const picks = await pickVisualChoices(
    ctx.industry ?? "",
    ctx.business_summary ?? "",
    ctx.brand_voice ?? "",
    anthropic,
  );

  // ── 2. Fetch hero photo — every business gets one ─────────────────────────
  // Photo-layout industries use the direct query (rendered in hero).
  // Type-layout industries use the atmospheric query (stored in DB, used for og:image).
  let heroImageUrl: string | null = null;
  let heroImageCredit: string | null = null;

  await emit({ type: "cmd", text: "Finding hero photo", ts: Date.now() });
  const unsplashQuery = picks.hero_layout === "photo"
    ? picks.unsplash_query
    : (picks.unsplash_query_atmospheric ?? picks.unsplash_query);
  const photo = await fetchUnsplashPhoto(unsplashQuery, env.UNSPLASH_ACCESS_KEY ?? "");
  if (photo) {
    heroImageUrl = photo.url;
    heroImageCredit = photo.credit;
  } else if (picks.hero_layout === "photo") {
    // Only fall back to type layout if the photo was intended for the rendered hero
    picks.hero_layout = "type";
  }

  // ── 3. Haiku: generate SEO metadata ───────────────────────────────────────
  await emit({ type: "cmd", text: "Writing SEO metadata", ts: Date.now() });

  let seoTitle = business.name;
  let seoDescription = ctx.value_proposition ?? `${business.name} — powered by TextOS.`;
  let seoKeywords: string[] = [];

  try {
    const seoMsg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `Generate SEO metadata for this business. Return ONLY valid JSON, no markdown.

Business name: ${business.name}
Industry: ${ctx.industry ?? "business"}
What it does: ${ctx.business_summary ?? ""}
Value proposition: ${ctx.value_proposition ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}

Return:
{
  "title": "string — page title under 60 chars, include business name",
  "description": "string — meta description under 160 chars",
  "keywords": ["array", "of", "5-8", "keyword", "phrases"]
}`,
      }],
    });

    const seoRaw = stripFences((seoMsg.content[0] as { type: string; text: string }).text.trim());
    const seo = JSON.parse(seoRaw);
    if (seo.title)       seoTitle = seo.title;
    if (seo.description) seoDescription = seo.description;
    if (Array.isArray(seo.keywords)) seoKeywords = seo.keywords.slice(0, 8);
  } catch {
    // Non-fatal — fallback values already set
  }

  // ── 4. Sonnet: generate full HTML ─────────────────────────────────────────
  await emit({ type: "cmd", text: "Building site HTML", ts: Date.now() });

  const FONT_IMPORTS: Record<string, string> = {
    fraunces:     "https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,400&display=swap",
    playfair:     "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap",
    dm_serif:     "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&display=swap",
    manrope:      "https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap",
    cormorant:    "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap",
    space_grotesk:"https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap",
  };

  const ACCENT_HEX: Record<string, string> = {
    terracotta: "#B8553A", sage: "#7A8E5A", navy: "#1F3556",
    charcoal: "#2A2826",  sienna: "#A04528", forest: "#2C5044",
    brass: "#9A7B3A",     ink: "#1F2937",
  };

  const accentHex = ACCENT_HEX[picks.accent_color] ?? "#f59e0b";
  const fontUrl = FONT_IMPORTS[picks.hero_font] ?? FONT_IMPORTS["space_grotesk"];
  const heroSection = picks.hero_layout === "photo" && heroImageUrl
    ? `hero image at ${heroImageUrl} (credit: ${heroImageCredit}), text overlay`
    : `text-only hero, dark background, accent color ${accentHex}`;

  const prompt = `Generate a clean, professional landing page HTML for this business.

Business name: ${business.name}
Industry: ${ctx.industry ?? "business"}
What it does: ${ctx.business_summary ?? ""}
Value proposition: ${ctx.value_proposition ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Brand voice: ${ctx.brand_voice ?? "professional and approachable"}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}
Tagline: ${ctx.positioning_statement ?? ""}
SEO title: ${seoTitle}
SEO description: ${seoDescription}

Design system:
- Font: Load from ${fontUrl} — use it for headings
- Body font: system-ui, sans-serif
- Accent color: ${accentHex}
- Hero layout: ${heroSection}
- Background: #0a0a0a (dark)

Requirements:
- Self-contained HTML file (no external JS)
- Mobile-responsive
- Sections: Hero (name + tagline), Problem/Solution, About the Founder, CTA
- NO placeholder images unless hero_layout is photo
- If photo hero: use <div style="background-image:url('${heroImageUrl ?? ""}')"> with overlay
- CTA button: "Get Started →" or industry-appropriate
- Footer: Powered by TextOS | ${heroImageCredit ?? ""}
- Include <meta name="description" content="${seoDescription}">
- Include <title>${seoTitle}</title>

Return ONLY valid JSON (no markdown, no backticks):
{
  "html": "string — full HTML document"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let html: string;
  try {
    html = JSON.parse(raw).html;
    if (!html) throw new Error("empty html");
  } catch {
    html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${business.name}</title><style>body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style></head><body><div style="text-align:center;padding:2rem"><h1 style="color:${accentHex};font-size:3rem">${business.name}</h1><p>${ctx.value_proposition ?? business.name}</p><p style="color:#666;font-size:0.8rem">Powered by TextOS</p></div></body></html>`;
  }

  // ── 5. Write visual identity to businesses table ───────────────────────────
  await emit({ type: "cmd", text: "Saving site configuration", ts: Date.now() });

  await supabase
    .from("businesses")
    .update({
      accent_color:   picks.accent_color,
      hero_layout:    picks.hero_layout,
      hero_font:      picks.hero_font,
      eyebrow_vocab:  picks.eyebrow_vocab,
      hero_image_url: heroImageUrl,
      hero_image_credit: heroImageCredit,
      seo_title:      seoTitle,
      seo_description: seoDescription,
      seo_keywords:   seoKeywords,
    })
    .eq("id", business.id);

  // ── 6. Store full HTML in business_assets ─────────────────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "website",
      asset_subtype: "business_landing_page",
      asset_url: plannedUrl,
      asset_text: html,
      metadata: {
        model: "claude-sonnet-4-6",
        title: seoTitle,
        description: seoDescription,
        accent_color: picks.accent_color,
        hero_font: picks.hero_font,
        hero_layout: picks.hero_layout,
        deployed: false,
        deploy_note: "Live deployment Sprint 9 — wildcard subdomain routing pending.",
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      url: plannedUrl,
      slug: business.slug,
      title: seoTitle,
      description: seoDescription,
      accent_color: picks.accent_color,
      hero_font: picks.hero_font,
      hero_layout: picks.hero_layout,
      deployed: false,
      deploy_note: "URL reserved. Live deployment enabled in Sprint 9 (wildcard subdomain routing).",
    },
  };
}

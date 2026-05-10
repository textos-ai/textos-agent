import type { TaskCtx, TaskResult } from "./types";
import { pickVisualChoices, fetchUnsplashPhoto } from "../pick-visual-choices";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runBusinessLandingPage(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit, supabase, env } = tc;

  const plannedUrl = `https://app.textos.ai/sites/${business.slug}`;

  await emit({ type: "cmd", text: `Building public site for ${business.name}`, ts: Date.now() });

  // ── 1. Pick visual identity ────────────────────────────────────────────────
  const picks = await pickVisualChoices(
    ctx.industry ?? "",
    ctx.business_summary ?? "",
    ctx.brand_voice ?? "",
    anthropic,
  );

  // ── 2. Fetch hero photo ────────────────────────────────────────────────────
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

  // ── 4. Write visual identity to businesses table ───────────────────────────
  await emit({ type: "cmd", text: "Saving site configuration", ts: Date.now() });

  await supabase
    .from("businesses")
    .update({
      accent_color:      picks.accent_color,
      hero_layout:       picks.hero_layout,
      hero_font:         picks.hero_font,
      eyebrow_vocab:     picks.eyebrow_vocab,
      hero_image_url:    heroImageUrl,
      hero_image_credit: heroImageCredit,
      seo_title:         seoTitle,
      seo_description:   seoDescription,
      seo_keywords:      seoKeywords,
    })
    .eq("id", business.id);

  return {
    output_data: {
      url:         plannedUrl,
      slug:        business.slug,
      title:       seoTitle,
      description: seoDescription,
      accent_color: picks.accent_color,
      hero_font:   picks.hero_font,
      hero_layout: picks.hero_layout,
    },
  };
}

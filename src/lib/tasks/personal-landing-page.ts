import type { TaskCtx, TaskResult } from "./types";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function runPersonalLandingPage(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, emit, supabase, taskRunId } = tc;

  // This task generates the BUSINESS website, not the user's personal page.
  // URL uses business.slug (not user.handle — personal site is a Sprint 9 deliverable).
  const plannedUrl = `https://${business.slug}.app.textos.ai`;

  await emit({ type: "cmd", text: `Generating business website for ${business.name}`, ts: Date.now() });

  const prompt = `Generate a clean, professional landing page HTML for this business.

Business name: ${business.name}
Business slug: ${business.slug}
Industry: ${ctx.industry ?? "business"}
What it does: ${ctx.business_summary ?? ""}
Value proposition: ${ctx.value_proposition ?? ""}
Target customer: ${JSON.stringify(ctx.target_customer)}
Brand voice: ${ctx.brand_voice ?? "professional and approachable"}
Key differentiators: ${JSON.stringify(ctx.key_differentiators)}
Tagline (if known): ${ctx.positioning_statement ?? ""}

Requirements:
- Self-contained HTML file (no external CSS/JS except Google Fonts)
- Mobile-responsive, dark background (#0a0a0a), clean typography
- Sections: Hero (business name + tagline), Problem/Solution (2-3 sentences), About the Founder, CTA
- Use Space Grotesk from Google Fonts
- Accent color: #f59e0b (amber)
- NO placeholder images — text-based hero only
- Industry-specific content — references "${ctx.industry ?? "the industry"}" specifically
- CTA button: "Get Started →" or industry-appropriate call to action
- Footer: Powered by TextOS

Return ONLY valid JSON (no markdown, no backticks):
{
  "html": "string — full HTML document",
  "title": "string — page title (under 60 chars)",
  "description": "string — meta description under 160 chars"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { html: string; title: string; description: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      html: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${business.name}</title><style>body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style></head><body><div style="text-align:center;padding:2rem"><h1 style="color:#f59e0b;font-size:3rem">${business.name}</h1><p>${ctx.value_proposition ?? business.name}</p><p style="color:#666;font-size:0.8rem">Powered by TextOS</p></div></body></html>`,
      title: `${business.name}`,
      description: ctx.value_proposition ?? `${business.name} — powered by TextOS.`,
    };
  }

  await emit({ type: "cmd", text: `Deploying to ${business.slug}.app.textos.ai`, ts: Date.now() });

  // Store HTML in business_assets (live deploy pending Sprint 9 wildcard subdomain routing)
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "website",
      asset_subtype: "business_landing_page",
      asset_url: plannedUrl,
      asset_text: parsed.html,
      metadata: {
        model: "claude-sonnet-4-6",
        title: parsed.title,
        description: parsed.description,
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
      title: parsed.title,
      description: parsed.description,
      deployed: false,
      deploy_note: "URL reserved. Live deployment enabled in Sprint 9 (wildcard subdomain routing).",
    },
  };
}

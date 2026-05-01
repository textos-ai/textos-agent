import type { TaskCtx, TaskResult } from "./types";

export async function runPersonalLandingPage(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, emit } = tc;

  const handle = user.handle ?? user.email.split("@")[0];
  const plannedUrl = `https://${handle}.app.textos.ai`;

  await emit({ type: "cmd", text: "Generating personal website from profile", ts: Date.now() });

  const prompt = `Generate a clean, professional personal landing page HTML for a founder.

Founder handle: ${handle}
Business: ${business.name}
Industry: ${ctx.industry ?? "business"}
Brand voice: ${ctx.brand_voice ?? "professional and approachable"}
Value proposition: ${ctx.value_proposition ?? ""}
Business summary: ${ctx.business_summary ?? ""}

Requirements:
- Self-contained HTML file (no external CSS/JS except Google Fonts)
- Mobile-responsive, dark background (#0a0a0a), clean typography
- Sections: Hero (name + tagline), About (2-3 sentences), Business (card for ${business.name}), Contact (link to email)
- Use Inter or Space Grotesk from Google Fonts
- Accent color: #f59e0b (amber)
- NO placeholder images — text-based hero only
- CTA button: "See what I'm building →" linking to /business/${business.slug}/
- Footer: Powered by TextOS

Return ONLY valid JSON:
{
  "html": "string — full HTML document (escape quotes properly)",
  "title": "string — page title",
  "description": "string — meta description under 160 chars"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  let parsed: { html: string; title: string; description: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      html: `<!DOCTYPE html><html><head><title>${handle} | TextOS</title></head><body><h1>${handle}</h1><p>Building ${business.name}</p><p>Powered by TextOS</p></body></html>`,
      title: `${handle} | TextOS`,
      description: `${handle} is building ${business.name} with TextOS.`,
    };
  }

  // Store in business_assets for later deployment (wildcard subdomain — Sprint 9)
  try {
    await tc.supabase.from("business_assets").insert({
      business_id: business.id,
      user_id: user.id,
      asset_type: "personal_website",
      asset_subtype: "html",
      asset_text: parsed.html,
      asset_url: plannedUrl,
    });
  } catch {
    // Non-fatal
  }

  await emit({ type: "cmd", text: `Deploying to ${handle}.app.textos.ai`, ts: Date.now() });

  return {
    output_data: {
      url: plannedUrl,
      handle,
      title: parsed.title,
      description: parsed.description,
      deployed: false,
      deploy_note: "URL reserved. Live deployment enabled in Sprint 9 (wildcard subdomain routing).",
    },
  };
}

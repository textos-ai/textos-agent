import type Anthropic from "@anthropic-ai/sdk";
import type { TaskCtx, TaskResult } from "./types";
import { buildLogoPrompt, generateLogoImage, type LogoBrief } from "../../services/fal";

// ── generateLogoBrief ──────────────────────────────────────────────────────
// Calls Haiku to produce a structured 4-field designer brief from
// business context. Result drives the Recraft prompt template.

const DEFAULT_BRIEF: LogoBrief = {
  structure_hint: "Geometric construction using simple primitives (circles, triangles, lines) arranged with mathematical precision",
  motif_hint: "abstract geometric form, intentional negative space",
  aesthetic_hint: "refined professional contemporary",
  color_hint: "black mark on white",
};

async function generateLogoBrief(
  anthropic: Anthropic,
  businessName: string,
  ctx: {
    industry?: string | null;
    positioning_statement?: string | null;
    key_differentiators?: unknown;
    brand_voice?: string | null;
    accent_color?: string | null;
  },
): Promise<LogoBrief> {
  const systemPrompt = `You are a senior brand designer.
Given the business below, output ONLY a JSON object with 4 keys (no markdown, no prose, no preamble):

{
  "structure_hint": "<one of three patterns: see below>",
  "motif_hint": "<5-8 concrete visual words>",
  "aesthetic_hint": "<2-4 word style tag>",
  "color_hint": "<specific color description with hex>"
}

structure_hint options (pick the one that fits the brand):
  - "Geometric construction using simple primitives (circles, triangles, lines) arranged with mathematical precision"
  - "Organic curves with natural flow, feels hand-considered but precise"
  - "Geometric foundation with one organic flourish that gives it character"

motif_hint rules:
  - 5-8 concrete visual words
  - Avoid clichés (no lightbulbs for ideas, no globes for reach, no handshakes for partnership, no rocket ships for growth)
  - Concrete imagery only

aesthetic_hint rules:
  - 2-4 words
  - Examples: "refined premium editorial" / "bold confident contemporary" / "warm approachable crafted" / "technical sharp precise"

color_hint rules:
  - 1-2 specific colors with hex codes
  - Max 2 colors plus white
  - Examples: "deep forest green (#1a3a2e) with cream accent (#f5e6d3)" or "black mark, single coral accent (#ff6b4a)"
  - Pull from accent_color if provided`;

  const diffs = Array.isArray(ctx.key_differentiators)
    ? (ctx.key_differentiators as string[]).join(", ")
    : "";

  const userPrompt = `Business:
  Name: ${businessName}
  Industry: ${ctx.industry || "unspecified"}
  Positioning: ${ctx.positioning_statement || ""}
  Differentiators: ${diffs}
  Brand voice: ${ctx.brand_voice || ""}
  Accent color from context: ${ctx.accent_color || "none"}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = (msg.content[0] as { type: string; text: string }).text.trim();
    const json = JSON.parse(text);
    const brief: LogoBrief = {
      structure_hint: typeof json.structure_hint === "string" ? json.structure_hint : DEFAULT_BRIEF.structure_hint,
      motif_hint:     typeof json.motif_hint     === "string" ? json.motif_hint     : DEFAULT_BRIEF.motif_hint,
      aesthetic_hint: typeof json.aesthetic_hint === "string" ? json.aesthetic_hint : DEFAULT_BRIEF.aesthetic_hint,
      color_hint:     typeof json.color_hint     === "string" ? json.color_hint     : DEFAULT_BRIEF.color_hint,
    };
    return brief;
  } catch (err) {
    console.error("[logo-brief] Haiku brief generation failed, using defaults:", err);
    return DEFAULT_BRIEF;
  }
}

// ── runLogo ────────────────────────────────────────────────────────────────

export async function runLogo(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit, supabase, taskRunId, env } = tc;

  await emit({
    type: "narrative",
    text: "Generating your visual identity — this is what people recognize first.",
    ts: Date.now(),
  });

  // ── 1. Haiku: build structured designer brief ──────────────────────────────
  await emit({ type: "cmd", text: "Composing brand design brief", ts: Date.now() });
  const brief = await generateLogoBrief(anthropic, business.name, ctx);
  console.log("[logo] brief generated:", JSON.stringify(brief));

  // ── 2. Template the full Recraft prompt from brief ─────────────────────────
  const prompt = buildLogoPrompt(brief, business.name, ctx.industry ?? "");
  console.log(`[logo] full prompt:\n${prompt}`);

  // ── 3. Generate logo via fal.ai Recraft V3 ─────────────────────────────────
  await emit({ type: "cmd", text: "Generating logo mark with Recraft V3", ts: Date.now() });

  const result = await generateLogoImage(prompt, env);

  if (!result) {
    throw new Error(
      env.FAL_API_KEY
        ? "[logo] fal.ai Recraft V3 returned no image — check API key validity and quota"
        : "[logo] FAL_API_KEY is not configured — set via `wrangler secret put FAL_API_KEY`",
    );
  }

  console.log(`[logo] fal returned url=${result.image_url}`);

  // ── 4. Download SVG bytes from fal CDN ────────────────────────────────────
  let assetUrl = result.image_url; // fal CDN URL (fallback if R2 fails)
  let r2Uploaded = false;
  const r2Key = `businesses/${business.id}/logo.svg`;

  await emit({ type: "cmd", text: "Uploading logo to R2", ts: Date.now() });

  console.log(`[logo] downloading SVG bytes from fal CDN...`);
  let svgBody: ArrayBuffer | null = null;
  try {
    const svgRes = await fetch(result.image_url);
    console.log(`[logo] download status=${svgRes.status}`);
    if (svgRes.ok) {
      svgBody = await svgRes.arrayBuffer();
      console.log(`[logo] downloaded bytes=${svgBody.byteLength}`);
    } else {
      console.error(`[logo] fal CDN download failed status=${svgRes.status}`);
    }
  } catch (fetchErr) {
    console.error(`[logo] fal CDN fetch threw:`, fetchErr);
  }

  // ── 5. Upload to R2 ───────────────────────────────────────────────────────
  if (svgBody && env.ASSETS) {
    try {
      await env.ASSETS.put(r2Key, svgBody, {
        httpMetadata: { contentType: "image/svg+xml" },
        customMetadata: {
          business_id: business.id,
          generated_at: new Date().toISOString(),
        },
      });
      console.log(`[logo] r2 upload ok key=${r2Key}`);
      assetUrl = `https://assets.textos.ai/${r2Key}`;
      r2Uploaded = true;
      await emit({ type: "cmd", text: "Logo saved to R2", ts: Date.now() });
    } catch (r2Err) {
      console.error(`[logo] r2 upload FAILED:`, r2Err);
      await emit({ type: "cmd", text: "[warn] R2 upload failed — using CDN URL", ts: Date.now() });
    }
  } else if (!env.ASSETS) {
    console.log(`[logo] ASSETS binding not present — using fal CDN URL`);
    await emit({ type: "cmd", text: "R2 not bound — logo URL stored as CDN reference (ephemeral)", ts: Date.now() });
  }

  // ── 6. Persist to business_assets ─────────────────────────────────────────
  await emit({ type: "cmd", text: "Saving logo to business assets", ts: Date.now() });
  console.log(`[logo] inserting business_assets row assetUrl=${assetUrl}`);

  try {
    const insertResult = await supabase.from("business_assets").insert({
      business_id:   business.id,
      task_run_id:   taskRunId,
      asset_type:    "logo",
      asset_subtype: "primary",
      asset_url:     assetUrl,
      asset_data: {
        format:       "svg",
        source:       "recraft-v3-vector",
        prompt,
        brief,
        generated_at: new Date().toISOString(),
      },
      metadata: {
        model:       "fal-ai/recraft-v3",
        style:       "vector_illustration",
        cost_cents:  8,
        fal_url:     result.image_url,
        r2_key:      r2Uploaded ? r2Key : null,
        r2_uploaded: r2Uploaded,
        seed:        result.seed ?? null,
      },
    });
    console.log(`[logo] business_assets insert result=${JSON.stringify(insertResult)}`);
  } catch (dbErr) {
    console.error(`[logo] business_assets insert FAILED:`, dbErr);
  }

  return {
    output_data: {
      asset_url:   assetUrl,
      r2_key:      r2Uploaded ? r2Key : null,
      r2_uploaded: r2Uploaded,
      style:       result.style,
      prompt,
      brief,
      fal_url:     result.image_url,
    },
  };
}

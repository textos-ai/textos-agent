import type { TaskCtx, TaskResult } from "./types";
import { buildLogoPrompt, generateLogoImage } from "../../services/fal";

export async function runLogo(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, emit, supabase, taskRunId, env } = tc;

  await emit({
    type: "narrative",
    text: "Generating your visual identity — this is what people recognize first.",
    ts: Date.now(),
  });

  // ── 1. Build prompt from business context ──────────────────────────────────
  const prompt = buildLogoPrompt(ctx);

  await emit({ type: "cmd", text: "Composing logo prompt from brand context", ts: Date.now() });

  // ── 2. Generate logo via fal.ai Recraft V3 ─────────────────────────────────
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

  // ── 3. Download SVG bytes from fal CDN ────────────────────────────────────
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

  // ── 4. Upload to R2 ───────────────────────────────────────────────────────
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

  // ── 5. Persist to business_assets ─────────────────────────────────────────
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
        prompt:       result.prompt,
        generated_at: new Date().toISOString(),
      },
      metadata: {
        model:       "fal-ai/recraft-v3",
        style:       result.style,
        seed:        result.seed ?? null,
        cost_cents:  8,
        r2_uploaded: r2Uploaded,
        r2_key:      r2Uploaded ? r2Key : null,
        fal_url:     result.image_url,
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
      prompt:      result.prompt,
      fal_url:     result.image_url,
    },
  };
}

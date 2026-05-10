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
    // FAL_API_KEY missing or fal API error — fail the task cleanly.
    // Orchestrator catches and continues pipeline; other tasks are unaffected.
    throw new Error(
      env.FAL_API_KEY
        ? "[logo] fal.ai Recraft V3 returned no image — check API key validity and quota"
        : "[logo] FAL_API_KEY is not configured — set via `wrangler secret put FAL_API_KEY`",
    );
  }

  // ── 3. Attempt R2 upload (optional — degrades to fal CDN URL if ASSETS unbound) ──
  let assetUrl = result.image_url; // fal CDN URL (~24h TTL fallback)
  let r2Uploaded = false;
  const r2Key = `businesses/${business.id}/logo.png`;

  if (env.ASSETS) {
    await emit({ type: "cmd", text: "Uploading logo to R2", ts: Date.now() });
    try {
      const imgRes = await fetch(result.image_url);
      if (imgRes.ok) {
        const body = await imgRes.arrayBuffer();
        await env.ASSETS.put(r2Key, body, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: {
            business_id: business.id,
            generated_at: new Date().toISOString(),
          },
        });
        // R2 public URL — update once bucket has public access or a Worker serving route.
        assetUrl = `https://assets.textos.ai/${r2Key}`;
        r2Uploaded = true;
        await emit({ type: "cmd", text: "Logo saved to R2", ts: Date.now() });
      }
    } catch (r2Err) {
      // Non-fatal — keep fal CDN URL, log for ops visibility.
      console.error("[logo] R2 upload failed — using fal CDN URL:", r2Err);
      await emit({ type: "cmd", text: "[warn] R2 upload failed — using CDN URL", ts: Date.now() });
    }
  } else {
    await emit({
      type: "cmd",
      text: "R2 not bound — logo URL stored as CDN reference (ephemeral)",
      ts: Date.now(),
    });
  }

  // ── 4. Persist to business_assets ─────────────────────────────────────────
  await emit({ type: "cmd", text: "Saving logo to business assets", ts: Date.now() });

  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type:    "logo",
      asset_subtype: "primary",
      asset_url:     assetUrl,
      asset_data: {
        format:       "png",
        prompt:       result.prompt,
        generated_at: new Date().toISOString(),
      },
      metadata: {
        model:       "recraft-v3",
        style:       result.style,
        seed:        result.seed ?? null,
        cost_cents:  8,
        r2_uploaded: r2Uploaded,
        r2_key:      r2Uploaded ? r2Key : null,
        fal_url:     result.image_url,
      },
    });
  } catch (dbErr) {
    // Non-fatal — log but don't fail the task over a DB write.
    console.error("[logo] business_assets insert failed:", dbErr);
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

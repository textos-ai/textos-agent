// Custom handler for generate-social-post.
// Dynamic per-platform fan-out: resolves connected publish-supported platforms
// at generation time, calls LLM once per platform with injected {{platform.*}} vars,
// writes one content_assets row per platform with target_platform = canonical slug.
// No hardcoded platform list anywhere in this file.

import type { TaskCtx, TaskResult } from "./types";
import { resolvePrompt } from "./prompt-resolver";
import { renderPrompt } from "./generic-document-runner";
import { resolveFeatureModel } from "../non-task-model-config";

interface PlatformPostOutput {
  post: string;
  hook: string;
  cta: string;
  character_count: number;
}

function stripFences(s: string): string {
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function validateOutput(parsed: unknown): PlatformPostOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.post !== "string" || obj.post.trim() === "") return null;
  if (typeof obj.hook !== "string" || obj.hook.trim() === "") return null;
  if (typeof obj.cta !== "string" || obj.cta.trim() === "") return null;
  const cc = typeof obj.character_count === "number"
    ? obj.character_count
    : obj.post.length;
  return {
    post: obj.post.trim(),
    hook: obj.hook.trim(),
    cta: obj.cta.trim(),
    character_count: cc,
  };
}

export async function runGenerateSocialPost(taskCtx: TaskCtx): Promise<TaskResult> {
  const {
    business, ctx, user,
    anthropic, models, featureConfig, supabase,
    taskRunId, abortSignal, sourceAsset, config,
  } = taskCtx;

  // 1. Resolve which platforms to generate for: connected accounts ∩ publish_supported.
  // Source of truth: business_integrations.config.accounts (Zernio slugs) ∩ platforms table.
  const { data: integration } = await supabase
    .from("business_integrations")
    .select("config")
    .eq("business_id", business.id)
    .eq("provider", "zernio")
    .eq("is_active", true)
    .maybeSingle();

  const zConfig = ((integration as any)?.config ?? {}) as {
    accounts?: { accountId: string; platform: string; handle?: string }[];
  };
  const connectedSlugs = (zConfig.accounts ?? []).map((a) => a.platform).filter(Boolean);

  if (connectedSlugs.length === 0) {
    throw new Error("no_connected_platforms: connect a social account first to generate posts");
  }

  const { data: platRows, error: platErr } = await supabase
    .from("platforms")
    .select("slug, display_name, char_limit, hashtag_limit")
    .in("slug", connectedSlugs)
    .eq("publish_supported", true)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (platErr) throw new Error(`platform_lookup_failed: ${platErr.message}`);

  const platforms = (platRows ?? []) as Array<{
    slug: string;
    display_name: string;
    char_limit: number | null;
    hashtag_limit: number | null;
  }>;

  if (platforms.length === 0) {
    throw new Error("no_publish_supported_platforms: connected platform does not support publishing yet");
  }

  // 2. Resolve prompt and model (shared across all platform calls).
  const promptDef = await resolvePrompt(supabase, "generate-social-post");
  if (!promptDef.system_prompt || promptDef.system_prompt.trim() === "") {
    throw new Error("task_missing_system_prompt: generate-social-post");
  }

  const model = resolveFeatureModel("feature-content-generation", featureConfig, models);

  // Shared template vars (same for all platforms)
  const sourceBlock = sourceAsset
    ? `## Source: ${sourceAsset.subtype ?? sourceAsset.assetType}\n\n${sourceAsset.text}\n\nUse the above document as primary context for this post.\n\n`
    : "";
  const source = {
    block: sourceBlock,
    text: sourceAsset?.text ?? "",
    id: sourceAsset?.id ?? "",
    subtype: sourceAsset?.subtype ?? "",
  };

  const rawAngle = typeof config?.angle === "string" ? config.angle.trim() : "";
  const rawDir   = typeof config?.direction === "string" ? config.direction.trim() : "";
  const dirParts: string[] = [];
  if (rawAngle) dirParts.push(`Angle: ${rawAngle}`);
  if (rawDir)   dirParts.push(`Direction: ${rawDir}`);
  const direction = { block: dirParts.join("\n") };

  const selectedKws = Array.isArray(config?.keywords)
    ? (config.keywords as unknown[]).filter((k): k is string => typeof k === "string")
    : [];

  // 3. Generate one post per platform; insert one content_assets row per platform.
  const contentAssetIds: string[] = [];

  for (const plat of platforms) {
    // Inject platform-specific vars so the prompt can write natively for each platform.
    const rendered = renderPrompt(promptDef.user_prompt_template, {
      business, ctx, user, source, direction,
      platform: {
        name: plat.display_name,
        slug: plat.slug,
        char_limit: String(plat.char_limit ?? 300),
      },
    });

    let result: PlatformPostOutput | null = null;
    let lastErr = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const retryNote = attempt === 1
        ? ""
        : `\n\n⚠ Previous response failed validation: ${lastErr}. Return ONLY valid JSON matching {"post":"...","hook":"...","cta":"...","character_count":0}.`;

      const msg = await anthropic.messages.create(
        {
          model,
          max_tokens: 1024,
          system: promptDef.system_prompt,
          messages: [{ role: "user", content: rendered + retryNote }],
        },
        abortSignal ? { signal: abortSignal } : undefined,
      );

      if (msg.stop_reason === "max_tokens") {
        throw new Error("task_output_truncated:generate-social-post stop_reason=max_tokens");
      }

      const block = msg.content[0];
      const text = block && block.type === "text" ? (block as { text: string }).text : "";
      const raw = stripFences(text.trim());

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        try {
          parsed = JSON.parse(raw.replace(/[\n\r\t]/g, " "));
        } catch (e) {
          lastErr = `JSON parse error: ${(e as Error).message}`;
          continue;
        }
      }

      const valid = validateOutput(parsed);
      if (valid) {
        result = valid;
        break;
      }
      lastErr = "shape mismatch (need { post, hook, cta, character_count })";
    }

    if (!result) {
      throw new Error(`generate_social_post_invalid_output[${plat.slug}]: ${lastErr}`);
    }

    // Append hashtags INCREMENTALLY — add selected tags one at a time, in order,
    // each only if the running total stays within the platform's char_limit.
    // Stop at the first tag that won't fit; keep the ones that did. Never
    // all-or-nothing. hashtag_limit (if set) caps how many we even consider.
    // Tags are lowercased with all non-alphanumerics stripped ("AI co-founder"
    // → "#aicofounder") so they link cleanly on every platform.
    let finalPost = result.post;
    if (selectedKws.length > 0) {
      const cap = typeof plat.hashtag_limit === "number" ? plat.hashtag_limit : selectedKws.length;
      const candidates = selectedKws
        .slice(0, cap)
        .map((kw) => "#" + kw.toLowerCase().replace(/[^a-z0-9]+/g, ""))
        .filter((tag) => tag.length > 1);
      let tagLine = "";
      for (const tag of candidates) {
        const nextLine = tagLine ? tagLine + " " + tag : tag;
        const combined = result.post + "\n\n" + nextLine;
        if (!plat.char_limit || combined.length <= plat.char_limit) {
          tagLine = nextLine;
        } else {
          break; // first tag that doesn't fit ends the run (selection order preserved)
        }
      }
      if (tagLine) finalPost = result.post + "\n\n" + tagLine;
    }

    const { data: caRow, error: caErr } = await supabase
      .from("content_assets")
      .insert({
        business_id: business.id,
        source_asset_id: sourceAsset?.id ?? null,
        task_run_id: taskRunId,
        content_type: "social_post",
        target_platform: plat.slug,
        generated_body: finalPost,
        status: "draft",
      })
      .select("id")
      .single();

    if (caErr || !caRow) {
      throw new Error(`content_assets_insert_failed[${plat.slug}]: ${caErr?.message ?? "no row returned"}`);
    }

    contentAssetIds.push((caRow as { id: string }).id);
  }

  return {
    output_data: {
      content_asset_ids: contentAssetIds,
      platform_count: platforms.length,
      platform_slugs: platforms.map((p) => p.slug),
      mode: sourceAsset ? "document" : "context_only",
    },
    model,
  };
}

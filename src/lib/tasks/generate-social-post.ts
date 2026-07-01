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

  // Shared template vars (same for all platforms).
  // When a source document is selected it is the PRIMARY SUBJECT — a strong,
  // explicit directive so the document's content drives the post and isn't lost
  // to the (rich) business context, which stays as voice/background only.
  const sourceBlock = sourceAsset
    ? [
        `# SOURCE MATERIAL FOR THE TECHNIQUE`,
        ``,
        sourceAsset.text,
        ``,
        `INSTRUCTION: The document above is the richest raw material for the technique — pull the ` +
          `reader's REAL language, specific pains, jobs, phrases, figures, and details from it and ` +
          `feed them into the technique's steps so the post is concrete and recognizably grounded ` +
          `in this material. The technique above still governs the angle, structure, and voice — ` +
          `this document supplies the specifics it runs on, not a different agenda.`,
        ``,
      ].join("\n")
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

  // 2b. Resolve the CONTENT PILLAR that steers this generation. config.pillar_id
  // is a business_pillars id (adopted/custom) or 'general'/absent -> the General
  // default. Always resolves a pillar (no "if no pillar" branch); General is the
  // neutral, draws-from-everything default that reproduces today's output. The
  // pillar's METHOD BODY (executable technique) leads the v5 prompt as
  // {{pillar.method_body}}; register/name follow. The business_pillar id (null
  // for General) is stamped on each content_assets row. method_body falls back
  // to intent for custom pillars that have none.
  const rawPillarId = typeof config?.pillar_id === "string" ? config.pillar_id.trim() : "";
  let pillar = { name: "General", intent: "", register: "", method_body: "" };
  let pillarMode = "value";
  let stampPillarId: string | null = null;
  let pillarResolved = false;
  if (rawPillarId && rawPillarId !== "general") {
    const { data: bp } = await supabase
      .from("business_pillars")
      .select("id, name, intent, register, method_body, mode")
      .eq("id", rawPillarId)
      .eq("business_id", business.id)
      .maybeSingle();
    if (bp) {
      const p = bp as { id: string; name: string; intent: string | null; register: string | null; method_body: string | null; mode: string | null };
      pillar = { name: p.name, intent: p.intent ?? "", register: p.register ?? "", method_body: (p.method_body ?? "").trim() || (p.intent ?? "") };
      pillarMode = p.mode === "promotional" ? "promotional" : "value";
      stampPillarId = p.id;
      pillarResolved = true;
    }
  }
  if (!pillarResolved) {
    const { data: gen } = await supabase
      .from("pillar_templates")
      .select("name, intent, register, method_body, mode")
      .eq("is_default", true)
      .limit(1)
      .maybeSingle();
    if (gen) {
      const g = gen as { name: string; intent: string | null; register: string | null; method_body: string | null; mode: string | null };
      pillar = { name: g.name, intent: g.intent ?? "", register: g.register ?? "", method_body: (g.method_body ?? "").trim() || (g.intent ?? "") };
      pillarMode = g.mode === "promotional" ? "promotional" : "value";
    }
  }

  // Mode: the pillar's own mode, overridable for a single run via config.pillar_mode.
  const override = typeof config?.pillar_mode === "string" ? config.pillar_mode.trim() : "";
  const effectiveMode = override === "value" || override === "promotional" ? override : pillarMode;

  // Compose the MODE directive + CONTEXT block (v6 references {{mode.directive}}
  // and {{context.block}}). VALUE mode strips the business entirely and demands a
  // hard, unsaid truth about the reader; PROMOTIONAL keeps the business as
  // subordinate raw material (v5 behavior).
  const modeDirective = effectiveMode === "value"
    ? [
        `## MODE: VALUE - pure reader insight, ZERO business mention`,
        `This is a VALUE post. Do NOT mention any business, company, product, brand, tool, service, or "why you need it" - not once, not even implied. There is no business in this post. The technique operates ONLY on the READER and their world.`,
        `Your job: deliver a HARD, UNSAID TRUTH about the reader's own situation - the uncomfortable thing nobody says out loud - and make them feel it. This is the "would post it 5x a week" bar: a genuine insight the reader would screenshot, not an ad. No pitch, no product, no call-to-action to any business, no competitor names, no "and that's why...". If you drift toward selling anything, stop and return to the reader's truth. The reader should think "nobody says this" - never "this is an ad".`,
      ].join("\n")
    : [
        `## MODE: PROMOTIONAL`,
        `The business context below is subordinate raw material the technique operates on. The business may appear, but the technique still governs the angle, structure, and voice - do not write a generic pitch or feature list. Lead with reader value.`,
      ].join("\n");

  const contextBlock = effectiveMode === "value"
    ? `# THE READER'S WORLD (write for and about THIS reader - nobody else)\n${JSON.stringify(ctx.target_customer ?? {})}\n\n(There is deliberately NO business, company, or product information here. Do not reference or invent one.)\n\n`
    : `# RAW MATERIAL - the business and its customer\nBusiness name: ${business.name}\nWhat it does: ${ctx.business_summary ?? ""}\nWho it serves: ${JSON.stringify(ctx.target_customer ?? {})}\nWhat makes it distinct: ${JSON.stringify(ctx.key_differentiators ?? [])}\nWhat it offers: ${ctx.value_proposition ?? ""}\n\n`;
  const mode = { directive: modeDirective };
  const context = { block: contextBlock };

  // 3. Generate one post per platform; insert one content_assets row per platform.
  const contentAssetIds: string[] = [];

  for (const plat of platforms) {
    // Inject platform-specific vars so the prompt can write natively for each platform.
    const rendered = renderPrompt(promptDef.user_prompt_template, {
      business, ctx, user, source, direction, pillar, mode, context,
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
        // FK → business_assets(id); only set for a single business_asset source.
        // task_run / combined-locked sources have no business_asset id (null).
        source_asset_id: sourceAsset?.businessAssetId ?? null,
        task_run_id: taskRunId,
        content_type: "social_post",
        target_platform: plat.slug,
        generated_body: finalPost,
        status: "draft",
        pillar_id: stampPillarId, // which pillar produced this (null = General default)
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

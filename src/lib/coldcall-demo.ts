// =============================================================
// Cold-call demo landing page — generation.
//
// A demo site is a SALES PROP shown to a prospect on a call: "here is what
// your site could look like". It is NOT the prospect's real website and NOT a
// Victora client site.
//
// ISOLATION IS THE HARD RULE. This module reads coldcall_leads, writes
// coldcall_demo_sites, and touches NOTHING in the client business system — no
// businesses row, no business_context, no business_assets, no sites/site_*, no
// tasks row, no task_runs, and not the shared TASK_QUEUE or its consumer.
//
// Neutral infrastructure it DOES reuse, as sanctioned: the {{var}} renderer,
// R2, and the non-task model registry. Prompts come from the isolated
// coldcall_demo_prompts table (see lib/coldcall-prompts.ts for why).
//
// HONESTY RULES baked into the content model:
//   - reviews are NEVER fabricated; the render shows a "connect your Google
//     Business Profile" placeholder instead
//   - a real rating shows only when we actually have one. rating IS NULL means
//     unrated, and must never render as 0
//   - no licence/insurance/warranty claims anywhere (enforced in the prompts)
// =============================================================

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { log } from "./logger";
// Prompts come from coldcall_demo_prompts, NOT prompt_definitions — that
// table's task_slug is a FK to tasks(slug), and a tasks row would couple this
// to the client catalog. renderPrompt is reused unchanged.
import { resolveColdcallPrompt } from "./coldcall-prompts";
import { renderPrompt } from "./tasks/generic-document-runner";
import { loadFeatureConfig, resolveFeatureModel } from "./non-task-model-config";
import { loadModelConfig } from "./model-config";

export const DEMO_PROMPT_SLUGS = ["demo-hero", "demo-services", "demo-why-us", "demo-faq"] as const;

const R2_PUBLIC = "https://assets.victora.ai";
const HERO_PREFIX = "demo-heroes";
const GENERIC_FOLDER = "generic";

export interface DemoLead {
  id: string;
  name: string;
  category: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  parish: string | null;
  rating: number | null;
  review_count: number | null;
  website_url: string | null;
}

/** URL-safe slug from a business name, plus 6 hex for uniqueness. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "demo";
}

export function hex6(): string {
  return Math.random().toString(16).slice(2, 8).padEnd(6, "0");
}

/**
 * Initials for the monogram badge: first letter of the first two words.
 * "Blue Ladder Electric" -> "BL". Single-word names give one letter rather
 * than an invented second. Leading articles and legal suffixes are skipped so
 * "The Plumbing Co LLC" reads PC, not TP.
 */
export function monogramOf(name: string): string {
  const SKIP = new Set(["the", "an", "llc", "inc", "co", "ltd", "corp", "and"]);
  const words = String(name || "")
    .replace(/[^A-Za-z0-9\s&]/g, " ")
    .split(/\s+/)
    // Single letters are kept deliberately: in a business name they are
    // initials, not articles. "A.R.E. Louisiana" must read AR, not RE.
    .filter((w) => w && (w.length === 1 || !SKIP.has(w.toLowerCase())));
  const src = words.length ? words : String(name || "").split(/\s+/).filter(Boolean);
  return src.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The town a customer would say. city → parish → market-less fallback. */
export function placeOf(lead: DemoLead): string {
  if (lead.city) return lead.city;
  if (lead.parish) {
    return lead.parish.replace(/(^|[\s_-])(\w)/g, (_, a: string, b: string) =>
      a.replace(/_/g, " ") + b.toUpperCase()) + " Parish";
  }
  return "your area";
}

// ── hero images ──────────────────────────────────────────────────────
/**
 * Resolve the R2 folder for a category, then list it.
 *
 * The category→folder mapping lives in coldcall_hero_map (a TABLE, so adding a
 * hero set is an INSERT not a deploy). An unmapped category is a seeding bug,
 * not something to paper over — but an EMPTY folder is expected while sets are
 * still being uploaded, so that falls back to generic by design.
 */
const IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i;
const VIDEO_RE = /\.(mp4|webm)$/i;

/** Public URL for an R2 key. Segments are encoded — real filenames contain
 *  spaces and parentheses, and a raw key in an <img src> is a broken image. */
const publicUrl = (key: string) =>
  `${R2_PUBLIC}/${key.split("/").map(encodeURIComponent).join("/")}`;

export async function pickHeroImages(
  supabase: SupabaseClient,
  env: Env,
  category: string | null,
): Promise<{ folder: string; hero: string | null; sections: string[]; video: string | null }> {
  let folder = GENERIC_FOLDER;
  if (category) {
    const { data, error } = await supabase
      .from("coldcall_hero_map")
      .select("folder")
      .eq("category", category)
      .maybeSingle();
    if (error) throw new Error(`hero_map_lookup_failed: ${error.message}`);
    if (data?.folder) folder = data.folder as string;
    else log.warn("[coldcall-demo] category_unmapped", { category });
  }

  const listFolder = async (f: string): Promise<string[]> => {
    if (!env.ASSETS) throw new Error("r2_assets_binding_missing");
    const listed = await env.ASSETS.list({ prefix: `${HERO_PREFIX}/${f}/` });
    return (listed.objects ?? [])
      .map((o) => o.key)
      // Ignore the folder placeholder object some upload tools create.
      .filter((k) => !k.endsWith("/"))
      .sort();
  };

  let keys = await listFolder(folder);
  // Fall back only when there is no IMAGE — a folder with a video but no
  // image still cannot render a poster, so images remain the requirement.
  if (!keys.some((k) => IMAGE_RE.test(k)) && folder !== GENERIC_FOLDER) {
    log.info("[coldcall-demo] hero_folder_empty_falling_back", { folder });
    folder = GENERIC_FOLDER;
    keys = await listFolder(GENERIC_FOLDER);
  }

  const images = keys.filter((k) => IMAGE_RE.test(k)).map(publicUrl);
  // Video hero, resolved HERE at generation time and stored in the content
  // model. Deliberately not resolved at render: the public page must not do
  // an R2 listing on every prospect's page load.
  const video = keys.filter((k) => VIDEO_RE.test(k)).map(publicUrl)[0] ?? null;

  return { folder, hero: images[0] ?? null, sections: images.slice(1, 4), video };
}

// ── section prompts ──────────────────────────────────────────────────
function parseStrictJson(raw: string, slug: string): Record<string, unknown> {
  // Models occasionally wrap JSON in a fence despite instruction. Strip it,
  // then parse — and fail loudly if it still is not JSON rather than shipping
  // a half-empty section.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const v = JSON.parse(cleaned);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("not a JSON object");
    }
    return v as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `demo_section_json_failed:${slug} ${err instanceof Error ? err.message : String(err)} ` +
      `raw_start=${cleaned.slice(0, 160).replace(/\s+/g, " ")}`,
    );
  }
}

async function runSection(
  anthropic: Anthropic,
  supabase: SupabaseClient,
  model: string,
  slug: string,
  vars: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const def = await resolveColdcallPrompt(supabase, slug);
  // renderPrompt's signature carries business/ctx/user from the task runner.
  // There is no business here by design — pass null rather than inventing one.
  const rendered = renderPrompt(def.user_prompt_template, {
    business: null,
    user: null,
    ...vars,
  } as { business: unknown; ctx: unknown; user: unknown });

  const msg = await anthropic.messages.create({
    model,
    max_tokens: def.max_output_tokens ?? 1200,
    ...(def.system_prompt ? { system: def.system_prompt } : {}),
    messages: [{ role: "user", content: rendered }],
  });

  const block = msg.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  if (!raw.trim()) {
    // An empty completion is usually a safety-classifier stop. Surface which
    // section and why rather than rendering a blank panel.
    throw new Error(
      `demo_section_empty:${slug} stop_reason=${msg.stop_reason ?? "unknown"} ` +
      `— the model returned no text (often a safety refusal). Check the lead's business name.`,
    );
  }
  return parseStrictJson(raw, slug);
}

// ── the content model ────────────────────────────────────────────────
export interface DemoContent {
  business: {
    name: string; phone: string | null; address: string | null;
    city: string | null; parish: string | null;
    rating: number | null; review_count: number | null; website_url: string | null;
  };
  hero: {
    image_url: string | null; eyebrow: string; headline: string;
    headline_accent: string; subhead: string; cta_label: string;
    // Resolved at GENERATION time from the trade folder. null when that
    // folder has no video, in which case the image hero renders unchanged.
    video_url: string | null;
    // The still shown before/behind the video, and the hero when there is no
    // video. Same first image either way.
    poster_url: string | null;
  };
  monogram: string;
  services: Record<string, unknown>;
  why_us: Record<string, unknown>;
  faq: Record<string, unknown>;
  reviews: { policy: "connect_gbp" };
  service_areas: string[];
  section_images: string[];
  generated_at: string;
}

/** Nearby localities to list as service areas. Parish first, then the town. */
function serviceAreas(lead: DemoLead): string[] {
  const out: string[] = [];
  if (lead.city) out.push(lead.city);
  if (lead.parish) {
    const p = lead.parish.replace(/(^|[\s_-])(\w)/g, (_, a: string, b: string) =>
      a.replace(/_/g, " ") + b.toUpperCase());
    out.push(`${p} Parish`);
  }
  // Deliberately NOT inventing neighbouring town names — naming a town the
  // business does not serve is the kind of detail a prospect catches instantly.
  return [...new Set(out)];
}

/**
 * Generate a demo site for a lead and return the content model.
 * Throws on any failure; the caller records status='failed' + the message.
 */
export async function generateDemoContent(
  supabase: SupabaseClient,
  env: Env,
  lead: DemoLead,
): Promise<{ content: DemoContent; heroFolder: string; ms: number; perSectionMs: Record<string, number> }> {
  const started = Date.now();

  // No-fallbacks: without a name there is nothing to put on the page, and
  // without a category every section would be generic filler.
  if (!lead.name || !lead.name.trim()) throw new Error("demo_missing_field: lead.name is empty");
  if (!lead.category || !lead.category.trim()) throw new Error("demo_missing_field: lead.category is empty");

  const [{ folder, hero, sections, video }, modelCfg, featureCfg] = await Promise.all([
    pickHeroImages(supabase, env, lead.category),
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);

  // Model resolves through the non-task registry — never a hardcoded string.
  const model = resolveFeatureModel("feature-coldcall-demo", featureCfg, modelCfg);

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const vars = {
    lead,
    ctx: { place: placeOf(lead), state: lead.state ?? "", trade: lead.category },
  };

  // All four sections in PARALLEL — they are independent, and running them in
  // series is what would push this past the request budget.
  const perSectionMs: Record<string, number> = {};
  const runTimed = async (slug: string) => {
    const t0 = Date.now();
    const out = await runSection(anthropic, supabase, model, slug, vars);
    perSectionMs[slug] = Date.now() - t0;
    return out;
  };

  const [heroCopy, services, whyUs, faq] = await Promise.all([
    runTimed("demo-hero"),
    runTimed("demo-services"),
    runTimed("demo-why-us"),
    runTimed("demo-faq"),
  ]);

  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

  const content: DemoContent = {
    business: {
      name: lead.name,
      phone: lead.phone,
      address: lead.address,
      city: lead.city,
      parish: lead.parish,
      // NULL rating means unrated. It is carried through as null so the render
      // can omit the badge entirely — never coerced to 0.
      rating: lead.rating,
      review_count: lead.review_count,
      website_url: lead.website_url,
    },
    hero: {
      image_url: hero,
      eyebrow: str(heroCopy.eyebrow),
      headline: str(heroCopy.headline),
      headline_accent: str(heroCopy.headline_accent),
      subhead: str(heroCopy.subhead),
      cta_label: str(heroCopy.cta_label, "Get a free quote"),
      video_url: video,
      poster_url: hero,
    },
    monogram: monogramOf(lead.name),
    services,
    why_us: whyUs,
    faq,
    // The render shows a "connect your Google Business Profile" placeholder.
    // Fabricating testimonials for a sales prop is prohibited outright.
    reviews: { policy: "connect_gbp" },
    service_areas: serviceAreas(lead),
    section_images: sections,
    generated_at: new Date().toISOString(),
  };

  const ms = Date.now() - started;
  log.info("[coldcall-demo] generated", {
    lead_id: lead.id, category: lead.category, folder, model,
    total_ms: ms, per_section_ms: perSectionMs,
    hero_images: sections.length + (hero ? 1 : 0),
    has_video: video !== null,
  });

  return { content, heroFolder: folder, ms, perSectionMs };
}

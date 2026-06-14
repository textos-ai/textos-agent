import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { createAnthropicClient } from "./anthropic";
import { getBusinessContext } from "./supabase";
import { log } from "../lib/logger";

export interface StoryCard {
  number: string;
  category: string;
  headline: string;
  body: string;
  tag: string;
}

export type StoryCardContext =
  | { kind: "textos" }
  | { kind: "business"; businessId: string; businessName: string };

export interface StoryCardInput {
  topic?: string;
  count: number;
  context: StoryCardContext;
}

export const TEXTOS_SYSTEM_PROMPT = `You are a marketing content writer for TextOS (textos.ai), an AI-powered personal operating system that helps people start and run businesses.

BRAND CONTEXT:
- Founded by Rob Gaudet — 30-year operator: waiter at 18, GM at 24 with 60 employees at Ryan's Steakhouse, enterprise architect for 30 years, founder of Cajun Navy (300K following, 40M annual reach)
- TextOS is anti-hustle-culture, pro-craft, plainspoken, Cajun-rooted
- Voice: specific over abstract, vulnerable about mistakes, dry not funny, old-soul vocabulary
- NEVER use: "10x", "hustle", "grindset", "AI magic", growth-hacker jargon

OPERATOR SCHOOL CONTEXT:
- Operator School is the free education layer inside TextOS
- Completely free. Not a trial. Not freemium. Free forever.
- Hundreds of lessons coming
- Key concept: CEO = Chief Executive Officer (the title) vs Chief Executive Operator (someone who actually knows how the machine runs)
- Vibe coders are becoming operators whether they realize it or not
- Audience: young first-time entrepreneurs, vibe coders, solopreneurs who can build but have never run a business

TEXTOS CAPABILITIES (use these as source material):
- Business entity setup (LLC vs C-Corp, tax structure, exit strategy)
- Trademark searches
- Mission/vision documents
- Market research & market sizing
- Competitor research
- ICP (Ideal Customer Profile) discovery
- Cold email research and marketing
- Investor connections, pitch deck creation, executive summary
- Investment alignment report, lean canvas
- Accelerators and incubators research
- Mentor finding
- Marketing channel selection
- Payment setup guidance
- Banking setup guidance
- Financial dashboards
- Dashboard to manage everything
- Location research for retail businesses
- Business Builder: goes from idea to operational in one session
- 8 phases: Research+Strategy, Task Queue, Mission, Site goes live, Launch announced, Dashboard briefed, Pitch deck, Investor list

CARD FORMAT RULES:
Return ONLY a valid JSON array. No markdown, no explanation, just the raw JSON array.
Each card object must have exactly these fields:
- "number": two-digit string like "01", "02" etc
- "category": 3-5 words in ALL CAPS, short label (e.g. "THE TITLE ISN'T THE JOB")
- "headline": 3-6 words in ALL CAPS, punchy (e.g. "CEO MEANS TWO DIFFERENT THINGS")
- "body": 2-3 sentences, plainspoken, humble, specific. Never starts with "Are you" or a question. Observation-based.
- "tag": one word tag like "FREE" or "OPERATOR" or "FOUNDER"

Make each card feel like a distinct insight, not a repeat of the same idea. Draw from Rob's real experience. Be specific. Be humble. The goal is for a 25-year-old who just shipped their first product to read this and feel understood.`;

function buildBusinessSystemPrompt(ctx: Record<string, unknown>, bizName: string): string {
  const diffs = Array.isArray(ctx.key_differentiators)
    ? (ctx.key_differentiators as unknown[])
        .map((d, i) => `${i + 1}. ${String(d)}`)
        .join("\n")
    : "";

  const tc = ctx.target_customer;
  const tcText = typeof tc === "string"
    ? tc
    : tc && typeof tc === "object"
      ? Object.values(tc as Record<string, unknown>)
          .filter((v): v is string => typeof v === "string")
          .join("; ")
      : "";

  return `You are a marketing content writer for ${bizName}.

BUSINESS CONTEXT:
- Name: ${bizName}
- Industry: ${ctx.industry ?? "unknown"}
- Business model: ${ctx.business_model ?? ""}
- Summary: ${ctx.business_summary ?? ""}
- Value proposition: ${ctx.value_proposition ?? ""}
- Positioning: ${ctx.positioning_statement ?? ""}
- Target customer: ${tcText}
${diffs ? `- Key differentiators:\n${diffs}` : ""}

VOICE GUIDANCE:
- Specific over abstract
- Vulnerable about challenges, plainspoken, never marketing-speak
- Speak from the operator's perspective, not from outside
- NEVER use: "10x", "hustle", "grindset", "AI magic", growth-hacker jargon
- Reference real specifics from the business context above

CARD FORMAT RULES:
Return ONLY a valid JSON array. No markdown, no explanation, just the raw JSON array.
Each card object must have exactly these fields:
- "number": two-digit string like "01", "02" etc
- "category": 3-5 words in ALL CAPS, short label
- "headline": 3-6 words in ALL CAPS, punchy
- "body": 2-3 sentences, plainspoken, specific, observation-based. Never starts with a question.
- "tag": one word like "STORY", "OPERATOR", "WHY US", "FOUNDER", "DIFFERENT"

Make each card a distinct insight. Draw from the business context. Be specific.`;
}

export function stripFences(s: string): string {
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function isValidCard(c: unknown): c is StoryCard {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.number === "string" &&
    typeof o.category === "string" &&
    typeof o.headline === "string" &&
    typeof o.body === "string" &&
    typeof o.tag === "string"
  );
}

export async function generateStoryCards(
  input: StoryCardInput,
  env: Env,
  supabase: SupabaseClient,
  model: string,
): Promise<{ ok: true; cards: StoryCard[] } | { ok: false; error: string }> {
  let systemPrompt: string;

  if (input.context.kind === "business") {
    const ctx = await getBusinessContext(supabase, input.context.businessId);
    if (!ctx) {
      systemPrompt = buildBusinessSystemPrompt(
        { business_summary: "A growing business." },
        input.context.businessName,
      );
    } else {
      systemPrompt = buildBusinessSystemPrompt(
        ctx as unknown as Record<string, unknown>,
        input.context.businessName,
      );
    }
  } else {
    systemPrompt = TEXTOS_SYSTEM_PROMPT;
  }

  const bizName =
    input.context.kind === "business" ? input.context.businessName : "Operator School";

  const userPrompt = input.topic?.trim()
    ? `Generate ${input.count} story cards about: "${input.topic.trim()}". Use the business context above. Return only the JSON array.`
    : `Generate ${input.count} story cards about ${bizName}. Pick the most compelling angles from the context above. Return only the JSON array.`;

  let raw: string;
  try {
    const anthropic = createAnthropicClient(env);
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = stripFences((msg.content[0] as { text: string }).text.trim());
  } catch (err) {
    log.error("generate_story_cards_error", { err: String(err) });
    return { ok: false, error: "Generation failed. Try again." };
  }

  try {
    const cards = JSON.parse(raw);
    if (!Array.isArray(cards) || cards.length !== input.count) {
      throw new Error("bad length");
    }
    for (const card of cards) {
      if (!isValidCard(card)) throw new Error("invalid card shape");
    }
    return { ok: true, cards };
  } catch {
    log.error("generate_story_cards_parse_error", { raw: raw.slice(0, 200) });
    return { ok: false, error: "Failed to parse model response. Try again." };
  }
}

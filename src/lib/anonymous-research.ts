/**
 * Lightweight research runner for anonymous snapshots.
 * Same AI logic as research-strategy task — no DB writes, no TaskCtx.
 */
import Anthropic from "@anthropic-ai/sdk";
import { extractErrorMessage } from "./extract-error";

export class ContentRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ContentRejectedError";
  }
}

const REFUSAL_PATTERNS = [
  /i(?:'m| am) (?:unable|not able)/i,
  /i (?:can't|cannot|won't|will not) (?:help|assist|provide|create|generate|research)/i,
  /i (?:apologize|understand) but/i,
  /this (?:request|content|topic) (?:involves|contains|is not something)/i,
  /instead,? (?:i |let me |i can )/i,
  /i (?:don't|do not) (?:feel comfortable|think I should)/i,
  /not (?:able|appropriate) to/i,
];

function looksLikeRefusal(text: string): boolean {
  const head = text.slice(0, 500);
  return REFUSAL_PATTERNS.some(p => p.test(head));
}

const SYSTEM = `You are the TextOS research agent — a world-class business strategist and market researcher.
Your output feeds every downstream task, so be thorough and precise.
Return ONLY a valid JSON object. No markdown fences, no prose, no explanation — just the JSON object starting with { and ending with }.`;

const REQUIRED_FIELDS = [
  "business_name", "industry", "business_summary",
  "target_customer", "value_proposition", "competitors", "positioning_statement",
];
const GENERIC_INDUSTRY = new Set(["General Business", "Business", "Other", "", "N/A"]);

export interface AnonymousInput {
  kind: "new_idea" | "existing" | "find_for_me";
  description?: string;
  url?: string;
  interests?: string;
  budget?: string;
}

export interface AnonymousSnapshot {
  name: string;
  alternatives: string[];
  industry: string;
  vertical: string;
  summary: string;
  competitors: Array<{ name: string; url?: string; note: string }>;
  positioning: string;
  value_proposition: string;
  target_customer: Record<string, unknown>;
  brand_voice: string;
  key_differentiators: string[];
}

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "TextOS-Agent/1.0 (research bot)" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
  } catch {
    return "";
  }
}

function buildIdea(input: AnonymousInput): string {
  if (input.kind === "existing") return input.url ?? "";
  if (input.kind === "find_for_me") {
    return `Find me a business idea. Interests: ${input.interests ?? "general"}. Budget: ${input.budget ?? "flexible"}.`;
  }
  return input.description ?? "";
}

function buildPrompt(input: AnonymousInput, idea: string, pageContent: string, retryNote: string): string {
  const urlSection    = input.url    ? `Existing URL: ${input.url}`      : "";
  const budgetSection = input.budget ? `Starting capital: ${input.budget}` : "";
  const pageSection   = pageContent  ? `\nActual page content fetched from the URL:\n"""\n${pageContent}\n"""` : "";

  const prompt = `Research this business and its market thoroughly.${retryNote}

Business type: ${input.kind}
${urlSection}
Idea / description: ${idea}
${budgetSection}
${pageSection}

Return EXACTLY this JSON object — no markdown, no extra keys, no comments:
{
  "business_name": "string — a concise, memorable brand name (2-4 words, Title Case)",
  "industry": "string — specific industry (NOT 'General Business')",
  "business_model": "string — how it makes money",
  "business_summary": "string — 2-3 sentences describing what the business does and for whom",
  "target_customer": {
    "description": "string — who the primary customer is",
    "pain_points": ["string", "string", "string"],
    "demographics": "string"
  },
  "value_proposition": "string — one crisp sentence on the unique value",
  "competitors": [
    { "name": "string", "url": "string — website if known, else empty", "description": "string", "weakness": "string" }
  ],
  "market_trends": ["string", "string", "string"],
  "positioning_statement": "string — for [target] who [need], [brand] is the [category] that [benefit] unlike [alternative]",
  "brand_voice": "string — tone and style",
  "key_differentiators": ["string", "string", "string"],
  "confidence": 75
}`;

  console.log(`[anon-research] kind=${input.kind} budget=${input.budget ?? "none"} prompt_length=${prompt.length}`);
  if (input.budget) console.log(`[anon-research] budget injected: "${input.budget}"`);
  return prompt;
}

export async function runAnonymousResearch(
  model: string,
  input: AnonymousInput,
  anthropic: Anthropic,
): Promise<AnonymousSnapshot> {
  const idea = buildIdea(input);

  // Fetch page content for existing business URLs
  let pageContent = "";
  if (input.kind === "existing" && input.url) {
    pageContent = await fetchPageText(input.url);
  }

  let parsed: Record<string, unknown> | null = null;
  let lastErr = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const retryNote = attempt === 1
      ? ""
      : `\n\n⚠️ Attempt ${attempt}/3. Previous response caused a parse error: "${lastErr}". Return ONLY the JSON object.`;

    let msg: Awaited<ReturnType<typeof anthropic.messages.create>>;
    try {
      msg = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(input, idea, pageContent, retryNote) }],
      });
    } catch (err) {
      // Anthropic SDK throws on 4xx — treat input-level rejections as content_rejected
      if (err instanceof Anthropic.APIError && err.status >= 400 && err.status < 500) {
        throw new ContentRejectedError(`API rejected input (${err.status}): ${err.message}`);
      }
      throw err;
    }

    const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());

    // Model returned a refusal rather than JSON — no point retrying
    if (looksLikeRefusal(raw)) {
      throw new ContentRejectedError("Model declined to research this input");
    }

    try {
      const candidate = JSON.parse(raw) as Record<string, unknown>;
      const missing = REQUIRED_FIELDS.filter(f => !(f in candidate) || candidate[f] === null || candidate[f] === "");
      if (missing.length > 0) throw new Error(`Missing fields: ${missing.join(", ")}`);
      if (GENERIC_INDUSTRY.has(candidate.industry as string)) throw new Error(`Generic industry: "${candidate.industry}"`);
      parsed = candidate;
      break;
    } catch (err) {
      lastErr = extractErrorMessage(err);
    }
  }

  if (!parsed) throw new Error(`Research failed after 3 attempts: ${lastErr}`);

  const competitors = (parsed.competitors as Array<Record<string, string>> ?? []).map(c => ({
    name: c.name ?? "",
    url: c.url ?? "",
    note: c.weakness ?? c.description ?? "",
  }));

  return {
    name: parsed.business_name as string,
    alternatives: [],
    industry: parsed.industry as string,
    vertical: parsed.industry as string,
    summary: parsed.business_summary as string,
    competitors,
    positioning: parsed.positioning_statement as string,
    value_proposition: parsed.value_proposition as string,
    target_customer: parsed.target_customer as Record<string, unknown>,
    brand_voice: parsed.brand_voice as string ?? "",
    key_differentiators: (parsed.key_differentiators as string[]) ?? [],
  };
}

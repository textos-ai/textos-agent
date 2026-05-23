import type { TaskCtx, TaskResult } from "./types";
import { extractErrorMessage } from "../extract-error";

const SYSTEM = `You are the TextOS research agent — a world-class business strategist and market researcher.
Your output feeds every downstream task, so be thorough and precise.
Return ONLY a valid JSON object. No markdown fences, no prose, no explanation — just the JSON object starting with { and ending with }.`;

const REQUIRED_FIELDS = [
  "industry", "business_model", "business_summary",
  "target_customer", "value_proposition", "competitors", "market_trends",
];
const GENERIC_INDUSTRY = new Set(["General Business", "Business", "Other", "", "N/A"]);

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "TextOS-Agent/1.0 (research bot)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

function buildPrompt(
  business: { name: string; kind: string; existing_business_url?: string | null },
  idea: string,
  pageContent: string,
  retryNote: string,
  findForMeData?: { interests: string; budget?: string } | null,
): string {
  if (findForMeData) {
    const budgetLine = findForMeData.budget
      ? `Budget available: ${findForMeData.budget}`
      : "Budget: not specified";
    return `You are helping a person find and launch a business that fits their background.${retryNote}

User background and skills:
"""
${findForMeData.interests}
"""
${budgetLine}

Task: Propose ONE remarkable, specific business concept this person could start — something that plays to their background, fits the budget, and has real market potential. Then research the market for that concept thoroughly.

Return EXACTLY this JSON object — no markdown, no extra keys, no comments:
{
  "industry": "string — specific industry (NOT 'General Business' — be specific)",
  "business_model": "string — how it makes money (saas_subscription, marketplace, consulting, service, etc.)",
  "business_summary": "string — 2-3 sentences: what the business does, for whom, and why this person is well-positioned to run it",
  "target_customer": {
    "description": "string — who the primary customer is",
    "pain_points": ["string", "string", "string"],
    "demographics": "string — relevant demographics"
  },
  "value_proposition": "string — one crisp sentence on the unique value (do NOT start with the company name or 'helps')",
  "competitors": [
    { "name": "string", "description": "string — what they do", "weakness": "string — exploitable gap" }
  ],
  "market_trends": ["string", "string", "string"],
  "positioning_statement": "string — for [target] who [need], [brand] is the [category] that [benefit] unlike [alternative]",
  "brand_voice": "string — tone and style descriptor",
  "key_differentiators": ["string", "string", "string"],
  "reasoning": "string — 2-3 sentences explaining why this concept fits this person's background and budget",
  "confidence": 75
}`;
  }

  const urlSection = business.existing_business_url
    ? `Existing URL: ${business.existing_business_url}`
    : "";
  const pageSection = pageContent
    ? `\nActual page content fetched from the URL:\n"""\n${pageContent}\n"""`
    : "";

  return `Research this business and its market thoroughly.${retryNote}

Business name: ${business.name}
Business type: ${business.kind}
${urlSection}
Idea / description: ${idea}
${pageSection}

Return EXACTLY this JSON object — no markdown, no extra keys, no comments:
{
  "industry": "string — specific industry name (NOT 'General Business' — be specific like 'Disaster Response Technology', 'DJ Booking Platform', 'Nonprofit Emergency Services')",
  "business_model": "string — how it makes money or is funded (nonprofit, saas_subscription, marketplace, consulting, donation_funded, etc.)",
  "business_summary": "string — 2-3 sentences describing what the business does and for whom",
  "target_customer": {
    "description": "string — who the primary customer is",
    "pain_points": ["string", "string", "string"],
    "demographics": "string — relevant demographics"
  },
  "value_proposition": "string — one crisp sentence on the unique value (do NOT start with the company name or 'helps')",
  "competitors": [
    { "name": "string", "description": "string — what they do", "weakness": "string — exploitable gap" }
  ],
  "market_trends": ["string", "string", "string"],
  "positioning_statement": "string — for [target] who [need], [brand] is the [category] that [benefit] unlike [alternative]",
  "brand_voice": "string — tone and style descriptor",
  "key_differentiators": ["string", "string", "string"],
  "reasoning": "string — 2-3 sentences of strategic rationale",
  "confidence": 75
}`;
}

export async function runResearchStrategy(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit, supabase, taskRunId } = tc;
  const ebd = business.existing_business_data as Record<string, string> | null;
  const isFindForMe = business.kind === "find_for_me";
  const findForMeData = isFindForMe
    ? { interests: ebd?.interests ?? "", budget: ebd?.budget }
    : null;
  const idea = isFindForMe
    ? ""
    : ebd?.idea ?? ebd?.description ?? business.name;

  await emit({
    type: "narrative",
    text: isFindForMe
      ? `Analyzing your background to find the right business concept…`
      : `Researching the market for ${business.name}…`,
    ts: Date.now(),
  });

  // ── Fetch page content for existing business URLs ───────────────────
  let pageContent = "";
  if (business.existing_business_url) {
    await emit({ type: "cmd", text: `Fetching ${business.existing_business_url}`, ts: Date.now() });
    try {
      pageContent = await fetchPageText(business.existing_business_url);
      await emit({ type: "cmd", text: `Page fetched — ${pageContent.length} chars of content`, ts: Date.now() });
    } catch (err) {
      await emit({ type: "cmd", text: `Fetch failed (${extractErrorMessage(err)}) — using Claude knowledge only`, ts: Date.now() });
    }
  }

  await emit({ type: "cmd", text: `Searching: "${business.name}" market size 2025`, ts: Date.now() });
  await emit({ type: "cmd", text: `Deep searching: ${business.name} competitors`, ts: Date.now() });

  // ── Retry loop: up to 3 attempts to get valid structured JSON ───────
  let parsed: Record<string, unknown> | null = null;
  let lastErr = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const retryNote =
      attempt === 1
        ? ""
        : `\n\n⚠️ Attempt ${attempt}/3. Your previous response caused a parse error: "${lastErr}". Return ONLY the JSON object — no backticks, no markdown, no prose.`;

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: buildPrompt(business, idea, pageContent, retryNote, findForMeData),
        },
      ],
    });

    const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());

    try {
      const candidate = JSON.parse(raw) as Record<string, unknown>;

      // Validate required fields
      const missing = REQUIRED_FIELDS.filter(
        (f) => !(f in candidate) || candidate[f] === null || candidate[f] === "",
      );
      if (missing.length > 0) {
        throw new Error(`Missing required fields: ${missing.join(", ")}`);
      }

      // Reject generic placeholder industry
      if (GENERIC_INDUSTRY.has(candidate.industry as string)) {
        throw new Error(
          `Industry is a generic placeholder: "${candidate.industry}". Must be specific.`,
        );
      }

      // Reject empty competitors array when we have an existing URL (should find some)
      if (
        business.existing_business_url &&
        Array.isArray(candidate.competitors) &&
        candidate.competitors.length === 0
      ) {
        throw new Error("No competitors returned for an existing business — retry with broader search.");
      }

      parsed = candidate;
      break;
    } catch (err) {
      lastErr = extractErrorMessage(err);
      await emit({
        type: "cmd",
        text: `> parse attempt ${attempt}/3 failed: ${lastErr}`,
        ts: Date.now(),
      });
    }
  }

  if (!parsed) {
    // Fail loudly — no silent defaults
    throw new Error(`Research synthesis failed after 3 attempts. Last error: ${lastErr}`);
  }

  await emit({
    type: "narrative",
    text: `Market classified: ${parsed.industry}. Found ${(parsed.competitors as unknown[])?.length ?? 0} competitors.`,
    ts: Date.now(),
  });
  await emit({ type: "cmd", text: `Saving strategy to business context`, ts: Date.now() });

  // ── Write research document to business_assets ──────────────────────
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "document",
      asset_subtype: "research_report",
      asset_data: parsed,
      metadata: {
        model: "claude-sonnet-4-6",
        page_fetched: !!pageContent,
        confidence: parsed.confidence,
      },
    });
  } catch {
    // Non-fatal
  }

  // Business naming is owned by the find-a-unique-business-name task,
  // which runs immediately after this one. Research no longer touches
  // businesses.name.

  return {
    output_data: { ...parsed, strategy: parsed.positioning_statement },
    context_updates: {
      industry: parsed.industry as string,
      business_model: parsed.business_model as string,
      business_summary: parsed.business_summary as string,
      target_customer: parsed.target_customer as Record<string, unknown>,
      value_proposition: parsed.value_proposition as string,
      competitors: parsed.competitors as unknown[],
      market_trends: parsed.market_trends as unknown[],
      positioning_statement: parsed.positioning_statement as string,
      brand_voice: parsed.brand_voice as string,
      key_differentiators: parsed.key_differentiators as unknown[],
      research_confidence_score:
        typeof parsed.confidence === "number" ? (parsed.confidence as number) : 70,
      last_research_run_at: new Date().toISOString(),
    },
  };
}

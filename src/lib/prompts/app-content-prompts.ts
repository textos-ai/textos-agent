// ─────────────────────────────────────────────────────────────────────────────
// App content prompts — v2 strategy pipeline (STYLE_GUIDE §13).
//
// Two prompts:
//   buildStrategyBuildPrompt   — BUILD time. LLM emits the §13 build schema
//                                (questions + result.section_plan directives +
//                                cta). It does NOT write the result bodies.
//   buildStrategyResultPrompt  — RUNTIME. LLM writes the result bodies FROM the
//                                visitor's actual answers, following section_plan.
//
// No-fallbacks: extractBusinessContext throws on any missing load-bearing field.
// Strategy archetype only this increment (assessment/calculator deferred).
// ─────────────────────────────────────────────────────────────────────────────

import type { BusinessContextRow } from "../../services/supabase";

export interface BusinessContext {
  name: string;            // filled from business.name in the handler
  industry: string;
  business_model: string;
  business_summary: string;
  differentiators: string;
  target_customer: string;
  value_proposition: string;
}

/**
 * Pull the business context the prompts need. NO-FALLBACKS: every field is
 * load-bearing — a missing one throws and the build halts loudly rather than
 * papering over with a default. (Replaces the old "customers" / "general" /
 * "unique approach" silent defaults.)
 */
export function extractBusinessContext(ctx: BusinessContextRow): BusinessContext {
  function req(val: unknown, field: string): string {
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
    throw new Error(`missing_business_context_field: ${field} (no-fallbacks — research-strategy must run first)`);
  }

  // target_customer is jsonb {description|summary|...} or a plain string.
  let targetCustomer = "";
  const tc = ctx.target_customer as Record<string, unknown> | null;
  if (tc && typeof tc === "object") {
    if (typeof tc.description === "string") targetCustomer = tc.description;
    else if (typeof tc.summary === "string") targetCustomer = tc.summary;
  } else if (typeof ctx.target_customer === "string") {
    targetCustomer = ctx.target_customer;
  }
  if (!targetCustomer.trim()) {
    throw new Error("missing_business_context_field: target_customer (no-fallbacks)");
  }

  const diffs = Array.isArray(ctx.key_differentiators)
    ? ctx.key_differentiators.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  if (diffs.length === 0) {
    throw new Error("missing_business_context_field: key_differentiators (no-fallbacks)");
  }

  return {
    name: "",
    industry: req(ctx.industry, "industry"),
    business_model: req(ctx.business_model, "business_model"),
    business_summary: req(ctx.business_summary, "business_summary"),
    differentiators: diffs.join(", "),
    target_customer: targetCustomer.trim(),
    value_proposition: req(ctx.value_proposition, "value_proposition"),
  };
}

const VOCAB_RULE =
  `Never use the words: AI, agent, automation, bot, "Get Started", "Dashboard", "generate", "prompt", "execute". Speak plainly, in this business's voice, to its customer.`;

/**
 * BUILD-time prompt: the LLM designs the app's questions + a result PLAN
 * (section directives) + the conversion cta. It does NOT write result bodies.
 */
export function buildStrategyBuildPrompt(
  bc: BusinessContext,
  operatorDescription: string,
): { system: string; user: string } {
  const system = `You design a "Personalized Strategy Plan" mini-app for a specific business. A visitor answers a few questions and receives a custom multi-section strategy. You produce ONLY the app's QUESTIONS and a RESULT PLAN (section directives) plus a call-to-action. You do NOT write the result bodies — those are written later from the visitor's actual answers. You do NOT write HTML or JavaScript.

BUSINESS:
- Name: ${bc.name}
- Industry: ${bc.industry}
- Business model: ${bc.business_model}
- What it does: ${bc.business_summary}
- Target customer: ${bc.target_customer}
- Differentiators: ${bc.differentiators}
- Value proposition: ${bc.value_proposition}

OPERATOR INTENT: ${operatorDescription}

DESIGN RULES (STYLE_GUIDE §13 contract):
- Questions must be specific to THIS business and gather the exact inputs needed to produce a genuinely personalized strategy. Generic questions are a failure.
- Produce EXACTLY 7 questions in this fixed order — the layout is fixed, only the content is yours:
    1. step "1", type "text"      — a short specific input
    2. step "1", type "text"      — a short specific input
    3. step "1", type "textarea"  — a longer free-text input
    4. step "2", type "radio"     — multiple choice, 3–5 options
    5. step "2", type "radio"     — multiple choice, 3–5 options
    6. step "3", type "text"      — a short specific input
    7. step "3", type "textarea"  — a longer free-text input
- Every question has a unique kebab "id", "text" (the question), "required" (boolean), and a "placeholder" for text/textarea questions.
- For every radio option provide: "label" (short), "value" (stable kebab id), "icon" (a Tabler icon slug, e.g. "target","users","calendar","rocket","coin","chart-bar"), and an optional one-line "description".
- result.section_plan: 3–5 entries. Each is { "heading": short section title, "directive": a precise instruction for how to WRITE that section FROM the visitor's answers }. The directive is read later by the result writer together with the visitor's responses — make it concrete (what to analyze, what to recommend), never generic filler.
- result.cta: a "primary_text"/"secondary_text" pair of button labels. Set both "primary_action" and "secondary_action" to the literal string "cta_url_placeholder" — the system substitutes the business's real URL.
- "hero_icon": one Tabler slug for the app hero.
- "image_prompt": a short prompt describing a result banner image (stored for later; not rendered yet).

${VOCAB_RULE}

OUTPUT: return ONLY a JSON object with EXACTLY these keys — no markdown, no code fences, no prose, first character "{":
{
  "app_title": "string",
  "app_tagline": "string",
  "hero_icon": "tabler-slug",
  "image_prompt": "string",
  "submit_button_text": "string (e.g. 'Get My Plan')",
  "questions": [
    { "id": "kebab-id", "step": "1", "type": "radio", "text": "string", "required": true,
      "options": [ { "label": "string", "value": "kebab", "icon": "tabler-slug", "description": "string" } ] },
    { "id": "kebab-id", "step": "2", "type": "textarea", "text": "string", "required": true, "placeholder": "string" }
  ],
  "result": {
    "section_plan": [ { "heading": "string", "directive": "string" } ],
    "cta": { "primary_text": "string", "primary_action": "cta_url_placeholder", "secondary_text": "string", "secondary_action": "cta_url_placeholder" }
  }
}`;

  const user = `Design the strategy app now for "${bc.name}". Operator request: "${operatorDescription}". Return only the JSON object, first character "{".`;
  return { system, user };
}

/**
 * RUNTIME prompt: the LLM writes the result bodies FROM the visitor's answers,
 * following the build-time section_plan. This is what makes the result
 * input-responsive rather than generic.
 */
export function buildStrategyResultPrompt(args: {
  bc: BusinessContext;
  appTitle: string;
  sectionPlan: Array<{ heading: string; directive: string }>;
  questions: Array<{ id: string; text: string }>;
  responses: Record<string, string>;
}): { system: string; user: string } {
  const qa = args.questions
    .map((q) => `Q (${q.id}): ${q.text}\nA: ${args.responses[q.id] ?? "(not answered)"}`)
    .join("\n\n");
  const plan = args.sectionPlan
    .map((s, i) => `${i + 1}. ${s.heading} — ${s.directive}`)
    .join("\n");

  const system = `You write a personalized strategy result for a visitor to the "${args.appTitle}" app, for the business "${args.bc.name}" (${args.bc.industry}; ${args.bc.business_summary}). Write the result DIRECTLY from the visitor's answers below — it must reflect their specific situation and choices, not generic advice. Produce exactly one section per item in the SECTION PLAN, in order, each following its directive and grounded in the visitor's answers. You do NOT write HTML.

${VOCAB_RULE}

OUTPUT: return ONLY a JSON object — no markdown, no prose, first character "{":
{ "headline": "string specific to their answers", "summary": "string, 2-3 sentences", "sections": [ { "heading": "string", "body": "string, 1-3 short paragraphs" } ] }`;

  const user = `SECTION PLAN:\n${plan}\n\nVISITOR ANSWERS:\n${qa}\n\nWrite the result now as JSON only, first character "{".`;
  return { system, user };
}

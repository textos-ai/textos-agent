// ─────────────────────────────────────────────────────────────────────────────
// App content prompts for v2 archetype-driven app generation.
//
// Each archetype has a specialized system prompt that guides the LLM to produce
// content matching that archetype's content_schema via tool_use. The prompts
// share a common skeleton but have archetype-specific guidance in section 5.
// ─────────────────────────────────────────────────────────────────────────────

import type { BusinessContextRow } from "../../services/supabase";

interface BusinessContext {
  name: string;
  kind: string;
  industry: string;
  differentiators: string;
  target_customer: string;
  value_proposition: string;
}

/**
 * Builds the system prompt for a specific archetype, given business context
 * and the operator's intent description.
 */
export function buildSystemPrompt(
  archetypeId: string,
  archetypeName: string,
  businessContext: BusinessContext,
  operatorDescription: string,
): string {
  const commonSkeleton = `You produce content for a ${archetypeName} mini-app for a specific business. You do NOT write HTML or JavaScript. You fill the content_schema with high-quality, business-specific content.

BUSINESS CONTEXT:
- Business name: ${businessContext.name}
- Business type: ${businessContext.kind}
- Industry: ${businessContext.industry}
- Key differentiators: ${businessContext.differentiators}
- Target customer: ${businessContext.target_customer}
- Value proposition: ${businessContext.value_proposition}

OPERATOR INTENT:
${operatorDescription}

QUALITY BAR:
- Result must provide monetary-equivalent value (replaces a consultant hour, a paid tool, an audit)
- Result must end with a clear CTA
- Content must be specific to this business, not generic
- Above-the-fold rule: hero section must work without scrolling

${getArchetypeSpecificGuidance(archetypeId)}

FORBIDDEN VOCABULARY:
Never use these terms: AI, agent, task, automation, tool, bot, execute, process, prompt, generate, "Get Started", "Dashboard". Use operator-vocabulary terms: business, customer, plan, brief, build.

OUTPUT INSTRUCTION:
Call the generate_app_content tool with content that conforms to the input_schema.`;

  return commonSkeleton;
}

/**
 * Returns archetype-specific guidance for section 5 of the system prompt.
 */
function getArchetypeSpecificGuidance(archetypeId: string): string {
  switch (archetypeId) {
    case "strategy":
      return `STRATEGY ARCHETYPE GUIDANCE:
- Produce 3-5 strategy sections, each actionable
- Section bodies should be 2-3 sentences
- Action items should be concrete and specific
- Focus on tactics that this specific business can implement immediately
- Each section should build toward a cohesive strategic direction`;

    case "assessment":
      return `ASSESSMENT ARCHETYPE GUIDANCE:
- Produce questions that meaningfully discriminate between strong and weak responses
- Score bands must collectively cover 0..max_score with no gaps
- Questions should probe areas where this business type commonly struggles
- Scoring should provide genuine insight, not just feel-good validation
- Results should include specific recommendations based on score ranges`;

    case "calculator":
      return `CALCULATOR ARCHETYPE GUIDANCE:
- Produce input fields that are easy for the visitor to fill from memory or quick estimate
- Expressions must use only the input ids you declare
- Use Math.{min,max,round,floor,ceil,abs,sqrt,pow} for math helpers
- Calculation should provide genuinely useful business insight
- Results should be actionable and specific to the calculated outcome`;

    default:
      throw new Error(`Unknown archetype_id: ${archetypeId}`);
  }
}

/**
 * Builds the simple user prompt that instructs the LLM to call the tool.
 * The system prompt carries the heavy guidance.
 */
export function buildUserPrompt(operatorDescription: string): string {
  return `Create content for this mini-app based on the business context and intent described above.

Operator's specific request: "${operatorDescription}"

Call the generate_app_content tool with appropriate content.`;
}

/**
 * Helper to extract business context from the database row format
 * into the simplified interface used by prompts.
 */
export function extractBusinessContext(ctx: BusinessContextRow): BusinessContext {
  // Extract target customer string from JSONB field
  let targetCustomerStr = "customers";
  if (ctx.target_customer && typeof ctx.target_customer === 'object') {
    // Extract meaningful string from the object structure
    const tc = ctx.target_customer as Record<string, unknown>;
    if (typeof tc.summary === 'string') {
      targetCustomerStr = tc.summary;
    } else if (typeof tc.description === 'string') {
      targetCustomerStr = tc.description;
    }
  }

  // Extract differentiators from array
  let diffStr = "unique approach";
  if (Array.isArray(ctx.key_differentiators) && ctx.key_differentiators.length > 0) {
    diffStr = ctx.key_differentiators.map(String).join(", ");
  }

  return {
    name: "Business", // Will be filled from business.name in the handler
    kind: ctx.business_model || "business",
    industry: ctx.industry || "general",
    differentiators: diffStr,
    target_customer: targetCustomerStr,
    value_proposition: ctx.value_proposition || "valuable service",
  };
}
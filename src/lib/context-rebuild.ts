// Rebuild Context — extract business_context fields from a business's documents.
//
// The doc->field map is DATA (tasks.is_context_source + tasks.context_fields), not
// code here. This module is the mechanism: resolve a doc's source text (edited
// prose first, frozen asset_data only as fallback), LLM-extract the fields that
// doc is allowed to own, then gate each value before it is written. Callers merge
// per the "most-specific-source-wins" rule and apply a PARTIAL patch so fields no
// document covers are never touched.

import type Anthropic from "@anthropic-ai/sdk";

export type Tier = 1 | 2 | 3;

export interface FieldSpec {
  shape: string;
  tier: Tier;
}

// The known business_context fields a document may populate, with an LLM shape
// hint and a safety tier. TIER 1 feeds app/logo/landing generation and halts it
// if malformed -> gated hardest.
export const CONTEXT_FIELD_SHAPES: Record<string, FieldSpec> = {
  industry:              { shape: "string - the industry / what the business does", tier: 2 },
  business_model:        { shape: "string - how the business makes money", tier: 3 },
  business_summary:      { shape: "string - a concise summary of the business", tier: 2 },
  target_customer:       { shape: "object { description: string, pain_points: string[], signals: string[], excludes: string[] }", tier: 2 },
  value_proposition:     { shape: "string - the core value proposition", tier: 1 },
  positioning_statement: { shape: "string - a positioning statement", tier: 1 },
  brand_voice:           { shape: "string - how the brand speaks", tier: 1 },
  competitors:           { shape: "string[] - competitor names or short descriptions", tier: 3 },
  market_trends:         { shape: "string[] - relevant market trends", tier: 3 },
  key_differentiators:   { shape: "string[] - what sets the business apart", tier: 3 },
  market_size:           { shape: "object { tam, sam, som }", tier: 3 },
};

export const TIER1_FIELDS = new Set(
  Object.entries(CONTEXT_FIELD_SHAPES).filter(([, s]) => s.tier === 1).map(([k]) => k),
);

const PLACEHOLDER =
  /^(n\/?a|none|null|unknown|tbd|todo|not\s+(enough|available|specified|provided|applicable)|insufficient|no\s+(information|data))/i;

export interface FieldVerdict {
  ok: boolean;
  reason?: string;
}

/** Gate a single extracted field value. TIER-1 is validated hardest. */
export function validateField(field: string, value: unknown): FieldVerdict {
  const spec = CONTEXT_FIELD_SHAPES[field];
  if (!spec) return { ok: false, reason: "unknown field" };

  if (field === "target_customer") {
    const v = value as { description?: unknown } | null;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.description === "string" && v.description.trim().length >= 20) {
      return { ok: true };
    }
    return { ok: false, reason: "no substantive description" };
  }

  if (field === "market_size") {
    const v = value as Record<string, unknown> | null;
    if (v && typeof v === "object" && !Array.isArray(v) && (v.tam != null || v.sam != null || v.som != null)) {
      return { ok: true };
    }
    return { ok: false, reason: "missing tam/sam/som" };
  }

  if (field === "competitors" || field === "market_trends" || field === "key_differentiators") {
    if (Array.isArray(value) && value.some((x) => (typeof x === "string" ? x.trim().length > 0 : x != null))) {
      return { ok: true };
    }
    return { ok: false, reason: "empty list" };
  }

  // Scalar string fields (incl. all TIER-1).
  const min = spec.tier === 1 ? 24 : 8;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length >= min && !PLACEHOLDER.test(t) && t.toLowerCase() !== field.replace(/_/g, " ")) {
      return { ok: true };
    }
  }
  return { ok: false, reason: spec.tier === 1 ? "extraction too thin" : "empty or placeholder" };
}

/** Build the fields block for the extraction prompt from a doc's allowed fields. */
export function buildFieldsSpec(fields: string[]): string {
  return fields
    .filter((f) => CONTEXT_FIELD_SHAPES[f])
    .map((f) => `- ${f}: ${CONTEXT_FIELD_SHAPES[f].shape}`)
    .join("\n");
}

/** Flatten a {title, sections[]} narrative asset_data into plain text. */
export function flattenAssetData(ad: unknown): string {
  if (ad == null) return "";
  if (typeof ad === "string") return ad;
  if (typeof ad === "object" && !Array.isArray(ad)) {
    const o = ad as { title?: unknown; sections?: unknown };
    if (Array.isArray(o.sections)) {
      const parts: string[] = [];
      if (o.title) parts.push(String(o.title));
      for (const s of o.sections) {
        if (s && typeof s === "object") {
          const sec = s as { heading?: unknown; body?: unknown };
          parts.push([sec.heading, sec.body].filter(Boolean).map(String).join("\n"));
        }
      }
      return parts.join("\n\n");
    }
    return JSON.stringify(ad);
  }
  return String(ad);
}

/** Pick only the allowed fields that are present (non-null) as keys in a
 *  structured asset_data (the never-edited fast path, no LLM). */
export function pickStructured(ad: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ad && typeof ad === "object" && !Array.isArray(ad)) {
    const o = ad as Record<string, unknown>;
    for (const f of fields) if (o[f] != null) out[f] = o[f];
  }
  return out;
}

function messageText(msg: unknown): string {
  const blocks = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let s = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** LLM-extract the allowed fields the document text substantially supports.
 *  Returns a partial object (covered fields only); {} on parse failure. */
export async function extractFromText(
  anthropic: Anthropic,
  model: string,
  businessName: string,
  docSubtype: string | null,
  text: string,
  fields: string[],
): Promise<Record<string, unknown>> {
  const spec = buildFieldsSpec(fields);
  if (!spec || !text.trim()) return {};
  const system =
    "You extract structured business-context fields from ONE business document. " +
    "Output ONLY fields the document's own text clearly and substantially supports. " +
    "If the document does not genuinely cover a field, OMIT it -- never guess, never " +
    "restate the field name, never invent. Return ONLY a JSON object, no markdown fences.";
  const user =
    `Business: ${businessName}\n` +
    `Extract these fields IF this document substantially supports them (omit any it does not):\n${spec}\n\n` +
    `Document (${docSubtype ?? "document"}):\n---\n${text.slice(0, 12000)}\n---\n` +
    `Return ONLY a JSON object containing the covered fields.`;
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: user }],
  });
  const parsed = parseJsonObject(messageText(msg));
  // Scope to allowed fields only.
  const scoped: Record<string, unknown> = {};
  for (const f of fields) if (parsed[f] != null) scoped[f] = parsed[f];
  return scoped;
}

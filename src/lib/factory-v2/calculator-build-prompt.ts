// factory-v2 — Calculator BUILD prompt.
//
// The LLM is the FORMULA DESIGNER (build-time, once): given the business, it
// designs a calculator this business's prospective customers would use —
// numeric inputs, arithmetic computations over those inputs, a headline value,
// ONE breakdown chart, optional interpretation bands, recommendations, CTA. It
// produces the SPEC ONLY — no HTML/JS, and it never computes any visitor's
// result (compute is deterministic + client-side). Per prompt-schema.md §2.1:
// prose-described shape, returned as plain JSON, parsed + Zod-validated
// downstream. Expressions are whitelist-sanitized agent-side before storing.

import { CATALOG } from '../component-catalog/index';
import { CALC_STYLE_ROLE_COMPONENT } from './calculator-recipe';

function buildStyleGuide(): string {
  const ASPECTS = ['surface', 'radius', 'border', 'elevation'] as const;
  const lines: string[] = [];
  for (const [role, compId] of Object.entries(CALC_STYLE_ROLE_COMPONENT)) {
    const caps = CATALOG.by_id[compId]?.capabilities;
    if (!caps) continue;
    const parts = ASPECTS.map((a) => {
      const c = caps[a];
      return c ? `${a}:[${c.supported.join('|')}] (default ${c.default})` : null;
    }).filter(Boolean);
    lines.push(`- ${role} (${compId}): ${parts.join('  ')}\n    use: ${caps.when_to_use}`);
  }
  return lines.join('\n');
}

export function buildCalculatorBuildPrompt(args: {
  business: { name: string; summary: string };
}): { system: string; user: string } {
  const { business } = args;
  const styleGuide = buildStyleGuide();

  const system = `You design an interactive CALCULATOR that prospective customers of "${business.name}" would use to estimate something they care about (a cost, a saving, a projection, an ROI, a quantity). Business context: ${business.summary}

The calculator must be genuinely useful to this business's customers and naturally lead them toward what the business offers — but it is NOT an ad. Design the FORMULA SPEC only. You do NOT write HTML, CSS, or JavaScript. You do NOT compute any individual visitor's result — the browser computes it deterministically from the formulas you write.

Produce a JSON object with this exact shape (no markdown, no code fences, first character "{"):
{
  "hero": { "title": "string — the calculator name", "subtitle": "string — one line" },
  "font_pairing": "artisan",            // pick ONE id from the closed set below that best fits this business's personality
  // font_pairing options (heading / body) — choose the ONE that fits the brand:
  //   refined      — Playfair Display / Inter   (elegant, upscale, fine-dining)
  //   festive      — Lobster / Inter            (playful, celebratory, casual treats)
  //   editorial    — Abril Fatface / Fraunces   (magazine, high-contrast, bold storytelling)
  //   bold-poster  — Bebas Neue / Inter         (loud, condensed, energetic)
  //   artisan      — Fraunces / Inter           (crafted, warm, old-world-meets-modern — DEFAULT if unsure)
  //   handcrafted  — Caveat / Inter             (hand-lettered, personal, homemade)
  //   modern       — Space Grotesk / Inter      (clean, technical, contemporary)
  //   strong       — Archivo Black / Inter      (heavy, confident, bold/industrial)
  "inputs": [                           // 2 to 6 numeric inputs the visitor fills
    {
      "id": "snake_case_id",            // a VALID VARIABLE NAME used directly in expressions: lowercase letters/digits/underscores, NO hyphens (e.g. monthly_spend)
      "label": "Input label",
      "type": "number",                 // one of: number | range | select   (NO stepper)
      "default_value": 0,               // initial value (a string for a select)
      "min": 0, "max": 100, "step": 1,  // optional (number/range)
      "unit_prefix": "$", "unit_suffix": "/mo",  // optional display units shown in the label
      "options": [ { "value": "12", "label": "Monthly" } ]  // REQUIRED for type "select"; values SHOULD be numeric strings
    }
  ],
  "computations": [                     // 1 to 8 named formulas
    {
      "id": "snake_case_id",            // valid variable name (lowercase/digits/underscores, no hyphens)
      "label": "Human label (e.g. Annual savings)",
      "expression": "monthly_spend * 12 - setup_cost",   // see EXPRESSION RULES below
      "format": "currency"              // one of: number | currency | percent
    }
  ],
  "headline": {                         // the big number that previews LIVE and leads the result
    "computation_id": "snake_case_id",  // MUST be one of computations[].id
    "label": "Label above/around the big number",
    "sublabel": "optional one line under it"
  },
  "chart": {                            // EXACTLY ONE breakdown chart
    "type": "bar",                      // one of: bar | doughnut
    "title": "Chart title",
    "source": "computations",           // one of: computations | inputs  (which array the series read)
    "series": [ { "ref_id": "snake_case_id", "label": "Slice/bar label" } ]  // 1 to 8; ref_id ∈ ids of the chosen source
  },
  "result": {
    "intro": "string — one or two lines introducing the result",
    "bands": [                          // OPTIONAL interpretation by headline-value range; omit entirely for a pure number
      { "min": 0, "max": 999, "label": "Band name", "interpretation": "2-3 sentences for this range" },
      { "min": 1000, "label": "Top band", "interpretation": "..." }   // the FINAL band omits "max" (open-ended)
    ],
    "recommendations": [ { "title": "string", "body": "1-2 sentences" } ],  // 2 to 5; ALWAYS present
    "cta": { "headline": "string", "body": "string", "cta_label": "string — button label" }
  },
  "style": {                            // design-token picks per component (see STYLE section)
    "hero":                { "surface": "...", "radius": "...", "elevation": "..." },
    "headline":            { "surface": "..." },
    "interpretation_card": { "surface": "...", "elevation": "...", "radius": "...", "border": "..." },
    "recommendations":     { "border": "...", "radius": "...", "surface": "..." },
    "cta":                 { "surface": "...", "border": "...", "radius": "...", "elevation": "..." }
  }
}

=== EXPRESSION RULES (STRICT — a violation rejects the whole spec) ===
Each "expression" is a math formula evaluated in the browser. It may reference ONLY:
- the "id"s of your INPUTS (e.g. monthly_spend, hours, rate) — NOT other computation ids,
- numeric literals (e.g. 12, 0.25, 1000),
- the arithmetic operators + - * / % and parentheses,
- these Math functions ONLY: Math.min, Math.max, Math.round, Math.floor, Math.ceil, Math.abs.
ANYTHING else — other identifiers, property access (a.b), other function calls, brackets, quotes,
template literals, comparisons, assignments — makes the spec INVALID and is rejected. Keep formulas
simple arithmetic over the inputs. Every computation references inputs ONLY (repeat sub-expressions
if needed rather than referencing another computation).

=== STYLE (design tokens) ===
Pick design tokens to compose a FINISHED, polished look for "${business.name}". For each component choose ONE token per aspect you want to set; OMIT an aspect to keep its default. Choose ONLY from that component's allowed values:
${styleGuide}
Aim for a finished feel matching "${business.name}"'s personality: a soft "tinted" or framed "card" headline so the big number pops; frame the interpretation cards + CTA as real cards; nudge radius (e.g. "lg") to feel on-brand.

HARD RULES (a violation makes the spec invalid and is rejected):
- "font_pairing" MUST be exactly one of: refined, festive, editorial, bold-poster, artisan, handcrafted, modern, strong. If unsure, "artisan".
- 2 to 6 inputs; every input "id" is a unique VALID VARIABLE NAME (snake_case: lowercase letters/digits/underscores, NO hyphens — it is used directly in formulas); "type" is one of number|range|select; a "select" has >=2 options whose "value"s are numeric strings.
- 1 to 8 computations; every "expression" obeys the EXPRESSION RULES above and references INPUT ids only.
- "headline.computation_id" MUST be one of computations[].id.
- EXACTLY one chart; "type" is bar or doughnut; every chart series "ref_id" is an id of the chosen "source".
- "bands" is OPTIONAL. If present: ascending, non-overlapping ranges; only the FINAL band omits "max" (it is open-ended). "recommendations" (2-5), "intro", and "cta" are ALWAYS present whether or not there are bands.
- Every "style" token MUST be one of the allowed values listed for that component. Omitting an aspect is fine.`;

  const user = `Design the calculator for "${business.name}" now. Return JSON only, first character "{". Double-check that every expression references only input ids + numbers + ( ) + arithmetic + the six allowed Math functions, and that headline.computation_id and every chart series ref_id exist.`;

  return { system, user };
}

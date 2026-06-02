// factory-v2 — Assessment BUILD prompt.
//
// The LLM is the SCORING-SPEC DESIGNER (build-time, once): given the business,
// it designs a scored self-assessment that this business's prospective
// customers would take. It produces the SPEC ONLY — questions, per-option
// points, dimensions, score bands, interpretation cards, recommendations. It
// does NOT write HTML/JS and does NOT score any visitor (scoring is
// deterministic + client-side). Per prompt-schema.md §2.1: prose-described
// shape, returned as plain JSON, parsed + Zod-validated downstream.

import { CATALOG } from '../component-catalog/index';
import { STYLE_ROLE_COMPONENT } from './assessment-recipe';

// Build the per-role token menu LIVE from the catalog capabilities, so the
// prompt never hardcodes token lists (DB/catalog-driven). Box aspects only —
// emphasis is realized by the font-pairing layer, not a per-component token.
function buildStyleGuide(): string {
  const ASPECTS = ['surface', 'radius', 'border', 'elevation'] as const;
  const lines: string[] = [];
  for (const [role, compId] of Object.entries(STYLE_ROLE_COMPONENT)) {
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

export function buildAssessmentBuildPrompt(args: {
  business: { name: string; summary: string };
}): { system: string; user: string } {
  const { business } = args;
  const styleGuide = buildStyleGuide();

  const system = `You design a SCORED self-assessment (a "scorecard" quiz) that prospective customers of "${business.name}" would take. Business context: ${business.summary}

The assessment must be genuinely relevant to this business's customers and help them realize they need what the business offers — but it is NOT an ad. Design the SCORING SPEC only. You do NOT write HTML, CSS, or JavaScript. You do NOT score any individual visitor — scoring is computed deterministically from the points you assign.

Produce a JSON object with this exact shape (no markdown, no code fences, first character "{"):
{
  "hero": { "title": "string — the assessment name", "subtitle": "string — one line" },
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
  "dimensions": [ { "id": "kebab-case-id", "label": "Human Axis Label" } ],   // 3 to 6 — these are the radar-chart axes
  "questions": [                                                              // 8 to 15 questions
    {
      "id": "kebab-case-id",
      "step": 1,                          // integer 1..3 — groups questions into wizard steps
      "label": "The question text",
      "type": "radio_cards",              // ALWAYS exactly "radio_cards"
      "dimension": "kebab-case-id",       // MUST equal one of dimensions[].id
      "options": [                        // 2 to 4 options
        { "value": "kebab-value", "label": "Short answer label", "points": 0 }
      ]
    }
  ],
  "scoring": {
    "max_score": 0,                       // MUST equal the SUM, over every question, of that question's HIGHEST option points
    "score_bands": [                      // contiguous integer buckets that TILE [0, max_score] with NO gaps and NO overlaps
      {
        "min": 0, "max": 0,               // inclusive; first band.min = 0; last band.max = max_score; each band.min = previous band.max + 1
        "label": "Band name",
        "color": "danger",                // one of: success | warning | danger | primary
        "interpretation_cards": [ { "title": "string", "body": "2-3 sentences for this band" } ]  // 1 to 3 cards
      }
    ]
  },
  "result": {
    "score_label": "string — e.g. Your readiness score",
    "score_subtitle": "string — one line under the badge",
    "recommendations": [ { "title": "string", "body": "1-2 sentences", "priority": "high" } ],   // 3 to 5; priority: high|medium|low
    "cta": { "headline": "string", "body": "string", "cta_label": "string — button label" }
  },
  "style": {                                // design-token picks per component (see STYLE section below)
    "questions":           { "radius": "..." },   // radio-cards answer buttons (collect side)
    "hero":                { "surface": "...", "radius": "...", "elevation": "..." },
    "interpretation_card": { "surface": "...", "elevation": "...", "radius": "...", "border": "..." },
    "recommendations":     { "border": "...", "radius": "...", "surface": "..." },
    "cta":                 { "surface": "...", "border": "...", "radius": "...", "elevation": "..." },
    "score_badge":         { "elevation": "..." }
  }
}

=== STYLE (design tokens) ===
Pick design tokens for the result components to compose a FINISHED, polished look for "${business.name}". For each component, choose ONE token per aspect you want to set; OMIT an aspect to keep its default. Choose ONLY from that component's allowed values:
${styleGuide}
Aim for a finished feel that matches "${business.name}"'s personality: frame the interpretation cards and the CTA as real cards (surface "card" or "raised-card") so content doesn't float; keep the hero readable (surface "plain", or a soft "tinted" band); give the score badge a subtle lift (elevation "sm"/"raised") if it suits the brand; nudge radius to feel on-brand (e.g. "lg" for a soft, premium feel).

HARD RULES (a violation makes the spec invalid and is rejected):
- "font_pairing" MUST be exactly one of: refined, festive, editorial, bold-poster, artisan, handcrafted, modern, strong. Pick the one that best matches the business's personality; if unsure, use "artisan".
- All "points" are NON-NEGATIVE INTEGERS. Higher points = healthier/more-ready answer.
- "max_score" MUST equal the sum of the maximum option points across ALL questions. Compute it carefully.
- "score_bands" MUST tile [0, max_score] exactly: sort by min; first.min = 0; last.max = max_score; every band.min = previous band.max + 1. No gaps, no overlaps.
- EVERY dimension in "dimensions" MUST be used by at least one question. Do not declare an axis you never score.
- EVERY question.dimension MUST be one of the declared dimension ids.
- 3 to 6 dimensions; 8 to 15 questions; every question has 2 to 4 options; every "type" is exactly "radio_cards".
- Spread questions across dimensions so each axis gets at least one question, and across steps 1..3 reasonably evenly.
- Every "style" token MUST be one of the allowed values listed for that component in the STYLE section above. Anything else is rejected. Omitting an aspect is fine (it keeps the default).`;

  const user = `Design the scored assessment for "${business.name}" now. Return JSON only, first character "{". Double-check that max_score equals the sum of the highest option points per question, and that the score bands tile [0, max_score] with no gaps.`;

  return { system, user };
}

// factory-v2 — Assessment §13 BUILD spec (the SCORING brain).
//
// Unlike Strategy's §13 (content the LLM writes per visitor), this is a
// SCORING SPEC the LLM produces ONCE at build time: questions with per-option
// points, scoring dimensions (radar axes), score bands → interpretation cards,
// and result recommendations/CTA. Runtime scoring is deterministic and runs
// CLIENT-SIDE — there is no per-visitor LLM call.
//
// Locks (approved 2026-06-01): radio_cards input only; dimensions 3–6; every
// dimension referenced by ≥1 question; bands contiguous + cover [0,max_score];
// max_score == Σ max(option.points); 8–15 questions; ≥2 options; integer
// points ≥ 0 (integers keep contiguous bands well-defined).

import { z } from 'zod';
import { isFontPairing, FONT_PAIRING_IDS } from './textos-style-layer';

const OptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  points: z.number().int().min(0),
});

const QuestionSchema = z.object({
  id: z.string().min(1),
  step: z.number().int().min(1).max(3),
  label: z.string().min(1),
  type: z.literal('radio_cards'), // radio_cards ONLY this build (star_rating/btn_check_radio = fast-follow)
  dimension: z.string().min(1),
  options: z.array(OptionSchema).min(2),
});

const DimensionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

const InterpretationCardSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

const BandSchema = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
  label: z.string().min(1),
  color: z.enum(['success', 'warning', 'danger', 'primary']),
  interpretation_cards: z.array(InterpretationCardSchema).min(1).max(3), // → card-basic ×N
});

const RecommendationSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(['high', 'medium', 'low']),
});

// Phase C — per-component design-token choices. Each aspect is an optional
// string; the resolver validates it against the component's capabilities
// .supported[] (throws if unsupported) and fills omissions with the default.
const TokenChoiceSchema = z
  .object({
    surface: z.string().optional(),
    radius: z.string().optional(),
    border: z.string().optional(),
    elevation: z.string().optional(),
    emphasis: z.string().optional(),
  })
  .partial();

const StyleChoicesSchema = z.object({
  questions: TokenChoiceSchema.optional(), // radio-cards (collect side)
  hero: TokenChoiceSchema.optional(),
  interpretation_card: TokenChoiceSchema.optional(),
  recommendations: TokenChoiceSchema.optional(),
  cta: TokenChoiceSchema.optional(),
  score_badge: TokenChoiceSchema.optional(),
});
export type StyleChoices = z.infer<typeof StyleChoicesSchema>;

export const AssessmentBuildSpecSchema = z.object({
  hero: z.object({ title: z.string().min(1), subtitle: z.string().min(1) }),
  // Phase C: the LLM's per-result-component token picks (validated against
  // each component's capabilities.supported[] by the resolver).
  style: StyleChoicesSchema,
  // TextOS style layer — the LLM picks ONE pairing from the closed set
  // (textos-style-layer.ts). Anything outside it fails validation (throw).
  font_pairing: z
    .string()
    .refine(isFontPairing, { message: `font_pairing must be one of: ${FONT_PAIRING_IDS.join(', ')}` }),
  dimensions: z.array(DimensionSchema).min(3).max(6), // radar needs ≥3 axes, caps at 6
  questions: z.array(QuestionSchema).min(8).max(15),
  scoring: z.object({
    max_score: z.number().int().min(1),
    score_bands: z.array(BandSchema).min(2),
  }),
  result: z.object({
    score_label: z.string().min(1),
    score_subtitle: z.string().min(1),
    recommendations: z.array(RecommendationSchema).min(3).max(5),
    cta: z.object({
      headline: z.string().min(1),
      body: z.string().min(1),
      cta_label: z.string().min(1),
    }),
  }),
});

export type AssessmentBuildSpec = z.infer<typeof AssessmentBuildSpecSchema>;

export class AssessmentSpecError extends Error {
  constructor(message: string) {
    super(`factory-v2 assessment spec: ${message}`);
    this.name = 'AssessmentSpecError';
  }
}

/**
 * Cross-field validation BEYOND the Zod shape. No-fallbacks: each rule throws
 * a clear, named error. Run after AssessmentBuildSpecSchema.parse().
 */
export function validateAssessmentSpec(spec: AssessmentBuildSpec): void {
  const dimIds = new Set(spec.dimensions.map((d) => d.id));

  // (i) every question.dimension must be a declared dimension.
  for (const q of spec.questions) {
    if (!dimIds.has(q.dimension)) {
      throw new AssessmentSpecError(
        `question "${q.id}" references dimension "${q.dimension}" which is not declared in dimensions[].`,
      );
    }
  }

  // (ii) every declared dimension must be referenced by ≥1 question (no orphan
  // axis that always scores 0).
  const referenced = new Set(spec.questions.map((q) => q.dimension));
  for (const d of spec.dimensions) {
    if (!referenced.has(d.id)) {
      throw new AssessmentSpecError(
        `dimension "${d.id}" (${d.label}) is orphaned — no question scores it, so its radar axis is always 0.`,
      );
    }
  }

  // max_score consistency: must equal Σ over questions of max(option.points).
  const computedMax = spec.questions.reduce(
    (sum, q) => sum + Math.max(...q.options.map((o) => o.points)),
    0,
  );
  if (spec.scoring.max_score !== computedMax) {
    throw new AssessmentSpecError(
      `scoring.max_score (${spec.scoring.max_score}) != Σ max(option.points) (${computedMax}).`,
    );
  }

  // bands contiguous + cover [0, max_score] with no gaps/overlaps.
  const bands = [...spec.scoring.score_bands].sort((a, b) => a.min - b.min);
  if (bands[0].min !== 0) {
    throw new AssessmentSpecError(`first score band must start at 0 (got ${bands[0].min}).`);
  }
  if (bands[bands.length - 1].max !== computedMax) {
    throw new AssessmentSpecError(
      `last score band must end at max_score ${computedMax} (got ${bands[bands.length - 1].max}).`,
    );
  }
  for (const b of bands) {
    if (b.min > b.max) {
      throw new AssessmentSpecError(`band "${b.label}" has min ${b.min} > max ${b.max}.`);
    }
  }
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].min !== bands[i - 1].max + 1) {
      throw new AssessmentSpecError(
        `score bands are not contiguous between "${bands[i - 1].label}" (max ${bands[i - 1].max}) and ` +
          `"${bands[i].label}" (min ${bands[i].min}) — expected min ${bands[i - 1].max + 1}.`,
      );
    }
  }
}

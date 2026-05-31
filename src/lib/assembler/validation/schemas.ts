// Per-archetype Zod schemas. Hand-authored in parallel to the
// content_schema descriptions in src/lib/archetypes/* — the descriptions
// are LLM-facing prompt scaffolding; these schemas are runtime guards.
//
// Maintainability note: when an archetype's content_schema changes, the
// corresponding Zod schema in this file must change too. The end-to-end
// smoke test (assembler.test.ts) catches drift.

import { z } from 'zod';

// ── Shared shapes ────────────────────────────────────────────────────

const HeroSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
}).passthrough();

const PaywallCopySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  cta_label: z.string().min(1),
  email_label: z.string().optional(),
  footer: z.string().optional(),
}).passthrough();

const CtaSchema = z.object({
  headline: z.string().min(1),
  body: z.string().min(1),
  cta_label: z.string().min(1),
  cta_url_placeholder: z.string().min(1),
}).passthrough();

// ── Strategy (§13-aligned, build-time) ───────────────────────────────
// STYLE_GUIDE §13 is the locked contract. This is the BUILD-TIME schema:
// questions + a result DIRECTIVE (section_plan) + the conversion cta.
// The result BODIES are generated at runtime from the visitor's answers
// (StrategyResultSchema below), not baked here. No-fallbacks: every
// required field must be present or validation throws — no defaults.

const StrategyOptionSchema = z.object({
  label: z.string().min(1),                 // §13: option label (was `title`)
  value: z.string().min(1),
  icon: z.string().min(1),                  // §4 requires a Tabler icon per option
  description: z.string().optional(),        // §13 (was `desc`)
}).passthrough();

const StrategyQuestionSchema = z.object({
  id: z.string().min(1),
  step: z.union([z.number(), z.enum(['1', '2', '3'])]),
  text: z.string().min(1),                  // §13: question text (was `label`)
  placeholder: z.string().optional(),
  type: z.enum(['text', 'textarea', 'radio']),  // §13 vocab (was `radio_cards`)
  required: z.boolean(),
  rows: z.number().optional(),
  options: z.array(StrategyOptionSchema).optional(),
}).passthrough();

// Build-time directive: heading + what the runtime result should analyze
// for this section. The runtime fills the body from the visitor's answers.
const StrategySectionPlanSchema = z.object({
  heading: z.string().min(1),
  directive: z.string().min(1),
}).passthrough();

// §13 cta: two explicit actions (primary + secondary). Build-time.
const StrategyCtaSchema = z.object({
  primary_text: z.string().min(1),
  primary_action: z.string().min(1),
  secondary_text: z.string().min(1),
  secondary_action: z.string().min(1),
}).passthrough();

export const StrategyContentSchema = z.object({
  app_title: z.string().min(1),             // §13 (was hero.title)
  app_tagline: z.string().min(1),           // §13 (was hero.subtitle)
  hero_icon: z.string().min(1),             // §13: Tabler slug (was emoji)
  image_prompt: z.string().min(1),          // §13: stored now; fal.ai wires in 3b
  submit_button_text: z.string().min(1),    // §13
  questions: z.array(StrategyQuestionSchema).min(1),
  // Gate copy CONTAINER (Item 2): ratified shape, contents deferred —
  // gates default 'free', so nothing is emitted/required this increment.
  paywall: PaywallCopySchema.optional(),
  result: z.object({
    section_plan: z.array(StrategySectionPlanSchema).min(1),
    cta: StrategyCtaSchema,
  }).passthrough(),
}).passthrough();

// ── Strategy runtime result (generated FROM the visitor's answers) ────
// Emitted by the runtime endpoint, not the build step. No-fallbacks.
export const StrategyResultSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  sections: z.array(z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
  }).passthrough()).min(1),
}).passthrough();

// ── Assessment ───────────────────────────────────────────────────────

const ScoreBandSchema = z.object({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  label: z.string().min(1),
  interpretation: z.string().min(1),
  color: z.enum(['success', 'warning', 'danger', 'primary']),
}).passthrough();

const AssessmentDimensionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
}).passthrough();

const AssessmentOptionSchema = z.object({
  value: z.string().min(1),
  title: z.string().optional(),
  points: z.number().nonnegative(),
}).passthrough();

const AssessmentQuestionSchema = z.object({
  id: z.string().min(1),
  step: z.union([z.number(), z.enum(['1', '2', '3'])]),
  label: z.string().min(1),
  type: z.enum(['radio_cards', 'star_rating', 'btn_check_radio']),
  required: z.boolean(),
  dimension: z.string().min(1),
  options: z.array(AssessmentOptionSchema).min(2),
}).passthrough();

const AssessmentRecommendationSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(['high', 'medium', 'low']),
}).passthrough();

export const AssessmentContentSchema = z.object({
  hero: HeroSchema,
  questions: z.array(AssessmentQuestionSchema).min(1),
  scoring: z.object({
    max_score: z.number().int().positive(),
    score_bands: z.array(ScoreBandSchema).min(1),
    dimensions: z.array(AssessmentDimensionSchema).min(1).max(6),
  }).passthrough(),
  paywall: PaywallCopySchema,
  result: z.object({
    score_label: z.string().min(1),
    score_subtitle: z.string().min(1),
    recommendations: z.array(AssessmentRecommendationSchema).min(1),
    cta: CtaSchema,
  }).passthrough(),
}).passthrough();

// ── Calculator ───────────────────────────────────────────────────────

const CalcInputSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
    message: 'input id must be a valid JS identifier (used in expressions)',
  }),
  label: z.string().min(1),
  type: z.enum(['number', 'range', 'select', 'stepper']),
  default_value: z.union([z.number(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  }).passthrough()).optional(),
}).passthrough();

const CalcCalculationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  expression: z.string().min(1),
  format: z.enum(['number', 'currency', 'percent']),
}).passthrough();

const CalcPreviewSchema = z.object({
  expression: z.string().min(1),
  format: z.enum(['number', 'currency', 'percent']),
  label: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
}).passthrough();

const CalcChartSchema = z.object({
  type: z.enum(['bar', 'doughnut']),
  title: z.string().min(1),
  data_source: z.enum(['calculations', 'inputs']),
  label_path: z.string().min(1),
  value_path: z.string().min(1),
}).passthrough();

const CalcBigNumberSchema = z.object({
  calculation_id: z.string().min(1),
  label: z.string().min(1),
  sublabel: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
}).passthrough();

export const CalculatorContentSchema = z.object({
  hero: HeroSchema,
  inputs: z.array(CalcInputSchema).min(1),
  preview: CalcPreviewSchema,
  calculations: z.array(CalcCalculationSchema).min(1),
  paywall: PaywallCopySchema,
  result: z.object({
    big_number: CalcBigNumberSchema,
    chart: CalcChartSchema,
    analysis_sections: z.array(z.object({
      heading: z.string().min(1),
      body: z.string().min(1),
    }).passthrough()).min(1),
    summary: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
    }).passthrough().optional(),
    cta: CtaSchema,
  }).passthrough(),
}).passthrough();

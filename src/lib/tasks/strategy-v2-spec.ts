// §13 LLM data contract for the strategy archetype (STYLE_GUIDE.md V1).
//
// This is the shape the v2 design-step LLM emits. It is DISTINCT from the
// internal StrategyContentSchema (schemas.ts) that the recipe-driven
// assembler consumes: the v2 handler validates the LLM output against THIS
// schema (no-fallbacks — missing required field halts the build), then maps
// it into the internal assembler content + carries the new visual fields
// (hero_icon, rich options, submit_button_text, result sections/cta,
// hero_image_url from fal.ai).
//
// Strategy-only. Assessment + calculator remain on their existing schemas.

import { z } from 'zod';

// Each multiple-choice option (§4 / §13). label + value required; icon +
// description optional (description encouraged, icon is a Tabler slug).
const StrategyV2OptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

// One question per step (§3). `radio` carries options[]; `text`/`textarea`
// carry an optional placeholder. No `step` field — the assembler creates one
// wizard step per question, in array order.
const StrategyV2QuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['radio', 'text', 'textarea']),
  text: z.string().min(1),
  placeholder: z.string().optional(),
  options: z.array(StrategyV2OptionSchema).optional(),
}).passthrough().superRefine((q, ctx) => {
  // radio questions must carry options; text/textarea must not need them.
  if (q.type === 'radio' && (!q.options || q.options.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `radio question "${q.id}" must include a non-empty options[] array`,
      path: ['options'],
    });
  }
});

const StrategyV2ResultSectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
}).passthrough();

const StrategyV2CtaSchema = z.object({
  primary_text: z.string().min(1),
  primary_action: z.string().min(1),
  secondary_text: z.string().min(1),
  secondary_action: z.string().min(1),
}).passthrough();

const StrategyV2ResultSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  sections: z.array(StrategyV2ResultSectionSchema).min(1),
  cta: StrategyV2CtaSchema,
}).passthrough();

// Full §13 composition spec. Every listed field is required (no-fallbacks);
// `app_type`, `placeholder`s, option `icon`/`description` are the only
// optionals. `image_prompt` drives the build-time fal.ai hero image.
export const StrategyV2SpecSchema = z.object({
  app_type: z.string().optional(),
  app_title: z.string().min(1),
  app_tagline: z.string().min(1),
  hero_icon: z.string().min(1),
  image_prompt: z.string().min(1),
  questions: z.array(StrategyV2QuestionSchema).min(1),
  submit_button_text: z.string().min(1),
  result: StrategyV2ResultSchema,
}).passthrough();

export type StrategyV2Spec = z.infer<typeof StrategyV2SpecSchema>;
export type StrategyV2Question = z.infer<typeof StrategyV2QuestionSchema>;
export type StrategyV2Option = z.infer<typeof StrategyV2OptionSchema>;

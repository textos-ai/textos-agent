// factory-v2 — Zod schema for LLM-produced Strategy RESULT content.
//
// CONTENT ONLY. This schema describes the fields the LLM returns — NO
// component ids, NO HTML, NO layout. The locked component recipe
// (strategy-result-recipe.ts) decides which catalog components render and
// maps these content fields onto their slots.

import { z } from 'zod';

export const StrategyLiveContentSchema = z.object({
  headline: z.string().min(1),
  tagline: z.string().min(1),
  // One result section per entry → one card-basic each (assembler composes).
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .min(1),
  // Concrete next actions → list-group items.
  action_items: z.array(z.string().min(1)).min(1),
  // Conversion CTA copy → card-cta.
  cta: z.object({
    headline: z.string().min(1),
    body: z.string().min(1),
    cta_label: z.string().min(1),
  }),
});

export type StrategyLiveContent = z.infer<typeof StrategyLiveContentSchema>;

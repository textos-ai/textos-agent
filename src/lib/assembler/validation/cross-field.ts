// Cross-field validation rules that Zod can't express on its own.
// Each function returns a list of human-readable violations.

import { validateScoreBands, maxReachableScore } from '../scoring';
import { sanitizeExpression } from '../expression-sanitizer';
import { ExpressionSanitizerError } from '../types';

// ── Strategy ─────────────────────────────────────────────────────────
// Strategy has no cross-field rules — every reference is contained
// within its own object. Question.step is a free-form 1|2|3 marker;
// the assembler groups by it but doesn't require coverage of any
// specific step set.

export function validateStrategyCrossFields(_content: unknown): string[] {
  return [];
}

// ── Assessment ───────────────────────────────────────────────────────

interface AssessmentForCrossField {
  questions: Array<{
    id: string;
    dimension: string;
    options: Array<{ value: string; points: number }>;
  }>;
  scoring: {
    max_score: number;
    score_bands: Array<{ min: number; max: number; label: string; interpretation: string; color: string }>;
    dimensions: Array<{ id: string; label: string }>;
  };
}

export function validateAssessmentCrossFields(content: AssessmentForCrossField): string[] {
  const errors: string[] = [];

  // 1. Every question.dimension references a real scoring.dimensions[].id.
  const dimIds = new Set(content.scoring.dimensions.map((d) => d.id));
  for (const q of content.questions) {
    if (!dimIds.has(q.dimension)) {
      errors.push(
        `question "${q.id}" references dimension "${q.dimension}" not in scoring.dimensions (have: ${[...dimIds].join(', ')})`,
      );
    }
  }

  // 2. score_bands cover [0, max_score] without gaps.
  const bandErrors = validateScoreBands(content.scoring as any);
  errors.push(...bandErrors);

  // 3. max_score matches max reachable (warn if too low; error if higher than possible).
  const maxReach = maxReachableScore(content as any);
  if (maxReach > content.scoring.max_score) {
    errors.push(
      `scoring.max_score (${content.scoring.max_score}) is lower than the maximum reachable sum (${maxReach}) across all questions' top options`,
    );
  }

  // 4. Every question.options[].points is ≥ 0 (Zod already enforces this,
  //    but we re-check here for parity with the brief.)
  for (const q of content.questions) {
    for (const o of q.options) {
      if (Number(o.points) < 0) {
        errors.push(`question "${q.id}" option "${o.value}" has negative points`);
      }
    }
  }

  return errors;
}

// ── Calculator ───────────────────────────────────────────────────────

interface CalculatorForCrossField {
  inputs: Array<{ id: string }>;
  preview: { expression: string };
  calculations: Array<{ id: string; expression: string }>;
  result: {
    big_number: { calculation_id: string };
    chart: { data_source: 'calculations' | 'inputs'; label_path: string; value_path: string };
  };
}

export function validateCalculatorCrossFields(content: CalculatorForCrossField): string[] {
  const errors: string[] = [];
  const inputIds = new Set(content.inputs.map((i) => i.id));

  // 1. preview.expression sanitizes with the declared input ids.
  try {
    sanitizeExpression(content.preview.expression, inputIds);
  } catch (e) {
    errors.push(`preview.expression: ${(e as ExpressionSanitizerError).reason ?? (e as Error).message}`);
  }

  // 2. Every calculations[].expression sanitizes.
  for (const c of content.calculations) {
    try {
      sanitizeExpression(c.expression, inputIds);
    } catch (e) {
      errors.push(`calculations[id="${c.id}"]: ${(e as ExpressionSanitizerError).reason ?? (e as Error).message}`);
    }
  }

  // 3. big_number.calculation_id references a real calculations[].id.
  const calcIds = new Set(content.calculations.map((c) => c.id));
  if (!calcIds.has(content.result.big_number.calculation_id)) {
    errors.push(
      `result.big_number.calculation_id "${content.result.big_number.calculation_id}" not found in calculations (have: ${[...calcIds].join(', ')})`,
    );
  }

  // 4. chart.data_source values are constrained by Zod; no extra check.

  return errors;
}

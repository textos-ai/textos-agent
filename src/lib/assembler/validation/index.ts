// Content validation entry point. Picks the per-archetype Zod schema,
// runs it, then runs cross-field validators. Returns the parsed content
// (typed as unknown — callers narrow per archetype) or throws a
// ContentValidationError.

import type { ArchetypeId } from '../../archetypes/index';
import { ContentValidationError } from '../types';
import { StrategyContentSchema, AssessmentContentSchema, CalculatorContentSchema } from './schemas';
import {
  validateStrategyCrossFields,
  validateAssessmentCrossFields,
  validateCalculatorCrossFields,
} from './cross-field';

const SCHEMAS = {
  strategy: StrategyContentSchema,
  assessment: AssessmentContentSchema,
  calculator: CalculatorContentSchema,
} as const;

const CROSS = {
  strategy: validateStrategyCrossFields,
  assessment: validateAssessmentCrossFields,
  calculator: validateCalculatorCrossFields,
} as const;

export interface ValidationResult {
  content: unknown;
  warnings: Array<{ severity: 'warning' | 'info'; location: string; message: string }>;
}

export function validateContent(
  archetype_id: ArchetypeId,
  raw: unknown,
): ValidationResult {
  const schema = SCHEMAS[archetype_id];
  if (!schema) {
    throw new ContentValidationError(
      'archetype_id',
      'one of strategy|assessment|calculator',
      archetype_id,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ContentValidationError(
      first.path.join('.'),
      first.code === 'invalid_type' ? (first as any).expected : first.message,
      receivedSnippet(raw, first.path),
      first.message,
    );
  }
  const crossErrors = CROSS[archetype_id](parsed.data as any);
  if (crossErrors.length > 0) {
    throw new ContentValidationError(
      'cross-field',
      'all cross-field invariants hold',
      crossErrors,
      crossErrors[0],
    );
  }

  // Surface unknown top-level keys as info warnings (LLMs sometimes add
  // extra context fields). Zod's `.passthrough()` keeps them, so we just
  // compare against the schema's known top-level keys.
  const warnings: ValidationResult['warnings'] = [];
  const knownTop = new Set(Object.keys((schema as any)._def.shape()));
  if (parsed.data && typeof parsed.data === 'object') {
    for (const k of Object.keys(parsed.data as Record<string, unknown>)) {
      if (!knownTop.has(k)) {
        warnings.push({
          severity: 'info',
          location: k,
          message: `unknown top-level field "${k}" — preserved but not used by the assembler`,
        });
      }
    }
  }

  return { content: parsed.data, warnings };
}

function receivedSnippet(raw: unknown, path: (string | number)[]): unknown {
  let cursor: any = raw;
  for (const seg of path) {
    if (cursor == null) return undefined;
    cursor = cursor[seg as any];
  }
  if (cursor == null) return cursor;
  if (typeof cursor === 'string') return cursor.slice(0, 80);
  if (Array.isArray(cursor)) return `[array length=${cursor.length}]`;
  if (typeof cursor === 'object') return '[object]';
  return cursor;
}

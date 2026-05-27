import { describe, it, expect } from 'vitest';
import { validateContent } from '../validation/index';
import { ContentValidationError } from '../types';
import { STRATEGY_CONTENT } from '../fixtures/strategy.fixture';
import { ASSESSMENT_CONTENT } from '../fixtures/assessment.fixture';
import { CALCULATOR_CONTENT } from '../fixtures/calculator.fixture';

describe('validateContent — strategy', () => {
  it('accepts the fixture', () => {
    const r = validateContent('strategy', STRATEGY_CONTENT);
    expect(r.content).toBeDefined();
  });
  it('rejects missing hero.title', () => {
    const bad = { ...STRATEGY_CONTENT, hero: { subtitle: 'x' } };
    expect(() => validateContent('strategy', bad)).toThrowError(ContentValidationError);
  });
  it('rejects wrong type', () => {
    const bad = { ...STRATEGY_CONTENT, questions: 'not an array' };
    expect(() => validateContent('strategy', bad)).toThrowError(ContentValidationError);
  });
});

describe('validateContent — assessment', () => {
  it('accepts the fixture', () => {
    const r = validateContent('assessment', ASSESSMENT_CONTENT);
    expect(r.content).toBeDefined();
  });

  it('rejects a question dimension that doesn\'t match scoring.dimensions', () => {
    const bad = JSON.parse(JSON.stringify(ASSESSMENT_CONTENT));
    bad.questions[0].dimension = 'made-up-dimension';
    expect(() => validateContent('assessment', bad)).toThrowError(ContentValidationError);
  });

  it('rejects score_bands with a gap', () => {
    const bad = JSON.parse(JSON.stringify(ASSESSMENT_CONTENT));
    bad.scoring.score_bands[0].max = 5; // creates gap 6..6
    bad.scoring.score_bands[1].min = 7;
    expect(() => validateContent('assessment', bad)).toThrowError(/gap|cross-field/);
  });

  it('rejects max_score lower than reachable', () => {
    const bad = JSON.parse(JSON.stringify(ASSESSMENT_CONTENT));
    bad.scoring.max_score = 10; // fixture reaches 18
    expect(() => validateContent('assessment', bad)).toThrow();
  });

  it('rejects negative points (Zod-level)', () => {
    const bad = JSON.parse(JSON.stringify(ASSESSMENT_CONTENT));
    bad.questions[0].options[0].points = -1;
    expect(() => validateContent('assessment', bad)).toThrow();
  });
});

describe('validateContent — calculator', () => {
  it('accepts the fixture', () => {
    const r = validateContent('calculator', CALCULATOR_CONTENT);
    expect(r.content).toBeDefined();
  });

  it('rejects an expression referencing an undeclared input', () => {
    const bad = JSON.parse(JSON.stringify(CALCULATOR_CONTENT));
    bad.calculations[0].expression = 'phantom_input * 2';
    expect(() => validateContent('calculator', bad)).toThrow();
  });

  it('rejects an expression containing window access', () => {
    const bad = JSON.parse(JSON.stringify(CALCULATOR_CONTENT));
    bad.preview.expression = 'window.location.href';
    expect(() => validateContent('calculator', bad)).toThrow();
  });

  it('rejects big_number.calculation_id with no matching calculation', () => {
    const bad = JSON.parse(JSON.stringify(CALCULATOR_CONTENT));
    bad.result.big_number.calculation_id = 'does_not_exist';
    expect(() => validateContent('calculator', bad)).toThrow();
  });
});

describe('validateContent — unknown fields', () => {
  it('surfaces unknown top-level fields as info warnings, not errors', () => {
    const extra = { ...STRATEGY_CONTENT, _llm_diagnostic: 'extra context' };
    const r = validateContent('strategy', extra as any);
    expect(r.warnings.some((w) => w.location === '_llm_diagnostic')).toBe(true);
  });
});

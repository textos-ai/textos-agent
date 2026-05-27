import { describe, it, expect } from 'vitest';
import { evalCalculatorExpression, runCalculator, validateCalculatorContent } from '../calculation';
import { CALCULATOR_CONTENT } from '../fixtures/calculator.fixture';
import { ExpressionSanitizerError } from '../types';

describe('evalCalculatorExpression', () => {
  it('evaluates arithmetic with input bindings', () => {
    const r = evalCalculatorExpression(
      'hourly_rate * hours_per_week * weeks_per_year',
      { hourly_rate: 100, hours_per_week: 25, weeks_per_year: 48 },
    );
    expect(r).toBe(100 * 25 * 48);
  });
  it('evaluates ternary', () => {
    const r = evalCalculatorExpression(
      'tax_rate > 0 ? salary * (1 - tax_rate / 100) : salary',
      { salary: 100000, tax_rate: 25 },
    );
    expect(r).toBe(75000);
  });
});

describe('runCalculator — fixture', () => {
  it('produces expected take-home', () => {
    const r = runCalculator(CALCULATOR_CONTENT as any, {
      hourly_rate: 100, hours_per_week: 25, weeks_per_year: 48, tax_rate: 25,
    });
    // gross = 100*25*48 = 120,000; take_home = 120,000 * 0.75 = 90,000
    expect(r.calculations_raw.take_home).toBe(90000);
    expect(r.big_number_value).toBe('$90,000');
    expect(r.calculations.gross_annual).toBe('$120,000');
  });

  it('builds bar-chart data from calculations', () => {
    const r = runCalculator(CALCULATOR_CONTENT as any, {
      hourly_rate: 100, hours_per_week: 25, weeks_per_year: 48, tax_rate: 25,
    });
    expect(r.chart_data.labels).toEqual([
      'Gross annual revenue', 'Estimated taxes', 'Annual take-home', 'Effective hourly',
    ]);
    expect(r.chart_data.values[0]).toBe(120000);
  });
});

describe('validateCalculatorContent', () => {
  it('passes the fixture', () => {
    expect(() => validateCalculatorContent(CALCULATOR_CONTENT as any)).not.toThrow();
  });

  it('rejects expression that references a non-existent input id', () => {
    const broken = {
      ...CALCULATOR_CONTENT,
      preview: { ...CALCULATOR_CONTENT.preview, expression: 'undeclared_var * 2' },
    };
    expect(() => validateCalculatorContent(broken as any)).toThrowError(ExpressionSanitizerError);
  });

  it('rejects when big_number.calculation_id does not match any calculation', () => {
    const broken = {
      ...CALCULATOR_CONTENT,
      result: {
        ...CALCULATOR_CONTENT.result,
        big_number: { ...CALCULATOR_CONTENT.result.big_number, calculation_id: 'does_not_exist' },
      },
    };
    expect(() => validateCalculatorContent(broken as any)).toThrow();
  });
});

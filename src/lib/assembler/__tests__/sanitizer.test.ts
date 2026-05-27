import { describe, it, expect } from 'vitest';
import { sanitizeExpression } from '../expression-sanitizer';
import { ExpressionSanitizerError } from '../types';

const IDS = new Set(['hourly_rate', 'hours_per_week', 'weeks_per_year', 'tax_rate', 'salary']);

describe('sanitizeExpression — accepts', () => {
  it.each([
    'hourly_rate',
    'hourly_rate * hours_per_week',
    '(hourly_rate + 5) * 1.05',
    'hourly_rate * hours_per_week * weeks_per_year * (1 - tax_rate / 100)',
    'Math.max(hourly_rate, 50)',
    'Math.min(Math.max(hourly_rate, 50), 200)',
    'Math.round(salary / 12)',
    'Math.sqrt(hourly_rate * hours_per_week)',
    'Math.pow(1.05, weeks_per_year / 52)',
    'tax_rate > 0 ? salary * (1 - tax_rate / 100) : salary',
    '(salary > 100000) && (tax_rate < 30) ? salary : 0',
    'salary + -100',
  ])('accepts: %s', (expr) => {
    expect(() => sanitizeExpression(expr, IDS)).not.toThrow();
  });
});

describe('sanitizeExpression — rejects', () => {
  it('rejects unknown identifier', () => {
    expect(() => sanitizeExpression('fetch_data * 2', IDS)).toThrowError(ExpressionSanitizerError);
  });
  it('rejects window access', () => {
    expect(() => sanitizeExpression('window.location', IDS)).toThrowError(/window/);
  });
  it('rejects document access', () => {
    expect(() => sanitizeExpression('document.cookie', IDS)).toThrowError(/document/);
  });
  it('rejects fetch', () => {
    expect(() => sanitizeExpression('fetch("/api")', IDS)).toThrow();
  });
  it('rejects template literal', () => {
    expect(() => sanitizeExpression('`${salary}`', IDS)).toThrow();
  });
  it('rejects assignment', () => {
    expect(() => sanitizeExpression('salary = 0', IDS)).toThrow();
  });
  it('rejects property access beyond Math whitelist', () => {
    expect(() => sanitizeExpression('Math.sin(salary)', IDS)).toThrow();
  });
  it('rejects nested Math access (Math.PI etc.)', () => {
    // Math.PI is a property, not a method. The whitelist is methods-only.
    expect(() => sanitizeExpression('salary + Math.PI', IDS)).toThrow();
  });
  it('rejects computed property access', () => {
    expect(() => sanitizeExpression('Math["min"](salary, 0)', IDS)).toThrow();
  });
  it('rejects regex literal', () => {
    // /salary/.test(...) — regex literals parse as RegExp under acorn.
    expect(() => sanitizeExpression('/x/.test(salary)', IDS)).toThrow();
  });
  it('rejects comment', () => {
    expect(() => sanitizeExpression('salary /* comment */ * 2', IDS)).toThrow();
  });
  it('rejects semicolon (multi-statement)', () => {
    expect(() => sanitizeExpression('salary; fetch("/")', IDS)).toThrow();
  });
  it('rejects empty expression', () => {
    expect(() => sanitizeExpression('', IDS)).toThrow();
  });
  it('rejects spread', () => {
    expect(() => sanitizeExpression('Math.max(...[1, 2])', IDS)).toThrow();
  });
  it('rejects array literal', () => {
    expect(() => sanitizeExpression('[salary][0]', IDS)).toThrow();
  });
});

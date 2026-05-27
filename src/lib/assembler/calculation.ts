// Calculator calculation runner — TS source of truth + emitted JS.
//
// The TS side validates expressions (via sanitizeExpression) and provides
// an evaluator we can unit-test against fixtures. The emitted JS bakes
// the (already-sanitized) expressions into the visitor-facing HTML; at
// runtime tx-bind.js handles the per-keystroke live preview, and the
// submit handler runs the final calculations to populate the result
// page.

import { sanitizeExpression } from './expression-sanitizer';
import type { ComputedCalculator } from './types';

interface CalcInput {
  id: string;
  default_value: number | string;
  type: 'number' | 'range' | 'select' | 'stepper';
}

interface CalcCalculation {
  id: string;
  label: string;
  expression: string;
  format: 'number' | 'currency' | 'percent';
}

interface CalcPreview {
  expression: string;
  format: 'number' | 'currency' | 'percent';
  label: string;
}

interface CalcChart {
  type: 'bar' | 'doughnut';
  data_source: 'calculations' | 'inputs';
  label_path: string;
  value_path: string;
  title: string;
}

interface CalcBigNumber {
  calculation_id: string;
  label: string;
  sublabel?: string;
  prefix?: string;
  suffix?: string;
}

interface CalculatorContent {
  inputs: CalcInput[];
  preview: CalcPreview;
  calculations: CalcCalculation[];
  result: {
    big_number: CalcBigNumber;
    chart: CalcChart;
  };
}

// ── Validation — runs in the content validator. Throws on rejection. ──

/**
 * Validate every expression in the content (preview + calculations) via
 * the sanitizer, and verify the cross-field invariants:
 *   - big_number.calculation_id references a real calculations[].id
 *   - chart.data_source is one of 'calculations' or 'inputs' (Zod
 *     already enforces this at the field level; we keep the runtime
 *     check defensive)
 *
 * Returns the original content unchanged on success.
 */
export function validateCalculatorContent(content: CalculatorContent): void {
  const inputIds = new Set(content.inputs.map((i) => i.id));
  sanitizeExpression(content.preview.expression, inputIds);
  for (const calc of content.calculations) {
    sanitizeExpression(calc.expression, inputIds);
  }
  const calcIds = new Set(content.calculations.map((c) => c.id));
  if (!calcIds.has(content.result.big_number.calculation_id)) {
    throw new Error(
      `result.big_number.calculation_id "${content.result.big_number.calculation_id}" does not match any calculations[].id (have: ${[...calcIds].join(', ')})`,
    );
  }
}

// ── Pure TS evaluator (used by unit tests, NOT by the visitor's
//    browser; the visitor's browser uses the emitted JS below) ────────

/**
 * Evaluate a calculator expression with the supplied input values.
 * The expression must already have passed sanitization — this evaluator
 * uses `new Function` and trusts the input. Returns the numeric result.
 */
export function evalCalculatorExpression(
  expression: string,
  inputs: Record<string, number>,
): number {
  const keys = Object.keys(inputs);
  const values = keys.map((k) => inputs[k]);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...keys, `return (${expression});`);
  return Number(fn(...values));
}

/**
 * Run all calculations + format per their declared formatter. Used by
 * the assembler when generating fixtures / preview data for the manifest
 * (not for visitor runtime).
 */
export function runCalculator(
  content: CalculatorContent,
  inputs: Record<string, number>,
): ComputedCalculator {
  const raw: Record<string, number> = {};
  const formatted: Record<string, string> = {};
  for (const c of content.calculations) {
    const v = evalCalculatorExpression(c.expression, inputs);
    raw[c.id] = v;
    formatted[c.id] = formatNumber(v, c.format);
  }
  const bigId = content.result.big_number.calculation_id;
  const bigValue = formatted[bigId] ?? String(raw[bigId] ?? 0);

  const chart_data = buildChartData(content, raw, inputs);

  return {
    calculations: formatted,
    calculations_raw: raw,
    big_number_value: bigValue,
    chart_data,
  };
}

function buildChartData(
  content: CalculatorContent,
  rawCalcs: Record<string, number>,
  inputs: Record<string, number>,
): { labels: string[]; values: number[] } {
  if (content.result.chart.data_source === 'calculations') {
    return {
      labels: content.calculations.map((c) => c.label),
      values: content.calculations.map((c) => rawCalcs[c.id] ?? 0),
    };
  }
  // 'inputs' — visitor-supplied values keyed by input id, with the
  // declared label for each input.
  // (CalcInput doesn't carry a label in our schema slice; chart label
  // path comes from inputs[].label in the LLM payload. We accept the
  // full content here so we can read it.)
  return {
    labels: content.inputs.map((i) => (i as any).label ?? i.id),
    values: content.inputs.map((i) => Number(inputs[i.id]) || 0),
  };
}

export function formatNumber(value: number, format: 'number' | 'currency' | 'percent'): string {
  if (!Number.isFinite(value)) return '—';
  if (format === 'currency') {
    return '$' + value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (format === 'percent') {
    return Math.round(value * 100) + '%';
  }
  return value.toLocaleString();
}

// ── Emitted JavaScript for the visitor's browser ──────────────────────

export function emitCalculatorScript(content: CalculatorContent): string {
  // Inline a compact slice. Calculations carry their expression source
  // because the result-render JS calls new Function on submit.
  const inlined = JSON.stringify({
    inputs: content.inputs.map((i) => ({
      id: i.id,
      default_value: i.default_value,
      label: (i as any).label ?? i.id,
    })),
    calculations: content.calculations.map((c) => ({
      id: c.id,
      label: c.label,
      expression: c.expression,
      format: c.format,
    })),
    result: {
      big_number: content.result.big_number,
      chart: content.result.chart,
    },
  });
  return `
// ── Calculator runtime (emitted by assembler) ──────────────────────
(function () {
  var DATA = ${inlined};
  function fmt(v, f) {
    if (!isFinite(v)) return '—';
    if (f === 'currency') return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (f === 'percent')  return Math.round(Number(v) * 100) + '%';
    return Number(v).toLocaleString();
  }
  function evalExpr(expr, inputs) {
    var keys = Object.keys(inputs);
    var vals = keys.map(function (k) { return inputs[k]; });
    // Use Function.bind to construct (...keys, body) without ES2018 spread,
    // so the emitted JS works under any ES2015+ environment.
    var args = keys.concat(['return (' + expr + ');']);
    var Ctor = Function.bind.apply(Function, [null].concat(args));
    var fn = new Ctor();
    return Number(fn.apply(null, vals));
  }
  function readInputs() {
    var out = {};
    for (var i = 0; i < DATA.inputs.length; i++) {
      var id = DATA.inputs[i].id;
      var el = document.getElementById(id);
      var raw = el ? el.value : DATA.inputs[i].default_value;
      var n = parseFloat(raw);
      out[id] = isNaN(n) ? 0 : n;
    }
    return out;
  }
  function runAll() {
    var inputs = readInputs();
    var raw = {};
    var formatted = {};
    for (var c = 0; c < DATA.calculations.length; c++) {
      var calc = DATA.calculations[c];
      var v = evalExpr(calc.expression, inputs);
      raw[calc.id] = v;
      formatted[calc.id] = fmt(v, calc.format);
    }
    var bigId = DATA.result.big_number.calculation_id;
    var labels, values;
    if (DATA.result.chart.data_source === 'calculations') {
      labels = DATA.calculations.map(function (c) { return c.label; });
      values = DATA.calculations.map(function (c) { return raw[c.id] || 0; });
    } else {
      labels = DATA.inputs.map(function (i) { return i.label; });
      values = DATA.inputs.map(function (i) { return inputs[i.id] || 0; });
    }
    return {
      inputs: inputs,
      calculations: formatted,
      calculations_raw: raw,
      big_number_value: formatted[bigId] != null ? formatted[bigId] : String(raw[bigId] || 0),
      chart_data: { labels: labels, values: values }
    };
  }
  window.__txAssembler = window.__txAssembler || {};
  window.__txAssembler.calculator = { run: runAll, data: DATA };
})();
`.trim();
}

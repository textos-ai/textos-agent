// factory-v2 — Calculator §BUILD spec (the FORMULA brain).
//
// Like Assessment's scoring spec, the LLM produces this ONCE at build time:
// numeric inputs, named arithmetic computations over those inputs, a headline
// computed value, one breakdown chart, optional interpretation bands, intro,
// recommendations, CTA. Runtime compute is deterministic + CLIENT-SIDE (tx-bind
// live preview + an inline snapshot on submit). There is NO result endpoint.
//
// SECURITY (no-fallbacks): each `expression` is LLM-generated and is evaluated
// client-side via `new Function()` (by tx-bind for the live headline and by the
// recipe's inline snapshot for the chart). It is sandboxed in the iframe, but we
// ALSO sanitize agent-side BEFORE storing — WHITELIST ONLY: input ids + numeric
// literals + arithmetic (+ - * / %) + parens + the whitelisted Math fns
// (min/max/round/floor/ceil/abs). ANY other identifier, property access,
// function call, template literal, or statement-level construct → THROW. We err
// maximally conservative: anything not provably safe is rejected.

import { z } from 'zod';
import { isFontPairing, FONT_PAIRING_IDS } from './textos-style-layer';

// ── Design-token picks (reuse the proven TokenChoice-per-role shape) ──────────
const TokenChoiceSchema = z
  .object({
    surface: z.string().optional(),
    radius: z.string().optional(),
    border: z.string().optional(),
    elevation: z.string().optional(),
    emphasis: z.string().optional(),
  })
  .partial();

export const CalcStyleChoicesSchema = z.object({
  hero: TokenChoiceSchema.optional(),
  headline: TokenChoiceSchema.optional(), // the large-number callout
  interpretation_card: TokenChoiceSchema.optional(),
  recommendations: TokenChoiceSchema.optional(),
  cta: TokenChoiceSchema.optional(),
});
export type CalcStyleChoices = z.infer<typeof CalcStyleChoicesSchema>;

// ── Spec pieces ───────────────────────────────────────────────────────────────
const InputSchema = z.object({
  id: z.string().min(1), // kebab; becomes the expression variable name
  label: z.string().min(1),
  type: z.enum(['number', 'range', 'select']), // NOT touchspin (dead auto-init)
  default_value: z.union([z.number(), z.string()]), // string only for select
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit_prefix: z.string().optional(),
  unit_suffix: z.string().optional(),
  options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
});

const ComputationSchema = z.object({
  id: z.string().min(1), // kebab
  label: z.string().min(1),
  expression: z.string().min(1), // sanitized — input ids + arithmetic + whitelisted Math.*
  format: z.enum(['number', 'currency', 'percent']),
});

const HeadlineSchema = z.object({
  computation_id: z.string().min(1), // → computations[].id
  label: z.string().min(1),
  sublabel: z.string().optional(),
});

const ChartSchema = z.object({
  type: z.enum(['bar', 'doughnut']), // ONE per calculator
  title: z.string().min(1),
  source: z.enum(['computations', 'inputs']),
  series: z.array(z.object({ ref_id: z.string().min(1), label: z.string().optional() })).min(1).max(8),
});

// Optional interpretation by headline-value range. Unlike Assessment's bounded
// score, a formula's output is UNBOUNDED — so the FINAL band omits `max`
// (open-ended +∞) instead of a fake ceiling. No-fallbacks-compatible.
const ResultBandSchema = z.object({
  min: z.number(),
  max: z.number().optional(), // omitted on the final (open-ended) band only
  label: z.string().min(1),
  interpretation: z.string().min(1), // → card-basic body
});

const RecommendationSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

export const CalculatorBuildSpecSchema = z.object({
  hero: z.object({ title: z.string().min(1), subtitle: z.string().min(1) }),
  font_pairing: z
    .string()
    .refine(isFontPairing, { message: `font_pairing must be one of: ${FONT_PAIRING_IDS.join(', ')}` }),
  style: CalcStyleChoicesSchema,
  inputs: z.array(InputSchema).min(2).max(6),
  computations: z.array(ComputationSchema).min(1).max(8),
  headline: HeadlineSchema,
  chart: ChartSchema,
  result: z.object({
    intro: z.string().min(1),
    bands: z.array(ResultBandSchema).min(2).optional(), // OPTIONAL — pure-number calculators allowed
    recommendations: z.array(RecommendationSchema).min(2).max(5),
    cta: z.object({ headline: z.string().min(1), body: z.string().min(1), cta_label: z.string().min(1) }),
  }),
});

export type CalculatorBuildSpec = z.infer<typeof CalculatorBuildSpecSchema>;

export class CalculatorSpecError extends Error {
  constructor(message: string) {
    super(`factory-v2 calculator spec: ${message}`);
    this.name = 'CalculatorSpecError';
  }
}

export class DisallowedExpressionTokenError extends Error {
  constructor(
    public readonly expression: string,
    public readonly reason: string,
  ) {
    super(
      `factory-v2 calculator: expression "${expression}" rejected — ${reason}. ` +
        `Whitelist ONLY: input ids, numeric literals, + - * / %, parentheses, and ` +
        `Math.{min,max,round,floor,ceil,abs}. No fallback — anything else is a hard reject.`,
    );
    this.name = 'DisallowedExpressionTokenError';
  }
}

const WHITELISTED_MATH = ['min', 'max', 'round', 'floor', 'ceil', 'abs'] as const;

/**
 * Strict whitelist sanitizer (no-fallbacks). Throws DisallowedExpressionTokenError
 * on ANYTHING outside the whitelist. `allowedIds` = the input ids this expression
 * may reference. Conservative by design: strip valid Math.<fn>( calls, then any
 * residual function-call, property-access, or unknown identifier is rejected.
 */
export function sanitizeExpression(expression: unknown, allowedIds: Set<string>): void {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new DisallowedExpressionTokenError(String(expression), 'empty or non-string expression');
  }
  const expr = expression;

  // 1. Character whitelist — only these may appear at all.
  if (/[^A-Za-z0-9_$.,+\-*/%()\s]/.test(expr)) {
    throw new DisallowedExpressionTokenError(expr, 'contains a character outside the allowed set');
  }
  // 2. Forbidden operator/comment sequences (defense in depth).
  if (/=>|\*\*|\/\/|\/\*|\+\+|--/.test(expr)) {
    throw new DisallowedExpressionTokenError(expr, 'contains a forbidden operator/comment sequence');
  }

  // 3. Strip every VALID Math.<whitelisted>( call → a bare "(" so no legitimate
  //    property access or function call should remain afterward.
  const mathCall = new RegExp(`Math\\.(?:${WHITELISTED_MATH.join('|')})\\s*\\(`, 'g');
  const stripped = expr.replace(mathCall, '(');

  // 4. After stripping, NO identifier may be immediately followed by "(" (a call),
  //    and NO "." may precede a letter (property access; decimals are ".digit").
  if (/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(stripped)) {
    throw new DisallowedExpressionTokenError(expr, 'disallowed function call (only Math.{min,max,round,floor,ceil,abs} permitted)');
  }
  if (/\.\s*[A-Za-z_$]/.test(stripped)) {
    throw new DisallowedExpressionTokenError(expr, 'disallowed property access');
  }

  // 5. Every remaining identifier must be an allowed input id (Math/its methods
  //    were stripped in step 3; anything left like a stray "Math" also fails here).
  const idents = stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const id of idents) {
    if (!allowedIds.has(id)) {
      throw new DisallowedExpressionTokenError(expr, `unknown identifier "${id}" (not a declared input id)`);
    }
  }
}

// Ids are used DIRECTLY as JS variable names in expressions (new Function over
// input ids), so they MUST be valid identifiers — snake_case, NOT kebab (a
// hyphen would parse as subtraction). Lowercase letter first, then letters/
// digits/underscores.
const IDENT = /^[a-z][a-z0-9_]*$/;

/**
 * Cross-field validation BEYOND the Zod shape. No-fallbacks: each rule throws a
 * clear, named error. Run after CalculatorBuildSpecSchema.parse().
 */
export function validateCalculatorSpec(spec: CalculatorBuildSpec): void {
  // (i) input ids: unique + kebab; select inputs declare options.
  const inputIds = new Set<string>();
  for (const inp of spec.inputs) {
    if (!IDENT.test(inp.id)) throw new CalculatorSpecError(`input id "${inp.id}" is not a valid identifier (snake_case, no hyphens — it is used as a formula variable).`);
    if (inputIds.has(inp.id)) throw new CalculatorSpecError(`duplicate input id "${inp.id}".`);
    inputIds.add(inp.id);
    if (inp.type === 'select' && (!inp.options || inp.options.length < 2)) {
      throw new CalculatorSpecError(`select input "${inp.id}" must declare >=2 options.`);
    }
  }

  // (ii) computation ids: unique + kebab; EVERY expression references INPUT ids
  //      only (keeps the live tx-bind headline + the inline snapshot consistent
  //      and order-independent). The sanitizer is the security gate.
  const compIds = new Set<string>();
  for (const comp of spec.computations) {
    if (!IDENT.test(comp.id)) throw new CalculatorSpecError(`computation id "${comp.id}" is not a valid identifier (snake_case, no hyphens).`);
    if (compIds.has(comp.id)) throw new CalculatorSpecError(`duplicate computation id "${comp.id}".`);
    if (inputIds.has(comp.id)) throw new CalculatorSpecError(`computation id "${comp.id}" collides with an input id.`);
    compIds.add(comp.id);
    sanitizeExpression(comp.expression, inputIds); // THROWS on anything not whitelisted
  }

  // (iii) headline references a real computation.
  if (!compIds.has(spec.headline.computation_id)) {
    throw new CalculatorSpecError(`headline.computation_id "${spec.headline.computation_id}" is not a declared computation.`);
  }

  // (iv) chart series reference real ids of the chosen source.
  const sourceIds = spec.chart.source === 'computations' ? compIds : inputIds;
  for (const s of spec.chart.series) {
    if (!sourceIds.has(s.ref_id)) {
      throw new CalculatorSpecError(`chart series ref_id "${s.ref_id}" is not a declared ${spec.chart.source} id.`);
    }
  }

  // (v) bands (optional): sorted ascending + non-overlapping; only the FINAL band
  //     may omit max (open-ended). No-fallbacks — no fake ceiling.
  if (spec.result.bands) {
    const bands = spec.result.bands;
    for (let i = 0; i < bands.length; i++) {
      const isLast = i === bands.length - 1;
      if (!isLast && bands[i].max == null) {
        throw new CalculatorSpecError(`only the final band may omit "max" (band "${bands[i].label}" omitted it).`);
      }
      if (isLast && bands[i].max != null) {
        throw new CalculatorSpecError(`the final band "${bands[i].label}" MUST omit "max" (open-ended +∞).`);
      }
      if (bands[i].max != null && bands[i].min > (bands[i].max as number)) {
        throw new CalculatorSpecError(`band "${bands[i].label}" has min ${bands[i].min} > max ${bands[i].max}.`);
      }
      if (i > 0) {
        const prevMax = bands[i - 1].max as number; // guaranteed defined (not last)
        if (bands[i].min <= prevMax) {
          throw new CalculatorSpecError(
            `bands overlap / not ascending between "${bands[i - 1].label}" (max ${prevMax}) and "${bands[i].label}" (min ${bands[i].min}).`,
          );
        }
      }
    }
  }
}

// Assembler input/output and computed-value types. The assembler is a
// pure function (archetype + content + context) → HTML string. Everything
// else here is metadata that flows out alongside the HTML for debugging
// and downstream consumers (Brief C apps page, manifest introspection).

import type { ArchetypeId } from '../archetypes/index';

// ── Inputs ───────────────────────────────────────────────────────────────

export interface AssemblerBusinessContext {
  /** Business slug. Used in routing fallbacks and share-bar URLs. */
  slug: string;
  /** Display name. Renders into PDF footer + share-bar text. */
  name: string;
  /** Operator URL substituted for the LLM's `cta_url_placeholder` sentinel. */
  operator_url: string;
  /** Optional brand accent hex. Reserved for future per-business styling
   *  on top of Homer; MVP uses Homer's default tokens. */
  accent_color_hex?: string;
}

export interface AssemblerInput {
  archetype_id: ArchetypeId;
  /** Raw LLM content payload. Shape must match the archetype's content_schema.
   *  The assembler validates with Zod before composition. */
  content: unknown;
  business_context: AssemblerBusinessContext;
  /** UUID of the asset row this app will live under. Used in event payloads
   *  and visitor-token localStorage key (tx_vt_<app_id>). */
  app_id: string;
  /** textos-agent base URL — receives runtime event POSTs from the visitor's
   *  browser. Same URL the existing pipeline uses. */
  api_base: string;
  /** Frontend host (e.g. https://textos-web-test.pages.dev) used to build
   *  absolute URLs for Homer's CSS/JS assets and share-bar links. */
  frontend_url: string;
}

// ── Output ───────────────────────────────────────────────────────────────

export type ValidationSeverity = 'warning' | 'info';

export interface ValidationWarning {
  severity: ValidationSeverity;
  /** Dotted path or component_id pointing at the location. */
  location: string;
  message: string;
}

export interface AssemblyManifest {
  archetype_id: ArchetypeId;
  /** Catalog component ids actually rendered into the HTML (post multi-
   *  candidate selection). Useful for introspection. */
  rendered_components: string[];
  /** For each multi-candidate slot (Assessment questions, Calculator inputs),
   *  which candidate was picked. */
  candidate_selections: Array<{
    location: string;
    selected_component_id: string;
    selected_for_type: string;
  }>;
  /** CSS hrefs referenced in <head>. */
  css_dependencies: string[];
  /** JS srcs referenced before </body>. */
  js_dependencies: string[];
  /** Final HTML size in bytes (for monitoring vs the LLM-only pipeline). */
  html_bytes: number;
}

export interface AssemblerOutput {
  html: string;
  validation_warnings: ValidationWarning[];
  manifest: AssemblyManifest;
}

// ── Computed values (synthesized from content + visitor input) ──────────
// In Brief B, the assembler does NOT see visitor input — it bakes the
// scoring/calc logic into emitted JS that runs in the visitor's browser.
// These TS types document the same shape both ends agree on.

export interface ComputedAssessmentScoreBand {
  min: number;
  max: number;
  label: string;
  interpretation: string;
  color: 'success' | 'warning' | 'danger' | 'primary';
}

export interface ComputedAssessment {
  total_score: number;
  max_score: number;
  /** Map of dimension_id → summed points. Drives the radar chart. */
  dimension_scores: Record<string, number>;
  score_band: ComputedAssessmentScoreBand;
  score_band_label: string;
}

export interface ComputedCalculator {
  /** Map of calculation_id → formatted display string. */
  calculations: Record<string, string>;
  /** Raw numeric values keyed by calculation_id. Used for chart payloads. */
  calculations_raw: Record<string, number>;
  /** Big-number value (resolved from result.big_number.calculation_id). */
  big_number_value: string;
  /** Chart.js dataset-shaped payload, ready to feed to new Chart(...) */
  chart_data: {
    labels: string[];
    values: number[];
  };
}

// ── Errors ─────────────────────────────────────────────────────────────

export class AssemblerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AssemblerError';
    this.code = code;
    this.details = details;
  }
}

export class ContentValidationError extends AssemblerError {
  readonly path: string;
  readonly expected: string;
  readonly received: unknown;
  constructor(path: string, expected: string, received: unknown, message?: string) {
    super('content_validation', message ?? `Content validation failed at ${path}: expected ${expected}`, {
      path, expected, received,
    });
    this.name = 'ContentValidationError';
    this.path = path;
    this.expected = expected;
    this.received = received;
  }
}

export class ExpressionSanitizerError extends AssemblerError {
  readonly expression: string;
  readonly reason: string;
  constructor(expression: string, reason: string) {
    super('expression_sanitizer', `Expression rejected: ${reason}. Expression: ${expression}`, {
      expression, reason,
    });
    this.name = 'ExpressionSanitizerError';
    this.expression = expression;
    this.reason = reason;
  }
}

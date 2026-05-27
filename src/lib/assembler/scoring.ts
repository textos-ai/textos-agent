// Assessment scoring — TypeScript source of truth + emitted JS for the
// visitor's browser.
//
// The TS implementation runs in the assembler for validation (does the
// max_score on this content match the maximum reachable sum? do the
// score_bands cover every integer in [0, max_score] without gaps?). The
// emitted JS string is baked into the generated HTML's <script> block;
// it runs in the visitor's browser when they hit Submit.
//
// Both implementations MUST stay in lockstep — same iteration order,
// same band-match rule, same dimension keys. The unit tests assert the
// TS version against fixtures; the emitted JS is a deterministic
// projection so it stays in sync by construction.

import type { ComputedAssessment, ComputedAssessmentScoreBand } from './types';

// ── Type aliases for the LLM-validated content slice we care about. ──

interface ScoringQuestion {
  id: string;
  dimension: string;
  options: Array<{ value: string; points: number; title?: string }>;
}

interface ScoringSpec {
  max_score: number;
  score_bands: ComputedAssessmentScoreBand[];
  dimensions: Array<{ id: string; label: string }>;
}

interface AssessmentContent {
  questions: ScoringQuestion[];
  scoring: ScoringSpec;
}

// ── Pure TS runner (validation + tests) ───────────────────────────────

/**
 * Compute the Assessment result from a visitor's responses. Responses
 * is a map of question.id → selected option.value. Returns the full
 * Computed* shape consumed by result-phase slot bindings.
 */
export function runAssessmentScoring(
  content: AssessmentContent,
  responses: Record<string, string>,
): ComputedAssessment {
  const dimensionScores: Record<string, number> = {};
  for (const d of content.scoring.dimensions) dimensionScores[d.id] = 0;

  let total = 0;
  for (const q of content.questions) {
    const selectedValue = responses[q.id];
    if (selectedValue == null) continue;
    const opt = q.options.find((o) => o.value === selectedValue);
    if (!opt) continue;
    const pts = Number(opt.points) || 0;
    total += pts;
    dimensionScores[q.dimension] = (dimensionScores[q.dimension] ?? 0) + pts;
  }

  const band = selectScoreBand(content.scoring.score_bands, total);

  return {
    total_score: total,
    max_score: content.scoring.max_score,
    dimension_scores: dimensionScores,
    score_band: band,
    score_band_label: band.label,
  };
}

/** Pick the band whose [min, max] inclusive range contains score. */
export function selectScoreBand(
  bands: ComputedAssessmentScoreBand[],
  score: number,
): ComputedAssessmentScoreBand {
  for (const b of bands) {
    if (score >= b.min && score <= b.max) return b;
  }
  // If no band matched (validation should have caught a gap), fall back
  // to the highest band so the result page still renders.
  return bands.reduce((acc, b) => (b.max > acc.max ? b : acc), bands[0]);
}

// ── Compile-time validation (called by content validator) ─────────────

/**
 * Verify that score_bands cover every integer in [0, max_score] with no
 * gaps and no overlaps. Returns a list of human-readable error strings;
 * empty list = valid.
 */
export function validateScoreBands(spec: ScoringSpec): string[] {
  const errors: string[] = [];
  if (spec.score_bands.length === 0) {
    errors.push('scoring.score_bands is empty');
    return errors;
  }
  const sorted = [...spec.score_bands].sort((a, b) => a.min - b.min);
  if (sorted[0].min !== 0) {
    errors.push(`scoring.score_bands does not start at 0 (lowest band min=${sorted[0].min})`);
  }
  const last = sorted[sorted.length - 1];
  if (last.max < spec.max_score) {
    errors.push(`scoring.score_bands ends at ${last.max}, below max_score=${spec.max_score}`);
  }
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.min > b.max) {
      errors.push(`band "${b.label}" has min(${b.min}) > max(${b.max})`);
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (b.min !== prev.max + 1) {
        if (b.min <= prev.max) {
          errors.push(`bands "${prev.label}" and "${b.label}" overlap at ${b.min}..${prev.max}`);
        } else {
          errors.push(`gap between "${prev.label}" (max=${prev.max}) and "${b.label}" (min=${b.min})`);
        }
      }
    }
  }
  return errors;
}

/** Sum the maximum reachable score by picking the highest-point option
 *  on every question. Used by the validator to check max_score is
 *  consistent with the questions. */
export function maxReachableScore(content: AssessmentContent): number {
  return content.questions.reduce((acc, q) => {
    const best = q.options.reduce(
      (m, o) => Math.max(m, Number(o.points) || 0),
      0,
    );
    return acc + best;
  }, 0);
}

// ── Emitted JavaScript for the visitor's browser ──────────────────────
// The function below produces a string of JS that, when included in the
// generated HTML's <script>, exposes window.__txAssembler.scoring.run()
// — called by the submit handler with the visitor's responses.

export function emitScoringScript(content: AssessmentContent): string {
  // Inline the content slice as a JS object literal. JSON.stringify is
  // safe because every value is plain data from the validated payload.
  const inlined = JSON.stringify({
    questions: content.questions.map((q) => ({
      id: q.id,
      dimension: q.dimension,
      options: q.options.map((o) => ({ value: o.value, points: Number(o.points) || 0 })),
    })),
    scoring: {
      max_score: content.scoring.max_score,
      score_bands: content.scoring.score_bands,
      dimensions: content.scoring.dimensions.map((d) => ({ id: d.id, label: d.label })),
    },
  });
  return `
// ── Assessment scoring (emitted by assembler) ──────────────────────
(function () {
  var DATA = ${inlined};
  function selectBand(bands, score) {
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (score >= b.min && score <= b.max) return b;
    }
    var top = bands[0];
    for (var j = 1; j < bands.length; j++) if (bands[j].max > top.max) top = bands[j];
    return top;
  }
  function run(responses) {
    var dim = {};
    for (var i = 0; i < DATA.scoring.dimensions.length; i++) {
      dim[DATA.scoring.dimensions[i].id] = 0;
    }
    var total = 0;
    for (var q = 0; q < DATA.questions.length; q++) {
      var qq = DATA.questions[q];
      var sel = responses[qq.id];
      if (sel == null) continue;
      var opt = null;
      for (var o = 0; o < qq.options.length; o++) {
        if (qq.options[o].value === sel) { opt = qq.options[o]; break; }
      }
      if (!opt) continue;
      var pts = Number(opt.points) || 0;
      total += pts;
      dim[qq.dimension] = (dim[qq.dimension] || 0) + pts;
    }
    var band = selectBand(DATA.scoring.score_bands, total);
    return {
      total_score: total,
      max_score: DATA.scoring.max_score,
      dimension_scores: dim,
      score_band: band,
      score_band_label: band.label
    };
  }
  window.__txAssembler = window.__txAssembler || {};
  window.__txAssembler.scoring = { run: run, data: DATA };
})();
`.trim();
}

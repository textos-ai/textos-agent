export { assembleApp } from './assembler';
export type {
  AssemblerInput,
  AssemblerOutput,
  AssemblerBusinessContext,
  AssemblyManifest,
  ValidationWarning,
  ComputedAssessment,
  ComputedAssessmentScoreBand,
  ComputedCalculator,
} from './types';
export { AssemblerError, ContentValidationError, ExpressionSanitizerError } from './types';

// Submodules — exported so tests + downstream callers can reach them
// without deep imports.
export { sanitizeExpression } from './expression-sanitizer';
export { resolveSlot, resolveSlotBindings } from './slot-resolver';
export { renderTemplate } from './template';
export { runAssessmentScoring, validateScoreBands, maxReachableScore, selectScoreBand } from './scoring';
export {
  evalCalculatorExpression,
  runCalculator,
  validateCalculatorContent,
  formatNumber,
} from './calculation';
export { validateContent } from './validation/index';

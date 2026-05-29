// Phase renderer — turns one ArchetypePhase into a chunk of HTML by
// iterating its components, picking candidates for multi-candidate slots,
// resolving slot bindings, rendering each catalog template via Mustache,
// and concatenating. The output is wrapped in a phase-scoped <section>.
//
// Multi-candidate selection rule:
//   For Assessment questions, the selected component_id matches:
//     - 'radio-cards'     when content.questions[i].type === 'radio_cards'
//     - 'star-rating'     when content.questions[i].type === 'star_rating'
//     - 'btn-check-radio' when content.questions[i].type === 'btn_check_radio'
//   For Calculator inputs, the selected component_id matches:
//     - 'number-input'      when type === 'number' and no unit
//     - 'input-with-unit'   when type === 'number' and a unit is present
//     - 'range-slider'      when type === 'range'
//     - 'select-native'     when type === 'select'
//     - 'touchspin-stepper' when type === 'stepper'
//   The renderer reads `optional: true` PhaseComponents as candidate
//   sets and resolves them via these rules. Non-optional components
//   render unconditionally.

import type {
  Archetype,
  ArchetypePhase,
  PhaseComponent,
} from '../archetypes/index';
import { CATALOG } from '../component-catalog/index';
import { resolveSlotBindings, type ResolverContext } from './slot-resolver';
import { renderTemplate } from './template';
import type { AssemblyManifest, ValidationWarning } from './types';

export interface PhaseRenderContext {
  archetype: Archetype;
  phase: ArchetypePhase;
  resolver_ctx: ResolverContext;
  /** Mutated by the renderer to record which components rendered. */
  manifest: AssemblyManifest;
  warnings: ValidationWarning[];
}

export function renderPhase(ctx: PhaseRenderContext): string {
  const { phase, archetype, resolver_ctx, manifest, warnings } = ctx;
  const chunks: string[] = [];

  // Strategy / Assessment use a wizard inside the inputs phase; for that
  // case we group components by step and emit the wizard's outer markup
  // ourselves. The wizard catalog component's html_template iterates its
  // `steps` slot; we feed it a pre-rendered HTML chunk per step.
  const isWizardPhase = phase.components.some((pc) => pc.component_id === 'wizard');

  if (phase.type === 'inputs' && isWizardPhase) {
    chunks.push(renderWizardInputs(ctx));
  } else if (phase.type === 'inputs') {
    // Calculator inputs phase — single screen, no wizard.
    chunks.push(renderFlatInputs(ctx));
  } else if (phase.type === 'paywall') {
    chunks.push(renderPaywall(ctx));
  } else if (phase.type === 'result') {
    chunks.push(renderResult(ctx));
  }

  return [
    `<section class="tx-phase tx-phase-${phase.id}" data-phase-id="${phase.id}"${phase.type !== 'inputs' ? ' hidden' : ''}>`,
    chunks.join('\n'),
    '</section>',
  ].join('\n');

  // ── inner helpers (close over ctx) ─────────────────────────────────

  function renderWizardInputs(_c: PhaseRenderContext): string {
    const heroComp = phase.components.find((pc) => pc.component_id === 'section-hero');
    const wizardComp = phase.components.find((pc) => pc.component_id === 'wizard');
    const progressComp = phase.components.find((pc) => pc.component_id === 'progress-bar');
    if (!wizardComp) return '';

    const stepComponents = phase.components.filter((pc) => typeof pc.step === 'number');
    const stepsMap = new Map<number, PhaseComponent[]>();
    for (const pc of stepComponents) {
      const arr = stepsMap.get(pc.step!) ?? [];
      arr.push(pc);
      stepsMap.set(pc.step!, arr);
    }
    const stepKeys = [...stepsMap.keys()].sort((a, b) => a - b);

    const sections: string[] = [];
    if (heroComp) sections.push(renderOne(heroComp, ctx));
    if (progressComp) sections.push(renderOne(progressComp, ctx));

    // Per-step content blocks rendered manually (we don't use the wizard
    // catalog template's {{#steps}} iterator because per-step component
    // composition is too rich for a single field binding).
    sections.push('<div class="tx-wizard" data-tx-wizard>');
    for (const step of stepKeys) {
      const comps = stepsMap.get(step)!;
      const stepInner = comps
        .filter((pc) => pc.component_id !== 'submit-button')
        .map((pc) => renderOne(pc, ctx))
        .filter(Boolean)
        .join('\n');
      // Bug 3: the final step's terminal action is hardcoded here (mirroring
      // the hardcoded "Next →" for non-final steps) rather than rendered from
      // the submit-button catalog component. The catalog template's
      // `{{label|Submit}}` default syntax isn't valid Mustache and the recipe
      // bound `label:'submit_label'` (a field the v2 transform never emits),
      // so renderOne() produced an empty `<button type="submit">`. It was also
      // type="submit", which the inputs orchestration (document-wrapper) does
      // not wire. A hardcoded type="button" with a real label is picked up by
      // the existing inputs→paywall handler.
      const isLastStep = step === stepKeys[stepKeys.length - 1];
      sections.push(
        `<div class="tx-wizard-step" data-step="${step}"${step !== stepKeys[0] ? ' hidden' : ''}>` +
          stepInner +
          (isLastStep
            ? '\n<button type="button" class="btn btn-primary tx-wizard-submit">See My Results →</button>'
            : '\n<button type="button" class="btn btn-primary tx-wizard-next" data-step-action="next">Next →</button>') +
          (step !== stepKeys[0]
            ? '\n<button type="button" class="btn btn-link tx-wizard-prev" data-step-action="prev">← Back</button>'
            : '') +
          '</div>',
      );
    }
    sections.push('</div>');
    return sections.join('\n');
  }

  function renderFlatInputs(_c: PhaseRenderContext): string {
    return phase.components
      .map((pc) => renderOne(pc, ctx))
      .filter(Boolean)
      .join('\n');
  }

  function renderPaywall(_c: PhaseRenderContext): string {
    // The paywall phase is a hidden modal that the runtime reveals on
    // submit. Render each component into a single container; runtime
    // wiring (Bootstrap modal show, event hooks) lives in the document
    // wrapper's emitted script.
    return phase.components
      .map((pc) => renderOne(pc, ctx))
      .filter(Boolean)
      .join('\n');
  }

  function renderResult(_c: PhaseRenderContext): string {
    // Result phase wraps in .txapp-result so the PDF block can target it.
    const inner = phase.components
      .map((pc) => renderOne(pc, ctx))
      .filter(Boolean)
      .join('\n');
    return `<div class="txapp-result" hidden>\n${inner}\n</div>`;
  }
}

/** Render a single PhaseComponent against the resolver context. Returns
 *  empty string if the component is a multi-candidate that didn't match
 *  the LLM's selected type. */
function renderOne(pc: PhaseComponent, ctx: PhaseRenderContext): string {
  const cat = CATALOG.by_id[pc.component_id];
  if (!cat) {
    ctx.warnings.push({
      severity: 'warning',
      location: pc.component_id,
      message: `catalog component "${pc.component_id}" not found — skipping`,
    });
    return '';
  }

  // Multi-candidate selection logic. We inspect the bound content to
  // decide whether to render this candidate.
  if (pc.optional && shouldSkipCandidate(pc, ctx)) {
    return '';
  }

  const { resolved, missing_slots } = resolveSlotBindings(pc.slot_bindings, ctx.resolver_ctx);
  if (missing_slots.length > 0 && !pc.optional) {
    ctx.warnings.push({
      severity: 'warning',
      location: `${ctx.phase.id}:${pc.component_id}`,
      message: `missing slot data for: ${missing_slots.join(', ')}`,
    });
  }
  const html = renderTemplate(cat.html_template, resolved);

  // Manifest bookkeeping.
  if (!ctx.manifest.rendered_components.includes(pc.component_id)) {
    ctx.manifest.rendered_components.push(pc.component_id);
  }

  return html;
}

/** Multi-candidate guard. Returns true when this optional candidate
 *  shouldn't render for the current LLM-supplied type. */
function shouldSkipCandidate(pc: PhaseComponent, ctx: PhaseRenderContext): boolean {
  // Strategy + Assessment question candidates: read questions[idx].type
  // and skip if it doesn't match this candidate.
  const qIdxMatch = /^questions\[(\d+)\]/.exec(Object.values(pc.slot_bindings)[0] ?? '');
  if (qIdxMatch && ctx.archetype.id === 'assessment') {
    const idx = Number(qIdxMatch[1]);
    const qType = readPath(ctx.resolver_ctx.content, `questions[${idx}].type`);
    if (!qType) return true; // no question at this index → skip
    const expectedComponent = mapAssessmentTypeToComponent(String(qType));
    if (expectedComponent !== pc.component_id) return true;
    // Record candidate selection for manifest.
    ctx.manifest.candidate_selections.push({
      location: `questions[${idx}]`,
      selected_component_id: pc.component_id,
      selected_for_type: String(qType),
    });
    return false;
  }

  // Calculator input candidates.
  const iIdxMatch = /^inputs\[(\d+)\]/.exec(Object.values(pc.slot_bindings)[0] ?? '');
  if (iIdxMatch && ctx.archetype.id === 'calculator') {
    const idx = Number(iIdxMatch[1]);
    const inputDef = readPath(ctx.resolver_ctx.content, `inputs[${idx}]`) as
      | { type?: string; unit?: string }
      | undefined;
    if (!inputDef) return true;
    const expected = mapCalculatorInputToComponent(String(inputDef.type), !!inputDef.unit);
    if (expected !== pc.component_id) return true;
    ctx.manifest.candidate_selections.push({
      location: `inputs[${idx}]`,
      selected_component_id: pc.component_id,
      selected_for_type: String(inputDef.type) + (inputDef.unit ? '+unit' : ''),
    });
    return false;
  }

  // Result-phase chart candidates (Calculator): bar vs doughnut.
  if (
    ctx.archetype.id === 'calculator' &&
    (pc.component_id === 'chart-bar' || pc.component_id === 'chart-doughnut')
  ) {
    const chartType = readPath(ctx.resolver_ctx.content, 'result.chart.type');
    if (pc.component_id === 'chart-bar' && chartType !== 'bar') return true;
    if (pc.component_id === 'chart-doughnut' && chartType !== 'doughnut') return true;
    return false;
  }

  // Optional but not a multi-candidate (spinner, alert, progress-bar,
  // optional summary card etc.): default to skipping, since they're
  // only meaningful when explicitly opted in by the archetype's runtime
  // (which Brief B doesn't wire yet — these light up at submit/error
  // time via the emitted script).
  if (pc.optional) return true;

  return false;
}

function mapAssessmentTypeToComponent(t: string): string | null {
  switch (t) {
    case 'radio_cards': return 'radio-cards';
    case 'star_rating': return 'star-rating';
    case 'btn_check_radio': return 'btn-check-radio';
    default: return null;
  }
}

function mapCalculatorInputToComponent(t: string, hasUnit: boolean): string | null {
  switch (t) {
    case 'number': return hasUnit ? 'input-with-unit' : 'number-input';
    case 'range': return 'range-slider';
    case 'select': return 'select-native';
    case 'stepper': return 'touchspin-stepper';
    default: return null;
  }
}

/** Local re-impl of the resolver's path walker, used here so we can
 *  inspect raw content without going through resolveSlot's layer prefix
 *  resolution. */
function readPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const segs: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') { i++; continue; }
    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) return undefined;
      segs.push(Number(path.slice(i + 1, close)));
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    segs.push(path.slice(i, j));
    i = j;
  }
  let cur: any = obj;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s as any];
  }
  return cur;
}

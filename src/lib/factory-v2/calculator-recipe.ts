// factory-v2 — Calculator LOCKED recipe + page builder.
//
// Composes the Calculator app 100% from the Homer catalog (throw-on-unknown via
// assembleComposition). HYBRID compute, fully CLIENT-SIDE (no result endpoint):
//   • LIVE headline preview in the collect panel — a `large-number` whose value
//     element is a tx-bind <output data-tx-output="<headline expr>">; tx-bind.js
//     self-inits and recomputes as the visitor types (the Calculator signature).
//   • FULL result on submit — an inline snapshot evaluates the formula once
//     (over the sanitized expressions), fills the result headline, paints the
//     chart via explicit `new CustomChartJs(...)` (the radar pattern — app.js
//     auto-init is DEAD in the iframe), and reveals the matched interpretation
//     band (if any).
//
// COLLECT (locked): section-hero[light] → card-basic frame { live large-number →
//   inputs (number-input | range-slider | select-native) → submit-button }.
// RESULT  (locked): section-hero[light] → card-basic frame { result large-number
//   → chart(bar|doughnut) → card-basic ×band(matched) → list-group → card-cta →
//   share-bar → download-button }.

import { assembleComposition, type CompositionBlock } from './assemble';
import type { CalculatorBuildSpec, CalcStyleChoices } from './calculator-spec-schema';
import { CATALOG } from '../component-catalog/index';
import { resolveComponentTokens, tokenClass, type ChosenTokens } from '../component-catalog/design-token-resolver';
import { resolveVendorScripts, BASE_BUNDLE_FULL } from '../component-catalog/vendor-scripts';

/** Component roles the LLM styles → their catalog component id. */
export const CALC_STYLE_ROLE_COMPONENT: Record<keyof CalcStyleChoices, string> = {
  hero: 'section-hero',
  headline: 'large-number',
  interpretation_card: 'card-basic',
  recommendations: 'list-group',
  cta: 'card-cta',
};

/** Validate every role's token choices against its component's supported[]
 *  (no-fallbacks: throws on unknown/unsupported). Used in the generate loop. */
export function validateCalculatorStyle(style: CalcStyleChoices | undefined): void {
  const s = style ?? {};
  for (const [role, compId] of Object.entries(CALC_STYLE_ROLE_COMPONENT)) {
    const entry = CATALOG.by_id[compId];
    if (!entry) continue;
    resolveComponentTokens(entry, (s[role as keyof CalcStyleChoices] ?? {}) as ChosenTokens);
  }
}

function roleClasses(style: CalcStyleChoices, role: keyof CalcStyleChoices): string {
  const entry = CATALOG.by_id[CALC_STYLE_ROLE_COMPONENT[role]];
  if (!entry) return '';
  return resolveComponentTokens(entry, (style[role] ?? {}) as ChosenTokens).classes;
}

/** The components this recipe ALWAYS composes (the chart id is added per spec). */
const CALC_BASE_COMPONENT_IDS = [
  'section-hero', 'number-input', 'range-slider', 'select-native', 'submit-button',
  'large-number', 'tx-bind', 'card-basic', 'list-group', 'card-cta',
  'share-bar', 'download-button', 'spinner', 'alert',
];

/** A " (unit)" suffix for a field LABEL when the spec gives the input a unit.
 *  Used for number inputs (which have no value readout of their own); range
 *  inputs show their unit in the live value badge instead (see the inline JS).
 *  Skips redundant cases where the unit word already appears in the label
 *  (e.g. "Number of guests" + unit "guests"). */
function unitParen(inp: CalculatorBuildSpec['inputs'][number]): string {
  const u = inp.unit_suffix || inp.unit_prefix;
  if (!u) return '';
  if (inp.label.toLowerCase().includes(u.toLowerCase())) return '';
  return ` (${u})`;
}

/** Server-side unit-formatted readout (mirrors the inline `withUnit`): prefix +
 *  value + suffix, with a space before WORD suffixes ("3 items") but not symbol
 *  suffixes ("50%"). Used to seed the slider badge so the unit shows on first paint. */
function unitReadout(inp: CalculatorBuildSpec['inputs'][number], v: string): string {
  const up = inp.unit_prefix ?? '';
  const us = inp.unit_suffix ? (/^[A-Za-z]/.test(inp.unit_suffix) ? ' ' + inp.unit_suffix : inp.unit_suffix) : '';
  return `${up}${v}${us}`;
}

/** Render ONE input from its catalog component (per input.type), then inject
 *  `data-bind` so tx-bind reads it (key = id/name = input.id). */
function inputHtml(inp: CalculatorBuildSpec['inputs'][number]): string {
  if (inp.type === 'range') {
    let html = assembleComposition([
      {
        component_id: 'range-slider',
        slot_values: {
          id: inp.id, name: inp.id, label: inp.label,
          min: inp.min ?? 0, max: inp.max ?? 100, step: inp.step ?? 1, value: inp.default_value,
        },
      },
    ]).html;
    html = html.replace('<input type="range" class="form-range"', '<input type="range" class="form-range" data-bind=""');
    // Seed the value badge WITH the unit so the readout shows e.g. "50%" / "3 items"
    // from first paint (the inline JS keeps it in sync as the slider moves).
    const v = String(inp.default_value);
    html = html.replace(
      `data-range-output-for="${inp.id}">${v}</span>`,
      `data-range-output-for="${inp.id}">${unitReadout(inp, v)}</span>`,
    );
    return html;
  }
  if (inp.type === 'select') {
    const opts = inp.options ?? [];
    let html = assembleComposition([
      {
        component_id: 'select-native',
        slot_values: {
          label: inp.label, name: inp.id,
          options: opts.map((o) => ({ value: o.value, label: o.label })),
          placeholder: '', required: 'required',
        },
      },
    ]).html;
    html = html.replace('<select class="form-select"', '<select class="form-select" data-bind=""');
    // Drop the empty placeholder option — a calculator select must ALWAYS hold a
    // real numeric value so the LIVE headline computes a real estimate from the
    // first paint (never $0). tx-bind reads the selected option's value.
    html = html.replace(/<option value="">[\s\S]*?<\/option>\s*/, '');
    // Pre-select the default_value option (or the first real option if the
    // default doesn't match one) so a real value is selected on load.
    const target = opts.some((o) => o.value === String(inp.default_value))
      ? String(inp.default_value)
      : (opts[0]?.value ?? '');
    if (target !== '') {
      html = html.replace(`<option value="${target}">`, `<option value="${target}" selected>`);
    }
    return html;
  }
  // number — a plain field has no value readout, so surface any unit in the label.
  let html = assembleComposition([
    {
      component_id: 'number-input',
      slot_values: {
        id: inp.id, name: inp.id, label: inp.label + unitParen(inp),
        min: inp.min ?? '', max: inp.max ?? '', step: inp.step ?? 1, value: inp.default_value,
      },
    },
  ]).html;
  return html.replace('<input type="number" class="form-control"', '<input type="number" class="form-control" data-bind=""');
}

export function buildCalculatorPage(spec: CalculatorBuildSpec): {
  innerHtml: string;
  inlineScript: string;
  scripts: string[];
  componentIds: string[];
} {
  const style = (spec.style ?? {}) as CalcStyleChoices;
  const cls = {
    hero: roleClasses(style, 'hero'),
    headline: roleClasses(style, 'headline'),
    card: roleClasses(style, 'interpretation_card'),
    list: roleClasses(style, 'recommendations'),
    cta: roleClasses(style, 'cta'),
  };
  // Shared frame for both surfaces (radius:lg + elevation:sm = rounded-3 shadow-sm).
  const FRAME_CLASSES = [tokenClass('radius', 'lg'), tokenClass('elevation', 'sm')].filter(Boolean).join(' ');

  const headlineComp = spec.computations.find((c) => c.id === spec.headline.computation_id)!;

  // ── COLLECT ───────────────────────────────────────────────────────────────
  const { html: collectHeroHtml } = assembleComposition([
    { component_id: 'section-hero', slot_values: { headline: spec.hero.title, tagline: spec.hero.subtitle, light: true }, extra_classes: cls.hero },
  ]);

  // LIVE headline large-number: swap its count-up span for a tx-bind <output>
  // bound to the headline computation's (input-only) expression.
  const liveLargeNumberRaw = assembleComposition([
    { component_id: 'large-number', slot_values: { label: spec.headline.label, value: '', prefix: '', suffix: '', subtitle: spec.headline.sublabel ?? '' }, extra_classes: cls.headline },
  ]).html;
  const liveOutput = `<output id="calc-live" data-tx-output="${headlineComp.expression.replace(/"/g, '&quot;')}" data-format="${headlineComp.format}">0</output>`;
  const liveLargeNumber = liveLargeNumberRaw.replace('<span data-target="">0</span>', liveOutput);

  const inputsHtml = spec.inputs.map(inputHtml).join('\n');
  const { html: submitHtml } = assembleComposition([
    { component_id: 'submit-button', slot_values: { label: 'See my full breakdown', variant: 'primary' } },
  ]);

  const collectFormHtml = `<form><div class="d-flex flex-column gap-3">${liveLargeNumber}${inputsHtml}${submitHtml}</div></form>`;
  const { html: collectCardHtml } = assembleComposition([
    { component_id: 'card-basic', slot_values: { content: collectFormHtml }, extra_classes: FRAME_CLASSES },
  ]);

  // ── RESULT (hidden on load) ─────────────────────────────────────────────────
  const { html: resultHeroHtml } = assembleComposition([
    { component_id: 'section-hero', slot_values: { headline: spec.hero.title, tagline: spec.result.intro, light: true }, extra_classes: cls.hero },
  ]);

  // result headline large-number: snapshot value set by the inline handler.
  const resultLargeNumberRaw = assembleComposition([
    { component_id: 'large-number', slot_values: { label: spec.headline.label, value: '', prefix: '', suffix: '', subtitle: spec.headline.sublabel ?? '' }, extra_classes: cls.headline },
  ]).html;
  const resultLargeNumber = resultLargeNumberRaw.replace('<span data-target="">0</span>', '<span id="calc-result-num">—</span>');

  // chart (ONE per spec): hidden until painted (avoid a reserved-height dead gap).
  const chartId = spec.chart.type === 'doughnut' ? 'chart-doughnut' : 'chart-bar';
  const { html: chartHtml } = assembleComposition([
    { component_id: chartId, slot_values: { id: 'calc-chart-canvas', height: '300px' } },
  ]);

  // interpretation bands (optional): pre-composed per band, hidden; inline reveals match.
  const bands = spec.result.bands ?? [];
  const bandCardsHtml = bands
    .map((b, i) => {
      const { html } = assembleComposition([
        { component_id: 'card-basic', slot_values: { title: b.label, content: b.interpretation }, extra_classes: cls.card },
      ]);
      return `<div class="calc-band" data-band="${i}" style="display:none">${html}</div>`;
    })
    .join('\n');

  const { html: listHtml } = assembleComposition([
    {
      component_id: 'list-group',
      slot_values: { items: spec.result.recommendations.map((r) => ({ label: `${r.title} — ${r.body}` })) },
      extra_classes: cls.list,
    },
  ]);
  const { html: ctaHtml } = assembleComposition([
    {
      component_id: 'card-cta',
      slot_values: { headline: spec.result.cta.headline, supporting_text: spec.result.cta.body, cta_url: '#', cta_label: spec.result.cta.cta_label },
      extra_classes: cls.cta,
    },
  ]);
  const { html: shareHtml } = assembleComposition([
    { component_id: 'share-bar', slot_values: { url: '#', text: spec.hero.title, subject: spec.hero.title, body: spec.result.intro } },
  ]);
  const { html: downloadHtml } = assembleComposition([
    { component_id: 'download-button', slot_values: { url: '#', label: 'Download this breakdown (PDF)', variant: 'outline-primary', download: 'calculation' } },
  ]);

  const resultInner = [
    resultLargeNumber,
    `<div id="calc-chart" style="display:none">${chartHtml}</div>`,
    bandCardsHtml,
    listHtml,
    ctaHtml,
    shareHtml,
    downloadHtml,
  ].join('\n');
  const { html: resultCardHtml } = assembleComposition([
    { component_id: 'card-basic', slot_values: { content: `<div class="d-flex flex-column gap-3">${resultInner}</div>` }, extra_classes: FRAME_CLASSES },
  ]);

  const innerHtml = [
    `<div id="calc-collect">`,
    collectHeroHtml,
    collectCardHtml,
    `</div>`,
    `<div id="calc-result" style="display:none">`,
    resultHeroHtml,
    resultCardHtml,
    `</div>`,
  ].join('\n');

  // ── Inline: live preview is tx-bind's job; SUBMIT computes the snapshot ──────
  // Expressions were whitelist-sanitized at build (calculator-spec-schema), so
  // new Function() over input ids is safe here (same engine tx-bind uses).
  const SPEC = {
    inputs: spec.inputs.map((i) => ({ id: i.id, type: i.type, up: i.unit_prefix ?? '', us: i.unit_suffix ?? '' })),
    computations: spec.computations.map((c) => ({ id: c.id, expression: c.expression, format: c.format })),
    headline: { computation_id: spec.headline.computation_id },
    chart: { type: spec.chart.type, source: spec.chart.source, title: spec.chart.title, series: spec.chart.series.map((s) => ({ ref_id: s.ref_id, label: s.label ?? s.ref_id })) },
    bands: bands.map((b) => ({ min: b.min, max: b.max ?? null })),
  };

  const inlineScript = `
(function(){
  var SPEC = ${JSON.stringify(SPEC)};
  var collect = document.getElementById('calc-collect');
  var result  = document.getElementById('calc-result');
  var form = collect && collect.querySelector('form');
  if(!form){ return; }

  // Range-slider value badges — app.js auto-init is dead in the iframe, so wire
  // the readout here (small, no dependency). Show the input's UNIT alongside the
  // value (e.g. "3 hours", "$18", "50%") so the number is self-explanatory.
  var UNIT = {};
  SPEC.inputs.forEach(function(i){ UNIT[i.id] = { up: i.up || '', us: i.us || '' }; });
  function withUnit(id, v){
    var u = UNIT[id] || { up: '', us: '' };
    var suf = u.us ? (/^[A-Za-z]/.test(u.us) ? ' ' + u.us : u.us) : ''; // word units get a space; symbols don't
    return u.up + v + suf;
  }
  form.querySelectorAll('input[type=range]').forEach(function(r){
    var out = document.querySelector('[data-range-output-for="' + r.id + '"]');
    if(out){ var upd = function(){ out.textContent = withUnit(r.id, r.value); }; r.addEventListener('input', upd); upd(); }
  });

  function inputCtx(){
    var ctx = {};
    SPEC.inputs.forEach(function(inp){
      var el = form.querySelector('[name="' + inp.id + '"]');
      var num = parseFloat(el ? el.value : '');
      ctx[inp.id] = isNaN(num) ? 0 : num;
    });
    return ctx;
  }
  function ev(expr, ctx){
    try {
      var keys = Object.keys(ctx);
      var fn = new Function(...keys, 'return (' + expr + ')');
      var v = fn(...keys.map(function(k){ return ctx[k]; }));
      return (typeof v === 'number' && isFinite(v)) ? v : 0;
    } catch(e){ return 0; }
  }
  function computeAll(){
    var ctx = inputCtx();
    SPEC.computations.forEach(function(c){ ctx[c.id] = ev(c.expression, ctx); });
    return ctx;
  }
  function fmt(v, f){
    if(f === 'currency'){ return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
    if(f === 'percent'){ return Math.round(Number(v) * 100) + '%'; }
    return Number(v).toLocaleString();
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var ctx = computeAll();
    var hcomp = SPEC.computations.filter(function(c){ return c.id === SPEC.headline.computation_id; })[0];
    var hval = ctx[SPEC.headline.computation_id] || 0;
    var numEl = document.getElementById('calc-result-num');
    if(numEl){ numEl.textContent = fmt(hval, hcomp ? hcomp.format : 'number'); }

    // interpretation band match (open-ended final band: max === null)
    if(SPEC.bands && SPEC.bands.length){
      var bi = -1;
      for(var i = 0; i < SPEC.bands.length; i++){
        var b = SPEC.bands[i];
        if(hval >= b.min && (b.max === null || hval <= b.max)){ bi = i; break; }
      }
      if(bi < 0){ bi = SPEC.bands.length - 1; }
      var bc = result.querySelector('.calc-band[data-band="' + bi + '"]');
      if(bc){ bc.style.display = ''; }
    }

    // chart: explicit CustomChartJs (auto-init is dead). Source = computations|inputs.
    var src = SPEC.chart.source === 'computations' ? ctx : inputCtx();
    var labels = [], data = [];
    SPEC.chart.series.forEach(function(s){ labels.push(s.label); var v = src[s.ref_id]; data.push(typeof v === 'number' ? v : 0); });
    var chartBox = document.getElementById('calc-chart');
    if(chartBox){ chartBox.style.display = ''; }
    var PALETTE = ['primary', 'success', 'info', 'warning', 'secondary'];
    try {
      new CustomChartJs({ selector: '#calc-chart-canvas', options: function(){
        var isDough = SPEC.chart.type === 'doughnut';
        var bg = isDough ? data.map(function(_, i){ return ins(PALETTE[i % PALETTE.length]); }) : ins('chart-primary');
        return {
          type: SPEC.chart.type,
          data: { labels: labels, datasets: [{ label: SPEC.chart.title, data: data, backgroundColor: bg, borderWidth: isDough ? 0 : undefined }] },
          options: isDough ? {} : { scales: { y: { beginAtZero: true } } }
        };
      } });
    } catch(err){ /* chart non-fatal */ }

    collect.style.display = 'none';
    result.style.display = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
`.trim();

  const componentIds = [...CALC_BASE_COMPONENT_IDS, chartId];
  const scripts = resolveVendorScripts(componentIds, BASE_BUNDLE_FULL);

  return { innerHtml, inlineScript, scripts, componentIds };
}

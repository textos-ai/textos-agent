// factory-v2 — Assessment LOCKED recipe + page builder.
//
// Composes the Assessment app 100% from the Homer catalog (throw-on-unknown
// active via assembleComposition) and bakes a ~deterministic CLIENT-SIDE
// scorer. There is NO server call on submit and NO /api/ result endpoint —
// scoring is pure math over the baked spec.
//
// COLLECT (locked): section-hero[light] → wizard(steps) → radio_cards per
//   question → submit (wizard's own submit button).
// RESULT (locked):  section-hero[light] → score-badge → chart-radar →
//   card-basic ×N (matched band) → list-group → card-cta → share-bar →
//   download-button.
//
// Score-dependent blocks (score-badge color/label, the band's card-basic ×N)
// are pre-composed PER BAND from the catalog and hidden; the client reveals the
// matched band, fills the score number, and inits the radar with the computed
// per-dimension values. Band-independent blocks (chart, recommendations, CTA,
// share, download) are composed once.

import { assembleComposition, type CompositionBlock } from './assemble';
import type { AssessmentBuildSpec, StyleChoices } from './assessment-spec-schema';
import { CATALOG } from '../component-catalog/index';
import { resolveComponentTokens, tokenClass, type ChosenTokens } from '../component-catalog/design-token-resolver';
import { resolveVendorScripts, BASE_BUNDLE_FULL } from '../component-catalog/vendor-scripts';

/** Component roles the LLM styles → their catalog component id. */
export const STYLE_ROLE_COMPONENT: Record<keyof StyleChoices, string> = {
  questions: 'radio-cards', // collect side
  hero: 'section-hero',
  interpretation_card: 'card-basic',
  recommendations: 'list-group',
  cta: 'card-cta',
  score_badge: 'score-badge',
};

/** Validate every role's token choices against its component's supported[]
 *  (no-fallbacks: throws on unknown/unsupported). Used in the generate loop. */
export function validateAssessmentStyle(style: StyleChoices | undefined): void {
  const s = style ?? {};
  for (const [role, compId] of Object.entries(STYLE_ROLE_COMPONENT)) {
    const entry = CATALOG.by_id[compId];
    if (!entry) continue;
    resolveComponentTokens(entry, (s[role as keyof StyleChoices] ?? {}) as ChosenTokens);
  }
}

/** Resolved token classes for a role (empty string if none/all-default). */
function roleClasses(style: StyleChoices, role: keyof StyleChoices): string {
  const entry = CATALOG.by_id[STYLE_ROLE_COMPONENT[role]];
  if (!entry) return '';
  return resolveComponentTokens(entry, (style[role] ?? {}) as ChosenTokens).classes;
}

export const LOCKED_ASSESSMENT_RESULT_ORDER = [
  'section-hero', // [light]
  'score-badge', // matched band
  'chart-radar', // per-dimension radar (client-computed values)
  'card-basic', // ×N — matched band interpretation_cards
  'list-group', // recommendations
  'card-cta',
  'share-bar',
  'download-button',
] as const;

/** Every component this recipe composes (result + collect + loading). The
 *  assembler derives the vendor scripts from THIS set; the LLM picks none. */
export const ASSESSMENT_COMPONENT_IDS: string[] = [
  ...LOCKED_ASSESSMENT_RESULT_ORDER,
  'wizard',
  'radio-cards',
  'spinner',
  'alert',
];

/** Render the radio_cards input HTML for one question, then apply the COLLECT
 *  token classes to the right elements: the question label (emphasis, larger +
 *  stronger — it's the primary text) and every answer button (radius). */
function questionInputHtml(
  q: AssessmentBuildSpec['questions'][number],
  labelClasses: string,
  btnClasses: string,
): string {
  const block: CompositionBlock = {
    component_id: 'radio-cards',
    slot_values: {
      label: q.label,
      name: q.id,
      id: q.id,
      options: q.options.map((o) => ({ label: o.label, value: o.value })), // points NOT in the input — scorer reads the baked spec
    },
  };
  let html = assembleComposition([block]).html;
  if (labelClasses) {
    html = html.replace('class="form-label d-block"', `class="form-label d-block ${labelClasses}"`);
  }
  if (btnClasses) {
    html = html.split('class="btn btn-outline-primary w-100 text-start p-3"').join(`class="btn btn-outline-primary w-100 text-start p-3 ${btnClasses}"`);
  }
  return html;
}

export function buildAssessmentPage(spec: AssessmentBuildSpec): {
  innerHtml: string;
  inlineScript: string;
  scripts: string[];
  componentIds: string[];
} {
  // Phase C: resolve the LLM's per-role token picks → Homer classes (validated
  // against each component's supported[]; non-default tokens only).
  const style = (spec.style ?? {}) as StyleChoices;
  const cls = {
    hero: roleClasses(style, 'hero'),
    card: roleClasses(style, 'interpretation_card'),
    list: roleClasses(style, 'recommendations'),
    cta: roleClasses(style, 'cta'),
    badge: roleClasses(style, 'score_badge'),
  };

  // COLLECT side (radio-cards): emphasis on the question LABEL (it's the primary
  // text — bump size + weight) and the radius token on the answer BUTTONS.
  const qResolved = resolveComponentTokens(
    CATALOG.by_id['radio-cards'],
    (style.questions ?? {}) as ChosenTokens,
  ).resolved;
  // fs-3 (Homer ~1.26rem) is a clear bump ABOVE body — note Homer's fs-* ramp is
  // rescaled vs Bootstrap (fs-5 = .845rem is SMALLER than body; fs-1 is largest).
  const qLabelClasses = `fs-3 ${tokenClass('emphasis', qResolved.emphasis)}`.trim();
  const qBtnClasses = tokenClass('radius', qResolved.radius);

  // Shared frame for BOTH the collect (wizard) and result content cards —
  // radius:lg + elevation:sm (rounded-3 + shadow-sm), token-derived, matching
  // the interpretation cards so the two pages read as the same app.
  const FRAME_CLASSES = [tokenClass('radius', 'lg'), tokenClass('elevation', 'sm')].filter(Boolean).join(' ');

  // ── COLLECT: hero[light] + wizard(steps grouped by question.step) ────────
  const stepNums = Array.from(new Set(spec.questions.map((q) => q.step))).sort((a, b) => a - b);
  const STEP_ICONS = ['list-check', 'adjustments', 'chart-dots', 'flag'];
  const steps = stepNums.map((stepNo, i) => {
    const qs = spec.questions.filter((q) => q.step === stepNo);
    return {
      id: `asmt-step-${i}`,
      title: `Step ${i + 1}`,
      subtitle: `${qs.length} question${qs.length === 1 ? '' : 's'}`,
      icon: STEP_ICONS[i] ?? 'list-check',
      content: qs.map((q) => questionInputHtml(q, qLabelClasses, qBtnClasses)).join('\n'),
      first: i === 0,
      hasPrev: i > 0,
      hasNext: i < stepNums.length - 1,
      last: i === stepNums.length - 1,
    };
  });

  // Hero stays ABOVE the frame; the wizard goes INSIDE a Homer card (card-basic).
  const { html: collectHeroHtml } = assembleComposition([
    { component_id: 'section-hero', slot_values: { headline: spec.hero.title, tagline: spec.hero.subtitle, light: true }, extra_classes: cls.hero },
  ]);
  const { html: collectWizardHtml } = assembleComposition([
    { component_id: 'wizard', slot_values: { steps } },
  ]);
  const { html: collectCardHtml } = assembleComposition([
    { component_id: 'card-basic', slot_values: { content: collectWizardHtml }, extra_classes: FRAME_CLASSES },
  ]);

  // ── RESULT: score-dependent blocks pre-composed PER BAND (sorted by min) ─
  const bands = [...spec.scoring.score_bands].sort((a, b) => a.min - b.min);

  // score-badge per band (number left blank → client fills the matched one)
  const bandBadges = bands
    .map((b, i) => {
      const { html } = assembleComposition([
        {
          component_id: 'score-badge',
          slot_values: { score: '', label: b.label, sublabel: spec.result.score_subtitle, variant: b.color },
          extra_classes: cls.badge,
        },
      ]);
      // Hidden via inline display:none (always wins over Bootstrap display
      // utilities); revealed by CLEARING the inline style. Fully out of flow.
      return `<div class="asmt-badge" data-band="${i}" style="display:none">${html}</div>`;
    })
    .join('\n');

  // card-basic ×N per band (matched band's interpretation_cards)
  const bandCards = bands
    .map((b, i) => {
      const cards = b.interpretation_cards
        .map((card) => assembleComposition([{ component_id: 'card-basic', slot_values: { title: card.title, content: card.body }, extra_classes: cls.card }]).html)
        .join('\n');
      // Toggled outer carries NO display-* utility (else .d-flex{!important}
      // would override the inline display:none). Flex layout lives on the inner.
      return `<div class="asmt-cards" data-band="${i}" style="display:none"><div class="d-flex flex-column gap-3">${cards}</div></div>`;
    })
    .join('\n');

  // Band-independent blocks (composed once).
  const { html: resultHeroHtml } = assembleComposition([
    { component_id: 'section-hero', slot_values: { headline: spec.result.score_label, tagline: spec.result.score_subtitle, light: true }, extra_classes: cls.hero },
  ]);
  const { html: chartHtml } = assembleComposition([
    { component_id: 'chart-radar', slot_values: { id: 'asmt-radar', height: '340px' } },
  ]);
  const { html: listHtml } = assembleComposition([
    {
      component_id: 'list-group',
      slot_values: {
        items: spec.result.recommendations.map((r) => ({ label: `[${r.priority.toUpperCase()}] ${r.title} — ${r.body}` })),
      },
      extra_classes: cls.list,
    },
  ]);
  const { html: ctaHtml } = assembleComposition([
    {
      component_id: 'card-cta',
      slot_values: {
        headline: spec.result.cta.headline,
        supporting_text: spec.result.cta.body,
        cta_url: '#',
        cta_label: spec.result.cta.cta_label,
      },
      extra_classes: cls.cta,
    },
  ]);
  const { html: shareRaw } = assembleComposition([
    {
      component_id: 'share-bar',
      slot_values: { url: '#', text: spec.hero.title, subject: spec.hero.title, body: spec.result.score_subtitle },
    },
  ]);
  // data-tx-pdf-skip: tx-pdf excludes the share row from the PDF.
  const shareHtml = `<div data-tx-pdf-skip>${shareRaw}</div>`;
  // Stamp the download anchor → tx-pdf builds a real PDF of #asmt-result on click.
  let downloadHtml = assembleComposition([
    {
      component_id: 'download-button',
      slot_values: { url: '#', label: 'Download your scorecard (PDF)', variant: 'outline-primary', download: 'download' },
    },
  ]).html;
  downloadHtml = downloadHtml.replace('<a href="#"', '<a href="#" data-tx-pdf="#asmt-result" data-tx-pdf-name="scorecard.pdf"');

  // Frame the RESULT content in a Homer card (hero stays ABOVE it), mirroring
  // the collect side. The flex layout lives inside the card-body.
  const resultInnerBlocks = [
    bandBadges, // locked order: score-badge (matched band revealed) …
    // chart-radar: hidden on load (its 340px box would otherwise occupy space
    // and push everything down). Revealed by the scorer right before painting.
    `<div id="asmt-chart" style="display:none">${chartHtml}</div>`,
    bandCards, //                … → card-basic ×N (matched band) …
    listHtml,
    ctaHtml,
    shareHtml,
    downloadHtml,
  ].join('\n');
  const { html: resultCardHtml } = assembleComposition([
    {
      component_id: 'card-basic',
      slot_values: { content: `<div class="d-flex flex-column gap-3">${resultInnerBlocks}</div>` },
      extra_classes: FRAME_CLASSES,
    },
  ]);

  const innerHtml = [
    // COLLECT: hero above, wizard inside a framed card.
    `<div id="asmt-collect">`,
    collectHeroHtml,
    collectCardHtml,
    `</div>`,
    // RESULT: hidden on load; hero above, content inside a matching framed card.
    `<div id="asmt-result" style="display:none">`,
    resultHeroHtml,
    resultCardHtml,
    `</div>`,
  ].join('\n');

  // ── Baked client scorer (trimmed spec: only what scoring needs) ──────────
  const SPEC = {
    questions: spec.questions.map((q) => ({
      id: q.id,
      dimension: q.dimension,
      options: q.options.map((o) => ({ value: o.value, points: o.points })),
    })),
    dimensions: spec.dimensions.map((d) => ({ id: d.id, label: d.label })),
    bands: bands.map((b) => ({ min: b.min, max: b.max })), // same order as the rendered .asmt-band[data-band] wrappers
  };

  const inlineScript = `
(function(){
  var SPEC = ${JSON.stringify(SPEC)};
  var collect = document.getElementById('asmt-collect');
  var result  = document.getElementById('asmt-result');
  var form = collect && collect.querySelector('form');
  if(!form){ return; }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var total = 0, byDim = {}, dimMax = {};
    SPEC.questions.forEach(function(q){
      var maxp = 0; q.options.forEach(function(o){ if(o.points > maxp) maxp = o.points; });
      dimMax[q.dimension] = (dimMax[q.dimension] || 0) + maxp;
      var sel = form.querySelector('input[name="' + q.id + '"]:checked');
      var pts = 0;
      if(sel){ var opt = null; q.options.forEach(function(o){ if(o.value === sel.value) opt = o; }); pts = opt ? opt.points : 0; }
      total += pts;
      byDim[q.dimension] = (byDim[q.dimension] || 0) + pts;
    });
    // band match (SPEC.bands pre-sorted, tiling [0, max_score])
    var idx = -1;
    for(var i = 0; i < SPEC.bands.length; i++){ if(total >= SPEC.bands[i].min && total <= SPEC.bands[i].max){ idx = i; break; } }
    if(idx < 0){ idx = SPEC.bands.length - 1; }
    collect.style.display = 'none';
    result.style.display = '';
    var badge = result.querySelector('.asmt-badge[data-band="' + idx + '"]');
    if(badge){ badge.style.display = ''; var num = badge.querySelector('.avatar-title'); if(num){ num.textContent = total; } }
    var cards = result.querySelector('.asmt-cards[data-band="' + idx + '"]');
    if(cards){ cards.style.display = ''; }
    var labels = SPEC.dimensions.map(function(d){ return d.label; });
    var values = SPEC.dimensions.map(function(d){ var mx = dimMax[d.id] || 1; return Math.round((byDim[d.id] || 0) / mx * 100); });
    // Reveal the radar container (hidden on load to avoid a 340px dead gap)
    // BEFORE painting, so Chart.js sizes the now-visible canvas correctly.
    var chartBox = document.getElementById('asmt-chart');
    if(chartBox){ chartBox.style.display = ''; }
    try {
      new CustomChartJs({ selector: '#asmt-radar', options: function(){ return {
        type: 'radar',
        data: { labels: labels, datasets: [{ label: 'Your scores', data: values,
          borderColor: ins('chart-primary'), backgroundColor: ins('chart-primary-rgb', 0.2), pointBackgroundColor: ins('chart-primary') }] },
        options: { scales: { r: { suggestedMin: 0, suggestedMax: 100 } } }
      }; } });
    } catch(err){ /* radar is non-fatal */ }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // Enter advances the wizard (and submits on the last step). We drive Homer's
  // OWN wizard API by clicking the active step's [data-wizard-next] (which is
  // bound to FormWizard.nextStep) rather than re-implementing step logic. Enter
  // inside a textarea is left alone (newline); everywhere else we preventDefault
  // so a lone text input can't implicitly submit the whole form mid-wizard.
  form.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' || e.shiftKey) return;
    if(e.target && e.target.tagName === 'TEXTAREA') return; // Enter = newline
    e.preventDefault();
    var pane = form.querySelector('.tab-pane.active');
    if(!pane) return;
    var next = pane.querySelector('[data-wizard-next]');
    if(next){ next.click(); return; }                 // advance via the wizard's API
    var submitBtn = pane.querySelector('button[type="submit"]');
    if(submitBtn){ submitBtn.click(); return; }        // last step → submit
    if(form.requestSubmit){ form.requestSubmit(); } else { form.submit(); }
  });
})();
`.trim();

  // Assembler-derived vendor scripts (LLM picks none): union of the composed
  // components' js_dependencies → validated against the base bundle → ordered
  // add-on srcs. Throws at build if a dep is unknown or unmet by the base.
  const scripts = resolveVendorScripts(ASSESSMENT_COMPONENT_IDS, BASE_BUNDLE_FULL);

  return { innerHtml, inlineScript, scripts, componentIds: ASSESSMENT_COMPONENT_IDS };
}

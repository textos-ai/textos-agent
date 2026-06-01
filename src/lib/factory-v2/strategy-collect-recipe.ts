// factory-v2 — Strategy COLLECT recipe (the running wizard) — Step B.
//
// PART 1 (lock): the COLLECT surface is composed 100% from catalog components:
//   section-hero[light]  → its own hero (hero on BOTH pages, per Rob)
//   wizard               → Homer multi-step shell (progress + Back/Next + Submit)
//                          with ONE catalog input per step:
//                            text     → text-input
//                            textarea → textarea
//                            radio    → radio-cards (visual cards)
//
// The §13 live-contract question SHAPE (id/type/text/placeholder/options) drives
// each step; the question CONTENT mirrors the live contract's Strategy example
// (the Whitmore & Boudreaux / event-planning question set in strategy-live-
// prompt.ts), so a visitor reproduces that scenario with their OWN answers.
//
// No hand-written app HTML: every block's HTML comes from a catalog template.
// The only non-component markup is the page scaffolding (collect/loading/result
// mount points) — the same class of structural frame as the document shell.

import { assembleComposition, type CompositionBlock } from './assemble';

export interface CollectOption {
  label: string;
  value: string;
  icon?: string;
  description?: string;
}
export interface CollectQuestion {
  id: string;
  type: 'text' | 'textarea' | 'radio';
  text: string;
  placeholder?: string;
  /** short wizard-tab label + Tabler icon for the step header */
  step_title: string;
  step_icon: string;
  options?: CollectOption[];
}

// §13 Strategy questions (content mirrors the live contract example).
export const STRATEGY_COLLECT_QUESTIONS: CollectQuestion[] = [
  {
    id: 'org',
    type: 'text',
    text: 'Company / organization hosting the event',
    placeholder: 'e.g. Whitmore & Boudreaux',
    step_title: 'Host',
    step_icon: 'building',
  },
  {
    id: 'venue',
    type: 'text',
    text: 'Neighborhood or venue (Greater New Orleans)',
    placeholder: 'e.g. Warehouse District — our office loft',
    step_title: 'Venue',
    step_icon: 'map-pin',
  },
  {
    id: 'vision',
    type: 'textarea',
    text: 'The holiday gathering you’re picturing',
    placeholder: 'Mood, headcount, what makes the charcuterie the talking point…',
    step_title: 'Vision',
    step_icon: 'sparkles',
  },
  {
    id: 'guests',
    type: 'radio',
    text: 'Approximate guest count',
    step_title: 'Guests',
    step_icon: 'users',
    options: [
      { label: 'Under 30', value: 'under-30', icon: 'user' },
      { label: '30–60', value: '30-60', icon: 'users' },
      { label: '60–150', value: '60-150', icon: 'users-group' },
      { label: '150+', value: '150-plus', icon: 'building-community' },
    ],
  },
  {
    id: 'experience',
    type: 'radio',
    text: 'Which charcuterie experience best fits the event',
    step_title: 'Style',
    step_icon: 'tools-kitchen-2',
    options: [
      { label: 'Drop-off boards', value: 'drop-off', icon: 'package', description: 'We deliver; you self-serve.' },
      { label: 'Staffed grazing station', value: 'staffed-station', icon: 'chef-hat', description: 'On-site attendant plates & replenishes.' },
      { label: 'Plated charcuterie course', value: 'plated', icon: 'tools-kitchen-2', description: 'Seated, coursed service.' },
      { label: 'Grazing table + bar', value: 'table-bar', icon: 'glass-cocktail', description: 'Full spread plus a pairing bar.' },
    ],
  },
  {
    id: 'event_date',
    type: 'text',
    text: 'Event date',
    placeholder: 'e.g. December 18',
    step_title: 'Date',
    step_icon: 'calendar-event',
  },
  {
    id: 'priorities',
    type: 'textarea',
    text: 'Priorities / constraints',
    placeholder: 'Budget, dietary needs, heritage touches, past disappointments…',
    step_title: 'Priorities',
    step_icon: 'list-check',
  },
];

const COLLECT_HERO = {
  headline: 'Plan Your Holiday Charcuterie',
  tagline: 'Answer a few quick questions and we’ll build your custom grazing-table game plan.',
};

/** Build the catalog block for one question's input. */
function inputBlockFor(q: CollectQuestion): CompositionBlock {
  if (q.type === 'text') {
    return {
      component_id: 'text-input',
      slot_values: { id: q.id, name: q.id, label: q.text, placeholder: q.placeholder ?? '', required: 'required' },
    };
  }
  if (q.type === 'textarea') {
    return {
      component_id: 'textarea',
      slot_values: { id: q.id, name: q.id, label: q.text, placeholder: q.placeholder ?? '', rows: 4 },
    };
  }
  // radio → radio-cards
  return {
    component_id: 'radio-cards',
    slot_values: { label: q.text, name: q.id, id: q.id, options: q.options ?? [] },
  };
}

/**
 * Assemble the full COLLECT inner HTML (hero + wizard) from the catalog, plus
 * the page scaffolding (loading + result mount points) and the client wizard
 * script. Returns { innerHtml, inlineScript } for the document shell.
 *
 * opts.postUrl — absolute URL the wizard POSTs answers to. REQUIRED for the
 * published /sites/ app: inside the apps-shell iframe the document is loaded
 * via srcdoc, so `window.location` is `about:srcdoc` and a relative POST would
 * fail. When omitted (the /dev/ same-origin pages), it falls back to
 * window.location.pathname.
 */
export function buildStrategyCollectPage(
  opts: { postUrl?: string } = {},
): { innerHtml: string; inlineScript: string } {
  const n = STRATEGY_COLLECT_QUESTIONS.length;

  // 1. Each question → its catalog input HTML (rendered first, injected raw
  //    into the wizard step's content slot).
  const steps = STRATEGY_COLLECT_QUESTIONS.map((q, i) => {
    const { html: inputHtml } = assembleComposition([inputBlockFor(q)]);
    return {
      id: `fv2-step-${i}`,
      title: q.step_title,
      subtitle: `Step ${i + 1} of ${n}`,
      icon: q.step_icon,
      content: inputHtml,
      first: i === 0,
      hasPrev: i > 0,
      hasNext: i < n - 1,
      last: i === n - 1,
    };
  });

  // 2. Compose hero[light] + wizard from the catalog.
  const collectBlocks: CompositionBlock[] = [
    { component_id: 'section-hero', slot_values: { headline: COLLECT_HERO.headline, tagline: COLLECT_HERO.tagline, light: true } },
    { component_id: 'wizard', slot_values: { steps } },
  ];
  const { html: collectHtml } = assembleComposition(collectBlocks);

  // 3. Loading state — composed from catalog (spinner + alert).
  const { html: loadingHtml } = assembleComposition([
    { component_id: 'spinner', slot_values: { style: 'border', variant: 'primary' } },
    { component_id: 'alert', slot_values: { variant: 'light', message: 'Building your custom grazing-table game plan…', icon: 'sparkles' } },
  ]);

  const innerHtml = [
    `<div id="fv2-collect">${collectHtml}</div>`,
    `<div id="fv2-loading" class="d-none text-center py-4">${loadingHtml}</div>`,
    `<div id="fv2-result"></div>`,
  ].join('\n');

  // Question id→text map for the client to assemble {question, answer} pairs.
  const qMeta = STRATEGY_COLLECT_QUESTIONS.map((q) => ({ id: q.id, text: q.text }));

  const inlineScript = `
(function(){
  var QUESTIONS = ${JSON.stringify(qMeta)};
  var POST_URL = ${JSON.stringify(opts.postUrl ?? null)} || window.location.pathname;
  var collect = document.getElementById('fv2-collect');
  var loading = document.getElementById('fv2-loading');
  var result  = document.getElementById('fv2-result');
  var form = collect && collect.querySelector('form');
  if(!form){ return; }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }
  function answerFor(q){
    var checked = form.querySelector('input[name="'+q.id+'"]:checked');
    if(checked){
      var lbl = form.querySelector('label[for="'+checked.id+'"]');
      var title = lbl && lbl.querySelector('.fw-semibold');
      return (title ? title.textContent : (lbl ? lbl.textContent : checked.value)).trim().replace(/\\s+/g,' ');
    }
    var el = form.querySelector('[name="'+q.id+'"]');
    return el ? (el.value||'').trim() : '';
  }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var answers = QUESTIONS.map(function(q){ return { question: q.text, answer: answerFor(q) }; });
    collect.classList.add('d-none');
    loading.classList.remove('d-none');
    fetch(POST_URL, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ answers: answers })
    }).then(function(r){ return r.text().then(function(t){ return { ok:r.ok, t:t }; }); })
      .then(function(res){
        loading.classList.add('d-none');
        if(!res.ok){ result.innerHTML = '<div class="alert alert-danger">Generation failed — '+esc(res.t).slice(0,400)+'</div>'; return; }
        result.innerHTML = res.t; // result carries its OWN hero + Download (revealed only now)
        window.scrollTo({ top:0, behavior:'smooth' });
      })
      .catch(function(err){
        loading.classList.add('d-none');
        result.innerHTML = '<div class="alert alert-danger">Network error — '+esc(String(err))+'</div>';
      });
  });
})();
`.trim();

  return { innerHtml, inlineScript };
}

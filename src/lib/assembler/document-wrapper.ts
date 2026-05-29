// Document wrapper — composes the full HTML document around the
// per-phase chunks. Pulls in Homer's CSS + JS bundles using absolute
// URLs (srcdoc-iframe origin is opaque, so relative paths don't resolve
// against the parent host), plus per-archetype dependencies.

import type { Archetype } from '../archetypes/index';
import { CATALOG } from '../component-catalog/index';
import { emitEventTrackingScript } from './event-tracking';
import { emitScoringScript } from './scoring';
import { emitCalculatorScript } from './calculation';
import { buildPdfBlock } from './pdf-block';
import type { AssemblerInput, AssemblyManifest } from './types';

export interface DocumentWrapperInput {
  archetype: Archetype;
  validated_content: any;
  input: AssemblerInput;
  manifest: AssemblyManifest;
  /** Pre-rendered per-phase HTML chunks (already wrapped in <section>s). */
  phase_chunks: string[];
}

/** Build the JS dependency list from the rendered catalog components. */
function jsDependencies(manifest: AssemblyManifest): string[] {
  const deps = new Set<string>();
  for (const id of manifest.rendered_components) {
    const cat = CATALOG.by_id[id];
    if (!cat) continue;
    for (const dep of cat.js_dependencies) {
      // Catalog js_dependencies entries are either '/homer/js/...' paths
      // or human-readable "Library (plugins/.../)" descriptors. We keep
      // only the path form and let the visitor's browser load them.
      if (dep.startsWith('/homer/')) deps.add(dep);
    }
  }
  return [...deps];
}

export function wrapDocument(d: DocumentWrapperInput): string {
  const { archetype, validated_content, input, manifest, phase_chunks } = d;
  const fe = input.frontend_url.replace(/\/$/, '');

  const cssLinks = [
    `${fe}/homer/css/vendors.min.css`,
    `${fe}/homer/css/app.min.css`,
  ];

  const archetypeJsDeps = jsDependencies(manifest);
  const jsScripts = [
    `${fe}/homer/js/vendors.min.js`,
    `${fe}/homer/js/app.mini.js`,
    ...archetypeJsDeps.map((d) => `${fe}${d}`),
  ];

  manifest.css_dependencies = cssLinks;
  manifest.js_dependencies = jsScripts;

  const pdfBlock = buildPdfBlock({
    accent_hex: input.business_context.accent_color_hex,
    business_name: input.business_context.name,
    business_url: `${fe}/sites/${input.business_context.slug}/`,
  });

  // Archetype-specific runtime script.
  let runtimeScript = '';
  if (archetype.id === 'assessment') {
    runtimeScript = emitScoringScript(validated_content);
  } else if (archetype.id === 'calculator') {
    runtimeScript = emitCalculatorScript(validated_content);
  }

  const eventScript = emitEventTrackingScript({
    api_base: input.api_base,
    app_id: input.app_id,
  });

  const orchestration = emitOrchestrationScript(archetype);

  return [
    '<!DOCTYPE html>',
    '<html lang="en" data-skin="default">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escapeHtml(archetype.name)} · ${escapeHtml(input.business_context.name)}</title>`,
    ...cssLinks.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`),
    '</head>',
    '<body>',
    '<div class="container my-4 my-md-5" style="max-width: 720px">',
    ...phase_chunks,
    '</div>',
    ...jsScripts.map((src) => `<script src="${escapeAttr(src)}"></script>`),
    '<script>',
    eventScript,
    '</script>',
    runtimeScript ? `<script>\n${runtimeScript}\n</script>` : '',
    `<script>\n${orchestration}\n</script>`,
    pdfBlock,
    '</body>',
    '</html>',
  ].filter(Boolean).join('\n');
}

/** Emit the small phase-orchestration script that wires submit → paywall
 *  → result. Independent of archetype-specific scoring/calc logic. */
function emitOrchestrationScript(archetype: Archetype): string {
  const archId = JSON.stringify(archetype.id);
  return `
// ── Phase orchestration (emitted by assembler) ─────────────────────
(function () {
  var EV = (window.__txAssembler && window.__txAssembler.events) || { emit: function () {} };
  var ARCHETYPE = ${archId};

  function findPhase(id) { return document.querySelector('.tx-phase-' + id); }
  function show(id)   { var n = findPhase(id); if (n) n.hidden = false; }
  function hide(id)   { var n = findPhase(id); if (n) n.hidden = true;  }

  // Wizard advance / back wiring.
  document.querySelectorAll('[data-step-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var step = btn.closest('.tx-wizard-step');
      if (!step) return;
      var action = btn.getAttribute('data-step-action');
      var siblings = Array.from(step.parentNode.querySelectorAll('.tx-wizard-step'));
      var idx = siblings.indexOf(step);
      var next = action === 'next' ? idx + 1 : idx - 1;
      if (next < 0 || next >= siblings.length) return;
      step.hidden = true;
      siblings[next].hidden = false;
      EV.emit('wizard_step_complete', 'inputs', { from: idx + 1, to: next + 1 });
    });
  });

  // Inputs phase change events.
  document.querySelectorAll('.tx-phase-inputs input, .tx-phase-inputs textarea, .tx-phase-inputs select').forEach(function (el) {
    el.addEventListener('change', function () {
      EV.emit('field_change', 'inputs', { id: el.id || el.name || null });
    });
  });

  // Submit button(s) inside the inputs phase reveal the paywall.
  document.querySelectorAll('.tx-phase-inputs button[type="button"], .tx-phase-inputs button:not([type])').forEach(function (btn) {
    // Skip wizard-internal next/back buttons (they have data-step-action).
    if (btn.hasAttribute('data-step-action')) return;
    btn.addEventListener('click', function () {
      // Run archetype-specific synthesis before revealing the paywall, so
      // teaser content can use computed values.
      try {
        if (ARCHETYPE === 'assessment' && window.__txAssembler && window.__txAssembler.scoring) {
          var responses = {};
          document.querySelectorAll('.tx-phase-inputs input[type=radio]:checked').forEach(function (i) {
            responses[i.name] = i.value;
          });
          window.__txAssembler.computed = window.__txAssembler.scoring.run(responses);
        } else if (ARCHETYPE === 'calculator' && window.__txAssembler && window.__txAssembler.calculator) {
          window.__txAssembler.computed = window.__txAssembler.calculator.run();
        }
      } catch (e) {
        console.warn('[tx-orchestration] computed synthesis failed', e);
      }
      EV.emit('paywall_shown', 'paywall', {});
      hide('inputs');
      show('paywall');
    });
  });

  // Paywall submit (email form) reveals the result.
  // Bug 3: the paywall CTA renders as <button type="submit"> with no wrapping
  // <form>, so the old type==='button'-only check never wired it and the
  // result never revealed. Handle type==='submit' too (preventDefault so a
  // bare submit button outside a form doesn't attempt navigation).
  document.querySelectorAll('.tx-phase-paywall form, .tx-phase-paywall button').forEach(function (el) {
    if (el.tagName === 'BUTTON' && (el.type === 'button' || el.type === 'submit')) {
      el.addEventListener('click', function (e) { e.preventDefault(); unlock(); });
    } else if (el.tagName === 'FORM') {
      el.addEventListener('submit', function (e) { e.preventDefault(); unlock(); });
    }
  });

  function unlock() {
    var email = (document.querySelector('.tx-phase-paywall input[type=email]') || {}).value || null;
    EV.emit('paywall_submit', 'paywall', { email: email });
    // Submissions endpoint is wired in Brief D; for now fire-and-forget.
    hide('paywall');
    show('result');
    EV.emit('result_viewed', 'result', {});
    // Charts go here in Brief C (wired against Chart.js with the computed
    // data). For Brief B, the result-phase HTML is rendered but chart
    // canvases are blank until the next brief.
  }

  // Share + download instrumentation.
  document.querySelectorAll('.tx-phase-result [data-tx-share]').forEach(function (el) {
    el.addEventListener('click', function () { EV.emit('result_shared', 'result', { target: el.getAttribute('data-tx-share') || null }); });
  });
  document.querySelectorAll('.tx-phase-result [data-tx-download]').forEach(function (el) {
    el.addEventListener('click', function () { EV.emit('result_downloaded', 'result', {}); });
  });
  // CTA click.
  document.querySelectorAll('.tx-phase-result .card-cta a, .tx-phase-result .card-cta button').forEach(function (el) {
    el.addEventListener('click', function () { EV.emit('cta_clicked', 'result', { href: el.getAttribute('href') || null }); });
  });
})();
`.trim();
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string { return escapeHtml(s); }

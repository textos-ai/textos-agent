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

  const orchestration = emitOrchestrationScript(archetype, input.api_base);

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
function emitOrchestrationScript(archetype: Archetype, apiBase: string): string {
  const archId = JSON.stringify(archetype.id);
  const apiBaseLit = JSON.stringify((apiBase || '').replace(/\/$/, ''));
  return `
// ── Phase orchestration (emitted by assembler) ─────────────────────
(function () {
  var EV = (window.__txAssembler && window.__txAssembler.events) || { emit: function () {} };
  var ARCHETYPE = ${archId};
  var API_BASE = ${apiBaseLit};

  function findPhase(id) { return document.querySelector('.tx-phase-' + id); }
  function show(id)   { var n = findPhase(id); if (n) n.hidden = false; }
  function hide(id)   { var n = findPhase(id); if (n) n.hidden = true;  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // The app runs in a same-origin srcdoc iframe; the visitor URL is on the
  // parent frame (/sites/{biz}/apps/{app}/). Derive the slugs from there.
  function resolveAppPath() {
    var p = '';
    try { p = window.parent.location.pathname; } catch (e) { p = window.location.pathname; }
    var m = p.match(/\\/sites\\/([^/]+)\\/apps\\/([^/]+)/);
    return m ? { bizSlug: m[1], appSlug: m[2] } : null;
  }

  function collectResponses() {
    var r = {};
    document.querySelectorAll('.tx-phase-inputs input, .tx-phase-inputs textarea, .tx-phase-inputs select').forEach(function (el) {
      if (el.type === 'radio') { if (el.checked) r[el.name] = el.value; }
      else if (el.name) { r[el.name] = el.value; }
    });
    return r;
  }

  function renderStrategyResult(root, data) {
    if (!root) return;
    var html = '';
    if (data.headline) html += '<h2 class="mb-2">' + esc(data.headline) + '</h2>';
    if (data.summary)  html += '<p class="text-muted mb-4">' + esc(data.summary) + '</p>';
    (data.sections || []).forEach(function (s) {
      html += '<div class="card mb-3"><div class="card-body">'
        + '<h5 class="card-title">' + esc(s.heading) + '</h5>'
        + '<p class="card-text">' + esc(s.body).replace(/\\n/g, '<br>') + '</p>'
        + '</div></div>';
    });
    if (data.cta && data.cta.primary_text) {
      html += '<div class="card border-primary"><div class="card-body text-center">';
      if (data.cta.primary_url) html += '<a class="btn btn-primary me-2" href="' + esc(data.cta.primary_url) + '">' + esc(data.cta.primary_text) + '</a>';
      if (data.cta.secondary_text && data.cta.secondary_url) html += '<a class="btn btn-link" href="' + esc(data.cta.secondary_url) + '">' + esc(data.cta.secondary_text) + '</a>';
      html += '</div></div>';
    }
    root.innerHTML = html;
  }

  // Wizard step navigation (tabs, progress, Next/Back) is owned by Homer's
  // form-wizard.js, which auto-inits on [data-wizard]. We no longer hand-roll
  // step show/hide here — the old [data-step-action] block was removed when
  // the renderer switched to composing the c_wizard catalog component.

  // Inputs phase change events.
  document.querySelectorAll('.tx-phase-inputs input, .tx-phase-inputs textarea, .tx-phase-inputs select').forEach(function (el) {
    el.addEventListener('change', function () {
      EV.emit('field_change', 'inputs', { id: el.id || el.name || null });
    });
  });

  // The wizard form's submit (the c_wizard template's final-step
  // type="submit" button) reveals the paywall. form-wizard.js owns step
  // navigation and only sets the progress bar to 100% on submit; we own the
  // terminal inputs→paywall transition. preventDefault stops the actual form
  // submission (we drive the flow in-page).
  document.querySelectorAll('.tx-phase-inputs form[data-wizard-validation]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (ARCHETYPE === 'strategy') {
        // GATE SEAM: result is hardwired 'free' this increment — no paywall
        // before the result. The result is generated from the visitor's
        // answers by POST .../by-slug/{app}/result and rendered in-place.
        var responses = collectResponses();
        var loc = resolveAppPath();
        var root = document.getElementById('tx-result-root');
        hide('inputs'); show('result');
        if (root) root.innerHTML = '<div class="text-center p-4"><div class="spinner-border text-primary" role="status"></div><p class="mt-3 text-muted">Building your plan…</p></div>';
        EV.emit('result_requested', 'result', {});
        if (!loc || !API_BASE) { if (root) root.innerHTML = '<p class="p-4 text-danger">Could not load your plan (missing app context).</p>'; return; }
        fetch(API_BASE + '/api/sites/' + encodeURIComponent(loc.bizSlug))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (biz) {
            if (!biz || !biz.id) throw new Error('business not found');
            return fetch(API_BASE + '/api/generated-apps/' + biz.id + '/by-slug/' + encodeURIComponent(loc.appSlug) + '/result', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ responses: responses })
            });
          })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.error || !data.headline) throw new Error((data && data.message) || 'no result');
            renderStrategyResult(root, data);
            EV.emit('result_viewed', 'result', {});
          })
          .catch(function (err) {
            if (root) root.innerHTML = '<div class="p-4 text-center"><p class="text-danger mb-1">We could not build your plan right now.</p><p class="text-muted small">Please refresh and try again.</p></div>';
            console.error('[tx] strategy result failed', err);
          });
        return;
      }

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
      } catch (e2) {
        console.warn('[tx-orchestration] computed synthesis failed', e2);
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

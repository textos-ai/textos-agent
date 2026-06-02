// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_clipboard_copy: ComponentCatalogEntry = {
  id: 'clipboard-copy',
  name: 'Copy-to-clipboard button',
  category: 'utility',
  description: 'Button that copies text from a target element to the clipboard (uses clipboard.js).',
  homer_classes: 'data-clipboard-target data-clipboard-text',
  source_page: 'misc-clipboard.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/misc-clipboard.html',
  html_template: `<button class="btn btn-sm btn-primary" data-clipboard-target="#{{target_id}}"><i class="ti ti-copy me-1"></i>{{label|Copy}}</button>
<span id="{{target_id}}">{{value}}</span>`,
  fillable_slots: ['target_id', 'value', 'label'],
  js_init: 'manual',
  js_dependencies: ['clipboard.js v2.0.11 (plugins/clipboard/)'],
  js_init_snippet: 'new ClipboardJS("[data-clipboard-target]");',
  mobile_responsive: true,
  text_mode_notes: 'No-op in text; the bot just sends the URL.',
  text_mode: 'adapted',
  reliability_tier: 'extended',
  reliability_notes: 'Not in vendors.min.js — must add clipboard.min.js script tag.',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  example_usage: 'Share-link copy.',
  capabilities: {
    when_to_use: 'A small solid button that copies a target value to the clipboard.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn btn-primary; color from variant / skin palette, not a token.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding.' },
  },
};

export const c_share_bar: ComponentCatalogEntry = {
  id: 'share-bar',
  name: 'Social share bar',
  category: 'utility',
  description: 'Row of social share buttons (X/Twitter, LinkedIn, Facebook, email, copy link).',
  homer_classes: 'btn-group btn-sm ti-brand-*',
  source_page: 'ui-buttons.html',
  source_verification: 'inferred',
  inference_confidence: 'medium',
  html_template: `<div class="d-flex gap-2 align-items-center flex-wrap">
  <span class="text-muted me-2">Share:</span>
  <a href="https://twitter.com/intent/tweet?url={{url}}&text={{text}}" class="btn btn-sm btn-outline-secondary"><i class="ti ti-brand-x"></i></a>
  <a href="https://www.linkedin.com/sharing/share-offsite/?url={{url}}" class="btn btn-sm btn-outline-secondary"><i class="ti ti-brand-linkedin"></i></a>
  <a href="https://www.facebook.com/sharer/sharer.php?u={{url}}" class="btn btn-sm btn-outline-secondary"><i class="ti ti-brand-facebook"></i></a>
  <a href="mailto:?subject={{subject}}&body={{body}}" class="btn btn-sm btn-outline-secondary"><i class="ti ti-mail"></i></a>
  <button class="btn btn-sm btn-outline-secondary" data-clipboard-text="{{url}}"><i class="ti ti-copy"></i></button>
</div>`,
  fillable_slots: ['url', 'text', 'subject', 'body'],
  js_init: 'manual',
  js_dependencies: ['clipboard.js (for copy button)'],
  // factory-v2: anchor links need no JS; copy button isn't init'd in our recipe → no add-on.
  vendor_scripts: [],
  js_init_snippet: 'new ClipboardJS("[data-clipboard-text]");',
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Bot offers share URLs as inline-keyboard buttons.',
  reliability_tier: 'core',
  reliability_notes: 'Built from Bootstrap buttons + Tabler brand icons + (optionally) clipboard.js. Not a single demo file, but each piece is verbatim.',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'A row of small outline icon-buttons for sharing a URL to social/email/clipboard.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn-outline-secondary on each icon button; 1px outline.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding on each share button.' },
  },
};

export const c_download_button: ComponentCatalogEntry = {
  id: 'download-button',
  name: 'Download button',
  category: 'utility',
  description: 'Anchor styled as button with download attribute.',
  homer_classes: 'btn btn-primary ti-download',
  source_page: 'ui-buttons.html',
  source_verification: 'inferred',
  inference_confidence: 'high',
  html_template: `<a href="{{url}}" class="btn btn-{{variant|primary}}" {{download}}><i class="ti ti-download me-1"></i>{{label|Download}}</a>`,
  fillable_slots: ['url', 'label', 'variant', 'download'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Bot sends a file or URL.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'An anchor styled as a solid button that downloads a file or opens a URL.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn btn-{variant}; color from the variant slot / skin palette, not a token.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding.' },
  },
};

export const c_collapse: ComponentCatalogEntry = {
  id: 'collapse',
  name: 'Collapse / show-more',
  category: 'utility',
  description: 'Bootstrap collapse toggle target.',
  homer_classes: 'collapse data-bs-toggle="collapse"',
  source_page: 'ui-collapse.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-collapse.html',
  html_template: `<button class="btn btn-outline-primary" data-bs-toggle="collapse" data-bs-target="#{{id}}">Show more</button>
<div class="collapse mt-2" id="{{id}}">{{slot:content}}</div>`,
  fillable_slots: ['id', 'content'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'calculator'],
  capabilities: {
    when_to_use: 'A show-more toggle: an outline button that reveals/hides a collapsing content region.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn-outline-primary trigger; 1px outline.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding on the trigger.' },
  },
};

export const c_offcanvas: ComponentCatalogEntry = {
  id: 'offcanvas',
  name: 'Offcanvas drawer',
  category: 'utility',
  description: 'Side drawer panel (left/right/top/bottom).',
  homer_classes: 'offcanvas offcanvas-start offcanvas-body',
  source_page: 'ui-offcanvas.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-offcanvas.html',
  html_template: `<button class="btn btn-primary" data-bs-toggle="offcanvas" data-bs-target="#{{id}}">{{trigger}}</button>
<div class="offcanvas offcanvas-{{position|end}}" tabindex="-1" id="{{id}}">
  <div class="offcanvas-header"><h5 class="offcanvas-title">{{title}}</h5><button type="button" class="btn-close" data-bs-dismiss="offcanvas"></button></div>
  <div class="offcanvas-body">{{slot:content}}</div>
</div>`,
  fillable_slots: ['id', 'trigger', 'title', 'content', 'position'],
  js_init: 'auto',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: [],
  capabilities: {
    when_to_use: 'A side drawer panel that slides in from an edge, opened by a solid trigger button.',
    surface: { supported: ['plain', 'card'], default: 'plain', notes: 'offcanvas panel is a plain surface; trigger is btn btn-primary.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding on the trigger button.' },
  },
};

export const c_dropdown: ComponentCatalogEntry = {
  id: 'dropdown',
  name: 'Dropdown menu',
  category: 'utility',
  description: 'Bootstrap dropdown.',
  homer_classes: 'dropdown dropdown-toggle dropdown-menu dropdown-item',
  source_page: 'ui-dropdowns.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-dropdowns.html',
  html_template: `<div class="dropdown">
  <button class="btn btn-{{variant|primary}} dropdown-toggle" data-bs-toggle="dropdown">{{label}}</button>
  <ul class="dropdown-menu">
    {{#items}}<li><a class="dropdown-item" href="{{href}}">{{label}}</a></li>{{/items}}
  </ul>
</div>`,
  fillable_slots: ['variant', 'label', 'items'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'calculator'],
  capabilities: {
    when_to_use: 'A solid toggle button that opens a menu of link items.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn btn-{variant} dropdown-toggle; color from the variant slot / skin palette, not a token.' },
    radius: { supported: ['rounded', 'pill', 'square'], default: 'rounded', notes: 'Bootstrap .btn default corner rounding on the toggle.' },
  },
};

export const c_password_strength: ComponentCatalogEntry = {
  id: 'password-strength',
  name: 'Password strength meter',
  category: 'utility',
  description: '4-segment password strength bar (Homer\'s misc-pass-meter pattern).',
  homer_classes: 'password-bar strong-bar bar-active-* password-input password-box',
  source_page: 'misc-pass-meter.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/misc-pass-meter.html',
  html_template: `<input type="password" class="form-control password-input" id="passInput">
<div class="password-bar mt-2"></div>`,
  fillable_slots: [],
  js_init: 'auto',
  js_dependencies: ['/homer/js/pages/misc-pass-meter.js'],
  js_init_snippet: '// Loaded only on misc-pass-meter page; not in app.js auto-init.',
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'extended',
  reliability_notes: 'TODO: js/pages/misc-pass-meter.js auto-runs on DOMContentLoaded if included. Mini-apps won\'t need user signup so this is probably unused.',
  archetype_fits: [],
  capabilities: {
    when_to_use: 'A password input with a 4-segment strength meter below it; no themable design surface.',
  },
};

// c_quill_editor moved to form.ts (category='form'); c_lightbox moved to
// display.ts (category='display'). Both remain in the catalog via their
// new home — by_category routes them off the entry's .category field, not
// the file location.

export const c_tour: ComponentCatalogEntry = {
  id: 'tour',
  name: 'Guided tour (TourGuide.js)',
  category: 'utility',
  description: 'Onboarding overlay walkthrough.',
  homer_classes: 'n/a (JS-driven)',
  source_page: 'misc-tour.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/misc-tour.html',
  html_template: `<!-- no markup; trigger via JS -->`,
  fillable_slots: [],
  js_init: 'manual',
  js_dependencies: ['tourguide.js (plugins/tourguidejs/)'],
  js_init_snippet: `new tourguide.TourGuideClient({}).addSteps([{ title, content, element: '#selector' }]).start();`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'experimental',
  reliability_notes: 'Probably overkill for mini-apps; could be useful for first-run hints on calculator inputs.',
  archetype_fits: [],
  capabilities: {
    when_to_use: 'A JS-driven onboarding overlay walkthrough; emits no markup, so no design tokens apply.',
  },
};

// ── Custom TextOS components (not in Homer recon) ────────────────────────

export const c_tx_bind: ComponentCatalogEntry = {
  id: 'tx-bind',
  name: 'Reactive input→output binding',
  category: 'utility',
  description: 'Live-updates a result element whenever bound inputs change. Supports expressions and formatters (number/currency/percent).',
  homer_classes: 'data-bind data-tx-output data-format',
  html_template: `<input type="number" id="{{input_id}}" name="{{input_id}}" value="{{value}}" data-bind="{{output_id}}">
<output id="{{output_id}}" data-tx-output="{{expression}}" data-format="{{format|number}}">0</output>`,
  fillable_slots: ['input_id', 'output_id', 'value', 'expression', 'format'],
  js_init: 'auto',
  js_dependencies: ['/homer/js/tx-bind.js'],
  js_init_snippet: '// Auto-initialized on DOMContentLoaded by tx-bind.js',
  mobile_responsive: true,
  text_mode: 'visual-only',
  text_mode_notes: 'Text mode: present final number, no live preview.',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS helper. Expression evaluator uses new Function() — safe in our context (LLM-generated expressions are sanitized + sandboxed).',
  source_verification: 'custom',
  archetype_fits: ['calculator'],
  example_usage: 'Calculator with live-updating projection as inputs change.',
  capabilities: {
    when_to_use: 'A reactive input→output binding that live-updates a result; a behavioral helper with no design surface of its own.',
  },
};

export const UTILITY_COMPONENTS: ComponentCatalogEntry[] = [
  c_clipboard_copy,
  c_share_bar,
  c_download_button,
  c_collapse,
  c_offcanvas,
  c_dropdown,
  c_password_strength,
  c_tour,
  c_tx_bind,
];

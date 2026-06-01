// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_alert: ComponentCatalogEntry = {
  id: 'alert',
  name: 'Alert / inline notice',
  category: 'feedback',
  description: 'Bootstrap alert in any variant, optional dismissible.',
  homer_classes: 'alert alert-* alert-dismissible',
  source_page: 'ui-alerts.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-alerts.html',
  html_template: `<div class="alert alert-{{variant|primary}} {{dismissible?alert-dismissible}}" role="alert">
  {{#icon}}<i class="ti ti-{{icon}} me-2"></i>{{/icon}}{{message}}
  {{#dismissible}}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>{{/dismissible}}
</div>`,
  fillable_slots: ['variant', 'message', 'icon', 'dismissible'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap (Alert)'],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Renders as plain text with emoji prefix.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'An inline colored notice (info/success/warning/danger), optionally dismissible.',
    surface: { supported: ['tinted'], default: 'tinted', notes: 'alert-{variant} renders bg-{color}-subtle; the color comes from the variant slot / skin palette, not a token.' },
    border: { supported: ['none', 'accent'], default: 'none', notes: 'Bootstrap alerts ship borderless; accent adds a colored left/full border (border-start border-{color}).' },
    radius: { supported: ['rounded'], default: 'rounded' },
  },
};

export const c_toast: ComponentCatalogEntry = {
  id: 'toast',
  name: 'Toast notification',
  category: 'feedback',
  description: 'Floating notification (dismissible).',
  homer_classes: 'toast toast-header toast-body toast-container',
  source_page: 'ui-notifications.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-notifications.html',
  html_template: `<div class="toast-container position-fixed top-0 end-0 p-3">
  <div id="{{id}}" class="toast" role="alert" aria-live="assertive" aria-atomic="true">
    <div class="toast-header">
      <strong class="me-auto">{{title}}</strong>
      <button type="button" class="btn-close" data-bs-dismiss="toast"></button>
    </div>
    <div class="toast-body">{{message}}</div>
  </div>
</div>`,
  fillable_slots: ['id', 'title', 'message'],
  js_init: 'manual',
  js_dependencies: ['Bootstrap'],
  js_init_snippet: 'new bootstrap.Toast(document.getElementById("{{id}}")).show();',
  mobile_responsive: true,
  text_mode_notes: 'Push notification metaphor; map to in-band confirmation message.',
  text_mode: 'adapted',
  reliability_tier: 'core',
  reliability_notes: 'Homer\'s app.js auto-constructs Toast instances on load — but to display, you still need to call .show().',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'A transient floating confirmation/notification card pinned to a screen corner.',
    surface: { supported: ['card', 'raised-card'], default: 'raised-card', notes: 'A floating card that needs to read above page content.' },
    radius: { supported: ['rounded'], default: 'rounded' },
    elevation: { supported: ['raised', 'lg'], default: 'lg', notes: 'Floating overlay — needs a pronounced shadow to lift off the page.' },
  },
};

export const c_progress_bar: ComponentCatalogEntry = {
  id: 'progress-bar',
  name: 'Progress bar',
  category: 'feedback',
  description: 'Bootstrap progress bar with optional striped/animated.',
  homer_classes: 'progress progress-bar progress-sm progress-md progress-lg',
  source_page: 'ui-progress.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-progress.html',
  html_template: `<div class="progress {{size}}" style="height:{{height|8px}};">
  <div class="progress-bar bg-{{variant|primary}} {{striped?progress-bar-striped}} {{animated?progress-bar-animated}}" role="progressbar" style="width:{{percent}}%;" aria-valuenow="{{percent}}" aria-valuemin="0" aria-valuemax="100"></div>
</div>`,
  fillable_slots: ['percent', 'variant', 'size', 'height', 'striped', 'animated'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Render as "Progress: 60%" or ascii bar.',
  reliability_tier: 'core',
  archetype_fits: ['assessment', 'calculator'],
  capabilities: {
    when_to_use: 'A horizontal track+fill bar showing percent completion (e.g. multi-step progress).',
    radius: { supported: ['rounded', 'pill'], default: 'pill', notes: 'Bootstrap progress tracks render with fully rounded (pill) ends by default.' },
  },
};

export const c_spinner: ComponentCatalogEntry = {
  id: 'spinner',
  name: 'Loading spinner',
  category: 'feedback',
  description: 'Bootstrap spinner (border or grow).',
  homer_classes: 'spinner-border spinner-grow',
  source_page: 'ui-spinners.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-spinners.html',
  html_template: `<div class="spinner-{{style|border}} text-{{variant|primary}}" role="status"><span class="visually-hidden">Loading...</span></div>`,
  fillable_slots: ['style', 'variant'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  text_mode_notes: 'In text mode: "Generating..." text.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'A small spinning loading indicator shown while async work is in flight.',
  },
};

export const c_modal: ComponentCatalogEntry = {
  id: 'modal',
  name: 'Modal',
  category: 'feedback',
  description: 'Bootstrap modal (centered, sized, scrollable variants).',
  homer_classes: 'modal modal-dialog modal-content modal-header modal-body modal-footer modal-lg modal-sm modal-dialog-centered',
  source_page: 'ui-modals.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-modals.html',
  html_template: `<div class="modal fade" id="{{id}}" tabindex="-1">
  <div class="modal-dialog {{size}} {{centered?modal-dialog-centered}}">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">{{title}}</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body">{{slot:content}}</div>
      {{#footer}}<div class="modal-footer">{{footer}}</div>{{/footer}}
    </div>
  </div>
</div>`,
  fillable_slots: ['id', 'title', 'content', 'footer', 'size', 'centered'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  example_usage: 'Email-capture modal at end of flow; share-link modal.',
  capabilities: {
    when_to_use: 'A centered overlay dialog (header + body + optional footer) over a backdrop.',
    surface: { supported: ['card', 'raised-card'], default: 'raised-card', notes: 'modal-content is a card that floats above a dimmed backdrop.' },
    radius: { supported: ['rounded', 'lg'], default: 'lg', notes: 'Dialogs read best with a larger corner radius.' },
    elevation: { supported: ['lg'], default: 'lg', notes: 'Overlay above the backdrop — strongest shadow tier.' },
  },
};

export const c_tooltip: ComponentCatalogEntry = {
  id: 'tooltip',
  name: 'Tooltip',
  category: 'feedback',
  description: 'Hover/focus tooltip via data-bs-toggle.',
  homer_classes: 'data-bs-toggle="tooltip"',
  source_page: 'ui-tooltips.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-tooltips.html',
  html_template: `<a href="#" data-bs-toggle="tooltip" data-bs-title="{{tip}}">{{label}}</a>`,
  fillable_slots: ['tip', 'label'],
  js_init: 'auto',
  js_dependencies: ['Bootstrap (Tooltip)'],
  js_init_snippet: '// Homer app.js initComponents instantiates Tooltip for every existing match on DOMContentLoaded. For dynamic content: new bootstrap.Tooltip(el)',
  mobile_responsive: true,
  text_mode: 'visual-only',
  text_mode_notes: 'Hover-only; not usable in text.',
  reliability_tier: 'core',
  archetype_fits: ['calculator'],
  example_usage: 'Inline help on form field labels.',
  capabilities: {
    when_to_use: 'A tiny hover/focus bubble with a short hint anchored to an element.',
    radius: { supported: ['sm', 'rounded'], default: 'sm', notes: 'Small bubble; modest corner rounding.' },
    elevation: { supported: ['sm'], default: 'sm', notes: 'Floating bubble — a light shadow lifts it off the anchor.' },
  },
};

export const c_popover: ComponentCatalogEntry = {
  id: 'popover',
  name: 'Popover',
  category: 'feedback',
  description: 'Larger info popup on click/hover.',
  homer_classes: 'data-bs-toggle="popover"',
  source_page: 'ui-popovers.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-popovers.html',
  html_template: `<button class="btn btn-light" data-bs-toggle="popover" data-bs-content="{{content}}" title="{{title}}">{{label}}</button>`,
  fillable_slots: ['title', 'content', 'label'],
  js_init: 'auto',
  js_dependencies: ['Bootstrap (Popover)'],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: [],
  capabilities: {
    when_to_use: 'A larger titled info popup (header + body) shown on click/hover, anchored to a trigger.',
    surface: { supported: ['card', 'raised-card'], default: 'raised-card', notes: 'A floating card-like bubble with a header and body.' },
    radius: { supported: ['sm', 'rounded'], default: 'rounded' },
    elevation: { supported: ['sm', 'raised'], default: 'raised', notes: 'Floating overlay above its trigger.' },
  },
};

export const c_sweetalert: ComponentCatalogEntry = {
  id: 'sweetalert',
  name: 'SweetAlert dialog',
  category: 'feedback',
  description: 'Rich modal alert (confirm, prompt, success, error).',
  homer_classes: 'n/a (JS-generated)',
  source_page: 'misc-sweet-alerts.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/misc-sweet-alerts.html',
  html_template: `<!-- no markup; invoke via JS -->`,
  fillable_slots: ['title', 'text', 'icon', 'confirmButtonText'],
  js_init: 'manual',
  js_dependencies: ['sweetalert2 v11.22.0 (in plugins/sweetalert2/)'],
  js_init_snippet: `Swal.fire({ title: '{{title}}', text: '{{text}}', icon: '{{icon}}', buttonsStyling: false, customClass: { confirmButton: 'btn btn-primary' } });`,
  mobile_responsive: true,
  text_mode_notes: 'Use for confirmation flows in web; map to plain Q&A in text.',
  text_mode: 'adapted',
  reliability_tier: 'extended',
  reliability_notes: 'Not bundled in vendors.min.js; must load sweetalert2.min.js separately.',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  example_usage: 'Email capture before download; "Are you sure?" confirmations.',
  capabilities: {
    when_to_use: 'A rich JS-generated confirm/prompt/success/error dialog (Swal.fire) — markup and styling are owned by the library.',
  },
};

export const c_placeholder_skeleton: ComponentCatalogEntry = {
  id: 'placeholder-skeleton',
  name: 'Placeholder / skeleton loader',
  category: 'feedback',
  description: 'Animated gray-bar skeleton while content loads.',
  homer_classes: 'placeholder placeholder-glow col-*',
  source_page: 'ui-placeholders.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-placeholders.html',
  html_template: `<p class="card-text placeholder-glow">
  {{#bars}}<span class="placeholder col-{{width}}"></span>{{/bars}}
</p>`,
  fillable_slots: ['bars'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'Animated gray placeholder bars standing in for content while it loads.',
    radius: { supported: ['square', 'rounded'], default: 'rounded', notes: 'Placeholder bars can be rendered square or with rounded ends.' },
  },
};

export const FEEDBACK_COMPONENTS: ComponentCatalogEntry[] = [
  c_alert,
  c_toast,
  c_progress_bar,
  c_spinner,
  c_modal,
  c_tooltip,
  c_popover,
  c_sweetalert,
  c_placeholder_skeleton,
];

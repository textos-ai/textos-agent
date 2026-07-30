// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_card_basic: ComponentCatalogEntry = {
  id: 'card-basic',
  name: 'Basic card',
  category: 'display',
  description: 'Bootstrap card with optional header, body, footer.',
  homer_classes: 'card card-header card-body card-footer card-title',
  source_page: 'ui-cards.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-cards.html',
  html_template: `<div class="card">
  {{#header}}<div class="card-header"><h5 class="card-title mb-0">{{header}}</h5></div>{{/header}}
  <div class="card-body">
    {{#title}}<h{{heading_level|5}} class="card-title mb-2">{{title}}</h{{heading_level|5}}>{{/title}}
    {{slot:content}}
  </div>
  {{#footer}}<div class="card-footer">{{footer}}</div>{{/footer}}
</div>`,
  fillable_slots: ['header', 'title', 'content', 'footer', 'heading_level'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Renders as a message section with title + body.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator', 'site'],
  capabilities: {
    when_to_use: 'The default container for a titled chunk of content (a result section, an interpretation block).',
    surface: { supported: ['card', 'raised-card', 'tinted'], default: 'card' },
    elevation: { supported: ['flat', 'sm', 'raised', 'lg'], default: 'flat', notes: 'Bootstrap .card ships flat; add .shadow* to lift.' },
    radius: { supported: ['square', 'sm', 'rounded', 'lg', 'xl'], default: 'rounded' },
    border: { supported: ['none', 'hairline', 'accent'], default: 'hairline', notes: 'border-0 for seamless on a tinted bg.' },
    emphasis: { supported: ['default', 'strong', 'feature'], default: 'strong', notes: 'card-title (h5) — strong; feature for a hero-card.' },
  },
};

export const c_card_cta: ComponentCatalogEntry = {
  id: 'card-cta',
  name: 'CTA card',
  category: 'display',
  description: 'Card containing centered headline, supporting copy, and a single primary action.',
  homer_classes: 'card card-body text-center btn btn-primary',
  source_page: 'landing.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/landing.html',
  html_template: `<div class="card border-0 bg-primary-subtle">
  <div class="card-body text-center p-4">
    <h{{heading_level|3}} class="fw-bold mb-2">{{headline}}</h{{heading_level|3}}>
    <p class="text-muted mb-3">{{supporting_text}}</p>
    <a href="{{cta_url}}" class="btn btn-primary rounded-pill">{{cta_label}}</a>
  </div>
</div>`,
  fillable_slots: ['headline', 'supporting_text', 'cta_url', 'cta_label', 'heading_level'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Renders as a paragraph + inline-keyboard button.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator', 'site'],
  example_usage: 'End-of-flow upsell ("Book a call", "Get the full report").',
  capabilities: {
    when_to_use: 'A centered conversion block: headline + supporting line + one primary button. End-of-flow.',
    surface: { supported: ['tinted', 'card', 'raised-card'], default: 'tinted', notes: 'bg-{color}-subtle; the color comes from the skin palette (variant), not a token.' },
    border: { supported: ['none', 'hairline'], default: 'none' },
    radius: { supported: ['rounded', 'lg', 'xl'], default: 'rounded', notes: 'the CTA button itself is pill.' },
    elevation: { supported: ['flat', 'sm', 'raised'], default: 'flat' },
    emphasis: { supported: ['strong', 'feature'], default: 'feature', notes: 'headline (h3 fw-bold).' },
  },
};

export const c_card_pricing: ComponentCatalogEntry = {
  id: 'card-pricing',
  name: 'Pricing card / Plan card',
  category: 'display',
  description: 'Tiered plan card: title + price + feature list (check/x icons) + footer CTA.',
  homer_classes: 'card card-body card-footer list-unstyled ti-check ti-x',
  source_page: 'pages-pricing.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/pages-pricing.html',
  html_template: `<div class="card h-100 bg-light bg-opacity-50 border-light rounded-4">
  <div class="card-body p-4 text-center">
    <h3 class="fw-bold mb-1">{{title}}</h3>
    <p class="text-muted mb-0">{{subtitle}}</p>
    <div class="my-4">
      <h1 class="display-6 fw-bold mb-0">{{price}}</h1>
      <small class="d-block text-muted">{{price_meta}}</small>
    </div>
    <ul class="list-unstyled text-start fs-sm fw-medium mb-0">
      {{#features}}<li class="mb-2"><i class="ti ti-{{included?check text-success:x text-danger}} me-2 fs-5"></i>{{label}}</li>{{/features}}
    </ul>
  </div>
  <div class="card-footer bg-transparent px-4 py-4">
    <a href="{{cta_url}}" class="btn btn-{{variant|primary}} w-100 fw-semibold rounded-pill">{{cta_label}}</a>
  </div>
  {{#badge}}<span class="position-absolute top-0 start-50 translate-middle-x badge bg-primary-subtle text-primary rounded-pill px-3 py-1 mt-3">{{badge}}</span>{{/badge}}
</div>`,
  fillable_slots: ['title', 'subtitle', 'price', 'price_meta', 'features', 'cta_url', 'cta_label', 'badge', 'variant'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy'],
  capabilities: {
    when_to_use: 'A tiered plan/pricing card: title + price + check/x feature list + footer CTA, optional ribbon badge.',
    surface: { supported: ['card', 'tinted', 'raised-card'], default: 'card', notes: 'bg-light bg-opacity-50; tinted via the variant CTA color from the skin palette.' },
    radius: { supported: ['rounded', 'lg', 'xl'], default: 'xl', notes: 'rounded-4 outer corners; footer button and badge are pill.' },
    border: { supported: ['none', 'hairline', 'accent'], default: 'hairline', notes: 'border-light; accent to mark the featured/selected plan.' },
    elevation: { supported: ['flat', 'sm', 'raised', 'lg'], default: 'flat', notes: 'add .shadow* to make the recommended plan pop.' },
    emphasis: { supported: ['strong', 'feature'], default: 'feature', notes: 'price is display-6 fw-bold; title is h3 fw-bold.' },
  },
};

export const c_list_group: ComponentCatalogEntry = {
  id: 'list-group',
  name: 'List group',
  category: 'display',
  description: 'Styled vertical list with optional icon, badge, active state.',
  homer_classes: 'list-group list-group-item',
  source_page: 'ui-list-group.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-list-group.html',
  html_template: `<ul class="list-group">
  {{#items}}
  <li class="list-group-item {{active?active}} {{disabled?disabled}} d-flex justify-content-between align-items-center">
    <span>{{#icon}}<i class="ti ti-{{icon}} me-1 fs-xl align-middle"></i>{{/icon}}{{label}}</span>
    {{#badge}}<span class="badge text-bg-{{badgeVariant|primary}}">{{badge}}</span>{{/badge}}
  </li>
  {{/items}}
</ul>`,
  fillable_slots: ['items'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Bulleted text list.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator', 'site'],
  example_usage: 'Recommendations list, breakdown items, action items.',
  capabilities: {
    when_to_use: 'A vertical list of items (recommendations, action items, breakdowns), optional per-item badge.',
    border: { supported: ['hairline', 'none'], default: 'hairline', notes: 'list-group-item dividers; none = flush variant.' },
    radius: { supported: ['rounded', 'square'], default: 'rounded', notes: 'outer corners of the group.' },
    surface: { supported: ['card', 'plain'], default: 'card', notes: 'item background.' },
    elevation: { supported: ['flat', 'sm'], default: 'flat' },
  },
};

export const c_timeline: ComponentCatalogEntry = {
  id: 'timeline',
  name: 'Timeline',
  category: 'display',
  description: 'Vertical timeline with timestamp, colored dot, and content.',
  homer_classes: 'timeline timeline-item timeline-time timeline-dot timeline-content',
  source_page: 'pages-timeline.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/pages-timeline.html',
  html_template: `<div class="timeline">
  {{#items}}
  <div class="timeline-item d-flex align-items-stretch">
    <div class="timeline-time pe-3 text-muted">{{time}}</div>
    <div class="timeline-dot bg-{{variant|primary}}"></div>
    <div class="timeline-content ps-3 pb-4">
      {{#title}}<h5 class="mb-1">{{title}}</h5>{{/title}}
      <p class="mb-0">{{content}}</p>
    </div>
  </div>
  {{/items}}
</div>`,
  fillable_slots: ['items'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy'],
  capabilities: {
    when_to_use: 'A vertical sequence of timestamped events with a colored dot per item (roadmap, history, steps).',
    surface: { supported: ['plain'], default: 'plain', notes: 'timeline items sit flush; the dot color comes from the variant slot (skin palette).' },
    emphasis: { supported: ['default', 'strong'], default: 'strong', notes: 'item title is an h5; body is default body copy.' },
  },
};

export const c_badge: ComponentCatalogEntry = {
  id: 'badge',
  name: 'Badge',
  category: 'display',
  description: 'Inline status/count chip.',
  homer_classes: 'badge text-bg-* badge-soft-* badge-outline-* rounded-pill',
  source_page: 'ui-badges.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-badges.html',
  html_template: `<span class="badge {{style|text-bg-primary}} {{pill?rounded-pill}}">{{label}}</span>`,
  fillable_slots: ['label', 'style', 'pill'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator', 'site'],
  capabilities: {
    when_to_use: 'A small inline status/count chip beside a label or heading.',
    surface: { supported: ['tinted'], default: 'tinted', notes: 'text-bg-* / badge-soft-* — color comes from the style slot (skin palette).' },
    radius: { supported: ['sm', 'rounded', 'pill'], default: 'sm', notes: 'Bootstrap .badge ships tight-rounded; add the pill flag for rounded-pill.' },
    emphasis: { supported: ['strong'], default: 'strong', notes: 'badge text is a bold small label.' },
  },
};

export const c_score_badge: ComponentCatalogEntry = {
  id: 'score-badge',
  name: 'Large score badge (circle avatar style)',
  category: 'display',
  description: 'Large circular badge with number — uses .avatar-title.',
  homer_classes: 'avatar avatar-xl avatar-title rounded-circle bg-primary-subtle text-primary',
  source_page: 'ui-images.html',
  source_verification: 'inferred',
  inference_confidence: 'high',
  html_template: `<div class="text-center my-3">
  <div class="avatar mx-auto" style="width:120px;height:120px;">
    <div class="avatar-title bg-{{variant|primary}}-subtle text-{{variant|primary}} rounded-circle display-4 fw-bold">{{score}}</div>
  </div>
  {{#label}}<h5 class="mt-3 mb-0">{{label}}</h5>{{/label}}
  {{#sublabel}}<p class="text-muted mb-0">{{sublabel}}</p>{{/sublabel}}
</div>`,
  fillable_slots: ['score', 'label', 'sublabel', 'variant'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Renders as "Score: 78/100" with label.',
  reliability_tier: 'core',
  reliability_notes: 'Built from .avatar + .avatar-title primitives; not a one-shot Homer demo but uses verified Homer classes.',
  archetype_fits: ['assessment'],
  capabilities: {
    when_to_use: 'The headline metric of an Assessment result: a large circular badge with a number + band label.',
    surface: { supported: ['tinted'], default: 'tinted', notes: 'bg-{variant}-subtle; variant = the score band color (skin palette).' },
    radius: { supported: ['circle'], default: 'circle', notes: 'structurally a circular avatar.' },
    emphasis: { supported: ['feature'], default: 'feature', notes: 'the number is display-4 fw-bold — the feature type.' },
    elevation: { supported: ['flat', 'sm', 'raised'], default: 'flat' },
    style_target: 'avatar-title', // resolved classes (e.g. shadow) land on the circle, not the outer wrapper
  },
};

export const c_large_number: ComponentCatalogEntry = {
  id: 'large-number',
  name: 'Animated large number display',
  category: 'display',
  description: 'Big headline number with animated count-up on scroll (uses Homer\'s data-target observer).',
  homer_classes: 'data-target',
  source_page: 'widgets.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/widgets.html',
  html_template: `<div class="text-center">
  {{#label}}<p class="text-muted mb-1">{{label}}</p>{{/label}}
  <h1 class="display-3 fw-bold mb-0">{{prefix}}<span data-target="{{value}}">0</span>{{suffix}}</h1>
  {{#subtitle}}<p class="text-muted mt-1 mb-0">{{subtitle}}</p>{{/subtitle}}
</div>`,
  fillable_slots: ['label', 'value', 'prefix', 'suffix', 'subtitle'],
  js_init: 'auto',
  js_dependencies: [],
  js_init_snippet: '// Homer\'s App.initCounter() auto-wires [data-target] via IntersectionObserver.',
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Just the number text; animation is bonus.',
  reliability_tier: 'core',
  archetype_fits: ['calculator', 'assessment'],
  example_usage: 'Calculator result, assessment score.',
  capabilities: {
    when_to_use: 'A big animated count-up headline number (calculator result, assessment score) with optional label/subtitle.',
    surface: { supported: ['plain', 'card', 'tinted'], default: 'plain', notes: 'ships flush/centered; wrap in a card or tinted callout to frame it.' },
    emphasis: { supported: ['feature'], default: 'feature', notes: 'the number is display-3 fw-bold; labels are text-muted helper.' },
  },
};

export const c_avatar: ComponentCatalogEntry = {
  id: 'avatar',
  name: 'Avatar (icon/text/image)',
  category: 'display',
  description: 'Circular/rounded image or text/icon container.',
  homer_classes: 'avatar avatar-sm avatar-md avatar-lg avatar-xl avatar-title rounded-circle',
  source_page: 'ui-images.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-images.html',
  html_template: `<span class="avatar avatar-{{size|md}}">
  {{#src}}<img src="{{src}}" class="rounded-circle" alt="{{alt}}">{{/src}}
  {{^src}}<span class="avatar-title bg-{{variant|primary}}-subtle text-{{variant|primary}} rounded-circle">{{#icon}}<i class="ti ti-{{icon}}"></i>{{/icon}}{{^icon}}{{initials}}{{/icon}}</span>{{/src}}
</span>`,
  fillable_slots: ['size', 'src', 'alt', 'icon', 'initials', 'variant'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'A small circular image / icon / initials marker (next to a name, item, or testimonial).',
    surface: { supported: ['tinted'], default: 'tinted', notes: 'icon/initials variant uses bg-{variant}-subtle; color from the variant slot (skin palette).' },
    radius: { supported: ['circle'], default: 'circle', notes: 'rounded-circle.' },
  },
};

export const c_table_static: ComponentCatalogEntry = {
  id: 'table-static',
  name: 'Static table',
  category: 'display',
  description: 'Standard Bootstrap table; for comparison breakdowns.',
  homer_classes: 'table table-hover table-striped table-bordered table-responsive',
  source_page: 'tables-static.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/tables-static.html',
  html_template: `<div class="table-responsive">
  <table class="table table-hover align-middle mb-0">
    <thead><tr>{{#columns}}<th>{{label}}</th>{{/columns}}</tr></thead>
    <tbody>{{#rows}}<tr>{{#cells}}<td>{{value}}</td>{{/cells}}</tr>{{/rows}}</tbody>
  </table>
</div>`,
  fillable_slots: ['columns', 'rows'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode_notes: 'Narrow tables (≤3 cols) OK at 375px with .table-responsive wrap. Wide tables horizontally scroll — acceptable but not ideal.',
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['calculator', 'assessment'],
  capabilities: {
    when_to_use: 'A static data table for comparison breakdowns (columns + rows).',
    surface: { supported: ['plain', 'card'], default: 'plain', notes: 'flush table-hover rows; wrap in a card to frame.' },
    border: { supported: ['none', 'hairline'], default: 'hairline', notes: 'row dividers; table-bordered for full grid, none for borderless.' },
    emphasis: { supported: ['default', 'strong'], default: 'default', notes: 'header cells read as strong; body cells default.' },
  },
};

export const c_blockquote: ComponentCatalogEntry = {
  id: 'blockquote',
  name: 'Blockquote',
  category: 'display',
  description: 'Styled quote block.',
  homer_classes: 'card-bodyquote blockquote',
  source_page: 'ui-cards.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-cards.html',
  html_template: `<blockquote class="blockquote">
  <p>{{quote}}</p>
  {{#cite}}<footer class="blockquote-footer">{{cite}}</footer>{{/cite}}
</blockquote>`,
  fillable_slots: ['quote', 'cite'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'site'],
  capabilities: {
    when_to_use: 'A styled pull-quote with optional citation (testimonial, key statement).',
    surface: { supported: ['plain', 'tinted', 'card'], default: 'plain', notes: 'flush by default; tint or card it to set the quote apart.' },
    border: { supported: ['none', 'accent'], default: 'none', notes: 'add a left accent rule to emphasize.' },
    emphasis: { supported: ['default', 'strong', 'feature'], default: 'default', notes: 'quote is body copy; bump to feature for a hero testimonial.' },
  },
};

// ── Moved from utility.ts (entry's .category='display') ────────────────

export const c_lightbox: ComponentCatalogEntry = {
  id: 'lightbox',
  name: 'Image lightbox (GLightbox)',
  category: 'display',
  description: 'Click-to-zoom image overlay.',
  homer_classes: 'image-popup',
  source_page: 'misc-gallery.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/misc-gallery.html',
  html_template: `<a href="{{full_url}}" class="image-popup"><img src="{{thumb_url}}" alt="{{alt}}" class="img-fluid"></a>`,
  fillable_slots: ['full_url', 'thumb_url', 'alt'],
  js_init: 'manual',
  js_dependencies: ['GLightbox (plugins/glightbox/)'],
  js_init_snippet: `GLightbox({ selector: '.image-popup' });`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'extended',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'A click-to-zoom thumbnail that opens the full image in an overlay (gallery/screenshot).',
    radius: { supported: ['square', 'sm', 'rounded', 'lg'], default: 'square', notes: 'img-fluid ships unrounded; add a rounded utility to soften the thumb.' },
  },
};

export const DISPLAY_COMPONENTS: ComponentCatalogEntry[] = [
  c_card_basic,
  c_card_cta,
  c_card_pricing,
  c_list_group,
  c_timeline,
  c_badge,
  c_score_badge,
  c_large_number,
  c_avatar,
  c_table_static,
  c_blockquote,
  c_lightbox,
];

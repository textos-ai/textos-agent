// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_container: ComponentCatalogEntry = {
  id: 'container',
  name: 'Container',
  category: 'layout',
  description: 'Bootstrap responsive container wrapper.',
  homer_classes: 'container container-fluid container-xl',
  source_page: 'ui-grid.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-grid.html',
  html_template: `<div class="container{{fluid?-fluid}}">{{slot:content}}</div>`,
  fillable_slots: ['content', 'fluid'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
};

export const c_row_col: ComponentCatalogEntry = {
  id: 'row-col',
  name: 'Row + Column grid',
  category: 'layout',
  description: 'Bootstrap 12-column grid.',
  homer_classes: 'row col col-* col-lg-* g-*',
  source_page: 'ui-grid.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-grid.html',
  html_template: `<div class="row g-{{gap|3}}">
  {{#cols}}<div class="col-{{size|12}} col-md-{{md}} col-lg-{{lg}}">{{slot:content}}</div>{{/cols}}
</div>`,
  fillable_slots: ['cols', 'gap'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
};

export const c_section_hero: ComponentCatalogEntry = {
  id: 'section-hero',
  name: 'Hero section with background',
  category: 'layout',
  description: 'Full-width section with background image and centered content.',
  homer_classes: 'section-cta card-side-img card-img-overlay auth-overlay',
  source_page: 'landing.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/landing.html',
  // `light` (boolean slot): when truthy, the hero drops the dark slab and
  // renders title+tagline directly on the page background with dark text.
  // DEFAULT (slot omitted / falsy) is the original dark style
  // (#1f2933 + text-white) so every existing use is byte-identical.
  html_template: `<section class="position-relative overflow-hidden" style="background-color:{{light?transparent:#1f2933}};background-image:url({{bg_url}});background-size:cover;background-position:center;">
  <div class="d-flex align-items-center flex-column gap-3 justify-content-center text-center p-4" style="min-height:200px;">
    <h3 class="{{light?text-dark:text-white}} fw-bold mb-0">{{headline}}</h3>
    <p class="{{light?text-secondary:text-white text-opacity-75}}">{{tagline}}</p>
    {{#cta_label}}<a href="{{cta_url}}" class="btn btn-primary rounded-pill">{{cta_label}}</a>{{/cta_label}}
  </div>
</section>`,
  fillable_slots: ['bg_url', 'headline', 'tagline', 'cta_url', 'cta_label', 'height', 'light'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  example_usage: 'Result page banner.',
};

export const LAYOUT_COMPONENTS: ComponentCatalogEntry[] = [
  c_container,
  c_row_col,
  c_section_hero,
];

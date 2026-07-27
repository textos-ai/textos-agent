// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_wizard: ComponentCatalogEntry = {
  id: 'wizard',
  name: 'Multi-step wizard with progress',
  category: 'navigation',
  description: 'Homer\'s exclusive wizard: tab nav + tab-content panes + progress bar + prev/next buttons. Supports step validation.',
  homer_classes: 'ins-wizard wizard-tabs data-wizard data-wizard-nav data-wizard-content data-wizard-progress data-wizard-next data-wizard-prev',
  source_page: 'form-wizard.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-wizard.html',
  html_template: `<form data-wizard-validation>
  <div class="ins-wizard" data-wizard>
    <div class="progress mb-4" style="height: 6px;">
      <div class="progress-bar bg-primary" data-wizard-progress style="width:0%;"></div>
    </div>
    <ul class="nav nav-tabs wizard-tabs" data-wizard-nav role="tablist">
      {{#steps}}
      <li class="nav-item"><a class="nav-link {{first?active}}" data-bs-toggle="tab" href="#{{id}}">
        <span class="d-flex align-items-center">
          <i class="ti ti-{{icon}} fs-32"></i>
          <span class="flex-grow-1 ms-2 text-truncate">
            <span class="fw-semibold text-body d-block">{{title}}</span>
            <span class="fs-xxs">{{subtitle}}</span>
          </span>
        </span>
      </a></li>
      {{/steps}}
    </ul>
    <div class="tab-content pt-3" data-wizard-content>
      {{#steps}}
      <div class="tab-pane fade {{first?show active}}" id="{{id}}">
        {{slot:content}}
        <div class="d-flex justify-content-between">
          {{#hasPrev}}<button type="button" class="btn btn-secondary" data-wizard-prev>← Back</button>{{/hasPrev}}
          {{#hasNext}}<button type="button" class="btn btn-primary" data-wizard-next>Next →</button>{{/hasNext}}
          {{#last}}<button type="submit" class="btn btn-success">Submit</button>{{/last}}
        </div>
      </div>
      {{/steps}}
    </div>
  </div>
</form>`,
  fillable_slots: ['steps', 'step.id', 'step.title', 'step.subtitle', 'step.icon', 'step.content'],
  js_init: 'auto',
  js_dependencies: ['Bootstrap (Tab)', '/homer/js/pages/form-wizard.js'], // free-text (Pipeline B reads these as paths) — UNCHANGED
  vendor_scripts: ['form-wizard'], // factory-v2 vendor-script registry id (Part B)
  js_init_snippet: '// auto-instantiates on document ready for every [data-wizard]; FormWizard class defined in form-wizard.js',
  mobile_responsive: true,
  text_mode_notes: 'In text mode, each step becomes a discrete conversational turn; progress bar maps to "Step X of N".',
  text_mode: 'adapted',
  reliability_tier: 'extended',
  reliability_notes: 'Must include form-wizard.js (it is NOT in vendors.min.js, only in js/pages/). Validation requires data-wizard-validation on the parent <form>.',
  archetype_fits: ['strategy', 'assessment'],
  capabilities: {
    when_to_use: 'A guided multi-step flow with a progress bar, step nav tabs, and prev/next/submit buttons.',
    border: { supported: ['hairline', 'none'], default: 'hairline', notes: 'nav-tabs underline divider on the step row; none drops it.' },
    radius: { supported: ['rounded', 'square'], default: 'rounded', notes: 'progress bar and button corners.' },
    elevation: { supported: ['flat', 'sm'], default: 'flat' },
  },
};

export const c_tabs: ComponentCatalogEntry = {
  id: 'tabs',
  name: 'Tabs',
  category: 'navigation',
  description: 'Bootstrap nav-tabs + tab-content panes.',
  homer_classes: 'nav nav-tabs nav-pills nav-link tab-content tab-pane',
  source_page: 'ui-tabs.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-tabs.html',
  html_template: `<ul class="nav nav-tabs mb-3">
  {{#tabs}}<li class="nav-item"><a href="#{{id}}" data-bs-toggle="tab" class="nav-link {{active?active}}">{{label}}</a></li>{{/tabs}}
</ul>
<div class="tab-content">
  {{#tabs}}<div class="tab-pane fade {{active?show active}}" id="{{id}}">{{slot:content}}</div>{{/tabs}}
</div>`,
  fillable_slots: ['tabs', 'tab.id', 'tab.label', 'tab.content'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode_notes: 'Each tab becomes a sequential message.',
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'Switch between sibling panels of content under a horizontal nav-tabs bar.',
    border: { supported: ['hairline', 'none'], default: 'hairline', notes: 'nav-tabs bottom-border underline; none = borderless (nav-pills-style).' },
    radius: { supported: ['rounded', 'square'], default: 'square', notes: 'tab heads are flush/underline by default; rounded for pill-style tabs.' },
    emphasis: { supported: ['default', 'strong'], default: 'default', notes: 'active tab label weight.' },
  },
};

export const c_accordion: ComponentCatalogEntry = {
  id: 'accordion',
  name: 'Accordion',
  category: 'navigation',
  description: 'Collapsible section group (one open at a time).',
  homer_classes: 'accordion accordion-item accordion-header accordion-button accordion-collapse accordion-body',
  source_page: 'ui-accordions.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-accordions.html',
  html_template: `<div class="accordion" id="{{id}}">
  {{#items}}
  <div class="accordion-item">
    <h2 class="accordion-header"><button class="accordion-button {{open?'':collapsed}}" type="button" data-bs-toggle="collapse" data-bs-target="#{{itemId}}">{{title}}</button></h2>
    <div id="{{itemId}}" class="accordion-collapse collapse {{open?show}}" data-bs-parent="#{{id}}">
      <div class="accordion-body">{{content}}</div>
    </div>
  </div>
  {{/items}}
</div>`,
  fillable_slots: ['id', 'items', 'item.itemId', 'item.title', 'item.content', 'item.open'],
  js_init: 'noop',
  js_dependencies: ['Bootstrap'],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Use for "Show more" patterns in result analysis. In text mode, each section becomes a follow-up message.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'calculator', 'site'],
  capabilities: {
    when_to_use: 'A stack of collapsible bordered sections; "Show more" / FAQ-style disclosure.',
    border: { supported: ['hairline', 'none'], default: 'hairline', notes: 'accordion-item dividers; none = flush variant.' },
    radius: { supported: ['rounded', 'square'], default: 'rounded', notes: 'outer corners of the group.' },
    surface: { supported: ['card', 'plain'], default: 'card', notes: 'item header/body background.' },
    elevation: { supported: ['flat', 'sm'], default: 'flat' },
  },
};

export const c_pagination: ComponentCatalogEntry = {
  id: 'pagination',
  name: 'Pagination',
  category: 'navigation',
  description: 'Page-link navigation.',
  homer_classes: 'pagination page-item page-link',
  source_page: 'ui-pagination.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-pagination.html',
  html_template: `<ul class="pagination justify-content-center mb-0">
  <li class="page-item {{prevDisabled?disabled}}"><a class="page-link" href="#">Previous</a></li>
  {{#pages}}<li class="page-item {{active?active}}"><a class="page-link" href="#">{{n}}</a></li>{{/pages}}
  <li class="page-item {{nextDisabled?disabled}}"><a class="page-link" href="#">Next</a></li>
</ul>`,
  fillable_slots: ['pages', 'prevDisabled', 'nextDisabled'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: [],
  example_usage: 'Could paginate long recommendation lists; not core MVP.',
  capabilities: {
    when_to_use: 'Numbered page-link navigation for long lists (prev / pages / next).',
    border: { supported: ['hairline', 'none'], default: 'hairline', notes: 'page-item borders between links.' },
    radius: { supported: ['rounded', 'square', 'pill'], default: 'rounded', notes: 'page-link corners; pill = fully rounded pager.' },
  },
};

export const c_breadcrumb: ComponentCatalogEntry = {
  id: 'breadcrumb',
  name: 'Breadcrumb',
  category: 'navigation',
  description: 'Hierarchical path indicator.',
  homer_classes: 'breadcrumb breadcrumb-item',
  source_page: 'ui-breadcrumb.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-breadcrumb.html',
  html_template: `<ol class="breadcrumb mb-0">
  {{#items}}<li class="breadcrumb-item {{active?active}}">{{#href}}<a href="{{href}}">{{label}}</a>{{/href}}{{^href}}{{label}}{{/href}}</li>{{/items}}
</ol>`,
  fillable_slots: ['items'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'Inline hierarchical path indicator (Home / Section / Current); minimal, no box.',
  },
};

export const NAVIGATION_COMPONENTS: ComponentCatalogEntry[] = [
  c_wizard,
  c_tabs,
  c_accordion,
  c_pagination,
  c_breadcrumb,
];

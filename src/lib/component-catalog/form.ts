// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_text_input: ComponentCatalogEntry = {
  id: 'text-input',
  name: 'Text input',
  category: 'form',
  description: 'Single-line labeled text input (Bootstrap form-control).',
  homer_classes: 'form-control',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label for="{{id}}" class="form-label">{{label}}</label>
  <input type="text" class="form-control" id="{{id}}" name="{{name}}" placeholder="{{placeholder}}" {{required}}>
</div>`,
  fillable_slots: ['id', 'name', 'label', 'placeholder', 'required'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Telegram: send plain text reply. SMS: same.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'calculator'],
  capabilities: {
    when_to_use: 'A single-line free-text question (name, headline, short answer).',
    border: { supported: ['hairline'], default: 'hairline', notes: 'standard form-control 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_textarea: ComponentCatalogEntry = {
  id: 'textarea',
  name: 'Textarea',
  category: 'form',
  description: 'Multi-line text input.',
  homer_classes: 'form-control',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label for="{{id}}" class="form-label">{{label}}</label>
  <textarea class="form-control" id="{{id}}" name="{{name}}" rows="{{rows|5}}" placeholder="{{placeholder}}"></textarea>
</div>`,
  fillable_slots: ['id', 'name', 'label', 'placeholder', 'rows'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy'],
  capabilities: {
    when_to_use: 'A multi-line free-text question (open feedback, longer prose answer).',
    border: { supported: ['hairline'], default: 'hairline', notes: 'standard form-control 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_email_input: ComponentCatalogEntry = {
  id: 'email-input',
  name: 'Email input',
  category: 'form',
  description: 'Email-typed input with browser validation.',
  homer_classes: 'form-control',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label for="{{id}}" class="form-label">{{label|Email}}</label>
  <input type="email" class="form-control" id="{{id}}" name="{{name|email}}" placeholder="name@example.com" {{required}}>
</div>`,
  fillable_slots: ['id', 'name', 'label', 'required'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  example_usage: 'Email-capture field at the end of every archetype.',
  capabilities: {
    when_to_use: 'Email capture with browser-native validation — typically the lead-gen field.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'standard form-control 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_number_input: ComponentCatalogEntry = {
  id: 'number-input',
  name: 'Number input',
  category: 'form',
  description: 'Numeric input (browser type=number).',
  homer_classes: 'form-control',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label for="{{id}}" class="form-label">{{label}}</label>
  <input type="number" class="form-control" id="{{id}}" name="{{name}}" min="{{min}}" max="{{max}}" step="{{step|1}}" value="{{value}}">
</div>`,
  fillable_slots: ['id', 'name', 'label', 'min', 'max', 'step', 'value'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Telegram: numeric reply. SMS: same.',
  reliability_tier: 'core',
  archetype_fits: ['calculator'],
  capabilities: {
    when_to_use: 'A bare numeric question (quantity, age, count) with optional min/max/step.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'standard form-control 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_input_with_unit: ComponentCatalogEntry = {
  id: 'input-with-unit',
  name: 'Input with prefix/suffix unit',
  category: 'form',
  description: 'Input-group with $/€/% or unit affix (e.g. ".00", "/month").',
  homer_classes: 'input-group input-group-text',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <div class="input-group">
    {{#prefix}}<span class="input-group-text">{{prefix}}</span>{{/prefix}}
    <input type="{{type|text}}" class="form-control" name="{{name}}" value="{{value}}">
    {{#suffix}}<span class="input-group-text">{{suffix}}</span>{{/suffix}}
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'type', 'value', 'prefix', 'suffix'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'In text mode, prefix/suffix becomes part of the prompt e.g. "Reply with amount in USD".',
  reliability_tier: 'core',
  archetype_fits: ['calculator'],
  capabilities: {
    when_to_use: 'A numeric/text question that needs a currency, percent, or unit affix ($ , % , /month).',
    border: { supported: ['hairline'], default: 'hairline', notes: 'input-group + affix share the form-control 1px outline as one unit.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'group rounds the outer corners; affixes flush internally.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_select_native: ComponentCatalogEntry = {
  id: 'select-native',
  name: 'Native select',
  category: 'form',
  description: 'Bootstrap-styled native select dropdown.',
  homer_classes: 'form-select',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <select class="form-select" name="{{name}}" {{required}}>
    <option value="">{{placeholder|Select}}</option>
    {{#options}}<option value="{{value}}">{{label}}</option>{{/options}}
  </select>
</div>`,
  fillable_slots: ['label', 'name', 'options', 'placeholder', 'required'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Maps cleanly to Telegram inline keyboard with numbered options.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'A single-choice dropdown for a longer option list where buttons/cards would crowd.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'standard form-select 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-select corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_select_choices: ComponentCatalogEntry = {
  id: 'select-choices',
  name: 'Searchable select (Choices.js)',
  category: 'form',
  description: 'Enhanced single/multi-select with search, remove buttons, groups.',
  homer_classes: 'form-control data-choices',
  source_page: 'form-plugins.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-plugins.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <select class="form-control" data-choices {{multiple}} {{searchable}} name="{{name}}">
    {{#options}}<option value="{{value}}">{{label}}</option>{{/options}}
  </select>
</div>`,
  fillable_slots: ['label', 'name', 'options', 'multiple', 'searchable'],
  js_init: 'auto',
  js_dependencies: ['choices.js v11.1.0', '/homer/js/pages/form-choice.js'],
  js_init_snippet: '// auto-bootstrapped on [data-choices] when form-choice.js is loaded',
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Falls back to native list of buttons in text mode.',
  reliability_tier: 'extended',
  reliability_notes: 'Requires loading choices.min.js + Homer\'s form-choice.js init.',
  archetype_fits: ['strategy', 'assessment'],
  capabilities: {
    when_to_use: 'A searchable single/multi-select for long option lists or tag-style multi-pick.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'Choices.js wraps the form-control 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_radio_group: ComponentCatalogEntry = {
  id: 'radio-group',
  name: 'Radio button group',
  category: 'form',
  description: 'Stacked or inline radio buttons (single-select).',
  homer_classes: 'form-check form-check-input form-check-label',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  {{#options}}
  <div class="form-check {{inline?form-check-inline}}">
    <input class="form-check-input" type="radio" name="{{name}}" id="{{id}}_{{value}}" value="{{value}}">
    <label class="form-check-label" for="{{id}}_{{value}}">{{label}}</label>
  </div>
  {{/options}}
</div>`,
  fillable_slots: ['label', 'name', 'id', 'options', 'inline'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment'],
  capabilities: {
    when_to_use: 'A single-choice question with a few text options shown as native radio rows.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'form-check-input glyph outline; checked state fills with accent (skin color).' },
    radius: { supported: ['circle'], default: 'circle', notes: 'native radio glyph is circular.' },
  },
};

export const c_checkbox_group: ComponentCatalogEntry = {
  id: 'checkbox-group',
  name: 'Checkbox group',
  category: 'form',
  description: 'Multi-select via stacked checkboxes.',
  homer_classes: 'form-check form-check-input',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  {{#options}}
  <div class="form-check">
    <input class="form-check-input" type="checkbox" name="{{name}}" id="{{id}}_{{value}}" value="{{value}}">
    <label class="form-check-label" for="{{id}}_{{value}}">{{label}}</label>
  </div>
  {{/options}}
</div>`,
  fillable_slots: ['label', 'name', 'id', 'options'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['assessment'],
  capabilities: {
    when_to_use: 'A multi-choice question with a few text options shown as native checkbox rows.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'form-check-input glyph outline; checked state fills with accent (skin color).' },
    radius: { supported: ['sm'], default: 'sm', notes: 'native checkbox glyph has a tight rounded corner.' },
  },
};

export const c_btn_check_radio: ComponentCatalogEntry = {
  id: 'btn-check-radio',
  name: 'Button-style radio group',
  category: 'form',
  description: 'Radio buttons rendered as a button group (good for short choice sets).',
  homer_classes: 'btn-check btn btn-outline-* btn-group',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  <div class="btn-group" role="group" aria-label="{{label}}">
    {{#options}}
    <input type="radio" class="btn-check" name="{{name}}" id="{{id}}_{{value}}" value="{{value}}" autocomplete="off">
    <label class="btn btn-outline-primary" for="{{id}}_{{value}}">{{label}}</label>
    {{/options}}
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'id', 'options'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Best 1:1 fit for Telegram inline-keyboard rows of buttons.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment'],
  capabilities: {
    when_to_use: 'A single-choice question with short option labels shown as a segmented button group.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn-outline border; selected state → accent (skin color fill).' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default btn corners; group flattens internal joins.' },
    surface: { supported: ['plain', 'tinted'], default: 'plain', notes: 'unselected transparent; selected fills tinted skin color. Color from variant slot / skin palette.' },
    emphasis: { supported: ['default', 'strong'], default: 'default' },
  },
};

export const c_btn_check_checkbox: ComponentCatalogEntry = {
  id: 'btn-check-checkbox',
  name: 'Button-style checkbox group',
  category: 'form',
  description: 'Multi-select checkboxes rendered as a button group.',
  homer_classes: 'btn-check btn btn-outline-* btn-group',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  <div class="btn-group" role="group">
    {{#options}}
    <input type="checkbox" class="btn-check" id="{{id}}_{{value}}" value="{{value}}" autocomplete="off">
    <label class="btn btn-outline-primary" for="{{id}}_{{value}}">{{label}}</label>
    {{/options}}
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'id', 'options'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['assessment'],
  capabilities: {
    when_to_use: 'A multi-choice question with short option labels shown as a segmented button group.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn-outline border; selected state → accent (skin color fill).' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default btn corners; group flattens internal joins.' },
    surface: { supported: ['plain', 'tinted'], default: 'plain', notes: 'unselected transparent; selected fills tinted skin color. Color from variant slot / skin palette.' },
    emphasis: { supported: ['default', 'strong'], default: 'default' },
  },
};

export const c_radio_cards: ComponentCatalogEntry = {
  id: 'radio-cards',
  name: 'Visual radio cards',
  category: 'form',
  description: 'Card-shaped radio inputs with icon + title + description (one selectable visual choice).',
  homer_classes: 'btn-check card border',
  source_page: 'form-elements.html', // composition pattern; cards + btn-check both demoed there
  source_verification: 'inferred',
  inference_confidence: 'high',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  <div class="row g-2">
    {{#options}}
    <div class="col-md-{{col|6}}">
      <input type="radio" class="btn-check" name="{{name}}" id="{{id}}_{{value}}" value="{{value}}" autocomplete="off">
      <label class="btn btn-outline-primary w-100 text-start p-3" for="{{id}}_{{value}}">
        {{#icon}}<i class="ti ti-{{icon}} fs-24 d-block mb-2"></i>{{/icon}}
        <span class="fw-semibold d-block">{{label}}</span>
        {{#description}}<small class="text-muted">{{description}}</small>{{/description}}
      </label>
    </div>
    {{/options}}
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'id', 'options'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Strip to title list; LLM emits numbered options.',
  reliability_tier: 'core',
  reliability_notes: 'Pure Bootstrap composition of btn-check + card-styled label. Verified primitives exist; composition is not a single Homer demo but is canonical.',
  archetype_fits: ['strategy', 'assessment'],
  capabilities: {
    when_to_use: 'A grid of selectable visual cards (icon + title + description) for a single-choice question — the richest wizard input.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'btn-outline border; selected state → accent (skin color).' },
    radius: { supported: ['rounded', 'lg'], default: 'rounded' },
    surface: { supported: ['plain', 'card'], default: 'plain', notes: 'outline cards on the page; selection fills with the tinted skin color.' },
    emphasis: { supported: ['default', 'strong'], default: 'strong', notes: 'option title fw-semibold; description muted.' },
  },
};

export const c_range_slider: ComponentCatalogEntry = {
  id: 'range-slider',
  name: 'Range slider',
  category: 'form',
  description: 'Native HTML5 range slider (Bootstrap-styled).',
  homer_classes: 'form-range',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="mb-3">
  <label for="{{id}}" class="form-label d-flex justify-content-between">
    <span>{{label}}</span>
    <span class="badge text-bg-light" data-range-output-for="{{id}}">{{value}}</span>
  </label>
  <input type="range" class="form-range" id="{{id}}" name="{{name}}" min="{{min|0}}" max="{{max|100}}" step="{{step|1}}" value="{{value|50}}">
</div>`,
  fillable_slots: ['id', 'name', 'label', 'min', 'max', 'step', 'value'],
  js_init: 'manual',
  js_dependencies: [],
  js_init_snippet: `// wire input event to update output badge:
document.querySelectorAll('input[type=range]').forEach(r => {
  const out = document.querySelector('[data-range-output-for="' + r.id + '"]');
  if (out) r.addEventListener('input', () => out.textContent = r.value);
});`,
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Text fallback: "Reply with a number between {min} and {max}".',
  reliability_tier: 'core',
  archetype_fits: ['calculator', 'assessment'],
  capabilities: {
    when_to_use: 'A bounded numeric question best answered by dragging a value (rating, budget, %).',
    surface: { supported: ['tinted'], default: 'tinted', notes: 'live-value badge uses text-bg-light tinted chip; track color from skin.' },
    radius: { supported: ['pill'], default: 'pill', notes: 'value badge is a rounded chip; native range track has no token-mapped corner.' },
  },
};

export const c_touchspin_stepper: ComponentCatalogEntry = {
  id: 'touchspin-stepper',
  name: 'Touchspin number stepper',
  category: 'form',
  description: 'Number input with explicit +/- buttons.',
  homer_classes: 'input-group data-touchspin data-minus data-plus',
  source_page: 'form-plugins.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-plugins.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <div class="input-group" data-touchspin>
    <button type="button" class="btn btn-light" data-minus><i class="ti ti-minus"></i></button>
    <input type="number" class="form-control text-center border-0" name="{{name}}" value="{{value|1}}" min="{{min|0}}" max="{{max|100}}">
    <button type="button" class="btn btn-light" data-plus><i class="ti ti-plus"></i></button>
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'value', 'min', 'max'],
  js_init: 'auto',
  js_dependencies: [],
  js_init_snippet: '// Homer\'s app.js Plugins.initTouchSpin() auto-binds on DOMContentLoaded.',
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  reliability_notes: 'Init is part of Homer\'s default app.js — runs everywhere.',
  archetype_fits: ['calculator'],
  capabilities: {
    when_to_use: 'A small-integer quantity question where +/- tapping beats typing (cart qty, count).',
    border: { supported: ['hairline'], default: 'hairline', notes: 'input-group outer outline; center input is border-0, framed by the +/- btn-light buttons.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'group rounds outer corners.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_switch: ComponentCatalogEntry = {
  id: 'switch',
  name: 'Toggle switch',
  category: 'form',
  description: 'iOS-style toggle (boolean input).',
  homer_classes: 'form-check form-switch',
  source_page: 'form-elements.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-elements.html',
  html_template: `<div class="form-check form-switch mb-2">
  <input class="form-check-input" type="checkbox" role="switch" id="{{id}}" name="{{name}}">
  <label class="form-check-label" for="{{id}}">{{label}}</label>
</div>`,
  fillable_slots: ['id', 'name', 'label'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  text_mode_notes: 'Maps to yes/no button pair.',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'calculator'],
  capabilities: {
    when_to_use: 'A single boolean on/off question (opt-in, enable feature).',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'switch track outline; on-state fills with accent (skin color).' },
    radius: { supported: ['pill'], default: 'pill', notes: 'form-switch track is pill-shaped.' },
  },
};

export const c_flatpickr_date: ComponentCatalogEntry = {
  id: 'flatpickr-date',
  name: 'Date picker (flatpickr)',
  category: 'form',
  description: 'Calendar date picker; supports range and inline modes.',
  homer_classes: 'form-control data-provider="flatpickr"',
  source_page: 'form-plugins.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-plugins.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <input type="text" class="form-control" data-provider="flatpickr" data-date-format="{{format|d M, Y}}" {{#range}}data-range-date{{/range}} name="{{name}}" placeholder="Select date">
</div>`,
  fillable_slots: ['label', 'name', 'format', 'range'],
  js_init: 'auto',
  js_dependencies: ['flatpickr (bundled in vendors.min.js)'],
  js_init_snippet: '// auto via Homer\'s app.js Plugins.initFlatPicker',
  mobile_responsive: true,
  text_mode_notes: 'flatpickr uses native picker on mobile by default (disableMobile: true is set in app.js — TODO verify this is desired; we may want disableMobile:false).',
  text_mode: 'adapted',
  reliability_tier: 'extended',
  reliability_notes: 'TODO: app.js sets disableMobile:true forcing the JS calendar even on mobile — may cramp 375px screens.',
  archetype_fits: ['strategy', 'calculator'],
  capabilities: {
    when_to_use: 'A date (or date-range) question answered via a calendar picker.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'underlying form-control 1px outline; popover calendar styled by flatpickr.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_file_input: ComponentCatalogEntry = {
  id: 'file-input',
  name: 'File input (native)',
  category: 'form',
  description: 'Bootstrap-styled native file picker.',
  homer_classes: 'form-control',
  source_page: 'form-wizard.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-wizard.html',
  html_template: `<div class="mb-3">
  <label class="form-label">{{label}}</label>
  <input type="file" class="form-control" name="{{name}}" {{accept}} {{multiple}}>
</div>`,
  fillable_slots: ['label', 'name', 'accept', 'multiple'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  text_mode_notes: 'File upload has no text-mode equivalent.',
  reliability_tier: 'core',
  archetype_fits: [],
  example_usage: 'Could collect a logo or photo for strategy generator, but not MVP.',
  capabilities: {
    when_to_use: 'A file/image upload question (logo, photo, document).',
    border: { supported: ['hairline'], default: 'hairline', notes: 'native form-control file picker 1px outline (not a dashed dropzone).' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

export const c_form_validation_state: ComponentCatalogEntry = {
  id: 'form-validation-state',
  name: 'Form validation (Bootstrap state)',
  category: 'form',
  description: 'Adds .needs-validation/novalidate form + .is-valid/.is-invalid + feedback divs.',
  homer_classes: 'needs-validation is-valid is-invalid invalid-feedback valid-feedback',
  source_page: 'form-validation.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-validation.html',
  html_template: `<form class="needs-validation" novalidate>
  <input type="text" class="form-control" required>
  <div class="invalid-feedback">{{error_message}}</div>
  <div class="valid-feedback">{{success_message}}</div>
  <button class="btn btn-primary" type="submit">Submit</button>
</form>`,
  fillable_slots: ['error_message', 'success_message'],
  js_init: 'auto',
  js_dependencies: [],
  js_init_snippet: '// Homer\'s app.js App.initFormValidation() auto-wires .needs-validation forms.',
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'Wraps a form to show Bootstrap valid/invalid state + feedback messages on submit.',
    border: { supported: ['hairline', 'accent'], default: 'hairline', notes: 'fields use the form-control 1px outline; is-valid/is-invalid recolor to an accent state border.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'default form-control corner.' },
  },
};

export const c_submit_button: ComponentCatalogEntry = {
  id: 'submit-button',
  name: 'Submit button',
  category: 'form',
  description: 'Standard form submit button (Bootstrap btn).',
  homer_classes: 'btn btn-primary',
  source_page: 'ui-buttons.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/ui-buttons.html',
  html_template: `<button type="submit" class="btn btn-{{variant|primary}} {{size}}">{{label|Submit}}</button>`,
  fillable_slots: ['label', 'variant', 'size'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'native',
  reliability_tier: 'core',
  archetype_fits: ['strategy', 'assessment', 'calculator'],
  capabilities: {
    when_to_use: 'The primary submit/CTA action that advances or completes a form.',
    border: { supported: ['none', 'hairline'], default: 'none', notes: 'btn-primary is a solid fill (no outline); btn-outline-* variant adds a hairline.' },
    radius: { supported: ['rounded', 'pill'], default: 'rounded', notes: 'default btn corner; rounded-pill via variant for a softer CTA.' },
    surface: { supported: ['tinted'], default: 'tinted', notes: 'solid fill in the variant color. Color from variant slot / skin palette.' },
    emphasis: { supported: ['default', 'strong'], default: 'strong', notes: 'CTA label reads as a strong action.' },
  },
};

// ── Moved from utility.ts (entry's .category='form') ────────────────────

export const c_quill_editor: ComponentCatalogEntry = {
  id: 'quill-editor',
  name: 'Rich text editor (Quill)',
  category: 'form',
  description: 'WYSIWYG editor (snow or bubble theme).',
  homer_classes: 'ql-toolbar ql-container',
  source_page: 'form-quill-editor.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/form-quill-editor.html',
  html_template: `<div id="{{id}}" style="height:{{height|300px}};"></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Quill (plugins/quill/)'],
  js_init_snippet: `new Quill('#{{id}}', { theme: '{{theme|snow}}' });`,
  mobile_responsive: true,
  text_mode_notes: 'Toolbar cramped on 375px. For text input we use plain textarea instead.',
  text_mode: 'adapted',
  reliability_tier: 'experimental',
  reliability_notes: 'Not bundled in vendors.min.js; adds ~200KB. Mobile toolbar overflows. Probably overkill for MVP.',
  archetype_fits: [],
  capabilities: {
    when_to_use: 'A rich-text (formatted) long-answer question — heavier than a plain textarea.',
    border: { supported: ['hairline'], default: 'hairline', notes: 'Quill ql-toolbar + ql-container each carry a 1px outline.' },
    radius: { supported: ['rounded'], default: 'rounded', notes: 'editor container corners.' },
    elevation: { supported: ['flat'], default: 'flat' },
  },
};

// ── Custom TextOS components (not in Homer recon) ────────────────────────

export const c_star_rating: ComponentCatalogEntry = {
  id: 'star-rating',
  name: 'Star rating (1-5)',
  category: 'form',
  description: 'Custom 5-star rating input with hover preview. Built from btn-check radios + Tabler star icons.',
  homer_classes: 'tx-star-rating btn-check ti ti-star ti-star-filled',
  html_template: `<div class="mb-3">
  <label class="form-label d-block">{{label}}</label>
  <div class="tx-star-rating d-inline-flex" data-tx-star-rating data-name="{{name}}">
    {{#stars}}
    <input type="radio" class="btn-check" name="{{name}}" id="{{id}}_{{value}}" value="{{value}}" autocomplete="off">
    <label class="btn btn-sm btn-link tx-star" for="{{id}}_{{value}}"><i class="ti ti-star"></i></label>
    {{/stars}}
  </div>
</div>`,
  fillable_slots: ['label', 'name', 'id', 'stars'],
  js_init: 'auto',
  js_dependencies: ['/homer/js/tx-star-rating.js'],
  js_init_snippet: '// Auto-initialized on DOMContentLoaded by tx-star-rating.js',
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Telegram: 5 inline-keyboard buttons "★ ★★ ★★★ ★★★★ ★★★★★".',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS component. Pure CSS+JS, no third-party deps.',
  source_verification: 'custom',
  archetype_fits: ['assessment'],
  example_usage: 'Self-assessment ratings on rubric questions.',
  capabilities: {
    when_to_use: 'A 1-5 satisfaction/quality rating answered by clicking stars.',
    border: { supported: ['none'], default: 'none', notes: 'btn-link stars carry no border or fill; selected stars colored by accent (skin) via ti-star-filled.' },
  },
};

export const FORM_COMPONENTS: ComponentCatalogEntry[] = [
  c_text_input,
  c_textarea,
  c_email_input,
  c_number_input,
  c_input_with_unit,
  c_select_native,
  c_select_choices,
  c_radio_group,
  c_checkbox_group,
  c_btn_check_radio,
  c_btn_check_checkbox,
  c_radio_cards,
  c_range_slider,
  c_touchspin_stepper,
  c_switch,
  c_flatpickr_date,
  c_file_input,
  c_form_validation_state,
  c_submit_button,
  c_star_rating,
  c_quill_editor,
];

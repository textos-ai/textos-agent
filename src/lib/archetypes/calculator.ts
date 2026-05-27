// Calculator with Analysis archetype.
//
// SHAPE DIFFERENCE FROM Strategy/Assessment: the inputs phase is a SINGLE
// SCREEN (not a wizard). All inputs visible at once on a 375px viewport.
// A `tx-bind`-driven `large-number` updates live as the visitor types —
// visible BEFORE the paywall, since they need to feel the calculator
// working to justify giving up their email.
//
// EXPRESSION SANITIZATION (deferred to Brief B / downstream):
//   preview.expression and each calculations[].expression are JS
//   expressions evaluated by tx-bind.js using `new Function()`. These
//   are LLM-generated. Before storing the content payload, the agent
//   MUST run a sanitization pass that:
//     • allows only references to input ids (variables) + numeric
//       literals + arithmetic operators (+ - * / %) + parens + the
//       handful of Math.* fns we whitelist (min/max/round/floor/ceil/abs).
//     • rejects any other identifier, property access, function call,
//       template literal, or statement-level construct.
//   This brief is data-only; the sanitizer lives in Brief B.
//
// CHART data binding:
//   chart.data_source = 'calculations' | 'inputs'. When 'calculations',
//   the assembler reads calculations[].id + label + final computed value
//   to feed Chart.js. When 'inputs', it reads inputs[].id + label + the
//   live input value. label_path and value_path are dotted paths into
//   those items.

import type { Archetype } from './types';

export const CALCULATOR_ARCHETYPE: Archetype = {
  id: 'calculator',
  name: 'Calculator with Analysis',
  tagline:
    'Visitor enters numbers, sees a live result, unlocks the analysis',
  preview_thumbnail_url: '/homer/images/archetype-previews/calculator.png',
  example_intents: [
    'Custom freelance pricing report',
    'SaaS pricing sensitivity calculator',
    'Side hustle income projection',
    'Marketing channel ROI estimator',
    'Time-to-profitability calculator',
  ],

  phases: [
    // ── Phase 1: Inputs (hero + single-screen input panel) ─────────
    {
      id: 'inputs',
      type: 'inputs',
      must_fit_above_fold: true,
      logged_events: ['app_loaded', 'field_change', 'phase_advance'],
      components: [
        {
          component_id: 'section-hero',
          slot_bindings: {
            headline: 'hero.title',
            tagline: 'hero.subtitle',
          },
        },
        // Live preview number — sits at the TOP of the input panel and
        // updates as inputs change. The tx-bind entry below wires it.
        {
          component_id: 'large-number',
          slot_bindings: {
            label: 'preview.label',
            value: 'preview.initial_value',
            prefix: 'preview.prefix',
            suffix: 'preview.suffix',
            subtitle: 'preview.subtitle',
          },
          notes:
            'Bound to preview.expression by tx-bind at runtime. Visible before paywall.',
        },
        {
          component_id: 'tx-bind',
          slot_bindings: {
            input_id: 'preview.input_id_placeholder',
            output_id: 'preview.output_id',
            value: 'preview.initial_value',
            expression: 'preview.expression',
            format: 'preview.format',
          },
          notes:
            'tx-bind is wired once per output. The assembler emits one tx-bind PhaseComponent per binding actually rendered. Expression MUST pass calculator-expression sanitization (see file header).',
        },
        // Inputs — assembler picks the catalog component per input.type.
        // We register all candidate input components per index so
        // slot_binding validation has a target regardless of which
        // type the LLM picked.
        ...buildCalculatorInputRefs(0, 6),
        {
          component_id: 'submit-button',
          slot_bindings: { label: 'submit_label' },
        },
        {
          component_id: 'spinner',
          optional: true,
          slot_bindings: { variant: 'spinner_variant' },
        },
        {
          component_id: 'alert',
          optional: true,
          slot_bindings: {
            variant: 'error_variant',
            message: 'error_message',
          },
        },
      ],
    },

    // ── Phase 2: Paywall ────────────────────────────────────────────
    {
      id: 'paywall',
      type: 'paywall',
      must_fit_above_fold: false,
      logged_events: ['paywall_shown', 'paywall_submit', 'paywall_abandon'],
      components: [
        {
          component_id: 'modal',
          slot_bindings: {
            id: 'paywall_modal_id',
            title: 'paywall.title',
            content: 'paywall.body',
            footer: 'paywall.footer',
            size: 'paywall_modal_size',
            centered: 'paywall_modal_centered',
          },
        },
        {
          component_id: 'large-number',
          slot_bindings: {
            label: 'result.big_number.label',
            value: 'computed.big_number_value',
            prefix: 'result.big_number.prefix',
            suffix: 'result.big_number.suffix',
            subtitle: 'result.big_number.sublabel',
          },
          notes:
            'Teaser: the big number. They already saw it live on the input panel — paywall shows it again to anchor the unlock value.',
        },
        {
          component_id: 'email-input',
          slot_bindings: {
            id: 'paywall_email_id',
            name: 'paywall_email_name',
            label: 'paywall.email_label',
            required: 'paywall_email_required',
          },
        },
        {
          component_id: 'submit-button',
          slot_bindings: { label: 'paywall.cta_label' },
        },
      ],
    },

    // ── Phase 3: Result ─────────────────────────────────────────────
    {
      id: 'result',
      type: 'result',
      must_fit_above_fold: false,
      logged_events: [
        'result_viewed',
        'result_shared',
        'result_downloaded',
        'cta_clicked',
      ],
      components: [
        {
          component_id: 'large-number',
          slot_bindings: {
            label: 'result.big_number.label',
            value: 'computed.big_number_value',
            prefix: 'result.big_number.prefix',
            suffix: 'result.big_number.suffix',
            subtitle: 'result.big_number.sublabel',
          },
          notes: 'Headline result, prominent at the top of the result page.',
        },
        {
          component_id: 'chart-bar',
          optional: true,
          slot_bindings: {
            id: 'chart_bar_id',
            height: 'chart_bar_height',
          },
          notes: 'Rendered when result.chart.type === "bar".',
        },
        {
          component_id: 'chart-doughnut',
          optional: true,
          slot_bindings: {
            id: 'chart_doughnut_id',
            height: 'chart_doughnut_height',
          },
          notes: 'Rendered when result.chart.type === "doughnut".',
        },
        {
          component_id: 'accordion',
          slot_bindings: {
            id: 'analysis_accordion_id',
            items: 'result.analysis_sections',
          },
          notes:
            'Analysis sections collapsed for compactness. Each accordion item maps to a result.analysis_sections[] entry.',
        },
        {
          component_id: 'card-basic',
          optional: true,
          slot_bindings: {
            title: 'result.summary.title',
            content: 'result.summary.body',
          },
          notes:
            'Optional summary card above the accordion. Only rendered when the LLM emits result.summary.',
        },
        {
          component_id: 'card-cta',
          slot_bindings: {
            headline: 'result.cta.headline',
            supporting_text: 'result.cta.body',
            cta_label: 'result.cta.cta_label',
            cta_url: 'result.cta.cta_url_placeholder',
          },
        },
        {
          component_id: 'share-bar',
          slot_bindings: {
            url: 'result.share.url',
            text: 'result.share.text',
            subject: 'result.share.subject',
            body: 'result.share.body',
          },
        },
        {
          component_id: 'download-button',
          slot_bindings: {
            url: 'result.download.url',
            label: 'result.download.label',
            variant: 'result.download.variant',
            download: 'result.download.filename',
          },
        },
      ],
    },
  ],

  content_schema: {
    description:
      'Calculator with Analysis content. Produce JSON matching the fields below. Expressions reference inputs by their `id` (e.g. "salary * (1 - tax_rate / 100)"). Expression syntax is restricted: numeric literals, input ids, arithmetic (+ - * / %), parens, and whitelisted Math fns (Math.min, Math.max, Math.round, Math.floor, Math.ceil, Math.abs). The agent sanitizes before storing.',
    fields: [
      {
        path: 'hero',
        type: 'object',
        required: true,
        description: 'Headline + tagline above the input panel.',
        item_schema: [
          { path: 'title', type: 'string', required: true, description: 'Calculator title.' },
          { path: 'subtitle', type: 'string', required: true, description: 'One-line tagline.' },
        ],
      },
      {
        path: 'inputs',
        type: 'array',
        required: true,
        description: '3-6 inputs visible above the fold at 375px. Each declares its id, type, defaults, and (for selects) options.',
        item_schema: [
          { path: 'id', type: 'string', required: true, description: 'Kebab-case id; referenced in expressions.' },
          { path: 'label', type: 'string', required: true, description: 'Input label.' },
          {
            path: 'type',
            type: 'enum',
            required: true,
            enum_values: ['number', 'range', 'select', 'stepper'],
            description: 'Drives which catalog component renders this input.',
          },
          { path: 'default_value', type: 'number', required: true, description: 'Initial value. Strings allowed for select type.' },
          { path: 'min', type: 'number', required: false, description: 'Lower bound (number/range/stepper).' },
          { path: 'max', type: 'number', required: false, description: 'Upper bound.' },
          { path: 'step', type: 'number', required: false, description: 'Step increment.' },
          { path: 'unit', type: 'string', required: false, description: 'Optional unit suffix/prefix (e.g., "$", "%", "hours").' },
          {
            path: 'options',
            type: 'array',
            required: false,
            description: 'Options for select type. Each: { value, label }.',
            item_schema: [
              { path: 'value', type: 'string', required: true, description: 'Stored value.' },
              { path: 'label', type: 'string', required: true, description: 'Visible label.' },
            ],
          },
        ],
      },
      {
        path: 'preview',
        type: 'object',
        required: true,
        description: 'The live-updating number at the top of the input panel. Visible before paywall.',
        item_schema: [
          {
            path: 'expression',
            type: 'string',
            required: true,
            description: 'JS expression referencing input ids. Sanitized downstream.',
            example: 'salary * (1 - tax_rate / 100)',
          },
          {
            path: 'format',
            type: 'enum',
            required: true,
            enum_values: ['number', 'currency', 'percent'],
            description: 'tx-bind formatter.',
          },
          { path: 'label', type: 'string', required: true, description: 'Label shown next to the live number.' },
          { path: 'prefix', type: 'string', required: false, description: 'Optional symbol before the number (e.g., "$").' },
          { path: 'suffix', type: 'string', required: false, description: 'Optional unit after the number (e.g., "/year").' },
        ],
      },
      {
        path: 'calculations',
        type: 'array',
        required: true,
        description:
          'Named calculation expressions. At least one MUST be the source of result.big_number.',
        item_schema: [
          { path: 'id', type: 'string', required: true, description: 'Kebab-case id; referenced by result.big_number.calculation_id and chart bindings.' },
          { path: 'label', type: 'string', required: true, description: 'Human-readable label (e.g., "Annual take-home").' },
          {
            path: 'expression',
            type: 'string',
            required: true,
            description: 'JS expression referencing input ids. Sanitized downstream.',
          },
          {
            path: 'format',
            type: 'enum',
            required: true,
            enum_values: ['number', 'currency', 'percent'],
            description: 'How to format the final value.',
          },
        ],
      },
      {
        path: 'paywall',
        type: 'object',
        required: true,
        description: 'Email-gate copy.',
        item_schema: [
          { path: 'title', type: 'string', required: true, description: 'Modal headline.' },
          { path: 'body', type: 'string', required: true, description: '1-2 sentences explaining the unlock.' },
          { path: 'cta_label', type: 'string', required: true, description: 'Button label.' },
          { path: 'email_label', type: 'string', required: false, description: 'Optional email input label.' },
        ],
      },
      {
        path: 'result',
        type: 'object',
        required: true,
        description: 'Result payload.',
        item_schema: [
          {
            path: 'big_number',
            type: 'object',
            required: true,
            description: 'The headline number shown at the top of the result + paywall teaser.',
            item_schema: [
              { path: 'calculation_id', type: 'string', required: true, description: 'References calculations[].id.' },
              { path: 'label', type: 'string', required: true, description: 'Label next to the big number.' },
              { path: 'sublabel', type: 'string', required: false, description: 'Optional sub-label under the number.' },
              { path: 'prefix', type: 'string', required: false, description: 'Optional prefix (e.g., "$").' },
              { path: 'suffix', type: 'string', required: false, description: 'Optional suffix (e.g., "/year").' },
            ],
          },
          {
            path: 'chart',
            type: 'object',
            required: true,
            description: 'Calculation breakdown chart.',
            item_schema: [
              {
                path: 'type',
                type: 'enum',
                required: true,
                enum_values: ['bar', 'doughnut'],
                description: 'Chart kind.',
              },
              { path: 'title', type: 'string', required: true, description: 'Chart title.' },
              {
                path: 'data_source',
                type: 'enum',
                required: true,
                enum_values: ['calculations', 'inputs'],
                description: 'Which array to read for chart data.',
              },
              {
                path: 'label_path',
                type: 'string',
                required: true,
                description: 'Dotted path within each data_source item that yields the chart label.',
                example: 'label',
              },
              {
                path: 'value_path',
                type: 'string',
                required: true,
                description: 'Dotted path within each data_source item that yields the chart value.',
                example: 'computed_value',
              },
            ],
          },
          {
            path: 'analysis_sections',
            type: 'array',
            required: true,
            description: '2-5 analysis sections rendered as accordion items.',
            item_schema: [
              { path: 'heading', type: 'string', required: true, description: 'Accordion title.' },
              { path: 'body', type: 'string', required: true, description: '2-3 paragraphs of analysis.' },
            ],
          },
          {
            path: 'summary',
            type: 'object',
            required: false,
            description: 'Optional summary card above the accordion.',
            item_schema: [
              { path: 'title', type: 'string', required: true, description: 'Summary title.' },
              { path: 'body', type: 'string', required: true, description: 'Summary body.' },
            ],
          },
          {
            path: 'cta',
            type: 'object',
            required: true,
            description: 'Operator CTA.',
            item_schema: [
              { path: 'headline', type: 'string', required: true, description: 'CTA headline.' },
              { path: 'body', type: 'string', required: true, description: 'Supporting text.' },
              { path: 'cta_label', type: 'string', required: true, description: 'Button label.' },
              {
                path: 'cta_url_placeholder',
                type: 'string',
                required: true,
                description: 'Literal placeholder string; assembler replaces with operator URL.',
                example: 'cta_url_placeholder',
              },
            ],
          },
        ],
      },
    ],
  },

  paywall: {
    type: 'email_gate',
    trigger_after_phase_id: 'inputs',
    teaser_visible: true,
    teaser_description:
      'Show the big number (they already saw it live on the input panel). Chart, accordion analysis, and CTA hidden until paywall submit.',
  },

  required_components: [
    'section-hero',
    'number-input',
    'input-with-unit',
    'range-slider',
    'select-native',
    'touchspin-stepper',
    'tx-bind',
    'large-number',
    'submit-button',
    'modal',
    'email-input',
    'chart-bar',
    'chart-doughnut',
    'card-basic',
    'accordion',
    'card-cta',
    'share-bar',
    'download-button',
  ],
  optional_components: ['spinner', 'alert'],

  logged_events: [
    'app_loaded',
    'phase_advance',
    'field_change',
    'wizard_step_complete',
    'paywall_shown',
    'paywall_submit',
    'paywall_abandon',
    'result_viewed',
    'result_shared',
    'result_downloaded',
    'cta_clicked',
  ],

  result_delivery: {
    on_page: true,
    emailed: true,
    permanent_url: true,
    pdf_download: true,
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * For each input index in [startIdx, startIdx+count), register the four
 * candidate input components (number-input, input-with-unit, range-slider,
 * select-native, touchspin-stepper) so slot_binding validation has a
 * resolution target regardless of which type the LLM picks. The assembler
 * picks one to render based on inputs[i].type.
 */
function buildCalculatorInputRefs(startIdx: number, count: number) {
  const out = [] as Array<{
    component_id: string;
    slot_bindings: Record<string, string>;
    optional: boolean;
    notes: string;
  }>;
  for (let i = 0; i < count; i++) {
    const iIdx = startIdx + i;
    const base = `inputs[${iIdx}]`;
    out.push({
      component_id: 'number-input',
      optional: true,
      slot_bindings: {
        id: `${base}.id`,
        name: `${base}.id`,
        label: `${base}.label`,
        min: `${base}.min`,
        max: `${base}.max`,
        step: `${base}.step`,
        value: `${base}.default_value`,
      },
      notes: `Rendered when inputs[${iIdx}].type === 'number' and no unit.`,
    });
    out.push({
      component_id: 'input-with-unit',
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        type: `${base}.type`,
        value: `${base}.default_value`,
        prefix: `${base}.unit_prefix`,
        suffix: `${base}.unit`,
      },
      notes: `Rendered when inputs[${iIdx}].type === 'number' and a unit is present.`,
    });
    out.push({
      component_id: 'range-slider',
      optional: true,
      slot_bindings: {
        id: `${base}.id`,
        name: `${base}.id`,
        label: `${base}.label`,
        min: `${base}.min`,
        max: `${base}.max`,
        step: `${base}.step`,
        value: `${base}.default_value`,
      },
      notes: `Rendered when inputs[${iIdx}].type === 'range'.`,
    });
    out.push({
      component_id: 'select-native',
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        options: `${base}.options`,
        placeholder: `${base}.placeholder`,
        required: `${base}.required`,
      },
      notes: `Rendered when inputs[${iIdx}].type === 'select'.`,
    });
    out.push({
      component_id: 'touchspin-stepper',
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        value: `${base}.default_value`,
        min: `${base}.min`,
        max: `${base}.max`,
      },
      notes: `Rendered when inputs[${iIdx}].type === 'stepper'.`,
    });
  }
  return out;
}

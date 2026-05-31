// Strategy Generator archetype.
//
// Wizard flattening (judgment call documented per Part 3 of the brief):
//   The inputs phase contains the `wizard` catalog component once at the
//   top of the components array, and each form field (text-input,
//   textarea, radio-cards) appears as a sibling PhaseComponent below it
//   with an explicit `step: 1|2|3` field. The assembler groups
//   components by step to populate the wizard's `steps` slot at render
//   time. The wizard PhaseComponent itself carries no step.
//   Rationale: a flat array keeps PhaseComponent uniform and lets us
//   validate slot_bindings the same way for every entry. The alternative
//   (nested step-sub-arrays inside the wizard) duplicates the catalog's
//   own step structure and complicates validation.

import type { Archetype } from './types';

export const STRATEGY_ARCHETYPE: Archetype = {
  id: 'strategy',
  name: 'Personalized Strategy Plan',
  tagline: 'Visitor answers a few questions, gets a custom multi-section plan',
  preview_thumbnail_url: '/homer/images/archetype-previews/strategy.png',
  example_intents: [
    '30-day reiki marketing plan',
    'Freelance pricing strategy',
    'First-month launch checklist',
    'Custom content calendar for a coaching practice',
    '90-day fitness studio growth plan',
  ],

  phases: [
    // ── Phase 1: Inputs (hero + wizard) ─────────────────────────────
    {
      id: 'inputs',
      type: 'inputs',
      must_fit_above_fold: true,
      logged_events: [
        'app_loaded',
        'field_change',
        'wizard_step_complete',
        'phase_advance',
      ],
      components: [
        {
          component_id: 'section-hero',
          slot_bindings: {
            headline: 'app_title',
            tagline: 'app_tagline',
          },
          notes: 'Hero stays visible above the wizard on the inputs phase.',
        },
        {
          component_id: 'wizard',
          slot_bindings: {
            steps: 'wizard.steps',
          },
          notes:
            'Assembler derives wizard.steps from the questions[] array, grouped by question.step.',
        },
        // ── Step 1: situational ─────────────────────────────────────
        {
          component_id: 'text-input',
          step: 1,
          slot_bindings: {
            id: 'questions[0].id',
            name: 'questions[0].id',
            label: 'questions[0].text',
            placeholder: 'questions[0].placeholder',
            required: 'questions[0].required',
          },
        },
        {
          component_id: 'text-input',
          step: 1,
          slot_bindings: {
            id: 'questions[1].id',
            name: 'questions[1].id',
            label: 'questions[1].text',
            placeholder: 'questions[1].placeholder',
            required: 'questions[1].required',
          },
        },
        {
          component_id: 'textarea',
          step: 1,
          slot_bindings: {
            id: 'questions[2].id',
            name: 'questions[2].id',
            label: 'questions[2].text',
            placeholder: 'questions[2].placeholder',
            rows: 'questions[2].rows',
          },
        },
        // ── Step 2: preferences ─────────────────────────────────────
        {
          component_id: 'radio-cards',
          step: 2,
          slot_bindings: {
            label: 'questions[3].text',
            name: 'questions[3].id',
            id: 'questions[3].id',
            options: 'questions[3].options',
          },
        },
        {
          component_id: 'radio-cards',
          step: 2,
          slot_bindings: {
            label: 'questions[4].text',
            name: 'questions[4].id',
            id: 'questions[4].id',
            options: 'questions[4].options',
          },
        },
        // ── Step 3: goals / constraints ─────────────────────────────
        {
          component_id: 'text-input',
          step: 3,
          slot_bindings: {
            id: 'questions[5].id',
            name: 'questions[5].id',
            label: 'questions[5].text',
            placeholder: 'questions[5].placeholder',
            required: 'questions[5].required',
          },
        },
        {
          component_id: 'textarea',
          step: 3,
          slot_bindings: {
            id: 'questions[6].id',
            name: 'questions[6].id',
            label: 'questions[6].text',
            placeholder: 'questions[6].placeholder',
            rows: 'questions[6].rows',
          },
        },
        {
          component_id: 'submit-button',
          step: 3,
          slot_bindings: {
            label: 'submit_button_text',
          },
        },
        {
          component_id: 'spinner',
          optional: true,
          slot_bindings: {
            variant: 'spinner_variant',
          },
          notes: 'Loading state during the LLM call.',
        },
        {
          component_id: 'alert',
          optional: true,
          slot_bindings: {
            variant: 'error_variant',
            message: 'error_message',
          },
          notes: 'Error state if the LLM call fails.',
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
          slot_bindings: {
            label: 'paywall.cta_label',
          },
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
          component_id: 'card-basic',
          slot_bindings: {
            title: 'result.plan_title',
            content: 'result.intro',
          },
          notes: 'Hero card with personalized plan title + intro.',
        },
        {
          component_id: 'card-basic',
          slot_bindings: {
            title: 'result.sections[].heading',
            content: 'result.sections[].body',
          },
          notes:
            'One card-basic per result.sections[] entry. Assembler iterates.',
        },
        {
          component_id: 'list-group',
          slot_bindings: {
            items: 'result.sections[].action_items',
          },
          optional: true,
          notes:
            'Action items list rendered inside each section card when present.',
        },
        {
          component_id: 'card-cta',
          slot_bindings: {
            headline: 'result.cta.headline',
            supporting_text: 'result.cta.body',
            cta_label: 'result.cta.cta_label',
            cta_url: 'result.cta.cta_url_placeholder',
          },
          notes:
            'cta_url is a placeholder string the LLM emits as `cta_url_placeholder`; assembler replaces with the operator URL at render time.',
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
      'Strategy Generator content. Produce JSON matching the fields below. Use the visitor\'s submitted question answers to personalize hero.title and result.plan_title. Each result.sections entry should be a coherent strategic chunk (e.g., "Audience research", "Channel mix", "First-30-days schedule"). The LLM does not write HTML or JS.',
    fields: [
      {
        path: 'hero',
        type: 'object',
        required: true,
        description: 'Headline + supporting tagline shown at the top of the app.',
        item_schema: [
          {
            path: 'title',
            type: 'string',
            required: true,
            description: 'Personalized headline (e.g., "Your 30-Day Reiki Marketing Plan").',
          },
          {
            path: 'subtitle',
            type: 'string',
            required: true,
            description: 'One-line description of what the visitor will receive.',
          },
        ],
      },
      {
        path: 'questions',
        type: 'array',
        required: true,
        description:
          '7 questions across 3 wizard steps. Steps 1, 2, 3 each fit a 375px viewport.',
        item_schema: [
          {
            path: 'id',
            type: 'string',
            required: true,
            description: 'Unique kebab-case identifier (e.g., "current-channels").',
          },
          {
            path: 'step',
            type: 'enum',
            required: true,
            enum_values: ['1', '2', '3'],
            description: 'Which wizard step this question belongs to.',
          },
          {
            path: 'label',
            type: 'string',
            required: true,
            description: 'Visible label / question text.',
          },
          {
            path: 'placeholder',
            type: 'string',
            required: false,
            description: 'Optional placeholder for text/textarea inputs.',
          },
          {
            path: 'type',
            type: 'enum',
            required: true,
            enum_values: ['text', 'textarea', 'radio_cards'],
            description: 'Input type — drives which catalog component renders this question.',
          },
          {
            path: 'required',
            type: 'boolean',
            required: true,
            description: 'Whether the question must be answered to advance.',
          },
          {
            path: 'rows',
            type: 'number',
            required: false,
            description: 'Row count for textarea questions. Default 5.',
            example: 5,
          },
          {
            path: 'options',
            type: 'array',
            required: false,
            description: 'Choices for radio_cards questions. Omit for text/textarea.',
            item_schema: [
              {
                path: 'value',
                type: 'string',
                required: true,
                description: 'Stored value if selected.',
              },
              {
                path: 'title',
                type: 'string',
                required: true,
                description: 'Short label shown on the card.',
              },
              {
                path: 'desc',
                type: 'string',
                required: false,
                description: 'Optional one-line elaboration shown under the title.',
              },
            ],
          },
        ],
      },
      {
        path: 'paywall',
        type: 'object',
        required: true,
        description: 'Email-gate copy shown after the wizard completes.',
        item_schema: [
          {
            path: 'title',
            type: 'string',
            required: true,
            description: 'Modal headline (e.g., "Your plan is ready").',
          },
          {
            path: 'body',
            type: 'string',
            required: true,
            description: '1-2 sentence explanation of what unlocking does (sends the full plan).',
          },
          {
            path: 'cta_label',
            type: 'string',
            required: true,
            description: 'Button label on the modal (e.g., "Get my plan").',
          },
          {
            path: 'email_label',
            type: 'string',
            required: false,
            description: 'Label for the email input. Defaults to "Email".',
          },
        ],
      },
      {
        path: 'result',
        type: 'object',
        required: true,
        description: 'Full result payload, delivered after paywall submit.',
        item_schema: [
          {
            path: 'plan_title',
            type: 'string',
            required: true,
            description: 'Personalized plan title using the visitor\'s inputs.',
          },
          {
            path: 'intro',
            type: 'string',
            required: true,
            description: '2-3 sentence introduction setting up the plan.',
          },
          {
            path: 'sections',
            type: 'array',
            required: true,
            description: '3-5 strategy sections, each a coherent strategic chunk.',
            item_schema: [
              {
                path: 'heading',
                type: 'string',
                required: true,
                description: 'Section heading.',
              },
              {
                path: 'body',
                type: 'string',
                required: true,
                description: 'Section body — 1-3 paragraphs of strategy.',
              },
              {
                path: 'action_items',
                type: 'array',
                required: false,
                description: 'Optional bullet list of concrete next actions.',
                item_schema: [
                  {
                    path: '',
                    type: 'string',
                    required: true,
                    description: 'One action item.',
                  },
                ],
              },
            ],
          },
          {
            path: 'cta',
            type: 'object',
            required: true,
            description: 'Final operator call-to-action below the sections.',
            item_schema: [
              {
                path: 'headline',
                type: 'string',
                required: true,
                description: 'CTA card headline.',
              },
              {
                path: 'body',
                type: 'string',
                required: true,
                description: 'Supporting text under the headline.',
              },
              {
                path: 'cta_label',
                type: 'string',
                required: true,
                description: 'Button label.',
              },
              {
                path: 'cta_url_placeholder',
                type: 'string',
                required: true,
                description:
                  'Literal placeholder string the assembler replaces with the operator URL. The LLM does not see the operator URL.',
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
      'Show the result\'s intro paragraph + each section\'s heading + 1-2 bullet points per section, with the section body text masked behind the email gate.',
  },

  required_components: [
    'section-hero',
    'wizard',
    'text-input',
    'textarea',
    'radio-cards',
    'submit-button',
    'modal',
    'email-input',
    'card-basic',
    'list-group',
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

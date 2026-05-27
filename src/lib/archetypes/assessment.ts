// Assessment with Scoring archetype.
//
// Scoring is deterministic and computed by the assembler at runtime
// (NOT by the LLM). The assembler sums each selected option's `points`
// per dimension and overall, then matches the total against
// scoring.score_bands to derive the displayed band + interpretation.
// The radar chart binds to per-dimension sums.
//
// Wizard flattening follows the same pattern as strategy.ts —
// see that file's header comment for rationale.

import type { Archetype } from './types';

export const ASSESSMENT_ARCHETYPE: Archetype = {
  id: 'assessment',
  name: 'Assessment with Scoring',
  tagline:
    'Visitor answers questions, gets a numeric score + personalized recommendations',
  preview_thumbnail_url: '/homer/images/archetype-previews/assessment.png',
  example_intents: [
    'Marketing readiness audit',
    'Is your business ready to hire?',
    '5-minute SEO health check',
    'Founder burnout self-check',
    'Pre-launch product validation scorecard',
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
            headline: 'hero.title',
            tagline: 'hero.subtitle',
          },
        },
        {
          component_id: 'wizard',
          slot_bindings: {
            steps: 'wizard.steps',
          },
          notes:
            'Assembler groups questions by question.step to populate the wizard.steps array.',
        },
        {
          component_id: 'progress-bar',
          optional: true,
          slot_bindings: {
            percent: 'wizard.progress_percent',
            variant: 'wizard.progress_variant',
            size: 'wizard.progress_size',
          },
          notes: 'Optional visual progress indicator at the top of the wizard.',
        },
        // Step 1 — 4-5 questions (assembler iterates over questions
        // grouped by step; we register one PhaseComponent per question
        // index so the slot_binding validation can resolve cleanly).
        ...buildAssessmentQuestionRefs(1, 0, 4),
        // Step 2 — next group.
        ...buildAssessmentQuestionRefs(2, 4, 4),
        // Step 3 — last group + submit.
        ...buildAssessmentQuestionRefs(3, 8, 4),
        {
          component_id: 'submit-button',
          step: 3,
          slot_bindings: {
            label: 'submit_label',
          },
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
          component_id: 'score-badge',
          slot_bindings: {
            score: 'computed.total_score',
            label: 'computed.score_band_label',
            sublabel: 'computed.score_band_sublabel',
            variant: 'computed.score_band_color',
          },
          notes: 'Teaser: shows the score number + band label only.',
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
          component_id: 'score-badge',
          slot_bindings: {
            score: 'computed.total_score',
            label: 'result.score_label',
            sublabel: 'result.score_subtitle',
            variant: 'computed.score_band_color',
          },
        },
        {
          component_id: 'chart-radar',
          slot_bindings: {
            id: 'chart_radar_id',
            height: 'chart_radar_height',
          },
          notes:
            'Chart.js data is wired by the assembler from computed.dimension_scores (≤6 axes).',
        },
        {
          component_id: 'card-basic',
          slot_bindings: {
            title: 'computed.score_band_label',
            content: 'computed.score_band_interpretation',
          },
          notes: 'Interpretation card — content comes from the matched score_band.',
        },
        {
          component_id: 'list-group',
          slot_bindings: {
            items: 'result.recommendations',
          },
          notes:
            'Each recommendation item: { title, body, priority }. Assembler renders priority as a badge inside the list item.',
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
          notes:
            'Share text template includes "I scored {{score}} on {{archetype_name}}". The score IS the shareable hook — Assessment is the most viral archetype.',
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
      'Assessment with Scoring content. Produce JSON matching the schema below. Each question has a dimension and each option carries a points value; the assembler sums points deterministically. score_bands MUST cover the [0, max_score] range without gaps. Dimensions cap at 6 (radar chart constraint).',
    fields: [
      {
        path: 'hero',
        type: 'object',
        required: true,
        description: 'Headline + tagline.',
        item_schema: [
          { path: 'title', type: 'string', required: true, description: 'Assessment title.' },
          { path: 'subtitle', type: 'string', required: true, description: 'One-line description.' },
        ],
      },
      {
        path: 'questions',
        type: 'array',
        required: true,
        description:
          '8-15 questions across 2-3 wizard steps. Each contributes to exactly one scoring dimension.',
        item_schema: [
          { path: 'id', type: 'string', required: true, description: 'Unique kebab-case id.' },
          {
            path: 'step',
            type: 'enum',
            required: true,
            enum_values: ['1', '2', '3'],
            description: 'Wizard step (1-indexed).',
          },
          { path: 'label', type: 'string', required: true, description: 'Question text.' },
          {
            path: 'type',
            type: 'enum',
            required: true,
            enum_values: ['radio_cards', 'star_rating', 'btn_check_radio'],
            description: 'Input type.',
          },
          { path: 'required', type: 'boolean', required: true, description: 'Whether answer is required.' },
          {
            path: 'dimension',
            type: 'string',
            required: true,
            description:
              'Scoring dimension id — must match one of scoring.dimensions[].id.',
          },
          {
            path: 'options',
            type: 'array',
            required: true,
            description:
              'Answer options. Each carries a points value that contributes to the dimension + total score.',
            item_schema: [
              { path: 'value', type: 'string', required: true, description: 'Stored value.' },
              { path: 'title', type: 'string', required: false, description: 'Short option label.' },
              { path: 'points', type: 'number', required: true, description: 'Score contribution for this option.' },
            ],
          },
        ],
      },
      {
        path: 'scoring',
        type: 'object',
        required: true,
        description: 'Deterministic scoring configuration. Assembler enforces.',
        item_schema: [
          {
            path: 'max_score',
            type: 'number',
            required: true,
            description: 'Highest score a visitor can reach by picking the highest-point option on every question.',
          },
          {
            path: 'score_bands',
            type: 'array',
            required: true,
            description:
              'Contiguous score buckets covering [0, max_score] with no gaps. The band whose [min, max] contains the total is the displayed band.',
            item_schema: [
              { path: 'min', type: 'number', required: true, description: 'Inclusive lower bound.' },
              { path: 'max', type: 'number', required: true, description: 'Inclusive upper bound.' },
              { path: 'label', type: 'string', required: true, description: 'Band label (e.g., "Solid foundation").' },
              {
                path: 'interpretation',
                type: 'string',
                required: true,
                description: '2-3 sentence interpretation shown when this band is matched.',
              },
              {
                path: 'color',
                type: 'enum',
                required: true,
                enum_values: ['success', 'warning', 'danger', 'primary'],
                description: 'Bootstrap colour variant used on the score badge + band card.',
              },
            ],
          },
          {
            path: 'dimensions',
            type: 'array',
            required: true,
            description: 'Scoring axes (≤6, radar chart constraint).',
            item_schema: [
              { path: 'id', type: 'string', required: true, description: 'Kebab-case id. Used by question.dimension.' },
              { path: 'label', type: 'string', required: true, description: 'Human-readable axis label on the radar chart.' },
            ],
          },
        ],
      },
      {
        path: 'paywall',
        type: 'object',
        required: true,
        description: 'Email-gate copy. Teaser shows score + band label.',
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
        description: 'Result payload — recommendations + CTA. Score band content is sourced from scoring.score_bands at runtime.',
        item_schema: [
          { path: 'score_label', type: 'string', required: true, description: 'Label shown next to the score badge (e.g., "Your readiness score").' },
          { path: 'score_subtitle', type: 'string', required: true, description: 'One-line subtitle under the badge.' },
          {
            path: 'recommendations',
            type: 'array',
            required: true,
            description: '3-5 prioritized recommendations.',
            item_schema: [
              { path: 'title', type: 'string', required: true, description: 'Recommendation title.' },
              { path: 'body', type: 'string', required: true, description: 'Body — 1-2 sentences.' },
              {
                path: 'priority',
                type: 'enum',
                required: true,
                enum_values: ['high', 'medium', 'low'],
                description: 'Priority badge rendered with the item.',
              },
            ],
          },
          {
            path: 'cta',
            type: 'object',
            required: true,
            description: 'Operator CTA.',
            item_schema: [
              { path: 'headline', type: 'string', required: true, description: 'CTA card headline.' },
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
      'Show only the computed score number and the score band label. Recommendations + radar chart + interpretation remain hidden until the email is submitted.',
  },

  required_components: [
    'section-hero',
    'wizard',
    'radio-cards',
    'star-rating',
    'btn-check-radio',
    'submit-button',
    'modal',
    'email-input',
    'score-badge',
    'chart-radar',
    'card-basic',
    'list-group',
    'card-cta',
    'share-bar',
    'download-button',
  ],
  optional_components: ['spinner', 'alert', 'progress-bar'],

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
 * Build one PhaseComponent per question in [startIdx, startIdx+count) for
 * the given step. Each question's input-type-specific slot_bindings are
 * chosen by the runtime based on question.type — we declare all three
 * candidates here so validation passes regardless of which type the LLM
 * picks for any given question. The assembler picks one to render.
 *
 * This keeps slot_binding validation pure (every binding key matches a
 * real fillable_slot) at the cost of registering three candidates per
 * question. The alternative — letting PhaseComponent.component_id be a
 * union — would weaken validation.
 */
function buildAssessmentQuestionRefs(
  step: 1 | 2 | 3,
  startIdx: number,
  count: number,
) {
  const out = [] as Array<{
    component_id: string;
    step: number;
    slot_bindings: Record<string, string>;
    optional: boolean;
    notes: string;
  }>;
  for (let i = 0; i < count; i++) {
    const qIdx = startIdx + i;
    const base = `questions[${qIdx}]`;
    out.push({
      component_id: 'radio-cards',
      step,
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        id: `${base}.id`,
        options: `${base}.options`,
      },
      notes: `Rendered when questions[${qIdx}].type === 'radio_cards'.`,
    });
    out.push({
      component_id: 'star-rating',
      step,
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        id: `${base}.id`,
        stars: `${base}.options`,
      },
      notes: `Rendered when questions[${qIdx}].type === 'star_rating'.`,
    });
    out.push({
      component_id: 'btn-check-radio',
      step,
      optional: true,
      slot_bindings: {
        label: `${base}.label`,
        name: `${base}.id`,
        id: `${base}.id`,
        options: `${base}.options`,
      },
      notes: `Rendered when questions[${qIdx}].type === 'btn_check_radio'.`,
    });
  }
  return out;
}

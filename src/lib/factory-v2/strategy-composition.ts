// factory-v2 — hardcoded Strategy-result composition (sample data).
//
// This is HAND-AUTHORED composition, NOT LLM output — we are testing the
// assembler, not generation. Every component_id below is a real entry in the
// existing Homer catalog; every slot key matches that entry's fillable_slots.
//
// Sample scenario: a charcuterie / grazing-table caterer's personalized
// "result" surface (the kind the Strategy archetype produces).
//
// NOTE on section-hero: the catalog template (component-catalog/layout.ts)
// hardcodes a dark slate background (background-color:#1f2933) with white
// text; "light" is NOT a fillable slot. Making the hero light would require
// editing the read-only catalog template, which this proof does not do — so
// the hero renders in its catalog-defined dark style. (Flagged to Rob.)

import type { CompositionBlock } from './assemble';

export const STRATEGY_PROOF_COMPOSITION: CompositionBlock[] = [
  // ── Hero (layout/section-hero) — title + tagline, no CTA, no bg image ──
  {
    component_id: 'section-hero',
    slot_values: {
      headline: 'Your Holiday Grazing-Table Game Plan',
      tagline: 'A custom charcuterie strategy for Whitmore & Boudreaux — built from your answers.',
      // bg_url intentionally omitted; cta_label omitted so the hero CTA arm stays empty.
    },
  },

  // ── Result section 1 (display/card-basic) ──
  {
    component_id: 'card-basic',
    slot_values: {
      title: 'Board Composition & Quantities',
      content:
        'For 60–150 guests at a staffed grazing station, plan three cured-meat anchors ' +
        '(soppressata, prosciutto, a Cajun-spiced tasso) plus two soft and two hard cheeses. ' +
        'Budget roughly 3 oz of meat and 2 oz of cheese per guest, scaling the upper end for ' +
        'the evening reception window.',
    },
  },

  // ── Result section 2 (display/card-basic) ──
  {
    component_id: 'card-basic',
    slot_values: {
      title: 'Service Model & Timeline for Dec 18',
      content:
        'Staffed-station service means one attendant per ~50 guests to replenish and plate. ' +
        'Stage the build 90 minutes before the 6:00 PM start, hold cold items at temperature, ' +
        'and refresh the boards at the one-hour mark so the spread still photographs well late ' +
        'in the evening.',
    },
  },

  // ── Action items (display/list-group) ──
  {
    component_id: 'list-group',
    slot_values: {
      items: [
        { label: 'Confirm final headcount by Dec 11 to lock meat & cheese orders.' },
        { label: 'Flag the gluten-free guests — plan a separate cracker/crudite zone to avoid cross-contact.' },
        { label: 'Reserve two staffed attendants for the 60–150 guest range.' },
        { label: 'Lean into the Cajun identity: tasso, pepper-jelly, and a remoulade dip as signature touches.' },
      ],
    },
  },

  // ── Conversion CTA (display/card-cta) ──
  {
    component_id: 'card-cta',
    slot_values: {
      headline: 'Ready to lock in December 18?',
      supporting_text: 'We hold one staffed-station event per evening. Reserve your date before the holiday calendar fills.',
      cta_url: '#',
      cta_label: 'Book a tasting call',
    },
  },

  // ── Download (utility/download-button) ──
  {
    component_id: 'download-button',
    slot_values: {
      url: '#',
      label: 'Download this plan as PDF',
      variant: 'outline-primary',
      download: 'download',
    },
  },
];

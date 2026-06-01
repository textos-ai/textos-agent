// factory-v2 — LOCKED Strategy RESULT recipe + content→slot mapping.
//
// PART 1 (lock): the Strategy result surface is ALWAYS composed from this
// fixed, ordered set of catalog component ids — approved by Rob (2026-05-31):
//
//   section-hero[light] → card-basic ×N → list-group → card-cta →
//   share-bar → download-button
//
// The LLM does NOT choose this list. card-basic repeats once per result
// section. share-bar is pure anchor links (verified: js_dependencies []), so
// it needs no extra JS bundle and no hand-rolled share logic.
//
// PART 3 (map): take validated LLM CONTENT and bind it onto each locked
// component's slot_values. No component ids or HTML come from the LLM.

import type { CompositionBlock } from './assemble';
import type { StrategyLiveContent } from './strategy-content-schema';

/** The locked result component order (card-basic expands ×N at map time). */
export const LOCKED_STRATEGY_RESULT_ORDER = [
  'section-hero',   // [light] banner — headline + tagline
  'card-basic',     // ×N — one per result section
  'list-group',     // action items
  'card-cta',       // conversion CTA
  'share-bar',      // social share (anchor links, no JS dep)
  'download-button', // PDF download
] as const;

// Share intent points at this proof page (sample). cta/download urls are
// placeholders for the proof — the real operator URL is substituted at
// render time in the production path.
const PROOF_SHARE_URL = 'https://textos-web-test.pages.dev/dev/factory-strategy-live.html';

export function buildStrategyResultComposition(content: StrategyLiveContent): CompositionBlock[] {
  const blocks: CompositionBlock[] = [];

  // 1. section-hero (light) — banner.
  blocks.push({
    component_id: 'section-hero',
    slot_values: {
      headline: content.headline,
      tagline: content.tagline,
      light: true,
    },
  });

  // 2. card-basic ×N — one per LLM section.
  for (const section of content.sections) {
    blocks.push({
      component_id: 'card-basic',
      slot_values: { title: section.title, content: section.body },
    });
  }

  // 3. list-group — action items.
  blocks.push({
    component_id: 'list-group',
    slot_values: { items: content.action_items.map((label) => ({ label })) },
  });

  // 4. card-cta — conversion CTA.
  blocks.push({
    component_id: 'card-cta',
    slot_values: {
      headline: content.cta.headline,
      supporting_text: content.cta.body,
      cta_url: '#',
      cta_label: content.cta.cta_label,
    },
  });

  // 5. share-bar — social share (anchor links).
  blocks.push({
    component_id: 'share-bar',
    slot_values: {
      url: PROOF_SHARE_URL,
      text: content.headline,
      subject: content.headline,
      body: content.tagline,
    },
  });

  // 6. download-button — PDF download.
  blocks.push({
    component_id: 'download-button',
    slot_values: {
      url: '#',
      label: 'Download this plan as PDF',
      variant: 'outline-primary',
      download: 'download',
    },
  });

  return blocks;
}

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

import { assembleComposition, type CompositionBlock } from './assemble';
import type { StrategyLiveContent } from './strategy-content-schema';
import { CATALOG } from '../component-catalog/index';
import { resolveComponentTokens, tokenClass, type ChosenTokens } from '../component-catalog/design-token-resolver';
import { STYLE_ROLE_COMPONENT } from './assessment-recipe';
import type { StyleChoices } from './assessment-spec-schema';

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
const PROOF_SHARE_URL = 'https://app.victora.ai/dev/factory-strategy-live.html';

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

// ── Styled + framed result (backport of the Assessment finished look) ────────
// Same shared frame as the collect side: radius:lg + elevation:sm.
const FRAME_CLASSES = [tokenClass('radius', 'lg'), tokenClass('elevation', 'sm')].filter(Boolean).join(' ');

function roleClasses(style: StyleChoices, role: keyof StyleChoices): string {
  const entry = CATALOG.by_id[STYLE_ROLE_COMPONENT[role]];
  if (!entry) return '';
  return resolveComponentTokens(entry, (style[role] ?? {}) as ChosenTokens).classes;
}

/**
 * Build the per-visitor RESULT as framed, token-styled HTML: hero (with tokens)
 * ABOVE a Homer card-basic frame wrapping the result blocks (each token-styled).
 * Matches the collect side + the Assessment result. Injected into #fv2-result;
 * inherits the page's font pairing.
 */
export function buildStrategyResultHtml(content: StrategyLiveContent, style: StyleChoices): string {
  const heroCls = roleClasses(style, 'hero');
  const cardCls = roleClasses(style, 'interpretation_card');
  const listCls = roleClasses(style, 'recommendations');
  const ctaCls = roleClasses(style, 'cta');

  const { html: heroHtml } = assembleComposition([
    { component_id: 'section-hero', slot_values: { headline: content.headline, tagline: content.tagline, light: true }, extra_classes: heroCls },
  ]);
  const cardsHtml = content.sections
    .map((s) => assembleComposition([{ component_id: 'card-basic', slot_values: { title: s.title, content: s.body }, extra_classes: cardCls }]).html)
    .join('\n');
  const { html: listHtml } = assembleComposition([
    { component_id: 'list-group', slot_values: { items: content.action_items.map((label) => ({ label })) }, extra_classes: listCls },
  ]);
  const { html: ctaHtml } = assembleComposition([
    { component_id: 'card-cta', slot_values: { headline: content.cta.headline, supporting_text: content.cta.body, cta_url: '#', cta_label: content.cta.cta_label }, extra_classes: ctaCls },
  ]);
  const { html: shareRaw } = assembleComposition([
    { component_id: 'share-bar', slot_values: { url: '#', text: content.headline, subject: content.headline, body: content.tagline } },
  ]);
  // data-tx-pdf-skip: tx-pdf excludes the share row from the PDF.
  const shareHtml = `<div data-tx-pdf-skip>${shareRaw}</div>`;
  // Stamp the download anchor → tx-pdf builds a real PDF of #fv2-result (the
  // per-visitor result is injected there) on click. Delegated binding catches it.
  let downloadHtml = assembleComposition([
    { component_id: 'download-button', slot_values: { url: '#', label: 'Download this plan as PDF', variant: 'outline-primary', download: 'download' } },
  ]).html;
  downloadHtml = downloadHtml.replace('<a href="#"', '<a href="#" data-tx-pdf="#fv2-result" data-tx-pdf-name="charcuterie-event-plan.pdf"');

  const blocks = [cardsHtml, listHtml, ctaHtml, shareHtml, downloadHtml].join('\n');
  const { html: cardFrame } = assembleComposition([
    { component_id: 'card-basic', slot_values: { content: `<div class="d-flex flex-column gap-3">${blocks}</div>` }, extra_classes: FRAME_CLASSES },
  ]);

  // hero ABOVE the framed card (matches the collect side + Assessment).
  return `<div class="d-flex flex-column gap-3">${heroHtml}${cardFrame}</div>`;
}

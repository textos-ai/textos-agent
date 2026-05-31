// factory-v2 — standalone Strategy-app assembler (clean-room proof).
//
// PROVES: an app surface can be composed 100% from the existing Homer
// component catalog (src/lib/component-catalog), with NO hand-written app
// HTML and NO silent fallback.
//
// Contract: a composition is an ordered array of { component_id, slot_values }.
// For each block we look up CATALOG.by_id[component_id]; if it is not in the
// catalog we THROW (loud, names the id) — never skip, never substitute. The
// catalog entry's own `html_template` is the ONLY source of each block's HTML.
//
// The component-catalog module is READ-ONLY input here; this file imports it
// but does not modify it.

import { CATALOG } from '../component-catalog/index';
import { renderTemplate } from './template-render';

export interface CompositionBlock {
  /** Must exist in CATALOG.by_id — otherwise assembly throws. */
  component_id: string;
  /** Values bound to the catalog entry's fillable slots. */
  slot_values: Record<string, unknown>;
}

export interface AssembleResult {
  /** Concatenated rendered blocks (no shell — see document-shell.ts). */
  html: string;
  /** component_ids rendered, in order. */
  rendered_ids: string[];
}

/** Thrown when a composition references a component_id absent from the
 *  catalog. No fallback — a composition that names an unknown component is
 *  a hard error. */
export class UnknownComponentError extends Error {
  constructor(
    public readonly component_id: string,
    public readonly index: number,
  ) {
    super(
      `factory-v2: composition block [${index}] references component_id "${component_id}", ` +
        `which is not in CATALOG.by_id. No fallback — every block must be a cataloged Homer component. ` +
        `(catalog has ${CATALOG.total_count} components.)`,
    );
    this.name = 'UnknownComponentError';
  }
}

/**
 * Compose an ordered list of catalog blocks into an HTML fragment.
 * Each block renders ONLY from its catalog entry's html_template.
 */
export function assembleComposition(blocks: CompositionBlock[]): AssembleResult {
  const parts: string[] = [];
  const rendered_ids: string[] = [];

  blocks.forEach((block, index) => {
    const entry = CATALOG.by_id[block.component_id];
    if (!entry) {
      throw new UnknownComponentError(block.component_id, index);
    }
    parts.push(renderTemplate(entry.html_template, block.slot_values));
    rendered_ids.push(entry.id);
  });

  return { html: parts.join('\n'), rendered_ids };
}

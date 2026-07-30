// Catalog validation — structural checks on html_template.
//
// WHY THIS EXISTS
//
// `{{key?className}}` compiles to `{{#key}}className{{/key}}` via `rest.trim()`
// in assembler/template.ts. It inserts NO separator. So this:
//
//     class="hero-media{{has_media?is-media}}"
//
// renders `class="hero-mediais-media"` — neither class matches anything. That
// shipped, and it cost a full debugging pass: with `.hero-media` not applying,
// its `position: relative` was gone, so the absolutely positioned `__bg` and
// `__scrim` resolved against the initial containing block and painted over the
// sections below. It only surfaced once the business uploaded hero media,
// because the sibling `{{^has_media}} is-solid{{/has_media}}` branch happened to
// carry a leading space.
//
// The compiler CANNOT fix this by inserting a space, because concatenation is
// sometimes the point: `container{{fluid?-fluid}}` builds `container-fluid`, and
// `ti-{{included?check}}` builds `ti-check`. So the separator is the author's
// responsibility, and this check makes forgetting it a test failure rather than
// a rendering mystery.

import type { ComponentCatalogEntry } from './types';

export interface ClassSeparatorViolation {
  component_id: string;
  /** The class attribute the construct appears in. */
  class_attr: string;
  /** The offending construct, e.g. "{{has_media?is-media}}". */
  construct: string;
  /** The character immediately before it. */
  preceded_by: string;
  /** What it would render as when the condition is truthy. */
  renders_as: string;
}

/**
 * Deliberate concatenations, exempt from the separator rule.
 *
 * Keyed `"<component_id>:<construct>"` — narrow on purpose. Exempting a whole
 * component would let a genuine mistake in the same template pass unnoticed, so
 * each intentional case is listed with the reason it is intentional.
 */
export const CLASS_CONCAT_ALLOWLIST = new Set<string>([
  // Builds `container-fluid` from `container` + `-fluid`. Bootstrap's modifier
  // is a suffix on one class, not a second class.
  'container:{{fluid?-fluid}}',
  // Builds a Tabler icon name in place: `ti-` + `check`/`x`, plus a colour
  // class. `ti-check text-success` is one assembled icon name and one class, so
  // the leading hyphen has to stay glued.
  'card-pricing:{{included?check text-success:x text-danger}}',
]);

const CLASS_ATTR_RE = /class="([^"]*)"/g;
/** `{{key?...}}` and `{{^key}}` — the two forms that emit a class conditionally. */
const CONSTRUCT_RE = /\{\{(?:\^?[a-zA-Z_][\w]*\?[^}]*|\^[a-zA-Z_][\w]*)\}\}/g;

/**
 * A conditional-class construct must be separated from what precedes it by:
 *   - the start of the attribute value,
 *   - whitespace, or
 *   - the end of another construct (`}}`).
 *
 * The `}}` case is allowed because adjacent constructs are how mutual exclusion
 * is expressed — `{{a?x}}{{^a}}y{{/a}}` emits exactly one of x / y, so no
 * separator is needed or wanted. Whether two adjacent constructs can BOTH emit
 * is not statically decidable, so that contract stays with the author.
 */
export function findClassSeparatorViolations(
  entries: ComponentCatalogEntry[],
  /** Override for tests: pass an empty set to see what the allowlist suppresses. */
  allowlist: ReadonlySet<string> = CLASS_CONCAT_ALLOWLIST,
): ClassSeparatorViolation[] {
  const out: ClassSeparatorViolation[] = [];

  for (const entry of entries) {
    const tpl = entry.html_template ?? '';
    for (const attrMatch of tpl.matchAll(CLASS_ATTR_RE)) {
      const value = attrMatch[1];
      for (const c of value.matchAll(CONSTRUCT_RE)) {
        const at = c.index ?? 0;
        if (at === 0) continue;                        // start of the attribute
        const before = value.slice(0, at);
        const prev = before.slice(-1);
        if (/\s/.test(prev)) continue;                 // properly separated
        if (before.endsWith('}}')) continue;           // adjacent construct
        if (allowlist.has(`${entry.id}:${c[0]}`)) continue;

        // Show what it actually produces, so the failure reads as the bug.
        const inner = c[0].replace(/^\{\{\^?/, '').replace(/\}\}$/, '');
        const emitted = inner.includes('?')
          ? inner.slice(inner.indexOf('?') + 1).split(':')[0].trim()
          : '';
        const lastToken = before.split(/\s/).pop() ?? '';
        out.push({
          component_id: entry.id,
          class_attr: attrMatch[0],
          construct: c[0],
          preceded_by: prev,
          renders_as: `${lastToken}${emitted}`,
        });
      }
    }
  }
  return out;
}

/** One-line-per-violation message for a test failure or a build guard. */
export function formatClassSeparatorViolations(v: ClassSeparatorViolation[]): string {
  return v.map((x) =>
    `  ${x.component_id}: ${x.construct} follows '${x.preceded_by}' in ${x.class_attr}\n` +
    `      renders as "${x.renders_as}" — one mangled token, not two classes.\n` +
    `      Fix: put a space BEFORE the construct. If the concatenation is\n` +
    `      deliberate, add "${x.component_id}:${x.construct}" to\n` +
    `      CLASS_CONCAT_ALLOWLIST in component-catalog/validate.ts with a reason.`,
  ).join('\n');
}

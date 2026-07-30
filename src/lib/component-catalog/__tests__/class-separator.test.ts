import { describe, it, expect } from 'vitest';
import { CATALOG } from '../index';
import {
  findClassSeparatorViolations,
  formatClassSeparatorViolations,
  CLASS_CONCAT_ALLOWLIST,
} from '../validate';
import type { ComponentCatalogEntry } from '../types';

// Regression guard for the bug that shipped as class="hero-mediais-media".
//
// {{key?className}} compiles with NO separator (assembler/template.ts uses
// rest.trim()), so `class="hero-media{{has_media?is-media}}"` renders one
// mangled token and neither class matches. The compiler cannot insert a space
// because `container{{fluid?-fluid}}` concatenates on purpose — so the rule is
// enforced here instead, and forgetting it fails the suite.

const ALL = Object.values(CATALOG.by_id) as ComponentCatalogEntry[];

function entry(id: string, html_template: string): ComponentCatalogEntry {
  return { id, html_template } as ComponentCatalogEntry;
}

describe('catalog: conditional-class separator', () => {
  it('THE WHOLE LIVE CATALOG is free of unseparated conditional classes', () => {
    const violations = findClassSeparatorViolations(ALL);
    expect(
      violations,
      violations.length
        ? `\n${violations.length} unseparated conditional class(es):\n${formatClassSeparatorViolations(violations)}\n`
        : '',
    ).toEqual([]);
  });

  it('catches the exact bug that shipped', () => {
    const v = findClassSeparatorViolations([
      entry('hero-media', '<section class="hero-media{{has_media?is-media}}">'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].renders_as).toBe('hero-mediais-media');
    expect(v[0].preceded_by).toBe('a');
  });

  it('accepts the same template once a space is added', () => {
    expect(findClassSeparatorViolations([
      entry('hero-media', '<section class="hero-media {{has_media?is-media}}">'),
    ])).toEqual([]);
  });

  it('accepts a construct at the very start of the attribute', () => {
    expect(findClassSeparatorViolations([
      entry('x', '<div class="{{active?active}} card">'),
    ])).toEqual([]);
  });

  it('accepts adjacent constructs — that is how mutual exclusion is written', () => {
    // Exactly one of these emits, so a separator would insert a stray space.
    expect(findClassSeparatorViolations([
      entry('x', '<div class="base {{a?on}}{{^a}}off{{/a}}">'),
    ])).toEqual([]);
  });

  it('catches an inverted section glued to a preceding class', () => {
    const v = findClassSeparatorViolations([
      entry('x', '<div class="base{{^a}}off{{/a}}">'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].construct).toBe('{{^a}}');
  });

  it('checks every class attribute, not just the first', () => {
    const v = findClassSeparatorViolations([
      entry('x', '<div class="ok {{a?y}}"><span class="bad{{b?z}}"></span></div>'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].renders_as).toBe('badz');
  });

  it('ignores conditionals outside a class attribute', () => {
    expect(findClassSeparatorViolations([
      entry('x', '<div data-state="on{{a?-active}}" aria-label="x{{b?y}}"></div>'),
    ])).toEqual([]);
  });

  it('honours the allowlist, and only for the exact component + construct', () => {
    // container{{fluid?-fluid}} is deliberate: it builds `container-fluid`.
    expect(findClassSeparatorViolations([
      entry('container', '<div class="container{{fluid?-fluid}}">'),
    ])).toEqual([]);
    // The same construct on a DIFFERENT component is not exempt.
    expect(findClassSeparatorViolations([
      entry('not-container', '<div class="container{{fluid?-fluid}}">'),
    ])).toHaveLength(1);
  });

  it('every allowlist entry still corresponds to a real catalog construct', () => {
    // Stops the allowlist rotting into a set of blanket exemptions that quietly
    // cover new mistakes after a template is rewritten.
    const live = new Set<string>();
    for (const e of ALL) {
      for (const attr of (e.html_template ?? '').matchAll(/class="([^"]*)"/g)) {
        for (const c of attr[1].matchAll(/\{\{(?:\^?[a-zA-Z_][\w]*\?[^}]*|\^[a-zA-Z_][\w]*)\}\}/g)) {
          live.add(`${e.id}:${c[0]}`);
        }
      }
    }
    const stale = [...CLASS_CONCAT_ALLOWLIST].filter((k) => !live.has(k));
    expect(stale, `stale allowlist entries — remove them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

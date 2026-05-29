import { describe, it, expect } from 'vitest';
import { renderTemplate, preprocessHomerConstructs } from '../template';

// Covers the four Homer constructs the preprocessor rewrites to vanilla
// Mustache (see template.ts). Each construct: truthy / falsy / empty / missing.

describe('renderTemplate — Homer constructs', () => {
  // ── {{slot:NAME}} — raw-HTML slot fill ────────────────────────────────
  describe('slot fill {{slot:NAME}}', () => {
    it('renders the flat slot value as RAW (unescaped) HTML when present', () => {
      const out = renderTemplate('<div>{{slot:content}}</div>', {
        content: '<b>hi</b>',
      });
      expect(out).toBe('<div><b>hi</b></div>'); // not escaped
    });

    it('renders empty when the slot key is missing', () => {
      const out = renderTemplate('<div>{{slot:content}}</div>', {});
      expect(out).toBe('<div></div>');
    });

    it('renders empty when the slot value is an empty string', () => {
      const out = renderTemplate('<div>{{slot:content}}</div>', { content: '' });
      expect(out).toBe('<div></div>');
    });
  });

  // ── {{key|default}} — default when empty/missing ──────────────────────
  describe('default {{key|default}}', () => {
    it('uses the value when present and non-empty (escaped)', () => {
      const out = renderTemplate('<i>{{label|Email}}</i>', { label: 'Name <x>' });
      expect(out).toBe('<i>Name &lt;x&gt;</i>'); // escaped scalar
    });

    it('uses the default when the key is an empty string', () => {
      const out = renderTemplate('<i>{{label|Email}}</i>', { label: '' });
      expect(out).toBe('<i>Email</i>');
    });

    it('uses the default when the key is missing', () => {
      const out = renderTemplate('<i>{{label|Email}}</i>', {});
      expect(out).toBe('<i>Email</i>');
    });

    it('handles defaults containing spaces and commas', () => {
      const out = renderTemplate('<i>{{format|d M, Y}}</i>', {});
      expect(out).toBe('<i>d M, Y</i>');
    });
  });

  // ── {{key?className}} — conditional class ─────────────────────────────
  describe('conditional class {{key?className}}', () => {
    it('emits the class when the flag is truthy', () => {
      const out = renderTemplate('<a class="x {{first?active}}">', { first: true });
      expect(out).toBe('<a class="x active">');
    });

    it('emits nothing when the flag is falsy', () => {
      const out = renderTemplate('<a class="x {{first?active}}">', { first: false });
      expect(out).toBe('<a class="x ">');
    });

    it('emits nothing when the flag is missing', () => {
      const out = renderTemplate('<a class="x {{first?active}}">', {});
      expect(out).toBe('<a class="x ">');
    });

    it('handles multi-word class names', () => {
      const out = renderTemplate('<div class="{{active?show active}}">', { active: true });
      expect(out).toBe('<div class="show active">');
    });
  });

  // ── {{key?truthy:falsy}} — ternary (incl. empty-truthy form) ──────────
  describe('ternary {{key?truthy:falsy}}', () => {
    it('emits the truthy arm when set', () => {
      const out = renderTemplate('<i class="{{included?check text-success:x text-danger}}">', {
        included: true,
      });
      expect(out).toBe('<i class="check text-success">');
    });

    it('emits the falsy arm when unset', () => {
      const out = renderTemplate('<i class="{{included?check text-success:x text-danger}}">', {
        included: false,
      });
      expect(out).toBe('<i class="x text-danger">');
    });

    it("empty-truthy form {{open?'':collapsed}} — truthy emits nothing", () => {
      const out = renderTemplate('<button class="b {{open?\'\':collapsed}}">', { open: true });
      expect(out).toBe('<button class="b ">');
    });

    it("empty-truthy form {{open?'':collapsed}} — falsy emits the class", () => {
      const out = renderTemplate('<button class="b {{open?\'\':collapsed}}">', { open: false });
      expect(out).toBe('<button class="b collapsed">');
    });
  });

  // ── Untouched: plain tags + sections still behave like vanilla ────────
  describe('vanilla Mustache untouched', () => {
    it('plain {{key}} is HTML-escaped', () => {
      expect(renderTemplate('<p>{{x}}</p>', { x: '<b>' })).toBe('<p>&lt;b&gt;</p>');
    });

    it('triple-brace {{{key}}} stays raw', () => {
      expect(renderTemplate('<p>{{{x}}}</p>', { x: '<b>' })).toBe('<p><b></p>');
    });

    it('sections {{#list}}…{{/list}} still iterate', () => {
      const out = renderTemplate('{{#opts}}<li>{{v}}</li>{{/opts}}', {
        opts: [{ v: 'a' }, { v: 'b' }],
      });
      expect(out).toBe('<li>a</li><li>b</li>');
    });

    it('inverted sections {{^x}} still render on falsy', () => {
      expect(renderTemplate('{{^x}}none{{/x}}', {})).toBe('none');
    });
  });

  // ── Preprocessor output shape (white-box sanity) ──────────────────────
  describe('preprocessHomerConstructs rewrites', () => {
    it('slot → triple-brace', () => {
      expect(preprocessHomerConstructs('{{slot:content}}')).toBe('{{{content}}}');
    });
    it('default → section + inverted', () => {
      expect(preprocessHomerConstructs('{{rows|5}}')).toBe(
        '{{#rows}}{{rows}}{{/rows}}{{^rows}}5{{/rows}}',
      );
    });
    it('conditional class → section', () => {
      expect(preprocessHomerConstructs('{{first?active}}')).toBe('{{#first}}active{{/first}}');
    });
    it('ternary → section + inverted', () => {
      expect(preprocessHomerConstructs('{{open?\'\':collapsed}}')).toBe(
        '{{#open}}{{/open}}{{^open}}collapsed{{/open}}',
      );
    });
    it('leaves plain tags, triple-brace, and sections alone', () => {
      expect(preprocessHomerConstructs('{{x}}')).toBe('{{x}}');
      expect(preprocessHomerConstructs('{{{x}}}')).toBe('{{{x}}}');
      expect(preprocessHomerConstructs('{{#x}}a{{/x}}')).toBe('{{#x}}a{{/x}}');
    });
  });
});

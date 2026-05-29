// Mustache wrapper. The catalog component templates use {{slot}} and
// {{#section}}…{{/section}} syntax — Mustache's exact grammar. We disable
// HTML-escape on a per-slot basis for fields that contain markup we
// generated ourselves (chart container ids, integer values) and keep it
// on for anything coming from the LLM.

import Mustache from 'mustache';

// Force-disable Mustache's tag re-escaping. The catalog templates use
// plain {{...}} for value interpolation; we deliberately want their
// values HTML-escaped to neutralize XSS in LLM-supplied strings. The
// only "raw" markers are {{{slot}}} (triple-brace) which Mustache
// natively treats as unescaped.
Mustache.escape = function (text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ── Homer construct preprocessor ─────────────────────────────────────────
// The Homer catalog templates (catalog-recon-report.md §R4) are authored in a
// notation that is NOT vanilla Mustache. Four constructs need rewriting to
// equivalent vanilla-Mustache before render, or they silently resolve to empty
// (vanilla treats e.g. `slot:content` as a literal key name that isn't in the
// view). We rewrite the template string once, then hand it to Mustache.render.
//
//   {{slot:NAME}}            raw-HTML slot fill        → {{{NAME}}}
//                            (caller puts the slot value on the view under its
//                             flat name — bare `NAME`, e.g. `content` — so we
//                             read it as triple-brace raw HTML, unescaped)
//   {{key|default}}          default when key empty    → {{#key}}{{key}}{{/key}}{{^key}}default{{/key}}
//   {{key?className}}        emit class if key truthy   → {{#key}}className{{/key}}
//   {{key?truthy:falsy}}     ternary                    → {{#key}}truthy{{/key}}{{^key}}falsy{{/key}}
//                            (covers the `{{open?'':collapsed}}` empty-truthy
//                             form and the general 2-arm form; '' / quotes are
//                             stripped from each arm)
//
// Only plain double-brace tags are touched. Triple-brace `{{{x}}}`, sections
// `{{#x}}`/`{{/x}}`/`{{^x}}`, comments `{{!}}`, partials `{{>}}`, unescaped
// `{{&}}`, and set-delimiters `{{=}}` are left untouched (negative lookahead).
// Single global pass over the ORIGINAL template — the sections we emit are not
// re-scanned, so generated `{{#key}}` blocks render via vanilla Mustache.

function stripWrappingQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function preprocessHomerConstructs(template: string): string {
  return template.replace(
    /\{\{(?![{#/^!>&=])\s*([^{}]+?)\s*\}\}/g,
    (full: string, inner: string): string => {
      // 1. Raw-HTML slot fill: {{slot:NAME}} → {{{NAME}}}
      if (inner.startsWith('slot:')) {
        const name = inner.slice('slot:'.length).trim();
        return `{{{${name}}}}`;
      }

      const q = inner.indexOf('?');
      const pipe = inner.indexOf('|');

      // 2. Conditional class / ternary: key?...  (no pipe in the catalog forms)
      if (q !== -1 && pipe === -1) {
        const key = inner.slice(0, q).trim();
        const rest = inner.slice(q + 1);
        const colon = rest.indexOf(':');
        if (colon !== -1) {
          // ternary: key?truthy:falsy
          const truthy = stripWrappingQuotes(rest.slice(0, colon).trim());
          const falsy = stripWrappingQuotes(rest.slice(colon + 1).trim());
          return `{{#${key}}}${truthy}{{/${key}}}{{^${key}}}${falsy}{{/${key}}}`;
        }
        // conditional class: key?className
        const cls = stripWrappingQuotes(rest.trim());
        return `{{#${key}}}${cls}{{/${key}}}`;
      }

      // 3. Default: key|default  (no '?' in the catalog forms)
      if (pipe !== -1 && q === -1) {
        const key = inner.slice(0, pipe).trim();
        const def = inner.slice(pipe + 1); // literal text; may contain spaces/commas
        return `{{#${key}}}{{${key}}}{{/${key}}}{{^${key}}}${def}{{/${key}}}`;
      }

      // 4. Plain tag — leave unchanged (vanilla Mustache, HTML-escaped).
      return full;
    },
  );
}

export function renderTemplate(
  template: string,
  view: Record<string, unknown>,
): string {
  return Mustache.render(preprocessHomerConstructs(template), view);
}

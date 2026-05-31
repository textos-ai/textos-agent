// factory-v2 — clean-room template renderer.
//
// CLEAN-ROOM PROOF (additive only). This is an INDEPENDENT re-implementation
// of the Homer-construct preprocessing + Mustache render that the catalog
// `html_template` strings expect. It deliberately does NOT import the existing
// assembler (src/lib/assembler/template.ts) so this proof stands alone — but
// the construct rules below mirror that file exactly so the SAME catalog
// templates render identically.
//
// Homer constructs rewritten to vanilla Mustache before render (else they
// resolve to empty, e.g. card-basic's `{{slot:content}}` body):
//   {{slot:NAME}}         → {{{NAME}}}                       (raw-HTML slot)
//   {{key|default}}       → {{#key}}{{key}}{{/key}}{{^key}}default{{/key}}
//   {{key?className}}     → {{#key}}className{{/key}}
//   {{key?truthy:falsy}}  → {{#key}}truthy{{/key}}{{^key}}falsy{{/key}}
//
// Plain {{...}} tags are HTML-escaped (XSS-neutral); only {{{...}}} (and
// {{slot:...}}, which compiles to it) render raw.

import Mustache from 'mustache';

// Force-disable Mustache's default tag re-escaping, then supply our own so
// plain {{...}} values are HTML-escaped. Mirrors assembler/template.ts.
Mustache.escape = function (text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

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

      // 2. Conditional class / ternary: key?...  (no pipe form)
      if (q !== -1 && pipe === -1) {
        const key = inner.slice(0, q).trim();
        const rest = inner.slice(q + 1);
        const colon = rest.indexOf(':');
        if (colon !== -1) {
          const truthy = stripWrappingQuotes(rest.slice(0, colon).trim());
          const falsy = stripWrappingQuotes(rest.slice(colon + 1).trim());
          return `{{#${key}}}${truthy}{{/${key}}}{{^${key}}}${falsy}{{/${key}}}`;
        }
        const cls = stripWrappingQuotes(rest.trim());
        return `{{#${key}}}${cls}{{/${key}}}`;
      }

      // 3. Default: key|default  (no '?' form)
      if (pipe !== -1 && q === -1) {
        const key = inner.slice(0, pipe).trim();
        const def = inner.slice(pipe + 1);
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

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

export function renderTemplate(
  template: string,
  view: Record<string, unknown>,
): string {
  return Mustache.render(template, view);
}

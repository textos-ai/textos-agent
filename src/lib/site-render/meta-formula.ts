// Per-page title and description formulas, evaluated from facts at render time.
//
// The formulas live on the TEMPLATE (page_types[].meta_formula), not in code, so
// a vertical can change how its pages describe themselves without a deploy.
//
// WHY EVALUATED AT RENDER, NOT SEEDED
//
// Migration 100 seeded meta_defaults into site_pages.meta once, at provision
// time. That snapshot goes stale the moment a business adds a service area or
// changes its name, and nothing re-runs it. A formula reads live facts on every
// request, so the title of a page cannot drift from what the page contains — the
// same property that makes derived fields correct by construction.
//
// Unknown tokens are left alone rather than blanked, so a typo in a template
// shows up as "{buiness_name}" on the page instead of a title with a hole in it.
// Visible beats silent.

import type { SiteFacts } from "./facts";

export interface MetaFormula {
  title?: string;
  description?: string;
}

/**
 * Token values available to a formula. Everything traces to a fact the operator
 * entered; nothing is invented, and an absent fact yields an empty token rather
 * than a guess.
 */
export function metaTokens(
  facts: SiteFacts,
  businessName: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const p = facts.profile;
  const services = facts.services.map((s) => s.name);
  const areas = facts.areas.map((a) => a.city);
  return {
    business_name: businessName,
    locality: p?.locality ?? "",
    region: p?.region ?? "",
    trade_noun: p?.trade_noun ?? "",
    trade_noun_plural: p?.trade_noun_plural ?? "",
    primary_service: services[0] ?? "",
    service_count: String(services.length),
    service_list: services.slice(0, 3).join(", "),
    area_count: String(areas.length),
    area_list: areas.slice(0, 3).join(", "),
    ...extra,
  };
}

/** Interpolate {token} placeholders. Unknown tokens survive verbatim. */
export function renderFormula(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : whole);
}

/**
 * Collapse the whitespace and stray punctuation left behind when a token resolves
 * to nothing — "Electrician in , LA" is worse than a shorter title.
 */
export function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    // Tighten only against punctuation that hugs the previous word. The em-dash
    // is a SEPARATOR and keeps its space — stripping it produced titles reading
    // "JK Quality Electric— electrician".
    .replace(/\s+([,.;:])/g, "$1")
    // A separator left dangling by an empty token, e.g. "Electrician in , LA".
    .replace(/([,—–-])\s*(?=[,.])/g, "")
    .replace(/\s*[—–-]\s*(?=$)/g, "")
    .replace(/(?<=^)\s*[—–,-]\s*/g, "")
    // "in , LA" -> "in LA" when a token resolved to nothing.
    .replace(/\b(in|near|across)\s*,\s*/gi, "$1 ")
    .replace(/,\s*,/g, ",")
    .trim();
}

export interface MetaLengths { title: number; description: number }

/**
 * Apply a formula, or return null when the template defines none.
 *
 * Lengths are reported rather than enforced by truncation: a title cut mid-word
 * reads as broken, and the honest fix is to shorten the formula. The manager can
 * surface an over-length title; silently chopping it would hide the problem.
 */
export function applyMetaFormula(
  formula: MetaFormula | undefined | null,
  tokens: Record<string, string>,
): { title: string | null; description: string | null } {
  if (!formula) return { title: null, description: null };
  return {
    title: formula.title ? tidy(renderFormula(formula.title, tokens)) || null : null,
    description: formula.description ? tidy(renderFormula(formula.description, tokens)) || null : null,
  };
}

/** Advisory bounds, checked not enforced. Google truncates around these. */
export const META_BOUNDS = { titleMax: 60, descMin: 140, descMax: 160 };

export function metaLengthWarnings(title: string | null, description: string | null): string[] {
  const w: string[] = [];
  if (title && title.length > META_BOUNDS.titleMax) {
    w.push(`title is ${title.length} characters; search results cut around ${META_BOUNDS.titleMax}`);
  }
  if (description && description.length < META_BOUNDS.descMin) {
    w.push(`description is ${description.length} characters; aim for ${META_BOUNDS.descMin}–${META_BOUNDS.descMax}`);
  }
  if (description && description.length > META_BOUNDS.descMax) {
    w.push(`description is ${description.length} characters; search results cut around ${META_BOUNDS.descMax}`);
  }
  return w;
}

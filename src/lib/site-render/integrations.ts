// Provider registry + per-site integration config (Phase 3A, Parts A and B).
//
// ADDING A PROVIDER MUST NOT REQUIRE A DEPLOY. Everything vendor-specific —
// the markup shape, where it belongs on the page, which fields the operator
// fills, what each field must look like — is a row in site_integration_providers.
// Nothing in this file knows what Housecall Pro or ElevenLabs is.
//
// OPERATORS SUPPLY VALUES, NEVER MARKUP. The embed template is admin-authored and
// is the only place HTML is written. An operator's value is checked against its
// field's own regex and then HTML-escaped into the template. There is no
// raw-HTML provider at any tier: an unvalidated "agent ID" box is a smaller
// injection surface than a textarea, not a safe one, and this renders on a
// licensed contractor's public site.
//
// This module is the DATA layer: load, validate, compose one embed. Where the
// composed fragments end up in the document is Part C.

import type { SupabaseClient } from "@supabase/supabase-js";
import { renderTemplate } from "../assembler/template";
import { unwrap } from "./facts";

/** Where a provider's markup belongs in the document. */
export type Placement = "head" | "body_end" | "inline_mount";

export const PLACEMENTS: readonly Placement[] = ["head", "body_end", "inline_mount"];

/** Screen corners a widget can claim. Null means it has no visible furniture. */
export const POSITIONS = [
  "bottom-right", "bottom-left", "top-right", "top-left", "fullscreen",
] as const;

/** Status of one site's integration. NEVER optimistic — see STATUSES. */
export const STATUSES = ["unverified", "connected", "error", "disabled"] as const;
export type IntegrationStatus = (typeof STATUSES)[number];

export interface ProviderField {
  key: string;
  label: string;
  help?: string | null;
  /** REQUIRED. A field without a pattern is rejected when the provider is saved. */
  pattern: string;
  required?: boolean;
  placeholder?: string | null;
}

export interface Provider {
  provider_key: string;
  display_name: string;
  category: string;
  embed_template: string;
  placement: Placement;
  fields: ProviderField[];
  position: string | null;
  requires_consent: boolean;
  provider_domains: string[];
  docs_url: string | null;
  active: boolean;
}

export interface SiteIntegration {
  id: string;
  site_id: string;
  provider: string;
  config: Record<string, unknown>;
  is_active: boolean;
  status: IntegrationStatus;
  last_verified_at: string | null;
}

/**
 * A pattern an admin wrote, compiled defensively.
 *
 * The registry is admin-only, so this is not a hostile input — but a regex is
 * still the one field where a typo becomes a hang rather than a wrong answer.
 * The length cap and the anchoring requirement below keep a catastrophically
 * backtracking pattern from reaching the request path, and the value being
 * matched is capped too, which is what actually bounds the work.
 */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_VALUE_LENGTH = 512;

export class ProviderDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderDefinitionError";
  }
}

/**
 * Validate a provider definition before it is stored.
 *
 * EVERY FIELD MUST CARRY A PATTERN. This is the load-bearing rule of the whole
 * design: the guarantee that an operator cannot inject markup comes from the
 * value being constrained, not from the template being careful. A field with no
 * pattern silently becomes a free-text box that lands inside a <script> tag.
 */
export function validateProviderDefinition(p: {
  provider_key?: unknown; embed_template?: unknown; fields?: unknown; placement?: unknown;
}): ProviderField[] {
  const fields = Array.isArray(p.fields) ? p.fields : null;
  if (!fields) throw new ProviderDefinitionError("fields must be an array");

  const seen = new Set<string>();
  const out: ProviderField[] = [];
  for (const raw of fields) {
    const f = raw as Partial<ProviderField>;
    if (!f || typeof f.key !== "string" || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(f.key)) {
      throw new ProviderDefinitionError(
        `field key must be lower_snake_case; got ${JSON.stringify(f?.key)}`);
    }
    if (seen.has(f.key)) throw new ProviderDefinitionError(`duplicate field key '${f.key}'`);
    seen.add(f.key);

    if (typeof f.label !== "string" || f.label.trim() === "") {
      throw new ProviderDefinitionError(`field '${f.key}' needs a label`);
    }
    if (typeof f.pattern !== "string" || f.pattern.trim() === "") {
      throw new ProviderDefinitionError(
        `field '${f.key}' needs a validation pattern. Every field must constrain its value — `
        + `that constraint is the only thing standing between an operator and a script tag.`);
    }
    if (f.pattern.length > MAX_PATTERN_LENGTH) {
      throw new ProviderDefinitionError(
        `field '${f.key}' pattern is ${f.pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}`);
    }
    // ANCHORED, or it does not constrain anything: /G-[0-9]+/ happily matches
    // inside `"><script>...` and the field would pass while carrying markup.
    if (!f.pattern.startsWith("^") || !f.pattern.endsWith("$")) {
      throw new ProviderDefinitionError(
        `field '${f.key}' pattern must be anchored with ^ and $, or it matches a substring `
        + `and the rest of the value rides along unchecked`);
    }
    try {
      new RegExp(f.pattern);
    } catch (err) {
      throw new ProviderDefinitionError(`field '${f.key}' pattern is not a valid regex: ${String(err)}`);
    }

    out.push({
      key: f.key,
      label: f.label,
      help: typeof f.help === "string" ? f.help : null,
      pattern: f.pattern,
      required: f.required !== false,
      placeholder: typeof f.placeholder === "string" ? f.placeholder : null,
    });
  }

  const template = typeof p.embed_template === "string" ? p.embed_template : "";

  // NO RAW-OUTPUT CONSTRUCTS. renderTemplate escapes plain {{value}}, but it
  // also treats {{{value}}}, {{&value}} and {{slot:value}} as RAW HTML by
  // design — the assembler needs that for markup it generated itself. In an
  // embed template it would hand the operator's value straight through
  // unescaped, and the entire "operators supply values, never markup" guarantee
  // would come down to whoever wrote the template remembering which brace to
  // use. Rejected structurally instead of trusted.
  const raw = /\{\{\{|\{\{\s*&|\{\{\s*slot:/.exec(template);
  if (raw) {
    throw new ProviderDefinitionError(
      `embed_template uses the raw-output construct '${raw[0].trim()}', which skips HTML escaping. `
      + `Use plain {{field_key}} — the escape is what keeps an operator's value from becoming markup.`);
  }

  // A template placeholder with no field behind it can never be filled, and would
  // render the literal {{...}} onto a public page.
  const used = [...template.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  for (const name of new Set(used)) {
    if (!seen.has(name)) {
      throw new ProviderDefinitionError(
        `embed_template uses {{${name}}} but no field defines it`);
    }
  }
  return out;
}

export class IntegrationConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "IntegrationConfigError";
    this.field = field;
  }
}

/**
 * Check an operator's values against the provider's own field patterns.
 *
 * Returns the cleaned config — ONLY keys the provider declares. A value the
 * provider does not know about cannot reach the template, so an extra key in the
 * payload is dropped rather than stored and forgotten.
 */
export function validateIntegrationConfig(
  provider: Pick<Provider, "provider_key" | "fields">,
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of provider.fields) {
    const raw = config[f.key];
    const value = raw === undefined || raw === null ? "" : String(raw).trim();

    if (value === "") {
      if (f.required) {
        throw new IntegrationConfigError(f.key, `${f.label} is required`);
      }
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new IntegrationConfigError(
        f.key, `${f.label} is longer than ${MAX_VALUE_LENGTH} characters`);
    }
    if (!new RegExp(f.pattern).test(value)) {
      throw new IntegrationConfigError(
        f.key,
        `${f.label} is not in the expected format`
        + (f.placeholder ? ` — it should look like ${f.placeholder}` : "") + ".");
    }
    out[f.key] = value;
  }
  return out;
}

/**
 * Compose one integration's markup.
 *
 * renderTemplate HTML-escapes {{value}}, so a validated value cannot close an
 * attribute or open a tag even if a pattern were loosened later. Both guards are
 * deliberate: the pattern decides what is acceptable, the escape decides what is
 * possible.
 */
export function renderIntegration(
  provider: Provider,
  config: Record<string, unknown>,
): string {
  const safe = validateIntegrationConfig(provider, config);
  return renderTemplate(provider.embed_template, safe);
}

/** The active provider catalogue. */
export async function loadProviders(
  supabase: SupabaseClient,
  opts: { includeInactive?: boolean } = {},
): Promise<Provider[]> {
  let q = supabase
    .from("site_integration_providers")
    .select("provider_key, display_name, category, embed_template, placement, fields, position, "
      + "requires_consent, provider_domains, docs_url, active")
    .order("category", { ascending: true })
    .order("display_name", { ascending: true });
  if (!opts.includeInactive) q = q.eq("active", true);
  // Cast through unknown: the generated Supabase types resolve a multi-column
  // projection to GenericStringError[], the same shape every other caller in
  // site-render works around.
  return unwrap<Provider[]>(
    (await q) as unknown as Parameters<typeof unwrap<Provider[]>>[0],
    "site_integration_providers", []);
}

/** One site's configured integrations. */
export async function loadSiteIntegrations(
  supabase: SupabaseClient,
  siteId: string,
): Promise<SiteIntegration[]> {
  return unwrap<SiteIntegration[]>(
    await supabase
      .from("site_integrations")
      .select("id, site_id, provider, config, is_active, status, last_verified_at")
      .eq("site_id", siteId),
    "site_integrations",
    [],
  );
}

/**
 * Two ACTIVE integrations claiming the same screen corner.
 *
 * Not hypothetical: a chat widget and a voice agent both default to
 * bottom-right, and the second one to load sits on top of the first. Nothing can
 * detect this at render time — both providers are behaving correctly — so it is
 * surfaced in the manager where somebody can choose.
 */
export function positionConflicts(
  providers: Provider[],
  integrations: SiteIntegration[],
): Array<{ position: string; providers: string[] }> {
  const byPosition = new Map<string, string[]>();
  for (const i of integrations) {
    if (!i.is_active) continue;
    const p = providers.find((x) => x.provider_key === i.provider);
    if (!p?.position) continue;
    const list = byPosition.get(p.position) ?? [];
    list.push(p.display_name);
    byPosition.set(p.position, list);
  }
  return [...byPosition.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([position, providers]) => ({ position, providers: providers.sort() }));
}

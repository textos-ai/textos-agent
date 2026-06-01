// factory-v2 — REAL business context loader + no-fallbacks validation (Phase 1).
//
// Replaces SAMPLE_BUSINESS with the business's REAL DB context for the
// clean factory-v2 pipeline. Loads `businesses` (by slug) + `business_context`
// (by business_id) via the Worker's service-role Supabase client, then HALTS
// LOUDLY if any load-bearing field is missing — never substitutes a sample or
// placeholder value (workspace no-fallbacks rule; reference impl:
// tasks/research-strategy.ts).
//
// Column names are taken from the typed loaders in services/supabase.ts
// (BusinessRow / BusinessContextRow) and verified against the live TEST DB via
// the route's ?debug=context mode before relying on them.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BusinessRow, BusinessContextRow } from '../../services/supabase';

// Load-bearing fields the Strategy result writer needs to ground its output in
// the REAL business. Missing/empty any of these → hard fail (no fallback).
export const REQUIRED_BUSINESS_FIELDS = ['name'] as const; // on businesses
export const REQUIRED_CONTEXT_FIELDS = [
  'industry',
  'business_summary',
  'value_proposition',
  'brand_voice',
] as const; // on business_context

// Generic/placeholder industries are treated as MISSING (same discipline as
// research-strategy.ts rejecting "General Business" / "Other").
const GENERIC_INDUSTRIES = new Set(['', 'general business', 'general', 'other', 'n/a', 'none', 'tbd']);

export interface RealBusinessIdentity {
  name: string;
  /** Rich summary composed from real context fields — fed to buildStrategyLivePrompt. */
  summary: string;
}

export class MissingContextError extends Error {
  constructor(
    public readonly slug: string,
    public readonly missing: string[],
  ) {
    super(
      `factory-v2: business "${slug}" is missing required context field(s): ${missing.join(', ')}. ` +
        `No fallback — the clean pipeline refuses to generate from a sample/placeholder. ` +
        `Populate these via the build pipeline (businesses.name + business_context.{industry,` +
        `business_summary,value_proposition,brand_voice}).`,
    );
    this.name = 'MissingContextError';
  }
}

export class BusinessNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`factory-v2: no active business found for slug "${slug}".`);
    this.name = 'BusinessNotFoundError';
  }
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Load the real business + its context by slug (dev proof: no user-scope). */
export async function loadRealBusiness(
  client: SupabaseClient,
  slug: string,
): Promise<{ business: BusinessRow; ctx: BusinessContextRow | null }> {
  const { data: business, error } = await client
    .from('businesses')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  if (!business) throw new BusinessNotFoundError(slug);

  const { data: ctx, error: ctxErr } = await client
    .from('business_context')
    .select('*')
    .eq('business_id', (business as BusinessRow).id)
    .maybeSingle();
  if (ctxErr) throw ctxErr;

  return { business: business as BusinessRow, ctx: (ctx as BusinessContextRow | null) ?? null };
}

/** Load the real business + its context by business id (the published-app
 *  result endpoint is keyed by businessId, mirroring /api/generated-apps). */
export async function loadRealBusinessById(
  client: SupabaseClient,
  businessId: string,
): Promise<{ business: BusinessRow; ctx: BusinessContextRow | null }> {
  const { data: business, error } = await client
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  if (!business) throw new BusinessNotFoundError(businessId);

  const { data: ctx, error: ctxErr } = await client
    .from('business_context')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();
  if (ctxErr) throw ctxErr;

  return { business: business as BusinessRow, ctx: (ctx as BusinessContextRow | null) ?? null };
}

/** Which required fields are present vs missing — used by validation AND ?debug. */
export function requiredFieldReport(
  business: BusinessRow | null,
  ctx: BusinessContextRow | null,
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];

  for (const f of REQUIRED_BUSINESS_FIELDS) {
    (business && nonEmpty((business as unknown as Record<string, unknown>)[f]) ? present : missing).push(`businesses.${f}`);
  }
  for (const f of REQUIRED_CONTEXT_FIELDS) {
    const val = ctx ? (ctx as unknown as Record<string, unknown>)[f] : undefined;
    let ok = nonEmpty(val);
    if (ok && f === 'industry' && GENERIC_INDUSTRIES.has(String(val).trim().toLowerCase())) {
      ok = false; // generic industry counts as missing
    }
    (ok ? present : missing).push(`business_context.${f}`);
  }
  return { present, missing };
}

/** Validate + build the real business identity, or HALT LOUDLY. */
export function buildRealIdentity(
  slug: string,
  business: BusinessRow,
  ctx: BusinessContextRow | null,
): RealBusinessIdentity {
  const { missing } = requiredFieldReport(business, ctx);
  if (missing.length > 0) throw new MissingContextError(slug, missing);

  // ctx is guaranteed non-null here (its fields were all present).
  const c = ctx as BusinessContextRow;
  const summary = [
    c.business_summary,
    `Industry: ${c.industry}.`,
    `Value proposition: ${c.value_proposition}.`,
    `Brand voice: ${c.brand_voice}.`,
    nonEmpty(c.positioning_statement) ? `Positioning: ${c.positioning_statement}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { name: business.name, summary };
}

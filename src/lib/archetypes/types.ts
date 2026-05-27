// Archetype contract types. An archetype is a structural template for a
// generated mini-app: it captures the visitor flow (phases), the catalog
// components used in each phase, the JSON shape the LLM must produce
// (content schema), the paywall mechanic, and which events the runtime
// emits.
//
// This file is DATA-CONTRACT ONLY. The assembler (Brief B) consumes
// these shapes; the LLM call code (later) builds the content using the
// schema as prompt scaffolding. Nothing here renders HTML or evaluates
// expressions.

import type { ArchetypeId as CatalogArchetypeId } from '../component-catalog/types';

// Re-export the ArchetypeId so callers can import it from one place
// (the archetype layer) without reaching into the catalog package.
export type ArchetypeId = CatalogArchetypeId;

// ── Logged events ────────────────────────────────────────────────────────
// Union of every event the runtime emits. Each archetype declares a
// subset under its logged_events field. The assembler enforces that the
// archetype-level set is a superset of the per-phase sets.

export type LoggedEvent =
  | 'app_loaded'
  | 'phase_advance'
  | 'field_change'
  | 'wizard_step_complete'
  | 'paywall_shown'
  | 'paywall_submit'
  | 'paywall_abandon'
  | 'result_viewed'
  | 'result_shared'
  | 'result_downloaded'
  | 'cta_clicked';

// ── Content schema ───────────────────────────────────────────────────────
// Describes what JSON the LLM must produce. Used at two layers:
//   1. Prompt scaffolding — render this schema into an instruction the
//      LLM follows.
//   2. Server-side validation after the LLM responds.

export type ContentFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'enum';

export interface ContentSchemaField {
  /** Dotted path. Top-level fields use bare names ('hero', 'questions');
   *  array members use '[]' marker ('questions[]'); nested object props
   *  use dots ('hero.title'). Paths inside an item_schema are relative
   *  to that item. */
  path: string;
  type: ContentFieldType;
  required: boolean;
  description: string;
  /** Permitted values when type === 'enum'. */
  enum_values?: string[];
  /** For type === 'array' or 'object', the nested fields. Paths inside
   *  item_schema are scoped to the item, not the parent. */
  item_schema?: ContentSchemaField[];
  example?: unknown;
}

export interface ContentSchema {
  description: string;
  fields: ContentSchemaField[];
}

// ── Paywall ──────────────────────────────────────────────────────────────

export type PaywallType = 'email_gate' | 'stripe_payment';

export interface PaywallSpec {
  type: PaywallType;
  /** Phase whose completion triggers the paywall. Must match a phase.id
   *  on the same archetype. The phase with type='paywall' itself is the
   *  paywall surface; trigger_after_phase_id is the phase that PRECEDES
   *  it (typically the inputs phase). */
  trigger_after_phase_id: string;
  /** When true, render a teaser of the final result inside the paywall
   *  surface before the visitor unlocks the full payload. */
  teaser_visible: boolean;
  /** Assembler-facing instruction for what the teaser includes.
   *  Free-form text; the assembler honours it when rendering. */
  teaser_description?: string;
}

// ── Phases & components ─────────────────────────────────────────────────

export type PhaseType = 'inputs' | 'paywall' | 'result';

/** A reference to a catalog component plus the bindings that fill its
 *  slots from the content payload. */
export interface PhaseComponent {
  /** Must exist in CATALOG.by_id. */
  component_id: string;
  /** Maps catalog fillable_slot names to dotted paths into the content
   *  payload. Every key here must match an entry in the catalog
   *  component's fillable_slots array. */
  slot_bindings: Record<string, string>;
  /** When the parent phase contains a wizard, this declares which step
   *  (1-indexed) the component renders inside. Ignored otherwise.
   *  See the wizard-flattening note in strategy.ts. */
  step?: number;
  optional?: boolean;
  notes?: string;
}

export interface ArchetypePhase {
  id: string;
  type: PhaseType;
  components: PhaseComponent[];
  /** Mobile constraint: at 375px viewport, the phase's primary content
   *  must fit without scrolling. The assembler honours this when
   *  choosing layouts. */
  must_fit_above_fold: boolean;
  /** Subset of the archetype's logged_events that fire during this
   *  phase. Validated against the archetype-level set. */
  logged_events: LoggedEvent[];
}

// ── Result delivery ─────────────────────────────────────────────────────
// MVP: all four channels enabled for every archetype.

export interface ResultDelivery {
  on_page: boolean;
  emailed: boolean;
  permanent_url: boolean;
  pdf_download: boolean;
}

// ── Archetype (top-level) ───────────────────────────────────────────────

export interface Archetype {
  id: ArchetypeId;
  name: string;
  tagline: string;
  preview_thumbnail_url: string;
  example_intents: string[];

  phases: ArchetypePhase[];
  content_schema: ContentSchema;
  paywall: PaywallSpec;

  /** Components that MUST appear in at least one phase. Validation
   *  rule: subset of the union of phase component_ids. */
  required_components: string[];
  /** Components that MAY appear in a phase. Validation rule: subset of
   *  the union of phase component_ids. */
  optional_components: string[];

  /** Events this archetype's runtime emits. Per Part 6 rule 6: must be
   *  a superset of the union of all phase.logged_events. */
  logged_events: LoggedEvent[];

  result_delivery: ResultDelivery;
}

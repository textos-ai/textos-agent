// Homer / TextOS Component Catalog — shared types.
// Each catalog entry describes a reusable UI component the deterministic
// app assembler can compose into a generated mini-app. The recon report
// at .homer-reference/catalog-recon-report.md is the authoritative source
// for the verbatim entries; per-category files import and re-export the
// concrete constants.

export type ComponentCategory =
  | 'form' | 'display' | 'feedback' | 'navigation'
  | 'data-viz' | 'layout' | 'utility';

export type ArchetypeId = 'strategy' | 'assessment' | 'calculator';

export type ReliabilityTier = 'core' | 'extended' | 'experimental';

export type TextMode = 'native' | 'adapted' | 'visual-only';

export type SourceVerification = 'verbatim' | 'inferred' | 'custom';

export type InferenceConfidence = 'high' | 'medium' | 'low';

export type JsInit = 'noop' | 'auto' | 'manual';

import type {
  ElevationToken, RadiusToken, BorderToken, SurfaceToken, EmphasisToken,
} from './design-tokens';

/** Per-aspect capability: which dictionary tokens a component supports + its
 *  current default. `default` MUST be in `supported`; both reference the closed
 *  design-token sets (design-tokens.ts) — never free-text. */
export interface AspectCapability<T extends string> {
  supported: T[];
  default: T;
  /** one-line: how this aspect applies to THIS component (e.g. which slot drives it). */
  notes?: string;
}

/** Structured design-token capability for a component. Each aspect is optional —
 *  present only when the component meaningfully supports it. Harmonizes the
 *  existing free-text `homer_classes` / ad-hoc variant/size slots ONTO the
 *  dictionary; coins no new words. */
export interface ComponentCapabilities {
  /** one-line, component-level: when to reach for this component. */
  when_to_use: string;
  elevation?: AspectCapability<ElevationToken>;
  radius?: AspectCapability<RadiusToken>;
  border?: AspectCapability<BorderToken>;
  surface?: AspectCapability<SurfaceToken>;
  emphasis?: AspectCapability<EmphasisToken>;
}

export interface ComponentCatalogEntry {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;

  homer_classes: string;
  source_page?: string;

  html_template: string;
  fillable_slots: string[];

  js_init: JsInit;
  js_dependencies: string[];
  js_init_snippet?: string;

  mobile_responsive: boolean;
  text_mode: TextMode;
  text_mode_notes?: string;

  reliability_tier: ReliabilityTier;
  reliability_notes?: string;

  source_verification: SourceVerification;
  source_demo_path?: string;
  inference_confidence?: InferenceConfidence;

  archetype_fits: ArchetypeId[];
  example_usage?: string;

  /** Structured design-token capability (Phase B). Optional — entries without
   *  it are still valid; populated catalog entries reference design-tokens.ts. */
  capabilities?: ComponentCapabilities;
}

export interface ComponentCatalog {
  by_id: Record<string, ComponentCatalogEntry>;
  by_category: Record<ComponentCategory, ComponentCatalogEntry[]>;
  by_archetype: Record<ArchetypeId, ComponentCatalogEntry[]>;
  by_tier: Record<ReliabilityTier, ComponentCatalogEntry[]>;
  total_count: number;
}

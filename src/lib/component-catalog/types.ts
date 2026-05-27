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
}

export interface ComponentCatalog {
  by_id: Record<string, ComponentCatalogEntry>;
  by_category: Record<ComponentCategory, ComponentCatalogEntry[]>;
  by_archetype: Record<ArchetypeId, ComponentCatalogEntry[]>;
  by_tier: Record<ReliabilityTier, ComponentCatalogEntry[]>;
  total_count: number;
}

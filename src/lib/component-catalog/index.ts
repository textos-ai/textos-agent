import { FORM_COMPONENTS } from './form';
import { NAVIGATION_COMPONENTS } from './navigation';
import { DISPLAY_COMPONENTS } from './display';
import { FEEDBACK_COMPONENTS } from './feedback';
import { DATA_VIZ_COMPONENTS } from './data-viz';
import { LAYOUT_COMPONENTS } from './layout';
import { UTILITY_COMPONENTS } from './utility';
import { SITE_COMPONENTS } from './site';
import type {
  ComponentCatalog,
  ComponentCatalogEntry,
  ComponentCategory,
  ArchetypeId,
  ReliabilityTier,
} from './types';

const ALL: ComponentCatalogEntry[] = [
  ...FORM_COMPONENTS,
  ...NAVIGATION_COMPONENTS,
  ...DISPLAY_COMPONENTS,
  ...FEEDBACK_COMPONENTS,
  ...DATA_VIZ_COMPONENTS,
  ...LAYOUT_COMPONENTS,
  ...UTILITY_COMPONENTS,
  // Public client-site chrome — 'site' archetype only, never in a mini-app.
  ...SITE_COMPONENTS,
];

const by_id: Record<string, ComponentCatalogEntry> = {};
for (const c of ALL) by_id[c.id] = c;

const by_category: Record<ComponentCategory, ComponentCatalogEntry[]> = {
  form: [], navigation: [], display: [], feedback: [],
  'data-viz': [], layout: [], utility: [],
};
for (const c of ALL) by_category[c.category].push(c);

const by_archetype: Record<ArchetypeId, ComponentCatalogEntry[]> = {
  strategy: [], assessment: [], calculator: [], site: [],
};
for (const c of ALL) {
  for (const a of c.archetype_fits) by_archetype[a].push(c);
}

const by_tier: Record<ReliabilityTier, ComponentCatalogEntry[]> = {
  core: [], extended: [], experimental: [],
};
for (const c of ALL) by_tier[c.reliability_tier].push(c);

export const CATALOG: ComponentCatalog = {
  by_id, by_category, by_archetype, by_tier,
  total_count: ALL.length,
};

export type {
  ComponentCatalog, ComponentCatalogEntry, ComponentCategory,
  ArchetypeId, ReliabilityTier, TextMode, SourceVerification,
  InferenceConfidence, JsInit,
} from './types';

export function getComponent(id: string): ComponentCatalogEntry | undefined {
  return by_id[id];
}

export function getArchetypeComponents(
  archetype: ArchetypeId
): ComponentCatalogEntry[] {
  return by_archetype[archetype].filter(c => c.reliability_tier !== 'experimental');
}

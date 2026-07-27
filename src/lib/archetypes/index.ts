import { STRATEGY_ARCHETYPE } from './strategy';
import { ASSESSMENT_ARCHETYPE } from './assessment';
import { CALCULATOR_ARCHETYPE } from './calculator';
import type { Archetype, ArchetypeId } from './types';

// Partial: ArchetypeId now includes 'site', which is a CATALOG TAG for public
// client-site sections and has no assembler definition. getArchetype('site')
// returning undefined is the intended behavior — assembleApp() already halts on
// an unknown archetype, which is what should happen until Phase 1B settles how
// SSR consumes catalog entries.
export const ARCHETYPES: Partial<Record<ArchetypeId, Archetype>> = {
  strategy: STRATEGY_ARCHETYPE,
  assessment: ASSESSMENT_ARCHETYPE,
  calculator: CALCULATOR_ARCHETYPE,
};

export const ARCHETYPE_LIST: Archetype[] = [
  STRATEGY_ARCHETYPE,
  ASSESSMENT_ARCHETYPE,
  CALCULATOR_ARCHETYPE,
];

export function getArchetype(id: ArchetypeId): Archetype | undefined {
  return ARCHETYPES[id];
}

export type {
  Archetype,
  ArchetypeId,
  ArchetypePhase,
  PhaseComponent,
  PhaseType,
  ContentSchema,
  ContentSchemaField,
  ContentFieldType,
  PaywallSpec,
  PaywallType,
  LoggedEvent,
  ResultDelivery,
} from './types';

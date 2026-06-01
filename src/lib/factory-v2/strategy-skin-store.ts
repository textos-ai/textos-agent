// factory-v2 — persisted skin store (Phase 1, step 2).
//
// The skin for a business's clean factory-v2 app is picked RANDOMLY exactly
// once and stored in `factory_v2_app_skin(business_id PK, skin)` (migration
// 043). Every render reads it back — same business → same skin forever. This
// replaces the provisional `pickStableSkin(business.id)` derivation.
//
// Worker route context: Math.random() is available here (this is normal route
// code, not a workflow script). The Worker uses the service-role client, which
// bypasses RLS, so it can upsert/select freely.
//
// Backlog: `factory_v2_app_skin` is the Option-A interim store. At cutover —
// when the factory-v2 app persists as a real `business_assets` 'app' row —
// migrate the skin to per-app `app_configs.skin`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { FACTORY_V2_SKINS, type FactoryV2Skin } from './strategy-skin';

const TABLE = 'factory_v2_app_skin';

export interface SkinResult {
  skin: FactoryV2Skin;
  /** true when this call performed the one-time random pick + insert. */
  created: boolean;
}

function randomSkin(): FactoryV2Skin {
  return FACTORY_V2_SKINS[Math.floor(Math.random() * FACTORY_V2_SKINS.length)];
}

/**
 * Read the stored skin for a business, or pick one ONCE and persist it.
 * Concurrency-safe: the insert uses ON CONFLICT DO NOTHING and we re-read the
 * canonical row, so a race between two first-renders still yields one stable
 * stored value. Throws on DB error (no silent fallback).
 */
export async function getOrCreateSkin(client: SupabaseClient, businessId: string): Promise<SkinResult> {
  // 1. Read-back path (every render after the first).
  const existing = await client.from(TABLE).select('skin').eq('business_id', businessId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.skin) {
    return { skin: existing.data.skin as FactoryV2Skin, created: false };
  }

  // 2. First render — pick ONCE and persist (DO NOTHING on conflict).
  const pick = randomSkin();
  const ins = await client
    .from(TABLE)
    .upsert({ business_id: businessId, skin: pick }, { onConflict: 'business_id', ignoreDuplicates: true })
    .select('skin');
  if (ins.error) throw ins.error;

  // 3. Re-read the canonical stored value (handles the race where another
  //    request inserted first — DO NOTHING means our pick may not be the winner).
  const after = await client.from(TABLE).select('skin').eq('business_id', businessId).maybeSingle();
  if (after.error) throw after.error;
  const stored = (after.data?.skin as FactoryV2Skin | undefined) ?? pick;
  return { skin: stored, created: true };
}

/** Read-only lookup (no pick) — for diagnostics. */
export async function readStoredSkin(client: SupabaseClient, businessId: string): Promise<FactoryV2Skin | null> {
  const { data, error } = await client.from(TABLE).select('skin').eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return (data?.skin as FactoryV2Skin | undefined) ?? null;
}

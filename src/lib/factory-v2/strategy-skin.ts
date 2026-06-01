// factory-v2 — stable Homer skin selection (Step B, styling).
//
// REQUIREMENT (brief step 1): the generator picks ONE of the six Homer skins
// for an app and that choice must be STABLE — the same skin on every render,
// NOT random per page load. In production the chosen skin is persisted ONCE,
// at app-build time, on the business's app build metadata (today that is the
// `business_assets` app row / `app_configs` for the app — there is no dedicated
// `skin` column yet; when one is added, persist there). Once persisted, every
// render reads the stored value.
//
// This proof has no business DB row to persist to, so we derive the skin
// DETERMINISTICALLY from a stable business seed (the business name). Same
// business → same skin on every render — which is exactly the stability the
// requirement demands, and the value is effectively an arbitrary pick across
// the six. (A live `?skin=` query override is honored by the route for Rob's
// curation; the seeded value is the stable default.)

export const FACTORY_V2_SKINS = ['default', 'two', 'three', 'four', 'five', 'six'] as const;
export type FactoryV2Skin = (typeof FACTORY_V2_SKINS)[number];

export function isFactoryV2Skin(v: unknown): v is FactoryV2Skin {
  return typeof v === 'string' && (FACTORY_V2_SKINS as readonly string[]).includes(v);
}

/** Deterministic, stable skin pick from a business seed (djb2-ish hash). */
export function pickStableSkin(seed: string): FactoryV2Skin {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0; // h*33 + c
  }
  const idx = Math.abs(h) % FACTORY_V2_SKINS.length;
  return FACTORY_V2_SKINS[idx];
}

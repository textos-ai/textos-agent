// =============================================================
// Per-lead script settings: the monthly price and which services the pitch
// names. Shared by the admin modal and the caller lead page so both validate
// identically — a price a caller reads aloud must not be accepted by one
// surface and rejected by the other.
// =============================================================

export type SettingsPatch = Record<string, number | boolean>;

export type ParseResult =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; message: string };

const SERVICE_KEYS = ["svc_website", "svc_ai_automation", "svc_fb_ads", "svc_trustlight"] as const;

// Numeric price columns, each validated as > 0. script_price_monthly is the
// bundled monthly price for the three core services; trustlight_price_yearly is
// the Vetted Network's own yearly price (migration 125).
const PRICE_KEYS = ["script_price_monthly", "trustlight_price_yearly"] as const;

/**
 * Validate a partial settings update.
 *
 * PARTIAL by design: only the keys present are written, so toggling one
 * service can never silently reset the price.
 *
 * No-fallbacks on the price — anything unparseable, zero or negative halts
 * rather than defaulting. The DB CHECK (> 0) is the backstop; this is the
 * clean 400.
 */
export function parseSettingsPatch(body: Record<string, unknown>): ParseResult {
  const patch: SettingsPatch = {};

  for (const key of PRICE_KEYS) {
    if (key in body) {
      const raw = body[key];
      const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, message: `${key} must be a number greater than 0` };
      }
      patch[key] = Math.round(n * 100) / 100;
    }
  }

  for (const key of SERVICE_KEYS) {
    if (key in body) {
      if (typeof body[key] !== "boolean") {
        return { ok: false, message: `${key} must be a boolean` };
      }
      patch[key] = body[key] as boolean;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "nothing to update" };
  }
  return { ok: true, patch };
}

export const SETTINGS_COLS =
  "id, script_price_monthly, svc_website, svc_ai_automation, svc_fb_ads, " +
  "svc_trustlight, trustlight_price_yearly";

// =============================================================
// Parish Exclusive — the rules for who holds an area, and when it frees.
//
// Lives here, not in the route, so nothing can route around it. Migration 126
// enforces the race at the database level with a partial unique index:
//
//   coldcall_leads_one_exclusive_per_area
//     ON (exclusive_trade, exclusive_county, exclusive_state)
//     WHERE plan='exclusive' AND vetting_status='verified'
//       AND the three area fields are NOT NULL
//
// THE INDEX CANNOT CHECK EXPIRY. An index predicate must be IMMUTABLE and
// now() is STABLE (42P17), which is why `exclusive_until > now()` is absent
// from it. So an EXPIRED claim still physically occupies the slot. Freeing it
// is this module's job — 126's own comment names "the sweep in the exclusivity
// manager" as the mechanism. Everything here follows from that one fact.
// =============================================================

/** The index from migration 126. Matched by name so a DIFFERENT unique
 *  violation is never mistaken for an area conflict. */
export const AREA_CONSTRAINT = "coldcall_leads_one_exclusive_per_area";

export interface Area {
  trade: string;
  county: string;
  state: string;
}

/**
 * Case and whitespace are NOT cosmetic here.
 *
 * The unique index compares raw text, so "Roofing" and "roofing" in the same
 * parish are two different rows to Postgres and BOTH claims would be allowed —
 * quietly defeating the one guarantee the brief calls non-negotiable. Every
 * write normalises first so the index is comparing what we think it is.
 *
 * County keeps the underscored form the lead data already uses
 * (st_tammany, pearl_river_ms); state is upper-cased.
 */
export function normalizeArea(input: {
  trade?: unknown; county?: unknown; state?: unknown;
}): Area | { error: string } {
  const trade = String(input.trade ?? "").trim().toLowerCase();
  const county = String(input.county ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const state = String(input.state ?? "").trim().toUpperCase();
  // No fallbacks: an area with a missing part is not an area.
  if (!trade) return { error: "trade is required" };
  if (!county) return { error: "county is required" };
  if (!state) return { error: "state is required" };
  if (!/^[A-Z]{2}$/.test(state)) return { error: "state must be a 2-letter code, e.g. LA" };
  return { trade, county, state };
}

export const areaKey = (a: Area) => `${a.trade}|${a.county}|${a.state}`;

/** Human form for messages and the UI: "roofing in st_tammany, LA". */
export const areaLabel = (a: Area) => `${a.trade} in ${a.county}, ${a.state}`;

export type ClaimState = "active" | "expired" | "none";

export interface ExclusiveRow {
  id: string;
  name?: string | null;
  trading_name?: string | null;
  legal_name?: string | null;
  plan?: string | null;
  vetting_status?: string | null;
  exclusive_trade?: string | null;
  exclusive_county?: string | null;
  exclusive_state?: string | null;
  exclusive_until?: string | null;
}

/**
 * Does this row hold an area right now, and is that hold still good?
 *
 * 'none' covers both "no area set" and "not a verified exclusive" — a row that
 * is not verified, or not on the exclusive plan, is outside the index
 * predicate and is therefore holding nothing, whatever its fields say.
 *
 * A NULL exclusive_until is treated as EXPIRED, not as "never expires". An
 * open-ended claim on a paid, time-boxed product is far more likely to be a
 * half-finished write than a deliberate grant of the area forever.
 */
export function claimState(row: ExclusiveRow, nowIso: string): ClaimState {
  const hasArea = !!(row.exclusive_trade && row.exclusive_county && row.exclusive_state);
  if (!hasArea) return "none";
  if (row.plan !== "exclusive" || row.vetting_status !== "verified") return "none";
  if (!row.exclusive_until) return "expired";
  return row.exclusive_until > nowIso ? "active" : "expired";
}

/** The area a row holds, or null. */
export function rowArea(row: ExclusiveRow): Area | null {
  if (!row.exclusive_trade || !row.exclusive_county || !row.exclusive_state) return null;
  return {
    trade: row.exclusive_trade,
    county: row.exclusive_county,
    state: row.exclusive_state,
  };
}

/** Name to show for a holder, preferring what the public would see. */
export const holderName = (row: ExclusiveRow) =>
  row.trading_name || row.legal_name || row.name || "(unnamed)";

/**
 * Is this Postgres error OUR area conflict?
 *
 * Checked by constraint name, not by the 23505 code alone: the leads table has
 * other unique indexes, and reporting "that area is taken" for an unrelated
 * violation would send an operator hunting for a claim that does not exist.
 */
export function isAreaConflict(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  return code === "23505" && msg.includes(AREA_CONSTRAINT);
}

/** The four fields that make up a claim, cleared together. */
export const AREA_FIELDS = {
  exclusive_trade: null,
  exclusive_county: null,
  exclusive_state: null,
  exclusive_until: null,
} as const;

/**
 * Only a verified record can hold an area — the index predicate says so, and
 * selling an area to an unverified business is the thing TrustLight exists to
 * prevent. Returned as a message rather than a boolean so the route can say
 * WHY without restating the rule.
 */
export function blocksClaim(row: ExclusiveRow): string | null {
  if (row.vetting_status !== "verified") {
    return `only a verified business can hold an area — this one is '${row.vetting_status ?? "unknown"}'`;
  }
  return null;
}

/**
 * Parse and validate the end date of a claim.
 *
 * Required, never defaulted. Parish Exclusive is a paid annual term; inventing
 * an end date here would be inventing the length of somebody's contract.
 */
export function parseUntil(value: unknown, nowIso: string): { until: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { error: "exclusive_until is required (ISO date) — a claim must have an end date" };
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: "exclusive_until is not a valid date" };
  const until = d.toISOString();
  if (until <= nowIso) return { error: "exclusive_until is in the past — that claim would already be expired" };
  return { until };
}

/** Whole days from now until the claim ends. Negative once expired. */
export function daysUntil(untilIso: string | null | undefined, now = new Date()): number | null {
  if (!untilIso) return null;
  return Math.floor((new Date(untilIso).getTime() - now.getTime()) / 86400000);
}

// The public home-trade vocabulary, for the bulk scripts.
//
// MIRRORS HOME_TRADE_CATEGORIES in src/lib/trustlight-public.ts. If the two
// ever disagree, src/ is correct and this file is the bug.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The list was copy-pasted into nine places. When the Gulf Coast import
// (2026-10-21) took it from sixteen trades to twenty-five, three of those
// copies were GATING WRITES — slugs.mjs decides who gets a shareable URL,
// places-run.mjs decides who Google is asked about, and verify-all.mjs decides
// whether the whole directory passes. A stale copy in any of them silently
// excludes 1,483 of the 2,536 new leads from work that was supposed to cover
// them, and nothing errors.
//
// The scripts that gate work import from here. The read-only diagnostics
// (domains.mjs, domains2.mjs, signal-probe.mjs, probe-book-mix.mjs,
// remap-hero-folders.mjs) still hold their own inline copies: they were
// written against a point-in-time question and re-running one is not part of
// any pipeline. The e2e suites keep theirs on purpose — they run against the
// deployed worker and must not import from a gitignored scratch directory.
//
// Cannot import src/lib/trustlight-public.ts directly: it is TypeScript, and
// these scripts run under bare node. The same reason dti.mjs and enrich.mjs
// are esbuild bundles rather than imports.

export const HOME_TRADES = [
  // the original sixteen (Louisiana scrape)
  "general contractor",
  "roofing contractor",
  "plumber",
  "electrician",
  "hvac contractor",
  "painter",
  "landscaper",
  "tree service",
  "gutter service",
  "fence contractor",
  "foundation repair",
  "garage door repair",
  "pest control",
  "pressure washing",
  "locksmith",
  "moving company",
  // added with the Gulf Coast import, 2026-10-21 (FL/AL/MS)
  "window installation",
  "flooring contractor",
  "septic service",
  "concrete contractor",
  "insulation contractor",
  "drywall contractor",
  "handyman",
  "tile contractor",
  "pool service",
  // added with the Alabama + Florida import, 2026-10-24 (wave al-fl-2026-10)
  "solar panel installation",
  "irrigation system",
  "hurricane shutters",
  "screen enclosure",
];

export const HOME = new Set(HOME_TRADES);

// App-pipeline model constants.
//
// INTERIM HARDCODE — see docs/textos-backlog-master.md "LLM Management
// Feature": once the DB-driven LLM registry + admin panel ship, these
// become registry lookups (per-pipeline model assignment), not code
// constants.
//
// Both currently resolve to opus-4-8 but are kept SEPARATE on purpose:
// they are independent cost levers. The per-visitor runtime result call
// (APP_RESULT_MODEL) is the one most likely to drop to a cheaper tier
// later — do NOT collapse the two.
//
// SCOPE GUARD: these belong to the app DESIGN/BUILD + runtime RESULT
// pipeline ONLY. Every other task (research, mission doc, parse-retry,
// validation, free-build tasks, etc.) keeps using
// resolveModelForTier() / LLM_TIER_TO_MODEL in ./llm-tier-model.ts.

/** Model for the app DESIGN/BUILD step (generate-business-app-v2). */
export const APP_BUILDER_MODEL = "claude-opus-4-8";

/** Model for the RUNTIME, per-visitor result-generation endpoint
 *  (POST /api/generated-apps/:businessId/by-slug/:slug/result). */
export const APP_RESULT_MODEL = "claude-opus-4-8";

// SUPERSEDED — both constants have been migrated to the non-task feature
// registry (non-task-model-config.ts + external_apis rows feature-app-builder
// and feature-app-result). No remaining callers; file kept for reference only.
// Do NOT add new callers — use resolveFeatureModel() instead.

/** @deprecated — use resolveFeatureModel("feature-app-builder", ...) */
export const APP_BUILDER_MODEL = "claude-opus-4-8";

/** @deprecated — use resolveFeatureModel("feature-app-result", ...) */
export const APP_RESULT_MODEL = "claude-opus-4-8";

export type ModelTier = "haiku" | "sonnet" | "opus";

export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

export type Complexity = "low" | "medium" | "high";

/**
 * Pick a model tier from task type and/or complexity.
 *
 * Sprint 2 default: low → haiku, medium → sonnet, high → opus.
 * taskType-specific overrides land in Sprint 5 once tasks have real
 * prompt templates and we know which need extended thinking.
 */
export function pickModel(
  _taskType?: string,
  complexity?: Complexity,
): ModelTier {
  if (complexity === "low") return "haiku";
  if (complexity === "high") return "opus";
  return "sonnet";
}

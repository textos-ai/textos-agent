import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../env";
import type { BusinessRow, BusinessContextRow, UserRow } from "../../services/supabase";
import type { StreamEvent } from "../stream-events";
import type { ModelConfig } from "../model-config";
import type { FeatureConfig } from "../non-task-model-config";

/**
 * Context passed to every task implementation.
 * The orchestrator builds this once and threads it through each task.
 */
export interface TaskCtx {
  env: Env;
  supabase: SupabaseClient;
  anthropic: Anthropic;
  /** Active model IDs per tier, loaded from external_apis.metadata.model at run start. */
  models: ModelConfig;
  /** Non-task feature model overrides, loaded from external_apis at run start. */
  featureConfig: FeatureConfig;
  business: BusinessRow;
  ctx: BusinessContextRow;
  user: UserRow;
  runId: string;
  taskRunId: string;
  nextSeq: () => number;
  emit: (evt: StreamEvent) => Promise<void>;
  cfLocation?: { lat: number; lng: number } | null;
  /** AbortSignal for per-agent hard timeout. When present, threaded to the
   *  Anthropic SDK call so a timed-out fetch is cancelled at the network layer.
   *  Absence means no external abort — the call runs to SDK/task completion. */
  abortSignal?: AbortSignal | null;
  /** True when the task is being run by the admin harness (not a real user run).
   *  Propagated to business_assets.is_harness so harness output is filterable. */
  isHarness?: boolean;
}

export interface TaskResult {
  output_data: Record<string, unknown>;
  context_updates?: Partial<Omit<BusinessContextRow, "id" | "business_id" | "user_id" | "created_at" | "updated_at">>;
  /** The resolved LLM model ID used for this run. Written to task_runs.model on completion. */
  model?: string;
}

export type TaskFn = (taskCtx: TaskCtx) => Promise<TaskResult>;

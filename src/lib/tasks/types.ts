import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../env";
import type { BusinessRow, BusinessContextRow, UserRow } from "../../services/supabase";
import type { StreamEvent } from "../stream-events";

/**
 * Context passed to every task implementation.
 * The orchestrator builds this once and threads it through each task.
 */
export interface TaskCtx {
  env: Env;
  supabase: SupabaseClient;
  anthropic: Anthropic;
  business: BusinessRow;
  ctx: BusinessContextRow;
  user: UserRow;
  runId: string;
  taskRunId: string;
  nextSeq: () => number;
  emit: (evt: StreamEvent) => Promise<void>;
  cfLocation?: { lat: number; lng: number } | null;
}

export interface TaskResult {
  output_data: Record<string, unknown>;
  context_updates?: Partial<Omit<BusinessContextRow, "id" | "business_id" | "user_id" | "created_at" | "updated_at">>;
}

export type TaskFn = (taskCtx: TaskCtx) => Promise<TaskResult>;

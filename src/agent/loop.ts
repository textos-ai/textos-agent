import type { TaskRow } from "../services/supabase";

/**
 * Agent execution loop — Sprint 2 placeholder.
 *
 * Sprint 5 expands this into the real loop:
 *   1. Render prompt_template with task inputs.
 *   2. Call Claude (with prompt caching on the system block).
 *   3. Drive tool use (web_search, file ops, send_email, etc.).
 *   4. Persist task_runs row + activity log entries.
 *
 * For Sprint 2 we just record the intent and return a stub so the
 * /tasks/run endpoint has something verifiable to return.
 */
export interface RunRequest {
  task: TaskRow;
  businessId?: string;
  inputs?: Record<string, unknown>;
}

export interface RunStub {
  status: "found";
  taskSlug: string;
  taskId: string;
  note: string;
}

export function stubRun(req: RunRequest): RunStub {
  return {
    status: "found",
    taskSlug: req.task.slug,
    taskId: req.task.id,
    note: "Sprint 2 stub — task lookup only. Real execution wired in Sprint 5.",
  };
}

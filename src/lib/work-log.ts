/**
 * Durable event logging to task_runs.work_log for paid tasks.
 *
 * Replaces emit() calls which are no-ops for paid tasks. Events are
 * written to task_runs.work_log JSONB array via RPC function for
 * atomic append without read-modify-write races.
 *
 * Supports environment-conditional payload truncation to keep prod
 * tables lean while providing full debug info in test.
 */

import type { TaskCtx } from './tasks/types';

/**
 * Truncate large payloads in production to keep work_log lean.
 * Test environment gets full payloads for debugging.
 */
function truncateForEnvironment(
  payload: Record<string, unknown>,
  environment: string
): Record<string, unknown> {
  if (environment === 'test') {
    return payload; // Full payload in test
  }

  // In production, truncate large string fields
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && value.length > 2048) {
      result[key] = value.slice(0, 2048) + '...TRUNCATED';
    } else if (typeof value === 'object' && value !== null) {
      const stringified = JSON.stringify(value);
      if (stringified.length > 2048) {
        result[key] = stringified.slice(0, 2048) + '...TRUNCATED';
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Append an event to task_runs.work_log for the current task run.
 *
 * @param taskCtx - Task context containing supabase client and taskRunId
 * @param eventType - Event identifier (e.g. 'v2_llm_call_started', 'v2_app_completed')
 * @param payload - Event data object (will be truncated in prod environment)
 */
export async function appendWorkLog(
  taskCtx: TaskCtx,
  eventType: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const truncatedPayload = truncateForEnvironment(payload, taskCtx.env.ENVIRONMENT);

  const event = {
    event: eventType,
    ts: new Date().toISOString(),
    payload: truncatedPayload
  };

  try {
    const { error } = await taskCtx.supabase.rpc('append_to_work_log', {
      p_run_id: taskCtx.taskRunId,
      p_event: event
    });

    if (error) {
      // Don't crash the task on logging failure - just log to console
      console.error('[work-log] append_failed', {
        task_run_id: taskCtx.taskRunId,
        event_type: eventType,
        error: error.message
      });
    }
  } catch (err) {
    // Don't crash the task on logging failure - just log to console
    console.error('[work-log] append_threw', {
      task_run_id: taskCtx.taskRunId,
      event_type: eventType,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
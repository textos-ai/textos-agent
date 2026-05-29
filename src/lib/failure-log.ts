/**
 * Bug logging dispatch for v2 app generation failures.
 *
 * Routes to app_bug_log (if asset exists) or app_errors (pre-asset failures).
 * Per schema reference:
 * - app_bug_log: id, business_id, asset_id, error_type, error_message, stack_trace, status, created_at
 * - app_errors: id, level, source, message, context (jsonb), created_at
 */

import type { TaskCtx } from './tasks/types';

/**
 * Log a failure to the appropriate table based on whether an asset was created.
 *
 * @param taskCtx - Task context with supabase client
 * @param kind - Error type/kind identifier
 * @param message - Human-readable error message
 * @param context - Additional context data
 * @param assetId - Optional asset ID if asset was created before failure
 */
export async function logFailure(
  taskCtx: TaskCtx,
  kind: string,
  message: string,
  context: Record<string, unknown>,
  assetId?: string
): Promise<void> {
  try {
    if (assetId) {
      // Asset exists - use app_bug_log
      await taskCtx.supabase
        .from('app_bug_log')
        .insert({
          business_id: taskCtx.business.id,
          asset_id: assetId,
          error_type: kind,
          error_message: message,
          stack_trace: JSON.stringify(context).slice(0, 16000), // Truncate to avoid DB limits
          status: 'open'
        });
    } else {
      // No asset - use app_errors (no FK constraints)
      await taskCtx.supabase
        .from('app_errors')
        .insert({
          level: 'error',
          source: 'generate-business-app-v2',
          message,
          context: {
            kind,
            task_run_id: taskCtx.taskRunId,
            business_id: taskCtx.business.id,
            ...context
          }
        });
    }
  } catch (err) {
    // Don't crash the task on logging failure - just log to console
    console.error('[failure-log] insert_failed', {
      task_run_id: taskCtx.taskRunId,
      kind,
      has_asset_id: !!assetId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
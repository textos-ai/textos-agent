/**
 * Queue message types. All messages are plain JSON-serializable objects.
 */

/**
 * Message body for the generate-business-app HTML-generation queue
 * (APP_GEN_HTML_QUEUE binding). Producer: the Design handler in
 * src/lib/tasks/generate-business-app-design.ts. Consumer:
 * src/queues/app-gen-html-consumer.ts.
 *
 * The producer pre-creates the html task_run row in status='queued' and
 * puts its id in `htmlTaskRunId` so the consumer can apply Rob's
 * idempotency contract:
 *   - existing 'completed' or 'running' → skip
 *   - existing 'failed' or 'queued'     → atomic flip → run
 *   - row missing                       → log + skip (unexpected)
 *
 * designTaskRunId is included for log correlation only — it is also
 * stored as task_runs.config.parent_design_task_run_id by the producer.
 */
export interface HtmlJobMessage {
  htmlTaskRunId: string;
  businessId: string;
  userId: string;
  designTaskRunId: string;
}

/**
 * Message body for the generic long-task queue (TASK_QUEUE binding). Producer:
 * the run endpoint in src/routes/business-task-run.ts, for any task flagged
 * tasks.is_long_running. Consumer: src/queues/task-queue-consumer.ts.
 *
 * Same idempotency contract as HtmlJobMessage: the producer pre-creates the
 * task_run row in status='queued' (config already set) and puts its id in
 * `taskRunId`. The consumer runs the SHARED runTaskInBackground with the queue's
 * ~15-min wall-clock budget, escaping the waitUntil silent-kill that caps the
 * inline path at ~60s. `taskSlug` lets the consumer load the task row generically
 * — no per-task branching, works for retrieval + enrichment + long documents.
 */
export interface TaskQueueMessage {
  taskRunId: string;
  businessId: string;
  userId: string;
  taskSlug: string;
}

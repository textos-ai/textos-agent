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

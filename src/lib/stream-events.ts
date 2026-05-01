/**
 * TextOS SSE stream event schema.
 *
 * Every message on the /stream/business/:slug endpoint conforms to one
 * of these shapes. The frontend pattern-matches on `type` to decide how
 * to render each event.
 *
 * Two conceptual streams are multiplexed onto a single SSE connection:
 *   - NARRATIVE  → human-readable agent commentary (amber text)
 *   - CMD        → atomic action log lines (cyan text)
 *
 * Lifecycle events (task_start, task_complete, build_complete) drive
 * live task-card updates in the dashboard without a full page reload.
 */

// ── Outbound event shapes ──────────────────────────────────────────────────

/** Agent's natural-language commentary — shown in amber in the terminal. */
export interface NarrativeEvent {
  type: "narrative";
  text: string;
  ts?: number;
}

/**
 * Atomic action line — shown in cyan.
 * Examples: "Searching web for: DJ booking market 2025"
 *           "Saving report: Market Research"
 *           "Updating task list..."
 */
export interface CmdEvent {
  type: "cmd";
  text: string;
  ts?: number;
}

/** A task transitioned to running state. Updates the task card badge. */
export interface TaskStartEvent {
  type: "task_start";
  task_slug: string;
  task_name: string;
  task_run_id: string;
  ts?: number;
}

/** A task finished successfully. Triggers a task-list refresh. */
export interface TaskCompleteEvent {
  type: "task_complete";
  task_slug: string;
  task_name: string;
  task_run_id: string;
  output_summary?: string; // short human-readable summary for the terminal
  ts?: number;
}

/** A task failed. Logs the error and marks the card. */
export interface TaskFailedEvent {
  type: "task_failed";
  task_slug: string;
  task_name: string;
  task_run_id: string;
  error: string;
  ts?: number;
}

/**
 * All default tasks finished. Signals the frontend to show the paywall
 * and stop reconnecting the stream.
 */
export interface BuildCompleteEvent {
  type: "build_complete";
  completed_count: number;
  summary: string;
  ts?: number;
}

/** Keepalive / connection status — never shown in terminal. */
export interface StatusEvent {
  type: "status";
  message: string;
  ts?: number;
}

/** Unrecoverable stream error. */
export interface StreamErrorEvent {
  type: "error";
  message: string;
  ts?: number;
}

export type StreamEvent =
  | NarrativeEvent
  | CmdEvent
  | TaskStartEvent
  | TaskCompleteEvent
  | TaskFailedEvent
  | BuildCompleteEvent
  | StatusEvent
  | StreamErrorEvent;

// ── Helper: serialise for SSE ──────────────────────────────────────────────

/** Returns the SSE-formatted string for a single event. */
export function sseEvent(evt: StreamEvent): string {
  return `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
}

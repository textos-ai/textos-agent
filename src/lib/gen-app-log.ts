/**
 * Structured logger for the generate-business-app pipeline.
 *
 * Three-lane logging (consolidated 2026-05-25 to reuse platform tables):
 *
 *   1. console.log — captured by `wrangler tail` (real-time, dev only).
 *   2. stream_events table — durable, queryable per business. Insert
 *      uses event_type='gen_app_<event>' so the new
 *      GET /api/businesses/:slug/app-logs route can filter cleanly via
 *      LIKE 'gen_app_%'. run_id is set to the task_run_id so events
 *      group per run via the existing index. Fire-and-forget.
 *   3. task_runs.work_log (jsonb array) — the per-task structured log
 *      for the failing/completing run. Updated as a full-buffer
 *      idempotent snapshot on every genAppLog call (read-modify-write
 *      against a module-scope buffer, so concurrent fires converge on
 *      the latest state — no read-before-write race). Fire-and-forget.
 *
 * Sink wiring: setGenAppLogSink(supabase) is called once per Worker
 * invocation at the top of runTaskInBackground (business-task-run.ts)
 * and processOne (queues/app-gen-html-consumer.ts). Without the sink,
 * lanes 2 and 3 silently skip — lane 1 still writes.
 *
 * Convention: every genAppLog call should pass `business_id` and
 * `task_run_id` so events index cleanly and group per run.
 */

// Loose Supabase typing — we don't want to drag the full @supabase/supabase-js
// types into this leaf module. At runtime only .from(...).insert(...) and
// .from(...).update(...).eq(...) are called.
type LogSinkSupabase = {
  from: (table: string) => {
    insert: (
      row: unknown,
    ) => PromiseLike<{ error: { message: string } | null }>;
    update: (patch: unknown) => {
      eq: (
        col: string,
        val: string,
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

const MAX_EVENTS_PER_TASK = 200;

// In-memory event buffer per task_run_id. Used for:
//   - takeGenAppEvents() drain on failure (embedded into task_runs.error)
//   - Full-buffer snapshot writes to task_runs.work_log on every fire
//     (idempotent — concurrent appends converge because we always write
//     the entire current buffer, not a delta)
const eventBuffers = new Map<string, Array<Record<string, unknown>>>();

// Per-task_run_id sequence counter for stream_events.seq. The platform
// orchestrator uses a per-run monotonic counter for ordering replays;
// we follow the same convention so the existing stream_events tooling
// can sort our gen-app events naturally.
const seqCounters = new Map<string, number>();

// Module-scope sink. Initialized by setGenAppLogSink() at the top of
// each Worker invocation that runs gen-app code. Reads are guarded so
// genAppLog stays safe to call from contexts without a wired sink.
let sinkSupabase: LogSinkSupabase | null = null;

/**
 * Register a Supabase client to receive durable copies of every
 * genAppLog event. Call once per Worker invocation that runs gen-app
 * code (runTaskInBackground entry, queue consumer processOne entry).
 * Safe to call repeatedly — last call wins.
 */
export function setGenAppLogSink(supabase: LogSinkSupabase): void {
  sinkSupabase = supabase;
}

/**
 * Clear the registered sink. Optional — module state resets when the
 * Worker invocation ends; this is for tests and explicit teardown.
 */
export function clearGenAppLogSink(): void {
  sinkSupabase = null;
}

export function genAppLog(
  event: string,
  data: Record<string, unknown> = {},
): void {
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = { event, ts, ...data };
  // ── Lane 1: console (wrangler tail) ─────────────────────────────────
  console.log("[GEN-APP]", JSON.stringify(entry));

  const tid =
    typeof data.task_run_id === "string" && data.task_run_id.length > 0
      ? (data.task_run_id as string)
      : null;
  const bid =
    typeof data.business_id === "string" && data.business_id.length > 0
      ? (data.business_id as string)
      : null;

  // ── In-memory buffer (also used by takeGenAppEvents on failure) ─────
  if (tid) {
    let buf = eventBuffers.get(tid);
    if (!buf) {
      buf = [];
      eventBuffers.set(tid, buf);
    }
    buf.push(entry);
    if (buf.length > MAX_EVENTS_PER_TASK) {
      buf.shift();
    }
  }

  if (!sinkSupabase) return;

  // ── Lane 2: stream_events insert (fire-and-forget) ──────────────────
  // event_type is prefixed with "gen_app_" so the LIKE 'gen_app_%'
  // query in GET /:slug/app-logs returns only gen-app events without
  // collateral from other platform writers.
  //
  // event_data carries only the caller-supplied payload — ts is already
  // in the row's created_at, event name is in event_type, and the two
  // indexed ids live in their own columns. Storing them again inside
  // the jsonb would just duplicate noise into every frontend render.
  if (bid && tid) {
    const seq = (seqCounters.get(tid) ?? 0) + 1;
    seqCounters.set(tid, seq);
    const eventDataPayload: Record<string, unknown> = { ...data };
    delete eventDataPayload.business_id;
    delete eventDataPayload.task_run_id;
    try {
      sinkSupabase
        .from("stream_events")
        .insert({
          run_id: tid,
          business_id: bid,
          seq,
          event_type: "gen_app_" + event,
          event_data: eventDataPayload,
        })
        .then(
          (res) => {
            if (res && res.error) {
              console.error(
                "[GEN-APP-SINK] stream_events_failed",
                JSON.stringify({ event, err: res.error.message }),
              );
            }
          },
          (err: unknown) => {
            console.error(
              "[GEN-APP-SINK] stream_events_rejected",
              JSON.stringify({
                event,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
          },
        );
    } catch (err) {
      console.error(
        "[GEN-APP-SINK] stream_events_threw_sync",
        JSON.stringify({
          event,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ── Lane 3 (task_runs.work_log) removed 2026-05-25 ──────────────────
  // The fire-and-forget snapshot write here raced with the explicit
  // awaited checkpoint writer in src/lib/tasks/generate-business-app-design.ts
  // (function `checkpoint()`). The handler's awaited writes are now the
  // single authoritative writer for task_runs.work_log on the Design
  // step. This module retains lane 1 (console) and lane 2 (stream_events)
  // only — work_log is owned by the handlers.
}

/**
 * Drain the buffered events for a task_run_id and return them. After
 * draining, the entry is removed from the Map so memory doesn't grow
 * unbounded across the lifetime of the Worker invocation.
 *
 * Used by the catch block in runTaskInBackground (business-task-run.ts)
 * to capture the full structured log of a failing run before writing
 * to task_runs.error. Returns [] if nothing was buffered for this id.
 */
export function takeGenAppEvents(
  taskRunId: string,
): Array<Record<string, unknown>> {
  const buf = eventBuffers.get(taskRunId);
  eventBuffers.delete(taskRunId);
  seqCounters.delete(taskRunId);
  return buf ?? [];
}

/**
 * Discard the buffered events and seq counter for a task_run_id
 * without returning them. Used on the success path so the buffer
 * doesn't keep growing across back-to-back consumer batches.
 */
export function clearGenAppEvents(taskRunId: string): void {
  eventBuffers.delete(taskRunId);
  seqCounters.delete(taskRunId);
}

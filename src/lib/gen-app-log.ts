/**
 * Structured logger for the generate-business-app pipeline.
 *
 * Every meaningful step in the chain (design + html + dispatch) calls
 * genAppLog(event, data) so wrangler tail can be filtered with a
 * simple `[GEN-APP]` substring match. Data is JSON-stringified once
 * per call; the prefix is stable so log aggregators can collapse on it.
 *
 * Usage:
 *   import { genAppLog } from "../lib/gen-app-log";
 *   genAppLog("handler_entry", { business_id, task_run_id, llm_tier });
 *
 * Convention: pass `business_id` and `task_run_id` on every call so
 * a tail filter narrows to a single run end-to-end.
 */
export function genAppLog(
  event: string,
  data: Record<string, unknown> = {},
): void {
  // console.log writes to the Worker's stdout — captured by wrangler tail.
  // JSON.stringify ensures the line is one logical record per console call.
  console.log(
    "[GEN-APP]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...data }),
  );
}

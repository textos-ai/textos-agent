/**
 * Format a generate-business-app failure as a human-readable summary
 * alongside the original technical message.
 *
 * Stored as a JSON STRING in task_runs.error (text column) for any task
 * whose slug starts with "generate-business-app". Frontend (apps.astro)
 * parses it; if `.summary` is present, that's what the operator sees.
 * Plain-text errors from other tasks remain untouched.
 *
 * Shape:
 *   {
 *     "technical": "stop_reason=max_tokens, elapsed=142000ms, ...",
 *     "summary":   "Plain English. No jargon. Actionable."
 *   }
 */

export interface GenAppErrorPayload {
  technical: string;
  summary: string;
}

/**
 * Map a raw technical error message (whatever the handler threw) to a
 * { technical, summary } pair. The technical field is the raw input,
 * unmodified. The summary field is a plain-English sentence chosen by
 * matching known substrings; falls back to a generic message when no
 * pattern matches.
 *
 * Update this table when you add new throw sites in the chain.
 */
export function formatGenAppError(technical: string): GenAppErrorPayload {
  const t = String(technical ?? "");

  let summary = "App generation failed. Please try again.";

  if (t.includes("html_truncated") || t.includes("stop_reason='max_tokens'")) {
    summary =
      "Your app couldn't be built this time — the AI hit the size limit for this complexity. Try again, or pick a lower intelligence level.";
  } else if (t.includes("concurrent_generation_in_progress")) {
    summary =
      "An app generation is already running for this business. Wait for it to finish, then try again.";
  } else if (t.includes("token_deduct_failed_post_run")) {
    summary =
      "Your app was built but the token charge didn't go through. The app is saved — please contact support to reconcile.";
  } else if (
    t.includes("timeout_5min") ||
    t.includes("timeout_stale") ||
    t.toLowerCase().includes("aborterror") ||
    /_timeout_\d+s\b/.test(t)
  ) {
    summary =
      "App generation took too long and was stopped. Try again with a lower intelligence level (Haiku is fastest).";
  } else if (t.includes("unknown_llm_tier")) {
    summary =
      "App generation failed due to a configuration error. Please contact support.";
  } else if (t.includes("INTERNAL_TRIGGER_SECRET")) {
    summary =
      "App generation pipeline is misconfigured. Please contact support.";
  } else if (t.includes("Failed to trigger generate-business-app-html")) {
    summary =
      "App generation failed mid-flow — the design saved but the build step didn't start. Try again.";
  } else if (t.includes("No app_draft found")) {
    summary =
      "App build step couldn't find its design. This is rare — please try again.";
  } else if (t.includes("HTML output didn't start with <!DOCTYPE html>")) {
    summary =
      "The AI returned a malformed app. Please try again.";
  } else if (t.includes("App design call failed")) {
    summary =
      "The design step failed. Please try again.";
  } else if (t.includes("App HTML generation failed")) {
    summary =
      "The build step failed. Please try again — Haiku tier is faster if Sonnet is timing out.";
  } else if (t.includes("business_context_not_found")) {
    summary =
      "Your business profile isn't fully set up yet. Complete the Business Builder first, then try again.";
  } else if (t.includes("html_call_timeout") || t.includes("design_call_timeout")) {
    summary =
      "The AI service didn't respond in time. Please try again — Haiku tier is faster.";
  }

  return { technical: t, summary };
}

/**
 * Convenience: stringify the payload for storage in task_runs.error.
 * Truncated to 4000 chars to fit the text column without surprises.
 */
export function serializeGenAppError(technical: string): string {
  return JSON.stringify(formatGenAppError(technical)).slice(0, 4000);
}

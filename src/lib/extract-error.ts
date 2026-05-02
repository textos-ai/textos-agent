/**
 * Extract a human-readable string from any thrown value.
 *
 * Handles:
 * - Error instances (uses .message)
 * - Anthropic SDK error objects with .code
 * - Plain objects (JSON.stringify, with circular-ref fallback)
 * - Primitives (String coercion)
 *
 * Never returns "[object Object]" — that means the caller
 * passed an Error directly to String() or template literal
 * instead of using this helper.
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string" && e.message.length > 0) {
      return e.message;
    }
    if (typeof e.code === "string" && e.code.length > 0) {
      return e.code;
    }
    if (typeof e.code === "number") {
      return String(e.code);
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      // circular reference or other stringify failure
    }
  }
  return String(err);
}

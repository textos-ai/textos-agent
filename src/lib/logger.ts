import type { SupabaseClient } from "@supabase/supabase-js";

type Level = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  // Single-line JSON — Cloudflare Workers logs capture this verbatim.
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

export async function persistError(
  supabase: SupabaseClient,
  level: "error" | "warn",
  source: string,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("app_errors")
      .insert({ level, source, message, context: context ?? null });
    if (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "persistError_insert_failed",
        supabase_error: error.message,
        original_source: source,
        original_message: message,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "persistError_threw",
      err: err instanceof Error ? err.message : String(err),
      original_source: source,
      original_message: message,
    }));
  }
}

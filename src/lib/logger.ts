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

// Database error classification — one definition, shared.
//
// Extracted from lib/site-render/facts.ts so the render path and the plain route
// handlers agree on what counts as a schema fault. Two copies of that list would
// drift, and the whole point is that a failure is reported as the thing it is.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
//
// A query that FAILED must never be reported as a query that found NOTHING. The
// two are different facts and they lead an operator to different actions:
//
//   "no such business"       -> check the slug, check who owns it
//   "the query blew up"      -> check the migration, the URL, the credentials
//
// 1C removed this lie from the render path (a missing table read as empty data and
// served a stale landing page). The same lie survived on the user routes as
// `getBusinessBySlug(...).catch(() => null)`, which turned every database failure
// into a 404 "business not found" — and cost a real debugging detour on the
// FACT_COLLECTIONS crash, where a malformed SUPABASE_URL was reported as a missing
// business.
export const SCHEMA_FAULT_CODES = new Set([
  "PGRST205", // Could not find the table '<x>' in the schema cache  (HTTP 404)
  "PGRST204", // Could not find the '<col>' column in the schema cache
  "42P01",    // undefined_table
  "42703",    // undefined_column                                     (HTTP 400)
  "42883",    // undefined_function
]);

/** A missing table/column/function: the feature is not deployed. Actionable. */
export class SchemaError extends Error {
  constructor(
    public readonly table: string,
    public readonly code: string,
    detail: string,
  ) {
    super(
      `Schema fault reading '${table}' (${code}): ${detail}. `
      + `This is a missing migration, not empty data — the feature is not deployed. `
      + `Apply the outstanding migrations in textos-agent/migrations/.`,
    );
    this.name = "SchemaError";
  }
}

export interface PostgrestErrorLike { code?: string; message?: string }

/**
 * Turn a PostgREST error into the loudest accurate Error for it.
 *
 * Callers `throw` the result. Kept separate from unwrap() because the service-layer
 * helpers return a row rather than a `{ data, error }` pair, but they must classify
 * failures identically.
 */
export function dbError(table: string, error: PostgrestErrorLike | null | undefined): Error {
  const code = error?.code ?? "unknown";
  const detail = error?.message ?? "no message";
  if (SCHEMA_FAULT_CODES.has(code)) return new SchemaError(table, code, detail);
  return new Error(`query_failed(${table}) [${code}]: ${detail}`);
}

/** True when the value looks like a PostgREST error object rather than a row. */
export function isPostgrestError(v: unknown): v is PostgrestErrorLike {
  return !!v && typeof v === "object" && ("code" in v || "message" in v);
}

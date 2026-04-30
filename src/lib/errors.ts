export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "internal"
  | "upstream_error"
  | "unauthorized";

export interface ErrorBody {
  error: ErrorCode;
  message?: string;
  details?: unknown;
}

export function errBody(
  error: ErrorCode,
  message?: string,
  details?: unknown,
): ErrorBody {
  return {
    error,
    ...(message ? { message } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

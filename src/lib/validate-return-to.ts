// Sanitize a frontend-supplied `return_to` so Stripe (Checkout or Portal)
// can't be used as an open redirect. Returns the validated path (always
// starts with "/") on success, or null when the input fails any check.
//
// Rules:
//  - must be a string
//  - must start with a single "/" (rejects protocol-relative "//evil.com")
//  - reject backslashes / angle brackets (defensive against weird XSS framing)
//  - cap at 500 chars

export function validateReturnTo(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.length > 500) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (/[\\<>]/.test(raw)) return null;
  return raw;
}

// Convenience wrapper that returns "/" as the fallback (matches the original
// users.ts:validateReturnTo behavior for the billing-portal endpoint).
export function validateReturnToOrRoot(raw: string | undefined | null): string {
  return validateReturnTo(raw) ?? "/";
}

/**
 * withTimeout — Promise.race wrapper that rejects after `ms` if the
 * underlying promise hasn't settled.
 *
 * IMPORTANT: this DOES NOT cancel the underlying promise. If `p` is an
 * Anthropic SDK call, the underlying fetch keeps running after this
 * rejects — the result is silently discarded. For Anthropic calls that
 * need true cancellation, use AbortController and pass controller.signal
 * via the SDK's options arg instead.
 *
 * Kept here as a shared export for callers that intentionally want
 * "give up waiting" semantics without cancellation (e.g., a quick
 * health-check fetch where the dangling promise is harmless).
 *
 * The generate-business-app-{design,html} handlers historically used this
 * helper locally. They've migrated to AbortController inline; their
 * local declarations remain (not deleted) for safety, but new call sites
 * should import from here.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  label: string,
  ms: number,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)),
      ms,
    ),
  );
  return Promise.race([p, timeout]);
}

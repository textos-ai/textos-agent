/**
 * Plain-language error messages for non-technical founders.
 * Maps Zernio error signals (HTTP status, errorMessage, errorCategory)
 * and our own validation failures to short, actionable human text.
 *
 * Rule: never expose raw API errors, status codes, errorCategory strings,
 * or jargon. Every message tells the user what happened and what to do.
 *
 * Character limits live in the `platforms` DB table — read at runtime
 * via the Worker. Callers must pass charLimit explicitly; no hardcoded
 * fallback maps exist here.
 */

function platformLabel(platform: string | undefined): string {
  if (!platform) return "this platform";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

// ── Publish / Zernio errors ───────────────────────────────────────────────────

export type FriendlyPublishOpts = {
  httpStatus?: number;       // HTTP status Zernio returned
  errorMessage?: string;     // Zernio errorMessage field (from body or poll)
  errorCategory?: string;    // Zernio errorCategory field (from body or poll)
  platform?: string;         // "bluesky" etc.
  charLimit?: number;        // platform's char limit (for length errors)
  contentLength?: number;    // draft length (for length errors)
};

export function friendlyPublishError(opts: FriendlyPublishOpts): string {
  const { httpStatus, errorCategory, platform, charLimit, contentLength } = opts;
  const msg   = (opts.errorMessage ?? "").toLowerCase();
  const cat   = (errorCategory    ?? "").toLowerCase();
  const pname = platformLabel(platform);

  // ── Content too long ──────────────────────────────────────────────────────
  if (
    msg.includes("cannot exceed") ||
    msg.includes("characters") ||
    msg.includes("too long")     ||
    cat.includes("length")       ||
    cat.includes("content")
  ) {
    const limit  = charLimit ?? 300;
    const lenStr = contentLength ? `Yours is ${contentLength} — ` : "";
    return (
      `This post is too long for ${pname} (max ${limit} characters). ` +
      `${lenStr}shorten it, or let Victora write a shorter version.`
    );
  }

  // ── Auth / connection expired ─────────────────────────────────────────────
  if (
    httpStatus === 401             ||
    cat.includes("auth")          ||
    cat.includes("unauthorized")  ||
    msg.includes("token")         ||
    msg.includes("expired")       ||
    msg.includes("unauthorized")
  ) {
    return `Your ${pname} connection needs refreshing — click Reconnect in the Publish Channels section.`;
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  if (httpStatus === 429 || cat.includes("rate") || msg.includes("rate limit")) {
    return `You've hit a posting limit — try again in a few minutes.`;
  }

  // ── Plan / quota limit ────────────────────────────────────────────────────
  if (
    httpStatus === 403          ||
    cat.includes("plan")        ||
    cat.includes("quota")       ||
    msg.includes("plan limit")  ||
    msg.includes("subscription")
  ) {
    return `You've reached your plan's posting limit. Check your account to upgrade or wait until it resets.`;
  }

  // ── Account not connected ─────────────────────────────────────────────────
  if (
    cat.includes("account")             ||
    msg.includes("account not found")   ||
    msg.includes("no account")          ||
    msg.includes("not connected")
  ) {
    return `Your ${pname} account isn't connected — use the Publish Channels section to connect it.`;
  }

  // ── Network / timeout ─────────────────────────────────────────────────────
  if (
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return `The publishing service didn't respond in time — try again in a moment.`;
  }

  // ── Generic safe fallback ─────────────────────────────────────────────────
  return (
    `Something went wrong publishing to ${pname}. ` +
    `Try again in a moment — if it keeps happening, try reconnecting your account.`
  );
}

// ── Pre-flight validation ─────────────────────────────────────────────────────

/**
 * Friendly error for content that exceeds a platform's character limit.
 * Called before any Zernio API call so users never wait to learn their post is too long.
 */
export function friendlyValidationError(
  platform: string,
  charLimit: number,
  contentLength: number,
): string {
  const pname = platformLabel(platform);
  return (
    `This post is too long for ${pname} (max ${charLimit} characters). ` +
    `Yours is ${contentLength} — shorten it, or let Victora write a shorter version.`
  );
}

// ── Generation errors (LLM / Claude side) ────────────────────────────────────

/**
 * Maps LLM / task-runner failures to friendly messages.
 * Wire this in task handlers wherever errors surface to the review UI.
 */
export function friendlyGenerationError(rawErr: string | undefined): string {
  const msg = (rawErr ?? "").toLowerCase();

  if (msg.includes("overloaded") || msg.includes("529") || msg.includes("capacity")) {
    return `Victora is busy right now — try again in a moment.`;
  }
  if (
    msg.includes("context") && msg.includes("long") ||
    msg.includes("maximum context") ||
    msg.includes("token limit")
  ) {
    return `There's too much context to process. Try with a shorter business description.`;
  }
  if (msg.includes("rate") || msg.includes("429")) {
    return `Too many requests — try again in a moment.`;
  }

  return `Something went wrong generating your post — try again in a moment.`;
}

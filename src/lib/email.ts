// =============================================================
// Outbound email for Victora — Cloudflare Email Service.
//
// The one place Victora sends email from. Uses the `send_email` Workers
// binding (env.EMAIL, declared per environment in wrangler.toml) with the
// structured message form: env.EMAIL.send({ from, to, subject, text, html })
// → { messageId }. On failure the binding throws an Error carrying a `code`
// (E_SENDER_NOT_VERIFIED, E_DAILY_LIMIT_EXCEEDED, E_RECIPIENT_SUPPRESSED, …).
// Docs: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
//
// The sender (address + display name) is NOT in code. It lives in the
// external_apis row 'cloudflare-email' (migration 140):
//   metadata.from_email, metadata.from_name
// Missing row, inactive row, or missing field → throw. No default sender.
//
// Failures are never swallowed: every failed send is logged with the
// provider's code and message, then rethrown for the caller to handle.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { log } from "./logger";

/** external_apis.slug of the row that holds the platform sender. */
const SENDER_CONFIG_SLUG = "cloudflare-email";

export interface PlatformEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface PlatformEmailResult {
  messageId: string;
  from: string;
}

/** Thrown for every failed send. `code` is Cloudflare's error code when it gave one. */
export class EmailSendError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "EmailSendError";
    this.code = code;
  }
}

async function loadSender(supabase: SupabaseClient): Promise<{ email: string; name: string }> {
  const { data, error } = await supabase
    .from("external_apis")
    .select("status, metadata")
    .eq("slug", SENDER_CONFIG_SLUG)
    .maybeSingle();
  if (error) {
    throw new EmailSendError(`email: could not read sender config (external_apis '${SENDER_CONFIG_SLUG}'): ${error.message}`, null);
  }
  if (!data) {
    throw new EmailSendError(`email: no external_apis row '${SENDER_CONFIG_SLUG}' — the platform sender is not configured (migration 140)`, null);
  }
  if (data.status !== "active") {
    throw new EmailSendError(`email: external_apis '${SENDER_CONFIG_SLUG}' is '${String(data.status)}', not active — refusing to send`, null);
  }
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const email = typeof meta.from_email === "string" ? meta.from_email.trim() : "";
  const name = typeof meta.from_name === "string" ? meta.from_name.trim() : "";
  const missing = [!email && "metadata.from_email", !name && "metadata.from_name"].filter(Boolean);
  if (missing.length) {
    throw new EmailSendError(`email: external_apis '${SENDER_CONFIG_SLUG}' is missing ${missing.join(" and ")}`, null);
  }
  return { email, name };
}

/**
 * Send one email through Cloudflare Email Service. Resolves with the
 * provider's messageId, or throws EmailSendError (after logging it).
 *
 * `purpose` is a short label for the logs (e.g. "welcome-email").
 */
export async function sendPlatformEmail(
  env: Env,
  supabase: SupabaseClient,
  msg: PlatformEmail,
  purpose: string,
): Promise<PlatformEmailResult> {
  if (!env.EMAIL) {
    const err = new EmailSendError("email: the EMAIL send_email binding is not configured on this Worker (wrangler.toml)", null);
    log.error("[email] send_failed", { purpose, to: msg.to, code: null, error: err.message });
    throw err;
  }

  let from: { email: string; name: string };
  try {
    from = await loadSender(supabase);
  } catch (err) {
    log.error("[email] send_failed", { purpose, to: msg.to, code: null, error: (err as Error).message });
    throw err;
  }

  try {
    const res = await env.EMAIL.send({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    if (!res?.messageId) {
      throw new EmailSendError("email: Cloudflare Email Service returned no messageId", null);
    }
    log.info("[email] sent", { purpose, to: msg.to, from: from.email, message_id: res.messageId });
    return { messageId: res.messageId, from: from.email };
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null;
    const message = err instanceof Error ? err.message : String(err);
    log.error("[email] send_failed", { purpose, to: msg.to, from: from.email, code, error: message });
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(`Cloudflare Email Service: ${code ? `${code} — ` : ""}${message}`, code);
  }
}

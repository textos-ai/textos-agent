// =============================================================
// TrustLight free-vetting campaign — the first 50.
//
// A comped listing is verified EXACTLY like a paid one. The nine checks are
// never skipped; the only difference is that no money changed hands. Nothing
// in this file can set a check, change a vetting_status to 'verified', or
// publish anything — those all still go through the gate in
// lib/trustlight-vetting.ts.
//
// The delicate part here is that we are about to publish claims about a
// business that never asked us to. So the email is written for someone who
// did not opt in: it says plainly what we did, shows exactly what will appear,
// and puts leaving one click away with no login and no reply required.
// =============================================================

import { log } from "./logger";
import type { Env } from "../env";

export const COMP_OFFER_STATUSES = ["offered", "accepted", "declined"] as const;
export type CompOfferStatus = (typeof COMP_OFFER_STATUSES)[number];

export const LISTING_CONSENTS = ["pending", "granted", "declined"] as const;

/**
 * Config keys read from coldcall_config. Load-bearing, so a missing one halts
 * loudly rather than defaulting — a wrong site URL means a removal link that
 * does not work, in an email telling someone they can remove themselves.
 */
export const CONFIG_KEYS = {
  graceDays: "comp_grace_days",
  siteUrl: "trustlight_site_url",
  fromEmail: "trustlight_from_email",
  fromName: "trustlight_from_name",
} as const;

export async function readConfig(
  supabase: { from: Function },
  keys: string[],
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; missing: string[] }> {
  const { data, error } = await supabase
    .from("coldcall_config").select("key, value").in("key", keys);
  if (error) return { ok: false, missing: keys };
  const values: Record<string, string> = {};
  for (const r of (data ?? []) as Array<{ key: string; value: string }>) values[r.key] = r.value;
  const missing = keys.filter((k) => !values[k]);
  if (missing.length) return { ok: false, missing };
  return { ok: true, values };
}

/** A random, unguessable token for the no-login removal link. */
export function removalToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface NotifyLead {
  trading_name: string | null; legal_name: string | null; name: string | null;
  trade: string | null; city: string | null; state: string | null;
  rating: number | null; review_count: number | null; dti_score: number | null;
  blurb: string | null; verified_year: number | null; slug: string | null;
  expires_at: string | null;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/**
 * The notify-before-publish email.
 *
 * PURE — no I/O. The admin preview renders this exact function, so what is
 * reviewed is byte-for-byte what sends. Same reasoning as the profile preview.
 *
 * Deliberately plain. The reader is a contractor who has never heard of us and
 * did not ask to be listed, quite possibly reading on a phone between jobs.
 * No marketing voice, no urgency, no "congratulations" — just what happened,
 * what it says, and how to stop it.
 */
export function renderNotifyEmail(
  lead: NotifyLead,
  urls: { profileUrl: string; removeUrl: string; siteUrl: string },
): { subject: string; text: string; html: string } {
  const name = lead.trading_name || lead.legal_name || lead.name || "your business";
  const where = [lead.city, lead.state].filter(Boolean).join(", ");
  const trade = lead.trade || "";
  const year = lead.verified_year ?? new Date().getFullYear();

  // Exactly the card the public will see, in words. Built from the same fields
  // the API returns so the email cannot describe something different.
  const shown: string[] = [];
  shown.push(`Name: ${name}`);
  if (trade) shown.push(`Trade: ${trade}`);
  if (where) shown.push(`Location: ${where}`);
  if (typeof lead.rating === "number") {
    shown.push(`Google rating: ${lead.rating}${lead.review_count ? ` (${lead.review_count} reviews)` : ""}`);
  }
  if (typeof lead.dti_score === "number") shown.push(`Digital Trust Index: ${lead.dti_score} out of 100`);
  if (lead.blurb) shown.push(`Description: ${lead.blurb}`);
  shown.push(`Verified: ${year}`);

  const subject = `${name} has been verified on TrustLight — no cost, and you can remove it`;

  const text = [
    `Hello,`,
    ``,
    `We are TrustLight, a directory of home-repair contractors built with Cajun Navy`,
    `Ground Force. It is given to families after hurricanes and floods so they can`,
    `find help without being taken advantage of.`,
    ``,
    `We independently verified ${name} at no cost to you. You did not sign up for`,
    `this and you owe us nothing. We checked nine things against public and`,
    `official records: your state licensing board record, your license, your`,
    `insurance with the carrier, your business filing, court records, your address,`,
    `your years in business, your contact details, and your reviews.`,
    ``,
    `Here is exactly what your listing will show:`,
    ``,
    ...shown.map((l) => `  ${l}`),
    ``,
    `That is all of it. We do not publish your phone number, your email, your`,
    `license number, your insurance carrier, or any of our notes.`,
    ``,
    `Your listing and verified badge:`,
    `  ${urls.profileUrl}`,
    ``,
    `IF YOU DO NOT WANT TO BE LISTED`,
    `Use this link and you are removed straight away. No login, no reply needed,`,
    `no questions:`,
    `  ${urls.removeUrl}`,
    ``,
    `You can also just reply to this email and we will take it down.`,
    ``,
    `If anything above is wrong, reply and tell us and we will correct it or`,
    `remove the listing, whichever you prefer.`,
    ``,
    `— TrustLight`,
    `  ${urls.siteUrl}`,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0a0f1c;line-height:1.55">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e8ee;border-radius:12px;padding:28px">
  <p style="margin:0 0 16px">Hello,</p>
  <p style="margin:0 0 16px">We are TrustLight, a directory of home-repair contractors built with Cajun Navy Ground Force. It is given to families after hurricanes and floods so they can find help without being taken advantage of.</p>
  <p style="margin:0 0 16px">We independently verified <strong>${esc(name)}</strong> at no cost to you. You did not sign up for this and you owe us nothing. We checked nine things against public and official records: your state licensing board record, your license, your insurance with the carrier, your business filing, court records, your address, your years in business, your contact details, and your reviews.</p>
  <p style="margin:0 0 8px"><strong>Here is exactly what your listing will show:</strong></p>
  <div style="background:#f6f7f9;border:1px solid #e5e8ee;border-radius:8px;padding:14px 16px;margin:0 0 16px">
    ${shown.map((l) => `<div style="margin:3px 0;font-size:14px">${esc(l)}</div>`).join("")}
  </div>
  <p style="margin:0 0 16px;font-size:14px;color:#5a626f">That is all of it. We do not publish your phone number, your email, your license number, your insurance carrier, or any of our notes.</p>
  <p style="margin:0 0 20px"><a href="${esc(urls.profileUrl)}" style="display:inline-block;background:#0a0f1c;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">See your listing and badge</a></p>
  <div style="border-top:1px solid #e5e8ee;padding-top:18px;margin-top:4px">
    <p style="margin:0 0 10px"><strong>If you do not want to be listed</strong></p>
    <p style="margin:0 0 12px;font-size:14px">Use this link and you are removed straight away. No login, no reply needed, no questions.</p>
    <p style="margin:0 0 14px"><a href="${esc(urls.removeUrl)}" style="color:#0a0f1c;font-weight:600">Remove ${esc(name)} from TrustLight</a></p>
    <p style="margin:0 0 6px;font-size:14px;color:#5a626f">You can also just reply to this email and we will take it down.</p>
    <p style="margin:0;font-size:14px;color:#5a626f">If anything above is wrong, reply and tell us and we will correct it or remove the listing, whichever you prefer.</p>
  </div>
  <p style="margin:22px 0 0;font-size:13px;color:#5a626f">— TrustLight · <a href="${esc(urls.siteUrl)}" style="color:#5a626f">${esc(urls.siteUrl)}</a></p>
</div></body></html>`;

  return { subject, text, html };
}

/**
 * Send via SendGrid, matching the call already used by welcome-email.ts.
 *
 * Not extracted into a shared service: the only two existing senders inline
 * this same fetch, and refactoring them is outside this brief. Logged as a
 * candidate rather than done opportunistically.
 *
 * Returns ok:false with a reason instead of throwing, so a failed send never
 * takes down the endpoint that called it — the caller decides what to do.
 */
export async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; text: string; html: string; from: string; fromName: string; replyTo?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.SENDGRID_API_KEY || env.SENDGRID_API_KEY === "PLACEHOLDER") {
    return { ok: false, reason: "SENDGRID_API_KEY is not configured" };
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: msg.from, name: msg.fromName },
        ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
        subject: msg.subject,
        // SendGrid spec: text/plain MUST precede text/html when both are
        // present (RFC 1341 — earlier parts are the fallbacks).
        content: [
          { type: "text/plain", value: msg.text },
          { type: "text/html", value: msg.html },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error("[trustlight] sendgrid_failed", { status: res.status, body: body.slice(0, 300) });
      return { ok: false, reason: `SendGrid ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("[trustlight] sendgrid_threw", { reason });
    return { ok: false, reason };
  }
}

/**
 * When a comped listing runs out of road.
 *
 * THE RULE, stated because the brief left it open: the clock starts when we
 * OFFER the paid plan, not when the listing goes live. A comped business is
 * not on a countdown from the day we verified it — it is on one from the day
 * we asked it to start paying. It gets `comp_grace_days` from that offer to
 * accept, and if it has not, the listing drops.
 *
 * A comped business we have never made an offer to is NOT swept. Dropping
 * someone we never asked would be the listing "silently" disappearing, which
 * is the thing the brief wants avoided in the other direction.
 */
export function compGraceDeadline(
  lead: { comp_offered_at: string | null },
  graceDays: number,
): Date | null {
  if (!lead.comp_offered_at) return null;
  return new Date(new Date(lead.comp_offered_at).getTime() + graceDays * 86400000);
}

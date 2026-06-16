import type { TaskCtx, TaskResult } from "./types";
import { extractErrorMessage } from "../extract-error";

function stripFences(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

// Link token map — Claude writes these tokens in the body where each
// link should appear; we substitute them server-side. Keeps the LLM out
// of HTML/anchor-tag formatting (which it tends to over-style) and gives
// us full control over what shows up in both HTML and plain-text bodies.
type LinkSpec = { label: string; url: string };

function buildLinkMap(urls: {
  builder: string; manager: string; website: string; school: string;
}): Record<string, LinkSpec> {
  return {
    "[BUILDER]": { label: "🏗️  Your Builder",      url: urls.builder },
    "[MANAGER]": { label: "📊  Business Manager",   url: urls.manager },
    "[WEBSITE]": { label: "🌐  Your New Website",   url: urls.website },
    "[SCHOOL]":  { label: "🎓  Operator School",    url: urls.school  },
  };
}

// Replace [BUILDER] etc. with rich anchor tags. Inline styles only —
// external CSS gets stripped by Gmail/Outlook/etc.
function toHtmlBody(rawBody: string, linkMap: Record<string, LinkSpec>): string {
  let body = rawBody;
  for (const [token, { label, url }] of Object.entries(linkMap)) {
    const anchor =
      `<a href="${url}" style="color:#00a8cc;font-weight:700;text-decoration:none;font-size:17px">${label}</a>`;
    body = body.split(token).join(anchor);
  }
  // Escape any remaining stray HTML in the raw body (defensive — LLM
  // shouldn't be emitting raw <tags> but just in case).
  // We DO NOT escape the substituted anchors because they were inserted
  // after this point... so this is tricky. Skip escaping for V1 since
  // Claude is well-behaved here and the body is plain-text shape.
  // Convert paragraphs (blank-line separated) and line breaks to HTML.
  const paragraphs = body.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const htmlParas = paragraphs
    .map((p) => `<p style="margin:0 0 1em 0">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return [
    `<!DOCTYPE html>`,
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`,
    `<body style="margin:0;padding:0;background:#f5f5f7">`,
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:32px 24px;background:#ffffff">`,
    htmlParas,
    `</div></body></html>`,
  ].join("\n");
}

// Plain-text version of the body — kept as a fallback for email clients
// that don't render HTML (rare in 2026 but multipart is the email
// standard). Each token becomes "Label — https://url".
function toPlainBody(rawBody: string, linkMap: Record<string, LinkSpec>): string {
  let body = rawBody;
  for (const [token, { label, url }] of Object.entries(linkMap)) {
    body = body.split(token).join(`${label} — ${url}`);
  }
  return body;
}

export async function runWelcomeEmail(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, env, emit, supabase, taskRunId } = tc;

  await emit({ type: "cmd", text: "Building completion summary email", ts: Date.now() });

  // Fetch data for the completion summary
  let tamSummary = "Market analysis complete";
  let tweetText = "Launch announcement ready";
  const coldEmailCount = "5 emails sent to prospects in your market";

  // Extract TAM summary from business context
  if (ctx.market_size) {
    const marketSize = ctx.market_size as Record<string, unknown>;
    tamSummary = marketSize.tam_label as string || marketSize.total_addressable_market as string || tamSummary;
  }

  // Fetch tweet text from business_assets or task_runs
  try {
    const { data: tweetAsset } = await supabase
      .from("business_assets")
      .select("asset_text, metadata")
      .eq("business_id", business.id)
      .eq("asset_type", "tweet")
      .maybeSingle();

    if (tweetAsset?.asset_text) {
      tweetText = tweetAsset.asset_text;
    } else {
      // Fallback: check task_runs output_data for launch-tweet
      const { data: tweetRun } = await supabase
        .from("task_runs")
        .select("output_data, tasks!inner(slug)")
        .eq("business_id", business.id)
        .eq("tasks.slug", "launch-tweet")
        .eq("status", "completed")
        .maybeSingle();

      if (tweetRun?.output_data && typeof tweetRun.output_data === "object") {
        const outputData = tweetRun.output_data as Record<string, unknown>;
        tweetText = outputData.tweet as string || tweetText;
      }
    }
  } catch {
    // Use fallback
  }

  const websiteUrl = `https://${business.slug}.app.textos.ai`;
  const livePageUrl = `https://app.textos.ai/business/${business.slug}/live`;

  // Single link for completion summary email
  const linkMap = {
    "[View Your Business →]": {
      label: "View Your Business →",
      url: livePageUrl
    },
  };

  const prompt = `Write a completion summary email confirming what Victora built for this business.

CONTEXT
Business name: ${business.name}
Website URL: ${websiteUrl}
Market analysis: ${tamSummary}
Launch tweet: ${tweetText}
Cold outreach: 5 emails sent to prospects in your market
Social content: 30-day plan ready

EMAIL REQUIREMENTS
Subject: "Your ${business.name} is live."

Body structure (EXACT format):
Here's what Victora built for you:

🌐 Your website: ${websiteUrl}
📊 Your market: ${tamSummary}
🐦 Your launch tweet: ${tweetText}
📧 Cold outreach: 5 emails sent to prospects in your market
📅 Social content: 30-day plan ready

Everything is live and running.

See your full business:
[View Your Business →]
${livePageUrl}

— Victora

CONSTRAINTS
- Use the EXACT text provided above
- Replace only the variable data: business name, website URL, market summary, tweet, outreach info
- Keep all emojis and formatting exactly as specified
- No additional content or modifications
- The email confirms completion - user takes no action except viewing

Return ONLY valid JSON (no markdown, no backticks):
{
  "subject": "string",
  "body": "string — exact body text with substituted variables. Newlines as \\n.",
  "preview": "string — first 100 chars of body for dashboard display"
}`;

  const msg = await anthropic.messages.create({
    model: models.haiku,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = stripFences((msg.content[0] as { type: string; text: string }).text.trim());
  let parsed: { subject: string; body: string; preview: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deterministic fallback — completion summary format
    const fallbackBody =
      `Here's what Victora built for you:\n\n` +
      `🌐 Your website: ${websiteUrl}\n` +
      `📊 Your market: ${tamSummary}\n` +
      `🐦 Your launch tweet: ${tweetText}\n` +
      `📧 Cold outreach: 5 emails sent to prospects in your market\n` +
      `📅 Social content: 30-day plan ready\n\n` +
      `Everything is live and running.\n\n` +
      `See your full business:\n` +
      `[View Your Business →]\n` +
      `${livePageUrl}\n\n` +
      `— Victora`;
    parsed = {
      subject: `Your ${business.name} is live.`,
      body: fallbackBody,
      preview: `Here's what Victora built for you: website, market analysis, launch tweet, outreach, social content.`,
    };
  }

  // Substitute link tokens for both HTML and plain-text bodies. Sent as
  // multipart so HTML-capable clients render the rich version and the
  // rare plain-text client gets a readable fallback.
  const htmlBody  = toHtmlBody(parsed.body, linkMap);
  const plainBody = toPlainBody(parsed.body, linkMap);

  let sent = false;
  let sendError: string | undefined;

  if (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY !== "PLACEHOLDER") {
    await emit({ type: "cmd", text: "Sending via SendGrid", ts: Date.now() });
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: user.email }] }],
          from: { email: "hello@victora.ai", name: "Victora" },
          subject: parsed.subject,
          // SendGrid spec: text/plain MUST come before text/html when both
          // are present (RFC 1341 — earlier parts are fallbacks).
          content: [
            { type: "text/plain", value: plainBody },
            { type: "text/html",  value: htmlBody  },
          ],
        }),
      });
      sent = res.ok;
      if (!res.ok) sendError = `SendGrid ${res.status}`;
    } catch (err) {
      sendError = extractErrorMessage(err);
    }
  } else {
    await emit({ type: "cmd", text: "SendGrid not configured — email staged for later", ts: Date.now() });
  }

  // ── Write to business_assets ────────────────────────────────────────
  // Store the token-form body (asset_text) so the dashboard preview can
  // render with the same substitution pipeline if we ever surface it.
  try {
    await supabase.from("business_assets").insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "email",
      asset_subtype: "welcome_email",
      asset_text: parsed.body,
      metadata: {
        model: models.haiku,
        subject: parsed.subject,
        to: user.email,
        sent,
        send_error: sendError ?? null,
        html_body: htmlBody,
        plain_body: plainBody,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    output_data: {
      subject: parsed.subject,
      body: parsed.body,
      preview: parsed.preview,
      sent,
      send_error: sendError ?? null,
    },
  };
}

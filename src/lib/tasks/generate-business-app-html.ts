import type { TaskCtx, TaskResult } from "./types";
import type { ModelConfig } from "../model-config";
import { sanitizeGeneratedHtml } from "../sanitize-generated-html";
import { genAppLog } from "../gen-app-log";

// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app-html — step 2 of 2 in the chain pattern.
//
// Triggered by generate-business-app-design via /api/internal/run-task, runs
// in its OWN Worker invocation (independent budget).
//
// Responsibilities:
//   1. Read the asset_type='app_draft' row written by the design step.
//   2. Make Call 2 (full HTML, max_tokens 12000, streaming) with a 90s
//      timeout. Raised from 8000 on 2026-05-25 after Haiku consistently
//      hit stop_reason=max_tokens around 29-30K chars on attempts. The
//      Worker is no longer constrained by the subrequest body timeout
//      because the consumer runs inside a Cloudflare Queue invocation
//      (15-min wall-clock budget). Streaming keeps the connection live.
//   3. Insert final asset_type='app' row, replace placeholders, update.
//   4. Upsert app_configs.
//   5. Delete the draft row.
//
// Token accounting: this task's tasks.token_cost=0; charging happens in the
// design step. Trying to debit twice would double-charge the user.
// ─────────────────────────────────────────────────────────────────────────────

interface AppDesign {
  app_type: string;
  app_title: string;
  app_tagline: string;
  app_description: string;
  app_icon?: string;
  questions: Array<{
    id: string;
    text: string;
    type: string;
    options?: string[];
    min?: number;
    max?: number;
  }>;
  free_tier_reveals: string;
  paid_tier_reveals: string;
  cta_label: string;
  result_logic: string;
  accent_color: string;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Turn a free-form app_title into a URL-safe slug.
 * Phase 1 multi-app: this slug becomes the per-app discriminator in the
 * unique partial index `(business_id, app_slug) WHERE asset_type='app'
 * AND app_slug IS NOT NULL`. 60-char cap matches the column width used
 * by similar business slugs elsewhere in the schema.
 */
function slugifyTitle(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics (Unicode block U+0300..U+036F) so titles
    // like "Café Picker" slugify to "cafe-picker" rather than "caf-picker".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/**
 * Pick a unique app_slug for this business by scanning existing rows
 * whose slug starts with the candidate, then appending -2, -3, ...
 * until a free value is found.
 *
 * One DB round-trip via LIKE narrows the candidate set; precise
 * matching (exact OR exact-prefix-with-dash-number) happens client-side
 * so we don't trip over `coolapp` colliding with `cool` or vice versa.
 *
 * Race-safe enough at our concurrency (single Worker invocation per
 * HTML run, the unique partial index is the authoritative guard). If a
 * concurrent insert races us, the INSERT will throw on the unique
 * constraint and the caller will see the error.
 */
async function pickUniqueAppSlug(
  supabase: { from: (t: string) => any },
  businessId: string,
  candidateBase: string,
): Promise<string> {
  const base = candidateBase || ("app-" + Date.now().toString(36).slice(-6));
  // LIKE narrows; client-side filter is exact.
  const { data } = await supabase
    .from("business_assets")
    .select("app_slug")
    .eq("business_id", businessId)
    .eq("asset_type", "app")
    .like("app_slug", base + "%");
  const taken = new Set<string>();
  for (const row of (data ?? []) as Array<{ app_slug: string | null }>) {
    const s = row.app_slug;
    if (typeof s !== "string") continue;
    if (s === base || s.startsWith(base + "-")) taken.add(s);
  }
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = base + "-" + n;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological — should never happen at our scale.
  return base + "-" + Date.now().toString(36).slice(-6);
}

function resolveAgentUrl(env: TaskCtx["env"]): string {
  if (env.AGENT_URL) return env.AGENT_URL;
  return env.ENVIRONMENT === "test"
    ? "https://textos-agent-test.rgaudet2023.workers.dev"
    : "https://api.victora.ai";
}

const CALL_TIMEOUT_MS = 90_000;

async function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)), ms),
  );
  return Promise.race([p, timeout]);
}

export async function runGenerateBusinessAppHtml(tc: TaskCtx): Promise<TaskResult> {
  const { business, anthropic, models, emit, supabase, env, taskRunId } = tc;
  const handlerStart = Date.now();

  const frontendUrl = env.FRONTEND_URL ?? "https://app.textos.ai";
  const agentUrl = resolveAgentUrl(env);
  const plannedUrl = `${frontendUrl}/sites/${business.slug}/app`;

  genAppLog("html_handler_entry", {
    business_id: business.id,
    task_run_id: taskRunId,
  });

  // ── Load the draft written by the design step ──────────────────────────────
  genAppLog("html_draft_read_start", {
    business_id: business.id,
    task_run_id: taskRunId,
  });
  const { data: draftRow, error: draftErr } = await supabase
    .from("business_assets")
    .select("id, asset_data")
    .eq("business_id", business.id)
    .eq("asset_type", "app_draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (draftErr) {
    genAppLog("html_draft_read_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      err: draftErr.message,
    });
    throw new Error(`Failed to read app_draft: ${draftErr.message}`);
  }
  if (!draftRow) {
    genAppLog("html_draft_not_found", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
    throw new Error(
      "No app_draft found for this business — design step must complete first.",
    );
  }
  const draftData = draftRow.asset_data as Record<string, unknown> | null;
  const design = draftData?.design as AppDesign | undefined;
  if (!design) {
    genAppLog("html_draft_malformed", {
      business_id: business.id,
      task_run_id: taskRunId,
      draft_row_id: draftRow.id,
    });
    throw new Error("app_draft has no design spec — design step output malformed.");
  }
  const llmTier = (draftData?.llm_tier as string) || "haiku";
  genAppLog("html_draft_read_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
    draft_row_id: draftRow.id,
    llm_tier: llmTier,
    app_type: design.app_type,
  });

  await emit({
    type: "cmd",
    text: `Building ${(design.app_type || "app").replace(/_/g, " ")}...`,
    ts: Date.now(),
  });

  // ── CALL 2 — HTML generation ───────────────────────────────────────────────
  // System prompt rewritten 2026-05-25: explicit conciseness rules added
  // after Haiku consistently hit stop_reason=max_tokens at 8000 with
  // verbose, comment-heavy output. The 12000-token budget is the hard
  // ceiling; the model still has to fit a complete document inside it,
  // so we instruct it to prioritize working code over polish. The
  // "stop_reason=end_turn is required" line gives the model an explicit
  // success criterion it can self-check against.
  const systemPrompt = `You are an expert frontend developer. Generate complete, self-contained HTML/CSS/JS. No external dependencies except vanilla JS. The app must be fully functional standalone. Return ONLY the complete HTML. No explanation. No markdown fences. Start with <!DOCTYPE html>.

CRITICAL — TOKEN BUDGET DISCIPLINE:
- You must complete the full HTML document within the token budget. Prioritize working code over polish.
- No code comments — neither HTML comments (<!-- -->) nor JS comments (// or /* */).
- Minimal whitespace. Collapse blank lines. Single-line CSS rules where possible. No decorative indentation.
- No decorative or aspirational code: no animations beyond the minimum, no easter eggs, no unused helpers.
- Single file only. Inline all CSS in <style>, all JS in <script>. No <link>, no external <script src>.
- stop_reason=end_turn is required. The response MUST end with the literal string </html>. If you sense you are running out of budget, simplify or shorten earlier sections rather than truncating at the end.`;

  // ── Paywall DISABLED (2026-05-25) ────────────────────────────────────────
  // Returning the full result to every visitor for now while we validate the
  // end-to-end generation + render flow. The design spec still carries
  // free_tier_reveals / paid_tier_reveals / cta_label fields, but the prompt
  // tells the model to ignore the free/paid split and show paid_tier_reveals
  // (the full reveal) unconditionally on submit. No paywall overlay, no
  // window.TXAPP.purchase(), no checkToken gating.
  //
  // The window.TXAPP global is still required because future re-introduction
  // of the paywall will need it — keeping it in the contract avoids breaking
  // the asset shape. purchase() and checkToken() are kept as no-op stubs so
  // any leftover references in older designs don't 500 the runtime.
  //
  // When re-introducing paywall: restore the "Free tier"/"Paid tier" split
  // and the paywall-overlay markup blocks below. Keep the {{...}} placeholder
  // substitution logic — it's still wired downstream.
  const userPrompt = `Generate a complete HTML file for this business mini-app based on this spec:

${JSON.stringify(design, null, 2)}

REQUIREMENTS:
- Self-contained single HTML file.
- Mobile-first responsive design.
- Brand accent color: ${design.accent_color}.
- Show all questions in the spec. On submit, show the FULL result — use paid_tier_reveals from the spec as the result body. Do NOT split into free vs paid. Do NOT render any paywall overlay. Do NOT render any "Unlock", "Purchase", or "Upgrade" button. Every visitor gets the full result.
- result_logic from the spec governs how to compute / present the result. Render the full result inline below the questions on submit.
- Add class="txapp-result" to whatever container you use for the result screen — this enables a Download-as-PDF button to be added automatically.
- window.TXAPP global object MUST be included verbatim (kept as a no-op stub for future re-introduction of paywall; do NOT call its methods from the UI):
    window.TXAPP = {
      businessId: '{{BUSINESS_ID}}',
      assetId: '{{ASSET_ID}}',
      apiBase: '{{API_BASE}}',
      visitorToken: null,
      purchase: function() { /* paywall disabled */ },
      checkToken: async function() { return true; }
    };
- Clean, professional design matching business brand (use accent_color liberally).
- Include error handling for any API failures in the result rendering path.

Start with <!DOCTYPE html>. No markdown fences. Return only HTML.`;

  // Resolve the concrete Anthropic model from the admin-configured tier map.
  // Throws on unknown tier — fail-fast rather than silently fall back.
  const htmlModel = (models as unknown as Record<string, string | undefined>)[llmTier];
  if (!htmlModel) throw new Error(`unknown_llm_tier: ${llmTier}`);

  let html: string;
  const callStart = Date.now();
  genAppLog("html_anthropic_call_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    model: htmlModel,
    max_tokens: 12000,
    prompt_chars: systemPrompt.length + userPrompt.length,
    timeout_ms: CALL_TIMEOUT_MS,
    stream: true,
  });
  // Streaming the HTML call — non-streaming (stream:false) at 8000 max_tokens
  // was silently killed by Cloudflare's subrequest body timeout mid-response
  // (no exception, no abort_fired, just a quiet invocation kill). Streaming
  // keeps the subrequest active as chunks arrive; each chunk is a separate
  // read from CF's perspective. We accumulate text from content_block_delta
  // events, then stream.finalMessage() gives us stop_reason + usage cleanly.
  // Tracking variables are declared OUTSIDE the inner try so the outer catch
  // can include partial state on failure.
  let stopReason: string = "unknown";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let chunkCount = 0;
  let accumulatedText = "";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      genAppLog("html_abort_fired", {
        business_id: business.id,
        task_run_id: taskRunId,
        elapsed_ms: Date.now() - callStart,
        chunks_received: chunkCount,
        chars_received: accumulatedText.length,
      });
      controller.abort();
    }, CALL_TIMEOUT_MS);
    try {
      const stream = anthropic.messages.stream(
        {
          model: htmlModel,
          max_tokens: 12000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: controller.signal },
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          (event as { delta?: { type?: string; text?: string } }).delta?.type === "text_delta"
        ) {
          const delta = (event as { delta: { text?: string } }).delta;
          if (typeof delta.text === "string") {
            accumulatedText += delta.text;
            chunkCount++;
          }
        }
      }
      const finalMessage = await stream.finalMessage();
      stopReason = (finalMessage as { stop_reason?: string }).stop_reason ?? "unknown";
      const usage = (finalMessage as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      inputTokens = usage?.input_tokens ?? null;
      outputTokens = usage?.output_tokens ?? null;
    } finally {
      clearTimeout(timeoutId);
    }
    genAppLog("html_anthropic_call_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
      stop_reason: stopReason,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      elapsed_ms: Date.now() - callStart,
      response_chars: accumulatedText.length,
      chunk_count: chunkCount,
    });
    html = stripFences(accumulatedText.trim());
    if (!html.toLowerCase().startsWith("<!doctype")) {
      genAppLog("html_doctype_missing", {
        business_id: business.id,
        task_run_id: taskRunId,
        head_preview: html.slice(0, 80),
      });
      throw new Error(`HTML output didn't start with <!DOCTYPE html>: ${html.slice(0, 80)}`);
    }
    // Truncation detection — same logic as before, now runs over the
    // accumulated streamed text. Two independent signals:
    //   1. Anthropic's stop_reason === 'max_tokens'  (model hit the budget)
    //   2. The parsed HTML doesn't end with </html>  (output cut mid-string)
    const endsWithHtmlTag = html.trimEnd().toLowerCase().endsWith("</html>");
    if (stopReason === "max_tokens" || !endsWithHtmlTag) {
      genAppLog("html_truncation_detected", {
        business_id: business.id,
        task_run_id: taskRunId,
        stop_reason: stopReason,
        ends_with_html_tag: endsWithHtmlTag,
        html_length: html.length,
        tail_preview: html.slice(-160),
      });
      throw new Error(
        `html_truncated: stop_reason='${stopReason}' ends_with_html_tag=${endsWithHtmlTag} length=${html.length}`,
      );
    }
  } catch (err) {
    genAppLog("html_anthropic_call_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      elapsed_ms: Date.now() - callStart,
      chunks_received: chunkCount,
      chars_received: accumulatedText.length,
      stop_reason_so_far: stopReason,
      err_name: err instanceof Error ? err.name : "unknown",
      err_message: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `App HTML generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Sanitization pass — neutralize patterns that violate the TXAPP execution
  // contract (external fetches, XHR, non-TXAPP localStorage, document.cookie,
  // window.parent). Regex-only — see lib/sanitize-generated-html.ts.
  // Removals are non-fatal; they get logged to app_bug_log for admin review.
  const sanitized = sanitizeGeneratedHtml(html);
  html = sanitized.html;
  genAppLog("html_sanitizer_findings", {
    business_id: business.id,
    task_run_id: taskRunId,
    total_removals: sanitized.removals.reduce((sum, r) => sum + r.count, 0),
    pattern_summary: sanitized.removals.map((r) => ({ pattern: r.pattern, count: r.count })),
  });
  if (sanitized.removals.length > 0) {
    await emit({
      type: "cmd",
      text: `[sanitized] removed ${sanitized.removals.reduce((sum, r) => sum + r.count, 0)} flagged pattern(s) from app HTML`,
      ts: Date.now(),
    });
    // Fire-and-log to app_bug_log so the admin queue surfaces this generation.
    // Non-fatal — if the insert errors, we still save the (sanitized) app.
    // asset_id is unknown at this point; updated by the admin queue UI manually
    // or filled by a later enrichment step.
    await supabase.from("app_bug_log").insert({
      business_id: business.id,
      asset_id: business.id, // placeholder — see comment
      error_type: "html_sanitization",
      error_message: JSON.stringify(sanitized.removals).slice(0, 4000),
      status: "open",
    }).then(() => {}, (e: unknown) => {
      // Non-fatal — log to Worker logs and continue.
      console.error("[generate-app-html] app_bug_log insert failed", e);
    });
  }

  await emit({ type: "cmd", text: "Saving your app...", ts: Date.now() });

  // ── Phase 1 multi-app: derive top-level app_slug + app_icon ────────────────
  // app_slug becomes the per-app URL discriminator (unique partial index
  // `(business_id, app_slug) WHERE asset_type='app'`). Slugified from
  // app_title with collision-handled -2, -3 suffix.
  //
  // app_icon was already validated and stored on design.app_icon by the
  // Design step (resolveAppIcon chain). We just promote it to the top-level
  // column here so list/by-slug endpoints don't have to dig into asset_data.
  // Fallback to '🧩' if for any reason design.app_icon is missing —
  // shouldn't happen post-Phase-1 but cheap insurance against drift.
  const candidateBase = slugifyTitle(design.app_title);
  const appSlug = await pickUniqueAppSlug(supabase, business.id, candidateBase);
  const appIcon =
    typeof design.app_icon === "string" && design.app_icon.trim().length > 0
      ? design.app_icon.trim()
      : "🧩";
  genAppLog("html_slug_resolved", {
    business_id: business.id,
    task_run_id: taskRunId,
    app_title: design.app_title,
    candidate_base: candidateBase,
    resolved_slug: appSlug,
    app_icon: appIcon,
  });

  // ── Insert final asset row (need its id to substitute placeholders) ────────
  genAppLog("html_asset_insert_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_type: "app",
    html_length: html.length,
    app_slug: appSlug,
  });
  const { data: assetRow, error: assetErr } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "app",
      asset_subtype: "mini_app",
      asset_url: plannedUrl,
      app_slug: appSlug,
      app_icon: appIcon,
      asset_data: {
        html: null,
        app_type: design.app_type,
        app_title: design.app_title,
        app_tagline: design.app_tagline,
        design,
        llm_tier: llmTier,
        generated_at: new Date().toISOString(),
      },
      metadata: { model: htmlModel, app_type: design.app_type, step: "html" },
    })
    .select("id")
    .single();

  if (assetErr || !assetRow) {
    genAppLog("html_asset_insert_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      err: assetErr?.message ?? "no_row_returned",
    });
    throw new Error(`Failed to write business_assets: ${assetErr?.message ?? "unknown"}`);
  }
  const assetId = assetRow.id as string;
  genAppLog("html_asset_insert_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_id: assetId,
  });

  // Substitute placeholders now that we know all values. {{BUSINESS_NAME}}
  // and {{BUSINESS_URL}} feed the PDF footer injected below. URL points at
  // the public site for this business so a downloaded PDF carries a route
  // back to the source.
  const businessName = String(business.name ?? "").replace(/</g, "&lt;");
  const businessUrl = `${frontendUrl}/sites/${business.slug}/`;
  const substituted = html
    .replace(/\{\{BUSINESS_ID\}\}/g, business.id)
    .replace(/\{\{ASSET_ID\}\}/g, assetId)
    .replace(/\{\{API_BASE\}\}/g, agentUrl)
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName)
    .replace(/\{\{BUSINESS_URL\}\}/g, businessUrl);

  // ── PDF download injection ───────────────────────────────────────────────
  // Runs AFTER sanitizeGeneratedHtml (which executed earlier at ~line 385).
  // The injected <script> contains no patterns the sanitizer would strip
  // (no fetch/external URLs, no localStorage outside tx_vt_*, no cookies,
  // no XHR, no window.parent), but if you ever tighten the sanitizer rules
  // make sure to either re-run sanitize after injection OR confirm the
  // new rules don't false-positive on this block. Selector contract: the
  // LLM is required to emit a <div class="txapp-result" hidden>…</div>
  // wrapper around the result content (see system prompt above).
  const accent = (design.accent_color && /^#[0-9a-fA-F]{3,8}$/.test(design.accent_color))
    ? design.accent_color
    : "#f59e0b";
  const pdfBlock = `
<style>
  /* padding-top reserves clear space for the absolute-positioned PDF
     button so it never overlaps the result's first heading. */
  .txapp-result { position: relative; padding-top: 52px; }
  .txapp-pdf-btn {
    position: absolute; top: 12px; right: 12px;
    background: ${accent}; color: #fff; border: none;
    padding: 7px 12px; border-radius: 6px;
    font-family: inherit; font-size: 12px; font-weight: 600;
    letter-spacing: 0.04em; cursor: pointer; z-index: 50;
    box-shadow: 0 2px 6px rgba(0,0,0,0.12);
  }
  .txapp-pdf-btn:hover { opacity: 0.9; }
  .txapp-pdf-footer { display: none; }
  @media print {
    /* Visibility-isolation pattern: hide everything, then unhide the
       result wrapper and its descendants. Works regardless of how deep
       the LLM nested the wrapper (body > main > .container > .result,
       etc.). Absolute-positioning the wrapper collapses the empty
       space the hidden elements still occupy. */
    body * { visibility: hidden !important; }
    .txapp-result, .txapp-result * { visibility: visible !important; }
    .txapp-result {
      position: absolute !important; top: 0; left: 0; right: 0;
      padding: 0 !important; background: #fff !important;
    }
    .txapp-result, .txapp-result * {
      color: #000 !important; background: transparent !important;
      box-shadow: none !important; text-shadow: none !important;
    }
    .txapp-result h1, .txapp-result h2, .txapp-result h3 { color: ${accent} !important; }
    .txapp-pdf-btn { display: none !important; }
    .txapp-pdf-footer {
      display: block !important; margin-top: 24px; padding-top: 12px;
      border-top: 1px solid #ccc; font-size: 11px; color: #555 !important;
    }
    @page { margin: 0.75in; }
  }
</style>
<script>
  (function () {
    // Result-wrapper detection. The prompt nudges the LLM toward
    // class="txapp-result", but compliance is imperfect — older apps and
    // some new ones use id="result" / class="result" / "outcome" / etc.
    // Strategy:
    //   1. Prefer the canonical .txapp-result if present.
    //   2. Fall back to any element whose id OR class contains
    //      "result" or "outcome" (case-insensitive).
    //   3. Restrict to block containers (div / section / article / main).
    //   4. Drop candidates contained by another candidate (outermost wins).
    //   5. Among ties, pick the largest by textContent length — that's
    //      the actual result-screen wrapper, not the inner score span.
    //   6. Skip injection if nothing plausible was found.
    function findResultWrapper() {
      var canonical = document.querySelector('.txapp-result');
      if (canonical) return canonical;
      var raw = Array.prototype.slice.call(document.querySelectorAll(
        '[id*="result" i], [class*="result" i], [id*="outcome" i], [class*="outcome" i]'
      ));
      if (raw.length === 0) return null;
      var wrappers = raw.filter(function (el) {
        var t = (el.tagName || '').toLowerCase();
        return t === 'div' || t === 'section' || t === 'article' || t === 'main';
      });
      if (wrappers.length === 0) wrappers = raw;
      var outer = wrappers.filter(function (el) {
        return !wrappers.some(function (o) { return o !== el && o.contains(el); });
      });
      if (outer.length === 0) outer = wrappers;
      outer.sort(function (a, b) {
        return (b.textContent || '').length - (a.textContent || '').length;
      });
      return outer[0] || null;
    }

    function attach() {
      var r = findResultWrapper();
      if (!r) {
        console.log('[txapp-pdf] no result wrapper found — PDF button skipped');
        return;
      }
      if (r.dataset.txPdfWired === '1') return;
      r.dataset.txPdfWired = '1';
      // Tag the wrapper so the @media print stylesheet (which targets
      // .txapp-result) picks it up even when the LLM used a different name.
      if (!r.classList.contains('txapp-result')) r.classList.add('txapp-result');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'txapp-pdf-btn';
      btn.textContent = 'Download as PDF';
      btn.addEventListener('click', function () { window.print(); });
      r.appendChild(btn);
      var foot = document.createElement('div');
      foot.className = 'txapp-pdf-footer';
      foot.textContent = 'Generated by ${businessName.replace(/'/g, "\\'")} — ${businessUrl}';
      r.appendChild(foot);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach);
    } else {
      attach();
    }
  })();
</script>
`;
  // Inject before </body>. Case-insensitive match; falls back to appending
  // if the LLM somehow omitted </body> (defensive — the prompt requires a
  // complete document).
  const finalHtml = /<\/body\s*>/i.test(substituted)
    ? substituted.replace(/<\/body\s*>/i, pdfBlock + "</body>")
    : substituted + pdfBlock;

  genAppLog("html_asset_update_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_id: assetId,
    final_html_length: finalHtml.length,
  });
  const { error: updateErr } = await supabase
    .from("business_assets")
    .update({
      asset_data: {
        html: finalHtml,
        app_type: design.app_type,
        app_title: design.app_title,
        app_tagline: design.app_tagline,
        design,
        llm_tier: llmTier,
        generated_at: new Date().toISOString(),
      },
    })
    .eq("id", assetId);
  if (updateErr) {
    genAppLog("html_asset_update_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      asset_id: assetId,
      err: updateErr.message,
    });
    throw new Error(`Failed to update business_assets HTML: ${updateErr.message}`);
  }
  genAppLog("html_asset_update_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_id: assetId,
  });

  // ── app_configs upsert (per-business) ──────────────────────────────────────
  genAppLog("html_app_configs_upsert_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_id: assetId,
  });
  const { error: cfgErr } = await supabase.from("app_configs").upsert(
    {
      business_id: business.id,
      asset_id: assetId,
      llm_tier: llmTier,
      free_tier_enabled: true,
      paid_tier_price_cents: 500,
      token_cost_per_use: 1,
      is_published: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "business_id" },
  );
  if (cfgErr) {
    genAppLog("html_app_configs_upsert_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      err: cfgErr.message,
    });
    // Non-fatal — the asset is saved; admin can fix config later.
    await emit({
      type: "cmd",
      text: `[warn] app_configs upsert failed: ${cfgErr.message}`,
      ts: Date.now(),
    });
  } else {
    genAppLog("html_app_configs_upsert_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
    });
  }

  // ── Delete the draft row now that the final asset is persisted ─────────────
  // Non-fatal if it fails — the draft is just a workspace row; the final 'app'
  // row is the source of truth for serving.
  genAppLog("html_draft_delete_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    draft_row_id: draftRow.id,
  });
  const { error: deleteErr } = await supabase
    .from("business_assets")
    .delete()
    .eq("id", draftRow.id);
  if (deleteErr) {
    genAppLog("html_draft_delete_failed", {
      business_id: business.id,
      task_run_id: taskRunId,
      draft_row_id: draftRow.id,
      err: deleteErr.message,
    });
    await emit({
      type: "cmd",
      text: `[warn] failed to delete app_draft (non-fatal): ${deleteErr.message}`,
      ts: Date.now(),
    });
  } else {
    genAppLog("html_draft_delete_complete", {
      business_id: business.id,
      task_run_id: taskRunId,
      draft_row_id: draftRow.id,
    });
  }

  await emit({
    type: "narrative",
    text: "Your app is live →",
    ts: Date.now(),
  });
  await emit({
    type: "cmd",
    text: `App deployed at /sites/${business.slug}/app`,
    ts: Date.now(),
  });

  genAppLog("html_handler_complete", {
    business_id: business.id,
    task_run_id: taskRunId,
    total_elapsed_ms: Date.now() - handlerStart,
    outcome: "success",
    asset_id: assetId,
    url: plannedUrl,
  });

  return {
    output_data: {
      step: "html",
      app_type: design.app_type,
      app_title: design.app_title,
      app_tagline: design.app_tagline,
      url: plannedUrl,
      asset_id: assetId,
    },
  };
}

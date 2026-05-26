import type { TaskCtx, TaskResult } from "./types";
import { resolveModelForTier } from "../llm-tier-model";
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

function resolveAgentUrl(env: TaskCtx["env"]): string {
  if (env.AGENT_URL) return env.AGENT_URL;
  return env.ENVIRONMENT === "test"
    ? "https://textos-agent-test.rgaudet2023.workers.dev"
    : "https://textos-agent-dev.rgaudet2023.workers.dev";
}

const CALL_TIMEOUT_MS = 90_000;

async function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)), ms),
  );
  return Promise.race([p, timeout]);
}

export async function runGenerateBusinessAppHtml(tc: TaskCtx): Promise<TaskResult> {
  const { business, anthropic, emit, supabase, env, taskRunId } = tc;
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

  // Resolve the concrete Anthropic model from the user-selected tier.
  // Throws on unknown tier — fail-fast rather than silently fall back.
  const htmlModel = resolveModelForTier(llmTier);

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

  // ── Insert final asset row (need its id to substitute placeholders) ────────
  genAppLog("html_asset_insert_start", {
    business_id: business.id,
    task_run_id: taskRunId,
    asset_type: "app",
    html_length: html.length,
  });
  const { data: assetRow, error: assetErr } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "app",
      asset_subtype: "mini_app",
      asset_url: plannedUrl,
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

  // Substitute placeholders now that we know all three values.
  const finalHtml = html
    .replace(/\{\{BUSINESS_ID\}\}/g, business.id)
    .replace(/\{\{ASSET_ID\}\}/g, assetId)
    .replace(/\{\{API_BASE\}\}/g, agentUrl);

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

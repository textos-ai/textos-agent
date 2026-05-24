import type { TaskCtx, TaskResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app-html — step 2 of 2 in the chain pattern.
//
// Triggered by generate-business-app-design via /api/internal/run-task, runs
// in its OWN Worker invocation (independent budget).
//
// Responsibilities:
//   1. Read the asset_type='app_draft' row written by the design step.
//   2. Make Call 2 (full HTML, max_tokens 8000) with a 45s timeout.
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

const CALL_TIMEOUT_MS = 45_000;

async function withTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label}_timeout_${Math.floor(ms / 1000)}s`)), ms),
  );
  return Promise.race([p, timeout]);
}

export async function runGenerateBusinessAppHtml(tc: TaskCtx): Promise<TaskResult> {
  const { business, anthropic, emit, supabase, env, taskRunId } = tc;

  const frontendUrl = env.FRONTEND_URL ?? "https://app.textos.ai";
  const agentUrl = resolveAgentUrl(env);
  const plannedUrl = `${frontendUrl}/sites/${business.slug}/app`;

  // ── Load the draft written by the design step ──────────────────────────────
  const { data: draftRow, error: draftErr } = await supabase
    .from("business_assets")
    .select("id, asset_data")
    .eq("business_id", business.id)
    .eq("asset_type", "app_draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (draftErr) {
    throw new Error(`Failed to read app_draft: ${draftErr.message}`);
  }
  if (!draftRow) {
    throw new Error(
      "No app_draft found for this business — design step must complete first.",
    );
  }
  const draftData = draftRow.asset_data as Record<string, unknown> | null;
  const design = draftData?.design as AppDesign | undefined;
  if (!design) {
    throw new Error("app_draft has no design spec — design step output malformed.");
  }
  const llmTier = (draftData?.llm_tier as string) || "haiku";

  await emit({
    type: "cmd",
    text: `Building ${(design.app_type || "app").replace(/_/g, " ")}...`,
    ts: Date.now(),
  });

  // ── CALL 2 — HTML generation ───────────────────────────────────────────────
  const systemPrompt = `You are an expert frontend developer. Generate complete, self-contained HTML/CSS/JS. No external dependencies except vanilla JS. The app must be fully functional standalone. Return ONLY the complete HTML. No explanation. No markdown fences. Start with <!DOCTYPE html>.`;

  const userPrompt = `Generate a complete HTML file for this business mini-app based on this spec:

${JSON.stringify(design, null, 2)}

REQUIREMENTS:
- Self-contained single HTML file
- Mobile-first responsive design
- Brand accent color: ${design.accent_color}
- Free tier: show all questions, then a teaser result (use free_tier_reveals)
- Paid tier: locked behind .paywall-overlay div (use paid_tier_reveals + cta_label)
- Paywall overlay HTML structure:
    <div class='paywall-overlay' id='paywall'>
      <div class='paywall-inner'>
        <h3>Unlock Your Full Results</h3>
        <p>${design.paid_tier_reveals.replace(/'/g, "&#39;")}</p>
        <button onclick='window.TXAPP.purchase()'>${design.cta_label.replace(/'/g, "&#39;")} →</button>
      </div>
    </div>
- window.TXAPP global object MUST be included verbatim:
    window.TXAPP = {
      businessId: '{{BUSINESS_ID}}',
      assetId: '{{ASSET_ID}}',
      apiBase: '{{API_BASE}}',
      visitorToken: localStorage.getItem('tx_vt_{{BUSINESS_ID}}') || null,
      purchase: function() {
        window.location.href = window.TXAPP.apiBase + '/api/generated-apps/{{BUSINESS_ID}}/purchase';
      },
      checkToken: async function() {
        if (!window.TXAPP.visitorToken) return false;
        const r = await fetch(window.TXAPP.apiBase + '/api/generated-apps/{{BUSINESS_ID}}/verify-token', {
          method: 'POST',
          headers: { 'x-visitor-token': window.TXAPP.visitorToken }
        });
        return r.ok;
      }
    };
- On submit: call window.TXAPP.checkToken()
    true → show full results, hide paywall
    false → show teaser + paywall overlay
- On page load: read ?vt=xxx query param. If present, store to localStorage as tx_vt_{{BUSINESS_ID}}, then set window.TXAPP.visitorToken.
- Clean, professional design matching business brand (use accent_color liberally)
- Include error handling for API failures

Start with <!DOCTYPE html>. No markdown fences. Return only HTML.`;

  let html: string;
  try {
    const msg = await withTimeout(
      anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        stream: false,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      "html_call",
      CALL_TIMEOUT_MS,
    );
    const block = msg.content[0];
    const text = block && block.type === "text" ? (block as { text: string }).text : "";
    html = stripFences(text.trim());
    if (!html.toLowerCase().startsWith("<!doctype")) {
      throw new Error(`HTML output didn't start with <!DOCTYPE html>: ${html.slice(0, 80)}`);
    }
  } catch (err) {
    throw new Error(
      `App HTML generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await emit({ type: "cmd", text: "Saving your app...", ts: Date.now() });

  // ── Insert final asset row (need its id to substitute placeholders) ────────
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
      metadata: { model: "claude-sonnet-4-20250514", app_type: design.app_type, step: "html" },
    })
    .select("id")
    .single();

  if (assetErr || !assetRow) {
    throw new Error(`Failed to write business_assets: ${assetErr?.message ?? "unknown"}`);
  }
  const assetId = assetRow.id as string;

  // Substitute placeholders now that we know all three values.
  const finalHtml = html
    .replace(/\{\{BUSINESS_ID\}\}/g, business.id)
    .replace(/\{\{ASSET_ID\}\}/g, assetId)
    .replace(/\{\{API_BASE\}\}/g, agentUrl);

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
    throw new Error(`Failed to update business_assets HTML: ${updateErr.message}`);
  }

  // ── app_configs upsert (per-business) ──────────────────────────────────────
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
    await emit({
      type: "cmd",
      text: `[warn] app_configs upsert failed: ${cfgErr.message}`,
      ts: Date.now(),
    });
  }

  // ── Delete the draft row now that the final asset is persisted ─────────────
  // Non-fatal if it fails — the draft is just a workspace row; the final 'app'
  // row is the source of truth for serving.
  const { error: deleteErr } = await supabase
    .from("business_assets")
    .delete()
    .eq("id", draftRow.id);
  if (deleteErr) {
    await emit({
      type: "cmd",
      text: `[warn] failed to delete app_draft (non-fatal): ${deleteErr.message}`,
      ts: Date.now(),
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

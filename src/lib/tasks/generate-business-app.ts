import type { TaskCtx, TaskResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// generate-business-app — two-call task handler.
//
// Call 1 (design): Claude returns a JSON spec describing the app type, question
// list, paywall reveal text, and accent color.
//
// Call 2 (HTML):   Claude returns a self-contained single-file HTML/CSS/JS app
// based on the spec. The HTML contains {{BUSINESS_ID}}, {{ASSET_ID}}, and
// {{API_BASE}} placeholders that this handler replaces before saving.
//
// Persistence:
//   - business_assets: asset_type='app', asset_subtype='mini_app'. asset_data
//     holds the final HTML and the design spec.
//   - app_configs: per-business pricing + LLM tier; created here on first run,
//     left untouched on re-runs (the user may have edited it).
// ─────────────────────────────────────────────────────────────────────────────

interface AppDesign {
  app_type: string;
  app_title: string;
  app_tagline: string;
  app_description: string;
  questions: Array<{
    id: string;
    text: string;
    type: "single_choice" | "multi_choice" | "text" | "number" | "scale";
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
  return s.replace(/^```(?:json|html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function resolveAgentUrl(env: TaskCtx["env"]): string {
  // Worker doesn't know its own public URL by default; derive from ENVIRONMENT.
  // Override-friendly: if AGENT_URL is set (wrangler.toml [vars]), it wins.
  const override = (env as unknown as { AGENT_URL?: string }).AGENT_URL;
  if (override) return override;
  return env.ENVIRONMENT === "test"
    ? "https://textos-agent-test.rgaudet2023.workers.dev"
    : "https://textos-agent-dev.rgaudet2023.workers.dev";
}

export async function runGenerateBusinessApp(tc: TaskCtx): Promise<TaskResult> {
  const { business, ctx, anthropic, emit, supabase, env, taskRunId } = tc;

  const frontendUrl = env.FRONTEND_URL ?? "https://app.textos.ai";
  const agentUrl = resolveAgentUrl(env);
  const plannedUrl = `${frontendUrl}/sites/${business.slug}/app`;

  // Optional user-provided description of what they want (passed through the
  // business-task-run dispatch path). May be undefined for the autonomous case.
  const taskRunRow = await supabase
    .from("task_runs")
    .select("config")
    .eq("id", taskRunId)
    .maybeSingle();
  const config = (taskRunRow.data?.config as Record<string, unknown> | null) || null;
  const userDescription =
    typeof config?.description === "string" ? config.description : "";
  const llmTier = typeof config?.llm_tier === "string" ? (config.llm_tier as string) : "haiku";

  await emit({ type: "cmd", text: "Designing your custom app...", ts: Date.now() });

  // ── CALL 1 — App design ────────────────────────────────────────────────────
  const call1System = `You are an expert web app designer for ${business.name}, a ${ctx.industry ?? "small"} business. ${ctx.business_summary ?? ""}. Return ONLY valid JSON. First character must be {.`;

  const call1User = `Design a custom mini-app for this business website. The app must be specific to this industry and serve the target customer directly.

Business context:
- Industry: ${ctx.industry ?? "unknown"}
- Summary: ${ctx.business_summary ?? "unknown"}
- Target customer: ${ctx.target_customer ? JSON.stringify(ctx.target_customer) : "unknown"}
- Value proposition: ${ctx.value_proposition ?? "unknown"}
- Brand voice: ${ctx.brand_voice ?? "professional"}
- Business kind: ${business.kind}

${userDescription ? `User-provided description (HONOR THIS): ${userDescription}` : ""}

Choose the BEST app type from this list based on the business:
  - assessment_quiz: customer readiness/fit quiz
  - quote_calculator: instant price estimator
  - roi_calculator: return on investment tool
  - recommendation_engine: product/service matcher
  - lead_qualifier: qualify visitor's needs
  - booking_intake: pre-booking question form
  - knowledge_checker: educational quiz

Return JSON:
{
  "app_type": "string",
  "app_title": "string",
  "app_tagline": "string",
  "app_description": "string (shown to visitor)",
  "questions": [
    {
      "id": "q1",
      "text": "string",
      "type": "single_choice|multi_choice|text|number|scale",
      "options": ["..."],
      "min": 0,
      "max": 10
    }
  ],
  "free_tier_reveals": "string — what the free tier shows after submit",
  "paid_tier_reveals": "string — what the paid tier unlocks",
  "cta_label": "string — paywall button text",
  "result_logic": "string — plain English: how to score/calculate results",
  "accent_color": "string — hex color matching the business brand"
}`;

  let design: AppDesign;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      stream: false,
      system: call1System,
      messages: [{ role: "user", content: call1User }],
    });
    const block = msg.content[0];
    const text = block && block.type === "text" ? (block as { text: string }).text : "";
    design = JSON.parse(stripFences(text.trim())) as AppDesign;
  } catch (err) {
    throw new Error(
      `App design call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await emit({
    type: "cmd",
    text: `Building ${design.app_type.replace(/_/g, " ")}...`,
    ts: Date.now(),
  });

  // ── CALL 2 — HTML generation ───────────────────────────────────────────────
  const call2System = `You are an expert frontend developer. Generate complete, self-contained HTML/CSS/JS. No external dependencies except vanilla JS. The app must be fully functional standalone. Return ONLY the complete HTML. No explanation. No markdown fences. Start with <!DOCTYPE html>.`;

  const call2User = `Generate a complete HTML file for this business mini-app based on this spec:

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
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      stream: false,
      system: call2System,
      messages: [{ role: "user", content: call2User }],
    });
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

  // ── Persist asset (needs id before placeholder replacement) ────────────────
  // Insert with a placeholder html, then update once we know the asset id.
  const { data: assetRow, error: assetErr } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: taskRunId,
      asset_type: "app",
      asset_subtype: "mini_app",
      asset_url: plannedUrl,
      asset_data: {
        // html filled in after id-aware replacement below
        html: null,
        app_type: design.app_type,
        app_title: design.app_title,
        app_tagline: design.app_tagline,
        design,
        llm_tier: llmTier,
        generated_at: new Date().toISOString(),
      },
      metadata: { model: "claude-sonnet-4-20250514", app_type: design.app_type },
    })
    .select("id")
    .single();

  if (assetErr || !assetRow) {
    throw new Error(`Failed to write business_assets: ${assetErr?.message ?? "unknown"}`);
  }
  const assetId = assetRow.id as string;

  // Replace placeholders now that we know all three values.
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

  // ── app_configs (per-business config; upsert on business_id) ───────────────
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
    // Non-fatal — the asset is saved; admin can fix config later. Log & continue.
    await emit({
      type: "cmd",
      text: `[warn] app_configs upsert failed: ${cfgErr.message}`,
      ts: Date.now(),
    });
  }

  await emit({
    type: "narrative",
    text: `Your ${design.app_type.replace(/_/g, " ")} is ready →`,
    ts: Date.now(),
  });
  await emit({
    type: "cmd",
    text: `App deployed at /sites/${business.slug}/app`,
    ts: Date.now(),
  });

  return {
    output_data: {
      app_type: design.app_type,
      app_title: design.app_title,
      app_tagline: design.app_tagline,
      url: plannedUrl,
      asset_id: assetId,
    },
  };
}

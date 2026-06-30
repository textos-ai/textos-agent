import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { createAnthropicClient } from "../services/anthropic";
import { loadModelConfig } from "../lib/model-config";
import { loadFeatureConfig, resolveFeatureModel } from "../lib/non-task-model-config";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// Only these statuses may be written from the review UI — blocks arbitrary status writes.
const UI_ALLOWED_STATUSES = new Set(["approved", "dismissed"]);

// ── GET /:slug/marketing/content-assets ─────────────────────────────────────
// Returns draft content_assets for this business, newest first.
// Joins content_types for card render hints (preview_component, label, suited_platforms).

app.get("/:slug/marketing/content-assets", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data, error } = await supabase
    .from("content_assets")
    .select(`
      id,
      content_type,
      target_platform,
      generated_body,
      status,
      created_at,
      source_asset_id,
      task_run_id,
      scheduled_for,
      scheduled_timezone,
      content_types (
        label,
        preview_component,
        suited_platforms
      )
    `)
    .eq("business_id", business.id)
    .in("status", ["draft", "approved", "scheduled"])
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    log.error("[marketing-content] list_failed", {
      business_id: business.id,
      err: error.message,
    });
    return c.json({ error: "Failed to load content" }, 500);
  }

  const rows = (data ?? []) as any[];

  // Hashtag indicator ("3 of 5 tags"): selected = the keywords chosen at
  // generation (task_runs.config.keywords); added = how many of those tags
  // actually landed in the body (incremental fit, per platform). Derived from
  // existing data — no extra column. One batched task_runs lookup for the page.
  const runIds = Array.from(
    new Set(rows.map((r) => r.task_run_id).filter((v): v is string => !!v)),
  );
  const keywordsByRun = new Map<string, string[]>();
  if (runIds.length > 0) {
    const { data: runs } = await supabase
      .from("task_runs")
      .select("id, config")
      .in("id", runIds);
    for (const run of (runs ?? []) as any[]) {
      const kws = Array.isArray(run.config?.keywords)
        ? (run.config.keywords as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      keywordsByRun.set(run.id, kws);
    }
  }

  const tagForm = (kw: string) => "#" + kw.toLowerCase().replace(/[^a-z0-9]+/g, "");

  const items = rows.map((row: any) => {
    const kws = (row.task_run_id && keywordsByRun.get(row.task_run_id)) || [];
    const selected = kws.length;
    const body = String(row.generated_body ?? "");
    const added = selected > 0
      ? kws.filter((kw) => { const t = tagForm(kw); return t.length > 1 && body.includes(t); }).length
      : 0;
    return {
      id: row.id,
      content_type: row.content_type,
      target_platform: row.target_platform ?? null,
      generated_body: row.generated_body,
      status: row.status,
      created_at: row.created_at,
      source_asset_id: row.source_asset_id ?? null,
      scheduled_for: row.scheduled_for ?? null,
      scheduled_timezone: row.scheduled_timezone ?? null,
      hashtags: { added, selected },
      content_type_meta: row.content_types
        ? {
            label: (row.content_types as any).label,
            preview_component: (row.content_types as any).preview_component,
            suited_platforms: (row.content_types as any).suited_platforms,
          }
        : null,
    };
  });

  return c.json({ items });
});

// Business timezone for day/week boundaries. America/Chicago (Central) for now;
// IANA name = DST-correct. Future: read a per-business tz, defaulting to this.
const BUSINESS_TZ = "America/Chicago";

// The Central calendar Y/M/D containing a given UTC instant.
function centralDateParts(utcMs: number): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return { y: +p.year, m: +p.month, d: +p.day };
}

// Milliseconds that wall-clock time in BUSINESS_TZ is ahead of UTC at `utcMs`
// (Central Standard = -6h → -21600000; Central Daylight = -5h → -18000000).
function centralOffsetMs(utcMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// UTC epoch ms for the start (midnight Central) of the Central day containing
// `utcMs`, shifted back `daysBack` Central days. Overflow-safe across months.
function centralDayStartUTC(utcMs: number, daysBack: number): number {
  const { y, m, d } = centralDateParts(utcMs);
  const wallMidnightAsUTC = Date.UTC(y, m - 1, d - daysBack, 0, 0, 0);
  // Correct the "as if UTC" guess by the real Central offset at that instant.
  return wallMidnightAsUTC - centralOffsetMs(wallMidnightAsUTC);
}

// ── GET /:slug/marketing/metrics ─────────────────────────────────────────────
// Two-tier counts from OUR content_assets (no Zernio reach data).
//   overall:     all-platform published (every platform VERSION), today, this
//                week, distinct IDEAS (task_run_id), in-draft.
//   perPlatform: same numbers scoped to each platform slug (keyed lowercase).
// Idea-vs-version: each generate request = one task_run = one idea, fanned out
// to one content_assets row PER platform — so distinct task_run_id = ideas,
// row count = platform versions. Soft-deleted rows (deleted_at) are excluded.
app.get("/:slug/marketing/metrics", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data, error } = await supabase
    .from("content_assets")
    .select("status, target_platform, task_run_id, published_at")
    .eq("business_id", business.id)
    .is("deleted_at", null);

  if (error) {
    log.error("[marketing-content] metrics_failed", {
      business_id: business.id,
      err: error.message,
    });
    return c.json({ error: "Failed to load metrics" }, 500);
  }

  const rows = (data ?? []) as Array<{
    status: string;
    target_platform: string | null;
    task_run_id: string | null;
    published_at: string | null;
  }>;

  // "Today" / "this week" use the business timezone (Central), so the day rolls
  // over at midnight Central — not 6/7pm. IANA America/Chicago handles CST/CDT
  // automatically (no hardcoded -6/-5 offset that would drift twice a year).
  const nowMs = Date.now();
  const tp = centralDateParts(nowMs);
  const startOfToday = centralDayStartUTC(nowMs, 0);
  const centralDow = new Date(Date.UTC(tp.y, tp.m - 1, tp.d)).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMon = (centralDow + 6) % 7;
  const startOfWeek = centralDayStartUTC(nowMs, daysSinceMon);

  const inToday = (ts: string | null) => !!ts && Date.parse(ts) >= startOfToday;
  const inWeek  = (ts: string | null) => !!ts && Date.parse(ts) >= startOfWeek;

  const overall = { published: 0, today: 0, week: 0, ideas: 0, draft: 0, approved: 0, scheduled: 0 };
  const ideaSet = new Set<string>();
  const perPlatform: Record<string, { published: number; today: number; week: number; draft: number; approved: number; scheduled: number }> = {};

  const bucket = (slugKey: string) =>
    (perPlatform[slugKey] ??= { published: 0, today: 0, week: 0, draft: 0, approved: 0, scheduled: 0 });

  for (const r of rows) {
    if (r.task_run_id) ideaSet.add(r.task_run_id);
    const pslug = (r.target_platform ?? "").toLowerCase();
    const pb = pslug ? bucket(pslug) : null;

    if (r.status === "published") {
      overall.published++;
      if (pb) pb.published++;
      if (inToday(r.published_at)) { overall.today++; if (pb) pb.today++; }
      if (inWeek(r.published_at))  { overall.week++;  if (pb) pb.week++; }
    } else if (r.status === "draft") {
      overall.draft++;
      if (pb) pb.draft++;
    } else if (r.status === "approved") {
      // "Ready to send" — approved but not yet published.
      overall.approved++;
      if (pb) pb.approved++;
    } else if (r.status === "scheduled") {
      // Committed to a future time (firing delegated to Zernio).
      overall.scheduled++;
      if (pb) pb.scheduled++;
    }
  }
  overall.ideas = ideaSet.size;

  return c.json({ overall, perPlatform });
});

// ── GET /:slug/marketing/calendar ────────────────────────────────────────────
// Calendar feed: future SCHEDULED posts (on scheduled_for) + past PUBLISHED
// posts (on published_at). One business, soft-deleted excluded. The frontend
// renders these on the Schedule calendar, color-coded by platform, with the two
// states visually distinct. Times are UTC ISO; the client displays Central.
app.get("/:slug/marketing/calendar", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data, error } = await supabase
    .from("content_assets")
    .select("id, target_platform, status, generated_body, scheduled_for, published_at")
    .eq("business_id", business.id)
    .in("status", ["scheduled", "published"])
    .is("deleted_at", null);

  if (error) {
    log.error("[marketing-content] calendar_failed", { business_id: business.id, err: error.message });
    return c.json({ error: "Failed to load calendar" }, 500);
  }

  const posts = ((data ?? []) as any[])
    .map((r) => {
      const when = r.status === "scheduled" ? r.scheduled_for : r.published_at;
      if (!when) return null;
      const body = String(r.generated_body ?? "");
      return {
        id: r.id,
        platform: (r.target_platform ?? "").toLowerCase(),
        status: r.status,
        when,                                   // UTC ISO
        title: body.length > 80 ? body.slice(0, 80) + "…" : body,
        body,
      };
    })
    .filter(Boolean);

  return c.json({ posts });
});

// ── PATCH /:slug/marketing/content-assets/:id ────────────────────────────────
// Two mutually exclusive modes — provide exactly one of:
//   { status: "approved" | "dismissed" }  — status transition (no body change)
//   { generated_body: "..." }             — inline body edit (status unchanged)
// Both modes require ownership: slug → businesses.user_id = auth.user_id,
// and confirm the asset belongs to this business before writing.

app.patch("/:slug/marketing/content-assets/:id", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { status?: string; generated_body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const hasStatus = typeof body.status === "string";
  const hasBody   = typeof body.generated_body === "string";

  if (!hasStatus && !hasBody) {
    return c.json({ error: "Provide 'status' or 'generated_body'" }, 400);
  }
  if (hasStatus && hasBody) {
    return c.json({ error: "Provide 'status' or 'generated_body', not both" }, 400);
  }
  if (hasStatus && !UI_ALLOWED_STATUSES.has(body.status!)) {
    return c.json({ error: "status must be 'approved' or 'dismissed'" }, 400);
  }
  if (hasBody && body.generated_body!.trim() === "") {
    return c.json({ error: "generated_body cannot be empty" }, 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  // Cross-business write guard: confirm asset belongs to this business
  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const patch = hasStatus
    ? { status: body.status! }
    : { generated_body: body.generated_body! };

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update(patch)
    .eq("id", id);

  if (updateErr) {
    log.error("[marketing-content] update_failed", { id, err: updateErr.message });
    return c.json({ error: "Failed to update" }, 500);
  }

  return c.json({ ok: true, id, ...patch });
});

// ── GET /:slug/marketing/content-assets/archive ─────────────────────────────
// Returns off-queue content_assets by filter:
//   deleted   = deleted_at IS NOT NULL (any status)
//   published = status 'published' AND deleted_at null
//   failed    = status 'failed'    AND deleted_at null

app.get("/:slug/marketing/content-assets/archive", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug   = c.req.param("slug");
  const filter = c.req.query("filter") ?? "deleted";
  const supabase = createSupabaseClient(c.env);

  if (!["deleted", "published", "failed"].includes(filter)) {
    return c.json({ error: "filter must be deleted, published, or failed" }, 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  let query = supabase
    .from("content_assets")
    .select("id, content_type, target_platform, generated_body, status, created_at, deleted_at, published_at")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });

  if (filter === "deleted") {
    query = query.not("deleted_at", "is", null);
  } else if (filter === "published") {
    query = query.eq("status", "published").is("deleted_at", null);
  } else {
    query = query.eq("status", "failed").is("deleted_at", null);
  }

  const { data, error } = await query;

  if (error) {
    log.error("[marketing-content] archive_list_failed", {
      business_id: business.id,
      filter,
      err: error.message,
    });
    return c.json({ error: "Failed to load archive" }, 500);
  }

  return c.json({ items: data ?? [], filter });
});

// ── POST /:slug/marketing/content-assets/:id/restore ─────────────────────────
// Restores a deleted or failed card back to the active queue.
//   Deleted rows : clears deleted_at (preserves existing status)
//   Failed rows  : resets status → draft, clears deleted_at if also soft-deleted

app.post("/:slug/marketing/content-assets/:id/restore", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id   = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id, status, deleted_at")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] restore_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (asset.deleted_at)          patch.deleted_at = null;
  if (asset.status === "failed") patch.status     = "draft";

  if (!Object.keys(patch).length) {
    return c.json({ error: "Asset is already active" }, 400);
  }

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update(patch)
    .eq("id", id);

  if (updateErr) {
    log.error("[marketing-content] restore_failed", { id, err: updateErr.message });
    return c.json({ error: "Failed to restore" }, 500);
  }

  log.info("[marketing-content] restored", { business_id: business.id, id });
  return c.json({ ok: true, id });
});

// ── POST /:slug/marketing/content-assets/:id/republish ───────────────────────
// Creates a NEW draft copy of a published post. The source row is NOT modified.
// Returns { ok, source_id, new_id } so the caller can verify the copy was made.

app.post("/:slug/marketing/content-assets/:id/republish", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id   = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: source, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id, status, generated_body, target_platform, content_type")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] republish_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!source) return c.json({ error: "Content asset not found" }, 404);
  if (source.status !== "published") {
    return c.json({ error: "Only published posts can be republished" }, 400);
  }

  const { data: newRow, error: insertErr } = await supabase
    .from("content_assets")
    .insert({
      business_id:    business.id,
      content_type:   source.content_type,
      target_platform: source.target_platform,
      generated_body: source.generated_body,
      status:         "draft",
      source_asset_id: source.id,
    })
    .select("id")
    .single();

  if (insertErr) {
    log.error("[marketing-content] republish_insert_failed", { id, err: insertErr.message });
    return c.json({ error: "Failed to create draft copy" }, 500);
  }

  log.info("[marketing-content] republished", {
    business_id: business.id,
    source_id: id,
    new_id: newRow.id,
  });

  return c.json({ ok: true, source_id: id, new_id: newRow.id });
});

// ── DELETE /:slug/marketing/content-assets/:id ───────────────────────────────
// Soft-delete: stamps deleted_at = now(). Row stays in DB; query filter excludes it.

app.delete("/:slug/marketing/content-assets/:id", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id   = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] delete_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const { error: delErr } = await supabase
    .from("content_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (delErr) {
    log.error("[marketing-content] delete_failed", { id, err: delErr.message });
    return c.json({ error: "Failed to delete" }, 500);
  }

  log.info("[marketing-content] soft_deleted", { business_id: business.id, id });
  return c.json({ ok: true, id });
});

// ── POST /:slug/marketing/content-assets/:id/generate-hook ───────────────────
// Accepts { content: string }, extracts the opener (~first sentence or 15 words),
// and rewrites it into a sharper social hook via LLM.
// Returns { hook: string, original_opener: string }.

app.post("/:slug/marketing/content-assets/:id/generate-hook", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { content?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "Provide a non-empty 'content' string" }, 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] hook_asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  // Extract opener: first sentence (≤20 words) or first 15 words as fallback
  const content = body.content.trim();
  const sentenceMatch = content.match(/^[^.!?]*[.!?]/);
  const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : null;
  const words = content.split(/\s+/);
  const fifteenWords = words.slice(0, 15).join(" ");
  const original_opener =
    firstSentence && firstSentence.split(/\s+/).length <= 20
      ? firstSentence
      : fifteenWords;

  const [models, featureConfig] = await Promise.all([
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);
  const model = resolveFeatureModel("feature-hook-generator", featureConfig, models);

  const anthropic = createAnthropicClient(c.env);
  const completion = await anthropic.messages.create({
    model,
    max_tokens: 120,
    system:
      "You are a social media copywriter. Rewrite the given opening into a sharper, more compelling hook for Bluesky. Stay under 15 words. Return ONLY the rewritten hook — no explanations, no quotes.",
    messages: [
      {
        role: "user",
        content: `Opening: ${original_opener}\n\nRewrite into a sharper hook (max 15 words):`,
      },
    ],
  });

  const block = completion.content[0];
  const hook = block.type === "text" ? block.text.trim() : "";

  log.info("[marketing-content] hook_generated", {
    business_id: business.id,
    asset_id: id,
    model,
  });

  return c.json({ hook, original_opener });
});

// ── POST /:slug/marketing/content-assets/:id/shorten ─────────────────────────
// Accepts { content: string, limit: number }, rewrites the full post to fit
// within `limit` characters while preserving voice and key points.
// Returns { shortened: string }.

app.post("/:slug/marketing/content-assets/:id/shorten", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { content?: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "Provide a non-empty 'content' string" }, 400);
  }
  const limit = typeof body.limit === "number" ? body.limit : 300;

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] shorten_asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const [models, featureConfig] = await Promise.all([
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);
  const model = resolveFeatureModel("feature-shorten", featureConfig, models);

  const anthropic = createAnthropicClient(c.env);
  const completion = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system:
      "You are a social media editor. Rewrite the given post to fit within the character limit while preserving its voice, core message, and key points. Do not truncate or use ellipses — rewrite it to be genuinely shorter. Return ONLY the rewritten post, no explanation.",
    messages: [
      {
        role: "user",
        content: `Rewrite to fit within ${limit} characters:\n\n${body.content.trim()}`,
      },
    ],
  });

  const block = completion.content[0];
  const shortened = block.type === "text" ? block.text.trim() : "";

  log.info("[marketing-content] post_shortened", {
    business_id: business.id,
    asset_id: id,
    original_len: body.content.length,
    shortened_len: shortened.length,
    limit,
    model,
  });

  return c.json({ shortened });
});

// ── GET /:slug/marketing/schedule-overview ──────────────────────────────────
// Real-data feed for the Schedule "Morning Briefing" page. Counts & rhythm only
// — NO post content. Sections: momentum hero, effort pipeline, cadence health
// (rolling 7-day published vs the platform's parsed weekly target), next prime
// slot per platform (clean optimal time, NO jitter), and this-week scheduled
// lanes (tappable markers + open prime slots). Central (America/Chicago) tz.
app.get("/:slug/marketing/schedule-overview", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);
  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const pad = (n: number) => String(n).padStart(2, "0");
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const f12 = (h: number, mn: number) => `${h % 12 === 0 ? 12 : h % 12}:${pad(mn)}${h >= 12 ? "pm" : "am"}`;
  const f12short = (h: number, mn: number) => `${h % 12 === 0 ? 12 : h % 12}${mn ? ":" + pad(mn) : ""}${h >= 12 ? "p" : "a"}`;

  // Full Central parts for an instant.
  const cParts = (utcMs: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(utcMs)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    const y = +p.year, m = +p.month, d = +p.day;
    return { y, m, d, hour: +p.hour, min: +p.minute, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  };
  const wallToUTC = (y: number, m: number, d: number, hh: number, mm: number) => {
    const g = Date.UTC(y, m - 1, d, hh, mm, 0);
    return g - centralOffsetMs(g);
  };
  // Parse messy recommended_cadence text → weekly min/max. Prefer an explicit
  // "/week" clause; otherwise treat "/day" figures as ×7.
  const parseWeekly = (text: string | null): { min: number; max: number } | null => {
    if (!text) return null;
    const t = text.toLowerCase();
    const wk = t.match(/(\d+)\s*[–\-]?\s*(\d+)?\s*\/?\s*week/);
    if (wk) { const a = +wk[1], b = wk[2] ? +wk[2] : +wk[1]; return { min: Math.min(a, b), max: Math.max(a, b) }; }
    const dy = t.match(/(\d+)\s*[–\-]?\s*(\d+)?\s*\/?\s*day/);
    if (dy) { const a = +dy[1], b = dy[2] ? +dy[2] : +dy[1]; return { min: Math.min(a, b) * 7, max: Math.max(a, b) * 7 }; }
    return null;
  };

  // Connected publish targets — same source publishing uses.
  const { data: integ } = await supabase
    .from("business_integrations").select("config")
    .eq("business_id", business.id).eq("provider", "zernio").eq("is_active", true).maybeSingle();
  const accounts = (((integ as any)?.config?.accounts) ?? []) as Array<{ platform: string }>;
  const connected = Array.from(new Set(accounts.map((a) => (a.platform || "").toLowerCase()).filter(Boolean)));
  const inList = connected.length ? connected : ["__none__"];

  const { data: platRows } = await supabase
    .from("platforms").select("slug, display_name, recommended_cadence").in("slug", inList);
  const platBySlug: Record<string, any> = {};
  (platRows ?? []).forEach((p: any) => { platBySlug[p.slug] = p; });

  const { data: slotRows } = await supabase
    .from("optimal_slots").select("platform_slug, day_of_week, local_time, priority")
    .in("platform_slug", inList).eq("content_type", "post").eq("is_active", true);
  const slotsByPlat: Record<string, Array<{ dow: number; hh: number; mm: number; pr: number }>> = {};
  (slotRows ?? []).forEach((s: any) => {
    const dow = DOW.indexOf(s.day_of_week); if (dow < 0) return;
    const [hh, mm] = String(s.local_time).split(":").map(Number);
    (slotsByPlat[s.platform_slug] ||= []).push({ dow, hh, mm, pr: s.priority });
  });

  const { data: caRows } = await supabase
    .from("content_assets").select("id, status, target_platform, published_at, scheduled_for")
    .eq("business_id", business.id).is("deleted_at", null);
  const rows = (caRows ?? []) as Array<any>;
  const platOf = (r: any) => (r.target_platform ?? "").toLowerCase();

  // Timezone-aware boundaries (Central).
  const nowMs = Date.now();
  const startOfToday = centralDayStartUTC(nowMs, 0);
  const tp = centralDateParts(nowMs);
  const cdow = new Date(Date.UTC(tp.y, tp.m - 1, tp.d)).getUTCDay();
  const startOfWeek = centralDayStartUTC(nowMs, (cdow + 6) % 7);
  const sevenAgo = nowMs - 7 * 86400000;
  const now = cParts(nowMs);

  // Hero + pipeline + rolling-7-day per-platform published.
  let today = 0, week = 0, allTime = 0;
  const pipeline = { draft: 0, approved: 0, scheduled: 0, published: 0 };
  const pub7: Record<string, number> = {};
  const draft7: Record<string, number> = {};
  for (const r of rows) {
    if (r.status === "published") {
      pipeline.published++; allTime++;
      const t = r.published_at ? Date.parse(r.published_at) : NaN;
      if (!isNaN(t)) {
        if (t >= startOfToday) today++;
        if (t >= startOfWeek) week++;
        if (t >= sevenAgo) pub7[platOf(r)] = (pub7[platOf(r)] || 0) + 1;
      }
    } else if (r.status === "draft") { pipeline.draft++; draft7[platOf(r)] = (draft7[platOf(r)] || 0) + 1; }
    else if (r.status === "approved") pipeline.approved++;
    else if (r.status === "scheduled") pipeline.scheduled++;
  }

  // Cadence health (rolling 7-day vs weekly target).
  const cadence = connected.map((s) => {
    const meta = platBySlug[s];
    const wk = parseWeekly(meta?.recommended_cadence ?? null);
    const count = pub7[s] || 0;
    let status = "unknown", behindBy = 0;
    if (wk) { if (count >= wk.min) status = "on"; else { status = "behind"; behindBy = wk.min - count; } }
    return {
      slug: s, name: meta?.display_name ?? s, count7d: count,
      min: wk?.min ?? null, max: wk?.max ?? null,
      rangeLabel: wk ? (wk.min === wk.max ? `${wk.min}` : `${wk.min}–${wk.max}`) : null,
      status, behindBy,
    };
  });

  // Next prime slot per platform (clean optimal time) + week-rhythm bars.
  const barOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  const nextSlots = connected.map((s) => {
    const slots = slotsByPlat[s] || [];
    let best: any = null;
    for (const sl of slots) {
      let daysAhead = (sl.dow - now.dow + 7) % 7;
      if (daysAhead === 0 && (sl.hh * 60 + sl.mm) <= now.hour * 60 + now.min + 2) daysAhead = 7;
      const utc = wallToUTC(now.y, now.m, now.d + daysAhead, sl.hh, sl.mm);
      if (!best || utc < best.utc || (utc === best.utc && sl.pr < best.pr)) best = { utc, pr: sl.pr };
    }
    const bars = barOrder.map((dow) => {
      const day = slots.filter((x) => x.dow === dow);
      if (!day.length) return { h: 0, pk: false };
      return { h: Math.max(...day.map((x) => 4 - x.pr)), pk: day.some((x) => x.pr === 1) };
    });
    let dowLabel: string | null = null, dateLabel: string | null = null, timeLabel: string | null = null;
    let isToday = false, nextBarIndex: number | null = null;
    if (best) {
      const f = cParts(best.utc);
      isToday = f.y === now.y && f.m === now.m && f.d === now.d;
      dowLabel = isToday ? "TODAY" : DOW[f.dow].toUpperCase();
      dateLabel = `${MONTHS[f.m - 1]} ${f.d}`;
      timeLabel = f12(f.hour, f.min);
      nextBarIndex = barOrder.indexOf(f.dow);
    }
    const meta = platBySlug[s];
    return {
      slug: s, name: meta?.display_name ?? s, cadenceLabel: meta?.recommended_cadence ?? null,
      dowLabel, dateLabel, timeLabel, isToday, bars, nextBarIndex, draftsReady: draft7[s] || 0,
    };
  });

  // This-week scheduled lanes (Mon..Sun Central).
  const dayHeaders: Array<{ dow: string; d: number; isToday: boolean; dowNum: number }> = [];
  for (let i = 0; i < 7; i++) {
    const dp = cParts(startOfWeek + i * 86400000 + 6 * 3600000); // noon-ish guards DST
    dayHeaders.push({ dow: DOW[dp.dow], d: dp.d, dowNum: dp.dow, isToday: dp.y === now.y && dp.m === now.m && dp.d === now.d });
  }
  const sched = rows.filter((r) => r.status === "scheduled" && r.scheduled_for);
  const laneDayIndex = (utcMs: number) => { const p = cParts(utcMs); return dayHeaders.findIndex((h) => h.d === p.d); };
  const isPrimeAt = (s: string, utcMs: number) => {
    const p = cParts(utcMs); const mins = p.hour * 60 + p.min;
    return (slotsByPlat[s] || []).some((sl) => sl.dow === p.dow && Math.abs(sl.hh * 60 + sl.mm - mins) <= 90);
  };
  const lanes = connected.map((s) => {
    const cells = dayHeaders.map((h, di) => {
      const markers = sched
        .filter((r) => platOf(r) === s && laneDayIndex(Date.parse(r.scheduled_for)) === di)
        .map((r) => {
          const ms = Date.parse(r.scheduled_for); const p = cParts(ms);
          return {
            id: r.id, time: f12short(p.hour, p.min), isPrime: isPrimeAt(s, ms),
            scheduledForLocal: `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hour)}:${pad(p.min)}`,
            whenLabel: `${DOW[p.dow]}, ${MONTHS[p.m - 1]} ${p.d} · ${f12(p.hour, p.min)}`,
          };
        });
      const hasPrime = (slotsByPlat[s] || []).some((sl) => sl.dow === h.dowNum);
      return { markers, openPrime: hasPrime && markers.length === 0 };
    });
    return { slug: s, name: platBySlug[s]?.display_name ?? s, cells };
  });

  // Lifecycle — SINGLE source of truth for empty/partial/full across all tabs.
  // EMPTY: no output/timing to show (drafts may exist; they shift CTA not state).
  // FULL: >= 4 distinct active weeks. PARTIAL: some data, below that bar.
  const pubWeeks = new Set<string>();
  for (const r of rows) {
    if (r.status === "published" && r.published_at) {
      const p = cParts(Date.parse(r.published_at));
      const back = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
      const ws = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
      pubWeeks.add(`${ws.getUTCFullYear()}-${ws.getUTCMonth() + 1}-${ws.getUTCDate()}`);
    }
  }
  const weeksActive = pubWeeks.size;
  const lifecycle = {
    state: pipeline.published === 0 && pipeline.scheduled === 0 ? "empty" : weeksActive >= 4 ? "full" : "partial",
    connectedCount: connected.length,
    draftCount: pipeline.draft,
    publishedCount: pipeline.published,
    scheduledCount: pipeline.scheduled,
    weeksActive,
  };

  return c.json({ hero: { today, week, allTime }, pipeline, cadence, nextSlots, lanes, dayHeaders, connectedCount: connected.length, lifecycle });
});

// ── GET /:slug/marketing/schedule-history?ym=YYYY-MM ────────────────────────
// Feeds the Month + All-time Schedule tabs. Real data only, counts/rhythm — NO
// post content. Month: per-day published/scheduled + per-platform split, hero
// stats, per-platform weekly rhythm. All-time: auto early/full state by history
// depth (weeks active), with real milestone progress for the early state.
app.get("/:slug/marketing/schedule-history", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);
  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const pad = (n: number) => String(n).padStart(2, "0");
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const cP = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, min: +p.minute };
  };
  const dateKey = (ms: number) => { const p = cP(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const dowOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekKeyOf = (y: number, m: number, d: number) => {
    const back = (dowOf(y, m, d) + 6) % 7;            // days since Monday
    const ws = new Date(Date.UTC(y, m - 1, d - back));
    return `${ws.getUTCFullYear()}-${pad(ws.getUTCMonth() + 1)}-${pad(ws.getUTCDate())}`;
  };
  const weekKeyOfKey = (key: string) => { const [yy, mm, dd] = key.split("-").map(Number); return weekKeyOf(yy, mm, dd); };
  const f12 = (h: number, mn: number) => `${h % 12 === 0 ? 12 : h % 12}:${pad(mn)}${h >= 12 ? "pm" : "am"}`;

  // Connected platforms + display names.
  const { data: integ } = await supabase
    .from("business_integrations").select("config")
    .eq("business_id", business.id).eq("provider", "zernio").eq("is_active", true).maybeSingle();
  const accounts = (((integ as any)?.config?.accounts) ?? []) as Array<{ platform: string }>;
  const connected = Array.from(new Set(accounts.map((a) => (a.platform || "").toLowerCase()).filter(Boolean)));
  const { data: platRows } = await supabase
    .from("platforms").select("slug, display_name").in("slug", connected.length ? connected : ["__none__"]);
  const nameOf: Record<string, string> = {};
  (platRows ?? []).forEach((p: any) => { nameOf[p.slug] = p.display_name; });

  const { data: caRows } = await supabase
    .from("content_assets").select("status, target_platform, published_at, scheduled_for")
    .eq("business_id", business.id).is("deleted_at", null);
  const rows = (caRows ?? []) as Array<any>;
  const platOf = (r: any) => (r.target_platform ?? "").toLowerCase();

  const nowMs = Date.now();
  const now = cP(nowMs);
  const todayKey = dateKey(nowMs);

  // Published / scheduled events with Central date keys.
  type Ev = { key: string; plat: string; ms: number; status: string };
  const events: Ev[] = [];
  for (const r of rows) {
    if (r.status === "published" && r.published_at) events.push({ key: dateKey(Date.parse(r.published_at)), plat: platOf(r), ms: Date.parse(r.published_at), status: "published" });
    else if (r.status === "scheduled" && r.scheduled_for) events.push({ key: dateKey(Date.parse(r.scheduled_for)), plat: platOf(r), ms: Date.parse(r.scheduled_for), status: "scheduled" });
  }

  // ===== MONTH =====
  const ym = c.req.query("ym");
  let mY = now.y, mM = now.m;
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { mY = +ym.slice(0, 4); mM = +ym.slice(5, 7); }
  const daysInMonth = new Date(Date.UTC(mY, mM, 0)).getUTCDate();
  const firstDow = dowOf(mY, mM, 1);
  const leadPad = (firstDow + 6) % 7;                 // Monday-first grid

  const monthDays = [];
  let monthPublished = 0, monthScheduled = 0;
  const monthActiveDays = new Set<string>();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${mY}-${pad(mM)}-${pad(d)}`;
    const evs = events.filter((e) => e.key === key);
    const published = evs.filter((e) => e.status === "published").length;
    const scheduled = evs.filter((e) => e.status === "scheduled").length;
    const byPlatform: Record<string, { published: number; scheduled: number }> = {};
    for (const e of evs) {
      (byPlatform[e.plat] ||= { published: 0, scheduled: 0 });
      if (e.status === "published") byPlatform[e.plat].published++; else byPlatform[e.plat].scheduled++;
    }
    const times = evs.map((e) => { const p = cP(e.ms); return { plat: e.plat, name: nameOf[e.plat] ?? e.plat, time: f12(p.hour, p.min), status: e.status }; })
      .sort((a, b) => a.time.localeCompare(b.time));
    if (published > 0) { monthPublished += published; monthActiveDays.add(key); }
    monthScheduled += scheduled;
    monthDays.push({
      date: key, dom: d, dow: dowOf(mY, mM, d), published, scheduled, byPlatform, times,
      isToday: key === todayKey, isPast: key < todayKey, isFuture: key > todayKey,
    });
  }
  const avgPerActiveDay = monthActiveDays.size ? +(monthPublished / monthActiveDays.size).toFixed(1) : 0;
  // First active day this month (for "started …" note).
  const monthActiveSorted = [...monthActiveDays].sort();
  const startedNote = monthActiveSorted.length ? (() => { const [yy, mm, dd] = monthActiveSorted[0].split("-").map(Number); return `${MONTHS[mm - 1]} ${dd}`; })() : null;

  // Per-platform month rhythm: published per week-of-month + this-month total.
  const monthWeekStarts = Array.from(new Set(Array.from({ length: daysInMonth }, (_, i) => weekKeyOf(mY, mM, i + 1)))).sort();
  const monthCadence = connected.map((s) => {
    const buckets = monthWeekStarts.map((wk) => events.filter((e) => e.status === "published" && e.plat === s && weekKeyOfKey(e.key) === wk).length);
    const total = events.filter((e) => e.status === "published" && e.plat === s && e.key.startsWith(`${mY}-${pad(mM)}`)).length;
    return { slug: s, name: nameOf[s] ?? s, total, weeks: buckets };
  });
  // on-pace count (rolling 7-day vs target) — reuse the simple read for the hero.
  const sevenAgo = nowMs - 7 * 86400000;
  const pub7: Record<string, number> = {};
  events.forEach((e) => { if (e.status === "published" && e.ms >= sevenAgo) pub7[e.plat] = (pub7[e.plat] || 0) + 1; });

  // ===== ALL-TIME =====
  const pubEvents = events.filter((e) => e.status === "published");
  const perPlatform = connected.map((s) => ({ slug: s, name: nameOf[s] ?? s, count: pubEvents.filter((e) => e.plat === s).length }))
    .sort((a, b) => b.count - a.count);
  const activeDayKeys = [...new Set(pubEvents.map((e) => e.key))].sort();
  const totalPublished = pubEvents.length;

  // Weekly published buckets (chronological) for the growth view.
  const weekCounts: Record<string, number> = {};
  pubEvents.forEach((e) => { const [yy, mm, dd] = e.key.split("-").map(Number); const wk = weekKeyOf(yy, mm, dd); weekCounts[wk] = (weekCounts[wk] || 0) + 1; });
  const weekKeys = Object.keys(weekCounts).sort();
  const weekly = weekKeys.map((w) => ({ weekStart: w, count: weekCounts[w] }));
  const weeksActive = weekKeys.length;

  // Longest run of consecutive active weeks (week starts 7 days apart).
  let longestWeekStreak = 0, run = 0; let prev: number | null = null;
  for (const w of weekKeys) {
    const [yy, mm, dd] = w.split("-").map(Number); const ms = Date.UTC(yy, mm - 1, dd);
    if (prev !== null && ms - prev === 7 * 86400000) run++; else run = 1;
    prev = ms; if (run > longestWeekStreak) longestWeekStreak = run;
  }
  // Current consecutive-day streak ending at the most recent active day.
  let currentStreakDays = 0;
  if (activeDayKeys.length) {
    let cursor = activeDayKeys[activeDayKeys.length - 1];
    const set = new Set(activeDayKeys);
    while (set.has(cursor)) {
      currentStreakDays++;
      const [yy, mm, dd] = cursor.split("-").map(Number);
      const prevMs = Date.UTC(yy, mm - 1, dd) - 86400000; const pp = new Date(prevMs);
      cursor = `${pp.getUTCFullYear()}-${pad(pp.getUTCMonth() + 1)}-${pad(pp.getUTCDate())}`;
    }
  }
  // Days since first publish (for "first full month" milestone).
  let daysSinceFirst = 0;
  if (activeDayKeys.length) {
    const [yy, mm, dd] = activeDayKeys[0].split("-").map(Number);
    daysSinceFirst = Math.max(1, Math.round((Date.UTC(now.y, now.m - 1, now.d) - Date.UTC(yy, mm - 1, dd)) / 86400000) + 1);
  }
  const state = weeksActive >= 4 ? "full" : "early";
  const allTime = {
    state,
    totals: { published: totalPublished, daysActive: activeDayKeys.length, currentStreakDays, platformCount: perPlatform.filter((p) => p.count > 0).length || connected.length },
    perPlatform, weekly, weeksActive, longestWeekStreak,
    milestones: {
      posts: { n: Math.min(totalPublished, 50), goal: 50 },
      firstMonth: { n: Math.min(daysSinceFirst, 30), goal: 30 },
      weekStreak: { n: Math.min(longestWeekStreak, 4), goal: 4 },
    },
  };

  return c.json({
    month: {
      year: mY, month: mM, label: `${MONTHS[mM - 1]} ${mY}`, leadPad, daysInMonth,
      hero: {
        published: monthPublished, scheduled: monthScheduled, avgPerActiveDay,
        onPaceCount: connected.filter((s) => (pub7[s] || 0) > 0).length, platformCount: connected.length,
      },
      days: monthDays, cadence: monthCadence, startedNote,
      prevYm: mM === 1 ? `${mY - 1}-12` : `${mY}-${pad(mM - 1)}`,
      nextYm: mM === 12 ? `${mY + 1}-01` : `${mY}-${pad(mM + 1)}`,
    },
    allTime,
    connectedCount: connected.length,
  });
});

export default app;

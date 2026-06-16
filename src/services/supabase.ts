import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TaskRow {
  id: string;
  slug: string;
  name: string;
  description_short: string | null;
  description_long: string | null;
  area:
    | "business_builder"
    | "daycycle"
    | "personal_website"
    | "public_business_website"
    | "business_manager";
  is_default: boolean;
  plan_required: "free" | "core_paid" | "premium_only" | "premium_inactive";
  visibility:
    | "hidden"
    | "teaser_locked"
    | "fully_locked"
    | "always_visible";
  price_cents: number;
  token_cost: number;
  prompt_template: string | null;
  output_type:
    | "document"
    | "configured"
    | "structured_data"
    | "image"
    | "image_set"
    | "video";
  inputs_required: Record<string, unknown> | null;
  status: "draft" | "active" | "deprecated";
  kind: "manual" | "system" | "scheduled";
  config_page_path: string | null;
  lifecycle_phase_id: string | null;
  is_regeneratable: boolean;
  asset_user_editable: boolean;
  // Admin flag — marks tasks that can be triggered / configured via
  // inbound text (Telegram, SMS, etc.). V1: metadata only; consumer
  // wiring lands in a later phase.
  text_controllable: boolean;
  // Present-tense verb shown in the first-build overlay while the task
  // runs (e.g. "Researching the market…"). DB-driven so adding a task
  // doesn't require a code change. Nullable for tasks that don't surface
  // a custom verb (frontend falls back to task.name).
  progress_verb: string | null;
}

// Columns selected for any task row read. Kept as a constant so the
// run endpoint, catalog endpoint, and business-tasks endpoint all stay
// in sync without drifting.
export const TASK_SELECT_COLUMNS =
  "id, slug, name, description_short, description_long, area, is_default, " +
  "plan_required, visibility, price_cents, token_cost, prompt_template, " +
  "output_type, inputs_required, status, kind, config_page_path, " +
  "lifecycle_phase_id, is_regeneratable, asset_user_editable, text_controllable, " +
  "progress_verb";

export async function getTaskBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<TaskRow | null> {
  const { data, error } = await client
    .from("tasks")
    .select(TASK_SELECT_COLUMNS)
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw error;
  return (data as TaskRow | null) ?? null;
}

export interface UserRow {
  id: string;
  email: string;
  handle: string | null;
  handle_confirmed_at: string | null;
  created_at: string;
}

/** Insert-or-no-op. Email is updated on conflict so renamed addresses sync. */
export async function upsertUser(
  client: SupabaseClient,
  user: { id: string; email: string },
): Promise<void> {
  const { error } = await client
    .from("users")
    .upsert(
      { id: user.id, email: user.email },
      { onConflict: "id", ignoreDuplicates: false },
    );
  if (error) throw error;
}

export async function getUserById(
  client: SupabaseClient,
  id: string,
): Promise<UserRow | null> {
  const { data, error } = await client
    .from("users")
    .select("id, email, handle, handle_confirmed_at, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as UserRow | null) ?? null;
}

export async function isHandleAvailable(
  client: SupabaseClient,
  handle: string,
): Promise<boolean> {
  // Case-insensitive check so "Rob" and "rob" are treated as the same handle.
  const { count, error } = await client
    .from("users")
    .select("*", { count: "exact", head: true })
    .ilike("handle", handle);
  if (error) throw error;
  return (count ?? 0) === 0;
}

/** Sets the user's handle and marks it as explicitly confirmed. */
export async function setUserHandle(
  client: SupabaseClient,
  user_id: string,
  handle: string,
): Promise<UserRow> {
  const { data, error } = await client
    .from("users")
    .update({ handle, handle_confirmed_at: new Date().toISOString() })
    .eq("id", user_id)
    .select("id, email, handle, handle_confirmed_at, created_at")
    .single();
  if (error) throw error;
  return data as UserRow;
}

export interface SubscriptionPlanRow {
  id: string;
  slug: string;
  name: string;
  monthly_cents: number;
  one_time_cents: number;
  business_quota: number;
  includes_premium_tasks: boolean;
  is_grandfathered: boolean;
  cohort_limit: number | null;
  is_active: boolean;
}

export async function getActivePlans(
  client: SupabaseClient,
): Promise<SubscriptionPlanRow[]> {
  const { data, error } = await client
    .from("subscription_plans")
    .select("*")
    .eq("is_active", true)
    .order("monthly_cents", { ascending: true });

  if (error) throw error;
  return (data as SubscriptionPlanRow[]) ?? [];
}

// ── business_context ──────────────────────────────────────────────────

export interface BusinessContextRow {
  id: string;
  business_id: string;
  user_id: string;
  // User research
  user_profile: Record<string, unknown>;
  user_research_log: unknown[];
  // Business research
  business_summary: string | null;
  industry: string | null;
  business_model: string | null;
  target_customer: Record<string, unknown>;
  value_proposition: string | null;
  // Market intelligence
  market_size: Record<string, unknown>;
  competitors: unknown[];
  market_trends: unknown[];
  // Strategic positioning
  positioning_statement: string | null;
  brand_voice: string | null;
  key_differentiators: unknown[];
  // Operational signals (V2)
  financial_snapshot: Record<string, unknown>;
  customer_signals: Record<string, unknown>;
  // Agent follow-up
  open_questions: unknown[];
  // Agent identity
  agent_name: string | null;
  // Telegram (V1 schema-ready, integration Sprint 8)
  telegram_chat_id: string | null;
  // Provenance
  last_research_run_at: string | null;
  research_confidence_score: number;
  created_at: string;
  updated_at: string;
}

export async function getBusinessContext(
  client: SupabaseClient,
  businessId: string,
): Promise<BusinessContextRow | null> {
  const { data, error } = await client
    .from("business_context")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  return (data as BusinessContextRow | null) ?? null;
}

export async function upsertBusinessContext(
  client: SupabaseClient,
  ctx: Partial<BusinessContextRow> & { business_id: string; user_id: string },
): Promise<BusinessContextRow> {
  const { data, error } = await client
    .from("business_context")
    .upsert(ctx, { onConflict: "business_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data as BusinessContextRow;
}

export async function countBusinessContextByUser(
  client: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await client
    .from("business_context")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw error;
  return count ?? 0;
}

// ── businesses ────────────────────────────────────────────────────────

export interface BusinessRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  kind: "new_idea" | "find_for_me" | "existing";
  existing_business_url: string | null;
  existing_business_data: Record<string, unknown> | null;
  created_at: string;
}

export async function getBusinessesByUser(
  client: SupabaseClient,
  userId: string,
): Promise<(BusinessRow & { has_context: boolean })[]> {
  const { data: businesses, error } = await client
    .from("businesses")
    .select("id, user_id, slug, name, kind, existing_business_url, created_at")
    .eq("user_id", userId)
    .eq("is_active", true) // hide soft-deleted / admin-deactivated rows
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!businesses || businesses.length === 0) return [];

  const { data: contexts, error: ctxError } = await client
    .from("business_context")
    .select("business_id")
    .eq("user_id", userId);

  if (ctxError) throw ctxError;

  const contextSet = new Set(
    (contexts ?? []).map((c: { business_id: string }) => c.business_id),
  );

  return (businesses as BusinessRow[]).map((b) => ({
    ...b,
    existing_business_data: null,
    has_context: contextSet.has(b.id),
  }));
}

export async function getBusinessBySlug(
  client: SupabaseClient,
  userId: string,
  slug: string,
): Promise<BusinessRow | null> {
  const { data, error } = await client
    .from("businesses")
    .select("*")
    .eq("user_id", userId)
    .eq("slug", slug)
    .eq("is_active", true) // deactivated business → treated as not found for user paths
    .maybeSingle();

  if (error) throw error;
  return (data as BusinessRow | null) ?? null;
}

export async function createBusiness(
  client: SupabaseClient,
  payload: {
    user_id: string;
    slug: string;
    name: string;
    kind: "new_idea" | "find_for_me" | "existing";
    existing_business_url?: string;
    existing_business_data?: Record<string, unknown>;
  },
): Promise<BusinessRow> {
  const { data, error } = await client
    .from("businesses")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data as BusinessRow;
}

export async function createEmptyBusinessContext(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  agentName?: string,
): Promise<void> {
  console.log(`[createEmptyBusinessContext] businessId=${businessId} agentName="${agentName}"`);
  // UPSERT so a pre-existing row (e.g. created by a DB trigger) gets agent_name
  // set rather than causing an INSERT conflict that silently drops the name.
  const { data, error } = await client
    .from("business_context")
    .upsert(
      { business_id: businessId, user_id: userId, agent_name: agentName ?? null },
      { onConflict: "business_id" },
    )
    .select("agent_name")
    .single();
  console.log(`[createEmptyBusinessContext] saved agent_name="${data?.agent_name}" error=${error ? JSON.stringify(error) : "none"}`);
  if (error) throw error;
}

export async function setAgentName(
  client: SupabaseClient,
  businessId: string,
  agentName: string,
): Promise<void> {
  const { error } = await client
    .from("business_context")
    .update({ agent_name: agentName })
    .eq("business_id", businessId);
  if (error) throw error;
}

export async function countUserBusinesses(
  client: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await client
    .from("businesses")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true); // quota only counts active businesses

  if (error) throw error;
  return count ?? 0;
}

export async function getUserSubscriptionPlan(
  client: SupabaseClient,
  userId: string,
): Promise<SubscriptionPlanRow | null> {
  const { data: sub, error: subError } = await client
    .from("user_subscriptions")
    .select("plan_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (subError) throw subError;
  if (!sub) return null;

  const { data: plan, error: planError } = await client
    .from("subscription_plans")
    .select("*")
    .eq("id", (sub as { plan_id: string }).plan_id)
    .single();

  if (planError) throw planError;
  return plan as SubscriptionPlanRow;
}

// ── task_runs ─────────────────────────────────────────────────────────

export interface TaskRunRow {
  id: string;
  user_id: string;
  business_id: string | null;
  task_id: string;
  status: "queued" | "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  output_data: Record<string, unknown> | null;
  paid_amount_cents: number;
  error: string | null;
}

export async function getTaskRunsForBusiness(
  client: SupabaseClient,
  businessId: string,
): Promise<TaskRunRow[]> {
  const { data, error } = await client
    .from("task_runs")
    .select(
      "id, user_id, business_id, task_id, status, started_at, completed_at, output_data, paid_amount_cents, error",
    )
    .eq("business_id", businessId)
    .order("started_at", { ascending: false });

  if (error) throw error;
  return (data as TaskRunRow[]) ?? [];
}

export async function getAllActiveTasks(
  client: SupabaseClient,
): Promise<TaskRow[]> {
  const { data, error } = await client
    .from("tasks")
    .select(TASK_SELECT_COLUMNS)
    .eq("status", "active");

  if (error) throw error;
  return (data as TaskRow[]) ?? [];
}

// ── playbook + playbook_runs (generalize the retired free_build_runs) ───
// playbook_runs is the thin execution header. It carries NO task counters —
// completed-count is derived from task_runs (run_id = playbook_run.id).

export interface PlaybookRunRow {
  id: string;
  playbook_id: string;
  business_id: string;
  user_id: string;
  status: "pending" | "running" | "completed" | "failed";
  last_heartbeat_at: string | null;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
}

// Find-or-create the business's default "Free Build" playbook. The free
// build IS the first playbook, so its run attaches here (decision: Option
// b). Stable identity: one playbook per business named 'Free Build'.
const FREE_BUILD_PLAYBOOK_NAME = "Free Build";

export async function getOrCreateFreeBuildPlaybook(
  client: SupabaseClient,
  businessId: string,
): Promise<string> {
  const existing = await client
    .from("playbook")
    .select("id")
    .eq("business_id", businessId)
    .eq("name", FREE_BUILD_PLAYBOOK_NAME)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) return existing.data.id as string;

  const created = await client
    .from("playbook")
    .insert({ business_id: businessId, name: FREE_BUILD_PLAYBOOK_NAME, status: "active" })
    .select("id")
    .single();
  if (created.error) throw created.error;
  return (created.data as { id: string }).id;
}

export async function getPlaybookRunByBusiness(
  client: SupabaseClient,
  businessId: string,
): Promise<PlaybookRunRow | null> {
  const { data, error } = await client
    .from("playbook_runs")
    .select("*")
    .eq("business_id", businessId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as PlaybookRunRow | null) ?? null;
}

export async function createPlaybookRun(
  client: SupabaseClient,
  payload: { playbook_id: string; business_id: string; user_id: string },
): Promise<PlaybookRunRow> {
  const { data, error } = await client
    .from("playbook_runs")
    .insert({ ...payload, status: "pending" })
    .select("*")
    .single();
  if (error) throw error;
  return data as PlaybookRunRow;
}

export async function updatePlaybookRun(
  client: SupabaseClient,
  runId: string,
  updates: Partial<Pick<PlaybookRunRow, "status" | "last_heartbeat_at" | "completed_at" | "failed_at" | "failure_reason">>,
): Promise<void> {
  const { error } = await client
    .from("playbook_runs")
    .update(updates)
    .eq("id", runId);
  if (error) throw error;
}

// ── stream_events ─────────────────────────────────────────────────────

export async function persistStreamEvent(
  client: SupabaseClient,
  runId: string,
  businessId: string,
  seq: number,
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("stream_events").insert({
    run_id: runId,
    business_id: businessId,
    seq,
    event_type: eventType,
    event_data: eventData,
  });
  if (error) {
    // Non-fatal — log but don't crash the stream
    console.error("[stream_events] persist failed:", error.message);
  }
}

export async function getStreamEventsForRun(
  client: SupabaseClient,
  runId: string,
): Promise<Array<{ seq: number; event_type: string; event_data: Record<string, unknown> }>> {
  const { data, error } = await client
    .from("stream_events")
    .select("seq, event_type, event_data")
    .eq("run_id", runId)
    .order("seq", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<{ seq: number; event_type: string; event_data: Record<string, unknown> }>;
}

// ── task_run CRUD (used by orchestrator) ─────────────────────────────

export async function createTaskRunForBuild(
  client: SupabaseClient,
  payload: {
    user_id: string;
    business_id: string;
    task_id: string;
    run_id?: string | null;
  },
): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("task_runs")
    .insert({
      ...payload,
      status: "running",
      state: "running",
      started_at: now,
      proposed_at: now,
      work_log: [],
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function completeTaskRun(
  client: SupabaseClient,
  id: string,
  outputData: Record<string, unknown>,
): Promise<void> {
  const { error } = await client
    .from("task_runs")
    .update({
      status: "completed",
      state: "complete",
      completed_at: new Date().toISOString(),
      output_data: outputData,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function failTaskRun(
  client: SupabaseClient,
  id: string,
  message: string,
): Promise<void> {
  const { error } = await client
    .from("task_runs")
    .update({
      status: "failed",
      state: "failed",
      failed_at: new Date().toISOString(),
      error: message,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function getCompletedTaskRunSlugs(
  client: SupabaseClient,
  businessId: string,
): Promise<Set<string>> {
  // Returns slugs of tasks that already have a completed run for this business
  const { data, error } = await client
    .from("task_runs")
    .select("task_id")
    .eq("business_id", businessId)
    .eq("status", "completed");
  if (error || !data || data.length === 0) return new Set();

  const taskIds = (data as { task_id: string }[]).map((r) => r.task_id);

  const { data: tasks, error: te } = await client
    .from("tasks")
    .select("slug")
    .in("id", taskIds);
  if (te || !tasks) return new Set();

  return new Set((tasks as { slug: string }[]).map((t) => t.slug));
}

// ── Templated 90-day plan ───────────────────────────────────────────────────
// New businesses get NO plan row, so the Victora campfire HALTS (NO-FALLBACKS:
// playbook.astro requires an active plan + start_date). This creates the
// templated plan (plan + 3 plan_phase) seeded from the existing lifecycle_phases
// (foundation/launch/scale). start_date = the business's created_at (date part).
// A NEW business is day 1 → Foundation 'active', Launch/Scale 'pending'.
//
// IDEMPOTENT: skips if an active plan already exists (re-entrant orchestrator,
// and protects Gaudet's hand-seeded plan). NO-FALLBACKS on inputs: throws if
// lifecycle_phases are missing or created_at is null — never a partial plan.
const PLAN_PHASE_TEMPLATE = [
  { slug: "foundation", name: "Foundation", sort_order: 1, start_day_offset: 1,  end_day_offset: 30, status: "active" },
  { slug: "launch",     name: "Launch",     sort_order: 2, start_day_offset: 31, end_day_offset: 60, status: "pending" },
  { slug: "scale",      name: "Scale",      sort_order: 3, start_day_offset: 61, end_day_offset: 90, status: "pending" },
] as const;

export async function ensureTemplatedPlan(
  client: SupabaseClient,
  business: { id: string; created_at?: string | null },
): Promise<{ created: boolean; planId: string }> {
  // Idempotency — never duplicate / overwrite an existing active plan.
  const { data: existing, error: exErr } = await client
    .from("plan")
    .select("id")
    .eq("business_id", business.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (exErr) throw new Error(`plan lookup failed: ${exErr.message}`);
  if (existing) return { created: false, planId: (existing as { id: string }).id };

  // start_date = business.created_at (date part). NO-FALLBACKS.
  let createdAt: string | null | undefined = business.created_at;
  if (!createdAt) {
    const { data: bizRow } = await client
      .from("businesses").select("created_at").eq("id", business.id).maybeSingle();
    createdAt = (bizRow as { created_at?: string } | null)?.created_at ?? null;
  }
  if (!createdAt) throw new Error(`cannot template plan: business ${business.id} has null created_at`);
  const startDate = String(createdAt).slice(0, 10); // YYYY-MM-DD

  // lifecycle_phases (foundation/launch/scale) — NO-FALLBACKS, all three required.
  const { data: lpRows, error: lpErr } = await client
    .from("lifecycle_phases").select("id, slug");
  if (lpErr) throw new Error(`lifecycle_phases lookup failed: ${lpErr.message}`);
  const lpBySlug: Record<string, string> = {};
  (lpRows as { id: string; slug: string }[] | null ?? []).forEach((r) => { lpBySlug[r.slug] = r.id; });
  for (const ph of PLAN_PHASE_TEMPLATE) {
    if (!lpBySlug[ph.slug]) throw new Error(`lifecycle_phase '${ph.slug}' missing — cannot template plan for business ${business.id}`);
  }

  // Insert the plan.
  const { data: planRow, error: planErr } = await client
    .from("plan")
    .insert({ business_id: business.id, name: "90-Day Operating Plan", horizon_days: 90, start_date: startDate, status: "active" })
    .select("id")
    .single();
  if (planErr || !planRow) throw new Error(`plan insert failed: ${planErr?.message ?? "no row"}`);
  const planId = (planRow as { id: string }).id;

  // Insert the 3 templated phases. If this fails, roll back the orphan plan so
  // we never leave a plan with no phases (partial = broken).
  const phaseRows = PLAN_PHASE_TEMPLATE.map((ph) => ({
    plan_id: planId,
    lifecycle_phase_id: lpBySlug[ph.slug],
    name: ph.name,
    sort_order: ph.sort_order,
    start_day_offset: ph.start_day_offset,
    end_day_offset: ph.end_day_offset,
    status: ph.status,
  }));
  const { error: phErr } = await client.from("plan_phase").insert(phaseRows);
  if (phErr) {
    await client.from("plan").delete().eq("id", planId).then(() => {}, () => {});
    throw new Error(`plan_phase insert failed: ${phErr.message}`);
  }

  return { created: true, planId };
}

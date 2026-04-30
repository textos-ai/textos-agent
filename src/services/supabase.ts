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
  prompt_template: string | null;
  output_type:
    | "document"
    | "dashboard_view"
    | "report"
    | "structured_data"
    | "generated_site";
  inputs_required: Record<string, unknown> | null;
  status: "draft" | "active" | "deprecated";
}

export async function getTaskBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<TaskRow | null> {
  const { data, error } = await client
    .from("tasks")
    .select(
      "id, slug, name, description_short, description_long, area, is_default, plan_required, visibility, price_cents, prompt_template, output_type, inputs_required, status",
    )
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
    .select("id, email, handle, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as UserRow | null) ?? null;
}

export async function isHandleAvailable(
  client: SupabaseClient,
  handle: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("handle", handle);
  if (error) throw error;
  return (count ?? 0) === 0;
}

export async function setUserHandle(
  client: SupabaseClient,
  user_id: string,
  handle: string,
): Promise<UserRow> {
  const { data, error } = await client
    .from("users")
    .update({ handle })
    .eq("id", user_id)
    .select("id, email, handle, created_at")
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

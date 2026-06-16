// ─────────────────────────────────────────────────────────────────────────────
// User profile aggregation — shared by `GET /api/users/me` (self) and
// `GET /admin/users/:id` (admin). DRY-extracted from users.ts so the two
// endpoints can never drift on response shape.
//
// Pricing posture for "spend": surface honest topup_spend_cents AND
// per-business subscription_status. Subscription-monthly totals would
// require Stripe invoice fetches (deferred to V1.1).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export interface UserProfile {
  id:         string;
  email:      string;
  name:       string | null;
  is_admin:   boolean;
  created_at: string;
  businesses: Array<{
    id:                       string;
    slug:                     string;
    name:                     string;
    created_at:               string;
    phase:                    string;
    subscription_status:          string | null;
    subscription_payment_source:  string | null;
    subscription_period_end:      string | null;
    period_tokens_remaining:      number;
    topup_tokens_remaining:       number;
    total_remaining:              number;
  }>;
  stats: {
    businesses_count:      number;
    total_tokens_consumed: number;
    topup_spend_cents:     number;
    tokens_per_task: Array<{
      task_slug:    string;
      task_name:    string;
      times_used:   number;
      total_tokens: number;
    }>;
    recent_transactions: Array<{
      kind:        string;
      tokens:      number;
      task_slug:   string | null;
      description: string | null;
      created_at:  string;
    }>;
  };
}

/**
 * Loads the full profile + stats for a single user. Used by both the
 * self-service endpoint (caller's own user_id) and the admin endpoint
 * (target user_id). Caller is responsible for any authorization gates;
 * this helper has no notion of who's asking.
 *
 * Returns `null` if the user row doesn't exist. Throws on any other DB error.
 */
export async function loadUserProfile(
  supabase: SupabaseClient,
  userId:   string,
): Promise<UserProfile | null> {
  // 1. Profile row
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, email, name, is_admin, created_at")
    .eq("id", userId)
    .maybeSingle();

  if (userErr) throw new Error(`user_lookup_failed: ${userErr.message}`);
  if (!user) return null;

  // 2. Parallel fan-out for the five big reads
  const [bizRes, debitsRes, recentRes, topupsRes, balancesRes] = await Promise.all([
    supabase
      .from("businesses")
      .select("id, slug, name, created_at, phase")
      .eq("user_id", userId)
      .eq("is_active", true) // user-facing profile — hide deactivated
      .order("created_at", { ascending: false }),
    supabase
      .from("token_transactions")
      .select("task_slug, tokens")
      .eq("user_id", userId)
      .like("kind", "debit_%"),
    supabase
      .from("token_transactions")
      .select("kind, tokens, task_slug, description, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("token_purchases")
      .select("amount_cents")
      .eq("user_id", userId)
      .eq("status", "succeeded"),
    supabase
      .from("token_balances")
      .select("business_id, period_tokens_included, period_tokens_used, topup_tokens_remaining")
      .eq("user_id", userId),
  ]);

  if (bizRes.error)      throw new Error(`businesses_lookup_failed: ${bizRes.error.message}`);
  if (debitsRes.error)   throw new Error(`debits_lookup_failed: ${debitsRes.error.message}`);
  if (recentRes.error)   throw new Error(`recent_lookup_failed: ${recentRes.error.message}`);
  if (topupsRes.error)   throw new Error(`topups_lookup_failed: ${topupsRes.error.message}`);
  // balances is non-fatal — businesses with no balance row default to zeros.
  const balanceByBiz = new Map<string, { period_remaining: number; topup_remaining: number }>();
  for (const row of (balancesRes.data ?? [])) {
    const periodIncluded = (row.period_tokens_included as number) ?? 0;
    const periodUsed     = (row.period_tokens_used as number) ?? 0;
    const topupRemain    = (row.topup_tokens_remaining as number) ?? 0;
    balanceByBiz.set(row.business_id as string, {
      period_remaining: Math.max(0, periodIncluded - periodUsed),
      topup_remaining:  topupRemain,
    });
  }

  // 3. Subscriptions for those businesses (skipped if none)
  const businessIds = (bizRes.data ?? []).map((b) => b.id as string);
  let subRows: Array<{ business_id: string; status: string; payment_source: string | null; current_period_end: string | null; created_at: string }> = [];
  if (businessIds.length > 0) {
    const { data: subs, error: subErr } = await supabase
      .from("business_subscriptions")
      .select("business_id, status, payment_source, current_period_end, created_at")
      .in("business_id", businessIds)
      .order("created_at", { ascending: false });
    // Non-fatal — businesses just show null subscription_status if this fails.
    if (!subErr) subRows = (subs ?? []) as typeof subRows;
  }

  // Pick best sub per business: prefer active/trialing, else most recent.
  const subByBiz = new Map<string, { status: string; payment_source: string | null; current_period_end: string | null }>();
  for (const sub of subRows) {
    const existing       = subByBiz.get(sub.business_id);
    const isActive       = sub.status === "active" || sub.status === "trialing";
    const existingActive = existing && (existing.status === "active" || existing.status === "trialing");
    const subVal = { status: sub.status, payment_source: sub.payment_source, current_period_end: sub.current_period_end };
    if (!existing) {
      subByBiz.set(sub.business_id, subVal);
    } else if (isActive && !existingActive) {
      subByBiz.set(sub.business_id, subVal);
    }
  }

  const businesses = (bizRes.data ?? []).map((b) => {
    const bal = balanceByBiz.get(b.id as string);
    const period_tokens_remaining = bal?.period_remaining ?? 0;
    const topup_tokens_remaining  = bal?.topup_remaining ?? 0;
    const sub = subByBiz.get(b.id as string);
    return {
      id:                           b.id as string,
      slug:                         b.slug as string,
      name:                         b.name as string,
      created_at:                   b.created_at as string,
      phase:                        b.phase as string,
      subscription_status:          sub?.status ?? null,
      subscription_payment_source:  sub?.payment_source ?? null,
      subscription_period_end:      sub?.current_period_end ?? null,
      period_tokens_remaining,
      topup_tokens_remaining,
      total_remaining:              period_tokens_remaining + topup_tokens_remaining,
    };
  });

  // 4. tokens_per_task aggregation in JS (cheap for V1 scale)
  const taskAgg = new Map<string, { times_used: number; total_tokens: number }>();
  let total_tokens_consumed = 0;

  for (const row of debitsRes.data ?? []) {
    const tokens = Math.abs(row.tokens as number);
    total_tokens_consumed += tokens;
    const slug = row.task_slug as string | null;
    if (!slug) continue;
    const existing = taskAgg.get(slug);
    if (existing) {
      existing.times_used   += 1;
      existing.total_tokens += tokens;
    } else {
      taskAgg.set(slug, { times_used: 1, total_tokens: tokens });
    }
  }

  // 5. Task names for the distinct slugs
  const slugs = Array.from(taskAgg.keys());
  const taskNameBySlug = new Map<string, string>();
  if (slugs.length > 0) {
    const { data: tasksData } = await supabase
      .from("tasks")
      .select("slug, name")
      .in("slug", slugs);
    for (const row of tasksData ?? []) {
      taskNameBySlug.set(row.slug as string, row.name as string);
    }
  }

  const tokens_per_task = Array.from(taskAgg.entries())
    .map(([task_slug, agg]) => ({
      task_slug,
      task_name:    taskNameBySlug.get(task_slug) ?? task_slug,
      times_used:   agg.times_used,
      total_tokens: agg.total_tokens,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const topup_spend_cents = (topupsRes.data ?? []).reduce(
    (acc, row) => acc + (row.amount_cents as number),
    0,
  );

  const recent_transactions = (recentRes.data ?? []).map((row) => ({
    kind:        row.kind as string,
    tokens:      row.tokens as number,
    task_slug:   row.task_slug as string | null,
    description: row.description as string | null,
    created_at:  row.created_at as string,
  }));

  return {
    id:         user.id as string,
    email:      user.email as string,
    name:       (user.name as string | null) ?? null,
    is_admin:   (user.is_admin as boolean) ?? false,
    created_at: user.created_at as string,
    businesses,
    stats: {
      businesses_count: businesses.length,
      total_tokens_consumed,
      topup_spend_cents,
      tokens_per_task,
      recent_transactions,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin list view — lighter-weight query, paginated, optional search.
// One row per user with minimal aggregate fields suitable for a table.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminUserListRow {
  id:                  string;
  email:               string;
  name:                string | null;
  is_admin:            boolean;
  created_at:          string;
  businesses_count:    number;
  subscription_status: string | null;  // most generous across user's businesses
}

export interface AdminUserListOpts {
  q?:         string;
  page?:      number;
  page_size?: number;
}

const STATUS_RANK: Record<string, number> = {
  active:     5,
  trialing:   4,
  past_due:   3,
  canceled:   2,
  expired:    1,
  incomplete: 0,
};

/** Pick the most generous status across a user's businesses. */
function mostGenerousStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  let best:     string | null = null;
  let bestRank = -1;
  for (const s of statuses) {
    const rank = STATUS_RANK[s] ?? -1;
    if (rank > bestRank) {
      best     = s;
      bestRank = rank;
    }
  }
  return best;
}

export async function listUsers(
  supabase: SupabaseClient,
  opts:     AdminUserListOpts = {},
): Promise<{ users: AdminUserListRow[]; total: number; page: number; page_size: number; has_more: boolean }> {
  const page      = Math.max(1, Math.floor(opts.page ?? 1));
  const page_size = Math.min(200, Math.max(1, Math.floor(opts.page_size ?? 50)));
  const from      = (page - 1) * page_size;
  const to        = from + page_size - 1;
  const q         = (opts.q ?? "").trim();

  // 1. Paginated users (with count for has_more / total)
  let query = supabase
    .from("users")
    .select("id, email, name, is_admin, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q) {
    // partial match on email OR name (case-insensitive). PostgREST `or` syntax.
    const escaped = q.replace(/[%,)]/g, "");  // strip chars that'd break the or-filter
    query = query.or(`email.ilike.%${escaped}%,name.ilike.%${escaped}%`);
  }

  const { data: users, count, error } = await query;
  if (error) throw new Error(`users_list_failed: ${error.message}`);

  const userIds = (users ?? []).map((u) => u.id as string);
  if (userIds.length === 0) {
    return { users: [], total: count ?? 0, page, page_size, has_more: false };
  }

  // 2. Businesses for those user ids (one query)
  const { data: bizRows, error: bizErr } = await supabase
    .from("businesses")
    .select("id, user_id")
    .in("user_id", userIds);
  if (bizErr) throw new Error(`businesses_for_users_failed: ${bizErr.message}`);

  const businessIdsByUser = new Map<string, string[]>();
  const userIdByBusiness  = new Map<string, string>();
  for (const b of bizRows ?? []) {
    const bid = b.id as string;
    const uid = b.user_id as string;
    if (!businessIdsByUser.has(uid)) businessIdsByUser.set(uid, []);
    businessIdsByUser.get(uid)!.push(bid);
    userIdByBusiness.set(bid, uid);
  }

  // 3. Subscriptions for all those businesses (one query)
  const allBusinessIds = Array.from(userIdByBusiness.keys());
  const statusByUser   = new Map<string, string[]>();
  if (allBusinessIds.length > 0) {
    const { data: subRows, error: subErr } = await supabase
      .from("business_subscriptions")
      .select("business_id, status")
      .in("business_id", allBusinessIds);
    if (!subErr) {
      for (const sub of subRows ?? []) {
        const uid = userIdByBusiness.get(sub.business_id as string);
        if (!uid) continue;
        if (!statusByUser.has(uid)) statusByUser.set(uid, []);
        statusByUser.get(uid)!.push(sub.status as string);
      }
    }
  }

  const rows: AdminUserListRow[] = (users ?? []).map((u) => ({
    id:                  u.id as string,
    email:               u.email as string,
    name:                (u.name as string | null) ?? null,
    is_admin:            (u.is_admin as boolean) ?? false,
    created_at:          u.created_at as string,
    businesses_count:    (businessIdsByUser.get(u.id as string) ?? []).length,
    subscription_status: mostGenerousStatus(statusByUser.get(u.id as string) ?? []),
  }));

  const total    = count ?? rows.length;
  const has_more = from + rows.length < total;

  return { users: rows, total, page, page_size, has_more };
}

import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { getBusinessBySlug } from "../services/supabase";
import { createAnthropicClient } from "../services/anthropic";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { MODEL_IDS } from "../agent/model-router";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

async function generateMorningLine(
  env: Env,
  businessName: string,
  agentName: string,
  mode: string,
  recentActivity: string[],
): Promise<string> {
  const client = createAnthropicClient(env);
  const activityStr =
    recentActivity.slice(0, 3).join(". ") || "things have been quiet since your last visit";

  const cruiseLine =
    `Write ONE sentence (~14 words) as the morning briefing for ${businessName}'s owner. ` +
    `You are ${agentName}, their operations director. Be specific and conversational — reference ` +
    `actual recent activity: ${activityStr}. ` +
    `Reference what happened and invite a decision. Example style: ` +
    `"Three replies came in overnight — want me to draft responses, or you taking these?"`;

  const chargeLine =
    `Write ONE sentence (~14 words) as the morning briefing for ${businessName}'s owner. ` +
    `You are ${agentName}. They are in CHARGE mode — be sharp and decision-forcing. ` +
    `Recent activity: ${activityStr}. ` +
    `Reference what happened and create urgency. Example style: ` +
    `"Three overnight replies. Every hour you wait, leads cool. Pick one to handle now."`;

  const prompt = mode === "charge" ? chargeLine : cruiseLine;

  try {
    const res = await client.messages.create({
      model: MODEL_IDS.haiku,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
    // Strip any surrounding quotes the model might add
    return text.replace(/^["']|["']$/g, "") || "Quiet morning. Want to talk through what's next?";
  } catch (err) {
    log.warn("morning_line_gen_failed", { err: String(err) });
    return "Quiet morning. Want to talk through what's next?";
  }
}

// ── GET /api/businesses/:slug/manage-data ─────────────────────────────────

app.get("/:slug/manage-data", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business: any;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("manage_data_biz_fetch", { err: String(err) });
    return c.json({ error: "internal" }, 500);
  }
  if (!business) return c.json({ error: "not_found", message: "Business not found" }, 404);

  const phase: string = (business as any).phase ?? "founding";
  const mode: string = (business as any).mode ?? "cruise";

  // Parallel fetches — graceful on missing tables
  const [ctxRes, goalsRes, lessonsRes, runsRes, milestonesRes, chargeRes] =
    await Promise.allSettled([
      supabase
        .from("business_context")
        .select("agent_name, business_summary, value_proposition")
        .eq("business_id", business.id)
        .maybeSingle(),
      supabase
        .from("business_goals")
        .select("id, label, goal_type, target_value, current_value, target_date, status")
        .eq("business_id", business.id)
        .eq("status", "active"),
      supabase
        .from("lessons")
        .select("id, phase, sequence, title, body")
        .eq("phase", phase)
        .eq("status", "active")
        .order("sequence", { ascending: true }),
      supabase
        .from("task_runs")
        .select("id, task_slug, status, completed_at, created_at, output_summary")
        .eq("business_id", business.id)
        .order("created_at", { ascending: false })
        .limit(25),
      supabase
        .from("milestones")
        .select("id, kind, label, occurred_at, highlight")
        .eq("business_id", business.id)
        .order("occurred_at", { ascending: false })
        .limit(10),
      mode === "charge"
        ? supabase
            .from("charge_windows")
            .select("*")
            .eq("business_id", business.id)
            .is("ended_at", null)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

  const ctx =
    ctxRes.status === "fulfilled" ? ((ctxRes.value as any).data as any) : null;
  const goalsRaw: any[] =
    goalsRes.status === "fulfilled" ? (((goalsRes.value as any).data as any[]) ?? []) : [];
  const lessonsRaw: any[] =
    lessonsRes.status === "fulfilled" ? (((lessonsRes.value as any).data as any[]) ?? []) : [];
  const runsRaw: any[] =
    runsRes.status === "fulfilled" ? (((runsRes.value as any).data as any[]) ?? []) : [];
  const milestonesRaw: any[] =
    milestonesRes.status === "fulfilled"
      ? (((milestonesRes.value as any).data as any[]) ?? [])
      : [];
  const chargeWindow =
    chargeRes.status === "fulfilled" ? ((chargeRes.value as any).data) : null;

  const agentName: string = ctx?.agent_name ?? "TextOS Agent";

  // ── Goals ──────────────────────────────────────────────────────────────
  const goals = goalsRaw.map((g) => ({
    id: g.id,
    label: g.label,
    target_value: Number(g.target_value),
    current_value: Number(g.current_value),
    goal_type: g.goal_type,
    target_date: g.target_date,
    pct:
      g.target_value > 0
        ? Math.min(100, Math.round((Number(g.current_value) / Number(g.target_value)) * 100))
        : 0,
  }));

  // ── Lesson (rotate daily by phase) ─────────────────────────────────────
  const dayIndex = Math.floor(Date.now() / 86400000);
  const lessonIndex = lessonsRaw.length > 0 ? dayIndex % lessonsRaw.length : 0;
  const lesson = lessonsRaw[lessonIndex] ?? null;

  // ── Morning line (KV-cached per business per day per mode) ─────────────
  const today = new Date().toISOString().slice(0, 10);
  const mlKey = `ml:${business.id}:${today}:${mode}`;
  let morningLine = await c.env.SNAPSHOT_KV.get(mlKey);
  if (!morningLine) {
    const recentActivity = runsRaw
      .filter((r) => r.status === "completed" && r.output_summary)
      .slice(0, 3)
      .map((r) => String(r.output_summary));
    morningLine = await generateMorningLine(
      c.env,
      business.name,
      agentName,
      mode,
      recentActivity,
    );
    await c.env.SNAPSHOT_KV.put(mlKey, morningLine, { expirationTtl: 21600 });
  }

  // ── Walk the floor ─────────────────────────────────────────────────────
  const now = Date.now();
  const activity = runsRaw
    .filter((r) => now - new Date(r.created_at || 0).getTime() < 3600000)
    .slice(0, 8)
    .map((r) => {
      const d = new Date(r.created_at);
      const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
      const text = r.output_summary || `${(r.task_slug as string).replace(/-/g, " ")} · ${r.status}`;
      return { ts: hm, text };
    });

  const completedSlugs = new Set(
    runsRaw.filter((r) => r.status === "completed").map((r) => r.task_slug as string),
  );
  const channels = [
    {
      name: "Cold outreach",
      status: completedSlugs.has("personalized-pitch-email") ? "live" : "paused",
      metric: completedSlugs.has("personalized-pitch-email") ? "Active" : "Not started",
    },
    {
      name: "Launch tweet",
      status: completedSlugs.has("launch-tweet") ? "live" : "paused",
      metric: completedSlugs.has("launch-tweet") ? "Posted" : "Not started",
    },
    {
      name: "Business site",
      status: completedSlugs.has("personal-landing-page") ? "live" : "paused",
      metric: completedSlugs.has("personal-landing-page") ? "Live" : "Not started",
    },
    {
      name: "Paid ads",
      status: "paused",
      metric: "Not started",
    },
  ];

  // ── Decisions ──────────────────────────────────────────────────────────
  const decisions = runsRaw
    .filter((r) => ["proposed", "awaiting_approval"].includes(r.status))
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      title: r.output_summary || "Review pending play",
      subtitle: (r.task_slug as string).replace(/-/g, " "),
      why: "Authorizing this play advances your business to the next milestone.",
      action_label: "Review & authorize",
      must_win: false,
    }));

  // ── Story ──────────────────────────────────────────────────────────────
  const milestones = milestonesRaw.map((m) => ({
    date: new Date(m.occurred_at)
      .toLocaleDateString("en-US", { month: "short", day: "numeric" })
      .toUpperCase(),
    label: m.label,
    highlight: m.highlight,
  }));

  // ── Day number ─────────────────────────────────────────────────────────
  const createdAt = new Date(business.created_at).getTime();
  const dayNumber = Math.max(1, Math.floor((Date.now() - createdAt) / 86400000) + 1);

  // ── Reach pace from goals ──────────────────────────────────────────────
  const reachGoal = goals.find((g) => g.goal_type === "reach") ?? null;

  c.header("Cache-Control", "private, no-store");
  return c.json({
    business: {
      id: business.id,
      slug: business.slug,
      name: business.name,
      phase,
      mode,
      agent_name: agentName,
      created_at: business.created_at,
      day_number: dayNumber,
    },
    goals,
    morning_line: morningLine,
    walk_the_floor: {
      reach_pace: reachGoal
        ? { current: reachGoal.current_value, target: reachGoal.target_value, pct: reachGoal.pct }
        : null,
      funnel: { saw: 0, visited: 0, engaged: 0, bought: 0 },
      channels,
      activity,
    },
    iris_check_in: null,
    lesson: lesson
      ? {
          phase: lesson.phase as string,
          sequence: lesson.sequence as number,
          total: lessonsRaw.length,
          title: lesson.title as string,
          body: lesson.body as string,
        }
      : null,
    decisions,
    story: {
      milestones:
        milestones.length > 0
          ? milestones
          : [{ date: "TODAY", label: "Day 1. The story starts here.", highlight: false }],
      trend_points: [],
    },
    charge_window: chargeWindow,
  });
});

// ── POST /api/businesses/:slug/mode ──────────────────────────────────────

app.post("/:slug/mode", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business: any;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch {
    return c.json({ error: "internal" }, 500);
  }
  if (!business) return c.json({ error: "not_found" }, 404);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const { mode, must_win_text, duration_hours = 72 } = body ?? {};
  if (!["cruise", "charge"].includes(mode)) {
    return c.json({ error: "invalid_mode", message: "mode must be 'cruise' or 'charge'" }, 400);
  }

  const now = new Date().toISOString();

  if (mode === "charge") {
    if (!must_win_text) {
      return c.json({ error: "validation", message: "must_win_text required for charge mode" }, 400);
    }
    const endsAt = new Date(Date.now() + Number(duration_hours) * 3600000).toISOString();
    await supabase
      .from("businesses")
      .update({ mode: "charge", mode_changed_at: now })
      .eq("id", business.id);
    await supabase.from("charge_windows").insert({
      business_id: business.id,
      must_win_text,
      duration_hours: Number(duration_hours),
      started_at: now,
      ends_at: endsAt,
    });
    log.info("charge_mode_entered", { business_id: business.id, duration_hours });
  } else {
    await supabase
      .from("businesses")
      .update({ mode: "cruise", mode_changed_at: now })
      .eq("id", business.id);
    await supabase
      .from("charge_windows")
      .update({ ended_at: now, outcome: "cancelled" })
      .eq("business_id", business.id)
      .is("ended_at", null);
    log.info("cruise_mode_restored", { business_id: business.id });
  }

  return c.json({ ok: true, mode });
});

export default app;

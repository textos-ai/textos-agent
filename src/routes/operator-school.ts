import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { requireAuth } from "../lib/jwt";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// Curriculum task order — matches tasks.execution_order set in prep SQL.
// Also used as JS-side fallback so ordering is deterministic even if the
// DB values haven't been applied yet.
const CURRICULUM_ORDER: Record<string, number> = {
  "research-strategy": 10,
  "tam-sam-som": 20,
  "mission-document": 30,
  "personal-landing-page": 40,
  "launch-tweet": 50,
  "personalized-pitch-email": 60,
};

const CURRICULUM_TASK_SLUGS = Object.keys(CURRICULUM_ORDER);

type LessonRow = {
  id: string;
  slug: string;
  title: string;
  task_slug: string;
  sort_order: number;
  min_minutes: number;
  tier: string;
  body?: string;
};

function sortLessons<T extends { task_slug: string; sort_order: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const ao = CURRICULUM_ORDER[a.task_slug] ?? 99;
    const bo = CURRICULUM_ORDER[b.task_slug] ?? 99;
    if (ao !== bo) return ao - bo;
    return a.sort_order - b.sort_order;
  });
}

// ── GET /api/operator-school ──────────────────────────────────────────────────
// Returns the full curriculum tree with per-user completion + badge state.
app.get("/", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const [lessonsRes, tasksRes, completionsRes, badgesRes, earningsRes] = await Promise.all([
    supabase
      .from("lessons")
      .select("id, slug, title, sort_order, min_minutes, tier, task_slug")
      .not("task_slug", "is", null),
    supabase
      .from("tasks")
      .select("slug, name")
      .in("slug", CURRICULUM_TASK_SLUGS),
    supabase
      .from("lesson_completions")
      .select("lesson_id, completed_at")
      .eq("user_id", auth.user_id),
    supabase
      .from("badges")
      .select("id, slug, tier, task_slug, lesson_id, name, description, icon_emoji"),
    supabase
      .from("badge_earnings")
      .select("badge_id, earned_at")
      .eq("user_id", auth.user_id),
  ]);

  if (lessonsRes.error) {
    log.error("os_curriculum_fetch", { err: lessonsRes.error.message });
    return c.json(errBody("internal", "failed to load curriculum"), 500);
  }

  const lessons = (lessonsRes.data ?? []) as LessonRow[];
  const tasks = tasksRes.data ?? [];
  const completions = completionsRes.data ?? [];
  const badges = badgesRes.data ?? [];
  const earnings = earningsRes.data ?? [];

  const taskMap = new Map(tasks.map((t) => [t.slug, t]));
  const completionMap = new Map(completions.map((c) => [c.lesson_id, c.completed_at]));
  const earningsMap = new Map(earnings.map((e) => [e.badge_id, e.earned_at]));

  const lessonBadgeByLessonId = new Map(
    badges
      .filter((b) => b.tier === "lesson" && b.lesson_id)
      .map((b) => [b.lesson_id as string, b]),
  );
  const taskBadgeBySlug = new Map(
    badges.filter((b) => b.tier === "task" && b.task_slug).map((b) => [b.task_slug as string, b]),
  );
  const masterBadge = badges.find((b) => b.tier === "master");

  // Group + sort by curriculum order
  const sorted = sortLessons(lessons);
  const grouped = new Map<string, LessonRow[]>();
  for (const l of sorted) {
    if (!grouped.has(l.task_slug)) grouped.set(l.task_slug, []);
    grouped.get(l.task_slug)!.push(l);
  }

  const taskSlugsInOrder = CURRICULUM_TASK_SLUGS.filter((s) => grouped.has(s));

  const taskItems = taskSlugsInOrder.map((taskSlug) => {
    const taskInfo = taskMap.get(taskSlug);
    const taskBadge = taskBadgeBySlug.get(taskSlug);
    const taskLessons = grouped.get(taskSlug) ?? [];

    return {
      task_slug: taskSlug,
      task_name: taskInfo?.name ?? taskSlug,
      badge: taskBadge
        ? {
            slug: taskBadge.slug,
            name: taskBadge.name,
            description: taskBadge.description,
            icon_emoji: taskBadge.icon_emoji,
            earned: earningsMap.has(taskBadge.id),
            earned_at: earningsMap.get(taskBadge.id) ?? null,
          }
        : null,
      lessons: taskLessons.map((lesson) => {
        const lb = lessonBadgeByLessonId.get(lesson.id);
        return {
          slug: lesson.slug,
          title: lesson.title,
          sort_order: lesson.sort_order,
          min_minutes: lesson.min_minutes,
          tier: lesson.tier,
          completed: completionMap.has(lesson.id),
          completed_at: completionMap.get(lesson.id) ?? null,
          lesson_badge: lb
            ? {
                slug: lb.slug,
                name: lb.name,
                icon_emoji: lb.icon_emoji,
                earned: earningsMap.has(lb.id),
              }
            : null,
        };
      }),
    };
  });

  const taskBadgesEarned = taskSlugsInOrder.filter((slug) => {
    const tb = taskBadgeBySlug.get(slug);
    return tb && earningsMap.has(tb.id);
  }).length;

  return c.json({
    tasks: taskItems,
    summary: {
      lessons_completed: completions.length,
      lessons_total: lessons.length,
      task_badges_earned: taskBadgesEarned,
      task_badges_total: CURRICULUM_TASK_SLUGS.length,
      ceo_badge: masterBadge
        ? {
            slug: masterBadge.slug,
            name: masterBadge.name,
            icon_emoji: masterBadge.icon_emoji,
            earned: earningsMap.has(masterBadge.id),
            earned_at: earningsMap.get(masterBadge.id) ?? null,
            progress: taskBadgesEarned,
            required: CURRICULUM_TASK_SLUGS.length,
          }
        : null,
    },
  });
});

// ── GET /api/operator-school/lessons/:slug ────────────────────────────────────
// Returns a single lesson with full body, completion state, and prev/next nav.
app.get("/lessons/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const { data: lesson, error: lessonErr } = await supabase
    .from("lessons")
    .select("id, slug, title, body, action_prompt, min_minutes, task_slug, sort_order, tier")
    .eq("slug", slug)
    .not("task_slug", "is", null)
    .maybeSingle();

  if (lessonErr) {
    log.error("os_lesson_fetch", { slug, err: lessonErr.message });
    return c.json(errBody("internal", "failed to load lesson"), 500);
  }
  if (!lesson) return c.json(errBody("not_found", "lesson not found"), 404);

  const taskSlug = lesson.task_slug as string;

  const [taskRes, siblingsRes, completionRes, lessonBadgeRes, taskBadgeRes] = await Promise.all([
    supabase.from("tasks").select("name").eq("slug", taskSlug).maybeSingle(),
    supabase
      .from("lessons")
      .select("slug, title, sort_order")
      .eq("task_slug", taskSlug)
      .not("task_slug", "is", null)
      .order("sort_order"),
    supabase
      .from("lesson_completions")
      .select("completed_at")
      .eq("user_id", auth.user_id)
      .eq("lesson_id", lesson.id)
      .maybeSingle(),
    supabase
      .from("badges")
      .select("name, description, icon_emoji")
      .eq("lesson_id", lesson.id)
      .eq("tier", "lesson")
      .maybeSingle(),
    supabase
      .from("badges")
      .select("name")
      .eq("task_slug", taskSlug)
      .eq("tier", "task")
      .maybeSingle(),
  ]);

  const siblings = siblingsRes.data ?? [];
  const idx = siblings.findIndex((s) => s.slug === slug);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  return c.json({
    lesson: {
      slug: lesson.slug,
      title: lesson.title,
      body: lesson.body,
      action_prompt: lesson.action_prompt,
      min_minutes: lesson.min_minutes,
      task_slug: taskSlug,
      task_name: taskRes.data?.name ?? taskSlug,
      task_badge_name: taskBadgeRes.data?.name ?? null,
      sort_order: lesson.sort_order,
      completed: !!completionRes.data,
      completed_at: completionRes.data?.completed_at ?? null,
      lesson_badge: lessonBadgeRes.data
        ? {
            name: lessonBadgeRes.data.name,
            icon_emoji: lessonBadgeRes.data.icon_emoji,
            description: lessonBadgeRes.data.description,
          }
        : null,
    },
    navigation: {
      previous: prev ? { slug: prev.slug, title: prev.title } : null,
      next: next ? { slug: next.slug, title: next.title } : null,
    },
  });
});

// ── POST /api/operator-school/lessons/:slug/complete ─────────────────────────
// Marks a lesson complete and cascades badge earnings.
// Idempotent: second call for the same lesson returns badges_just_earned: [].
app.post("/lessons/:slug/complete", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");

  const supabase = createSupabaseClient(c.env);

  const { data: lesson } = await supabase
    .from("lessons")
    .select("id, task_slug")
    .eq("slug", slug)
    .not("task_slug", "is", null)
    .maybeSingle();

  if (!lesson) return c.json(errBody("not_found", "lesson not found"), 404);

  // Idempotency check — if already completed, return early with no new badges.
  const { data: existing } = await supabase
    .from("lesson_completions")
    .select("completed_at")
    .eq("user_id", auth.user_id)
    .eq("lesson_id", lesson.id)
    .maybeSingle();

  if (existing) {
    return c.json({
      lesson_completion: { lesson_slug: slug, completed_at: existing.completed_at },
      badges_just_earned: [],
    });
  }

  // Insert completion
  const { data: newRow, error: insertErr } = await supabase
    .from("lesson_completions")
    .insert({ user_id: auth.user_id, lesson_id: lesson.id })
    .select("completed_at")
    .single();

  if (insertErr) {
    log.error("os_complete_insert", { slug, err: insertErr.message });
    return c.json(errBody("internal", "failed to record completion"), 500);
  }

  const completedAt: string = newRow.completed_at;
  const taskSlug = lesson.task_slug as string;

  const badgesJustEarned: Array<{
    tier: string;
    slug: string;
    name: string;
    description: string;
    icon_emoji: string | null;
  }> = [];

  // Load existing badge earnings once — used for all "already have it?" checks.
  const { data: existingEarnings } = await supabase
    .from("badge_earnings")
    .select("badge_id")
    .eq("user_id", auth.user_id);

  const earnedIds = new Set((existingEarnings ?? []).map((e) => e.badge_id));

  // Step 1 — lesson badge
  const { data: lb } = await supabase
    .from("badges")
    .select("id, slug, name, description, icon_emoji")
    .eq("lesson_id", lesson.id)
    .eq("tier", "lesson")
    .maybeSingle();

  if (lb && !earnedIds.has(lb.id)) {
    const { error: lbErr } = await supabase
      .from("badge_earnings")
      .insert({ user_id: auth.user_id, badge_id: lb.id });
    if (!lbErr) {
      earnedIds.add(lb.id);
      badgesJustEarned.push({ tier: "lesson", slug: lb.slug, name: lb.name, description: lb.description, icon_emoji: lb.icon_emoji });
    } else {
      log.warn("os_lesson_badge_insert", { slug, err: lbErr.message });
    }
  }

  // Step 2 — check task badge (are all lessons in this task now done?)
  const { data: taskLessons } = await supabase
    .from("lessons")
    .select("id")
    .eq("task_slug", taskSlug)
    .not("task_slug", "is", null);

  const taskLessonIds = (taskLessons ?? []).map((l) => l.id);

  const { count: taskDoneCount } = await supabase
    .from("lesson_completions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user_id)
    .in("lesson_id", taskLessonIds);

  if (taskLessonIds.length > 0 && (taskDoneCount ?? 0) >= taskLessonIds.length) {
    const { data: tb } = await supabase
      .from("badges")
      .select("id, slug, name, description, icon_emoji")
      .eq("task_slug", taskSlug)
      .eq("tier", "task")
      .maybeSingle();

    if (tb && !earnedIds.has(tb.id)) {
      const { error: tbErr } = await supabase
        .from("badge_earnings")
        .insert({ user_id: auth.user_id, badge_id: tb.id });
      if (!tbErr) {
        earnedIds.add(tb.id);
        badgesJustEarned.push({ tier: "task", slug: tb.slug, name: tb.name, description: tb.description, icon_emoji: tb.icon_emoji });

        // Step 3 — check master badge (all 6 task badges earned?)
        const { data: allTaskBadges } = await supabase
          .from("badges")
          .select("id")
          .eq("tier", "task");

        const allTaskBadgeIds = (allTaskBadges ?? []).map((b) => b.id);
        const earnedTaskCount = allTaskBadgeIds.filter((id) => earnedIds.has(id)).length;

        if (earnedTaskCount >= CURRICULUM_TASK_SLUGS.length) {
          const { data: mb } = await supabase
            .from("badges")
            .select("id, slug, name, description, icon_emoji")
            .eq("tier", "master")
            .maybeSingle();

          if (mb && !earnedIds.has(mb.id)) {
            const { error: mbErr } = await supabase
              .from("badge_earnings")
              .insert({ user_id: auth.user_id, badge_id: mb.id });
            if (!mbErr) {
              badgesJustEarned.push({ tier: "master", slug: mb.slug, name: mb.name, description: mb.description, icon_emoji: mb.icon_emoji });
            } else {
              log.warn("os_master_badge_insert", { err: mbErr.message });
            }
          }
        }
      } else {
        log.warn("os_task_badge_insert", { taskSlug, err: tbErr.message });
      }
    }
  }

  return c.json({
    lesson_completion: { lesson_slug: slug, completed_at: completedAt },
    badges_just_earned: badgesJustEarned,
  });
});

// ── GET /api/operator-school/badges ───────────────────────────────────────────
// Returns earned badges for the user. Used by Manager left-rail strip.
app.get("/badges", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const { data: earnings, error } = await supabase
    .from("badge_earnings")
    .select("badge_id, earned_at")
    .eq("user_id", auth.user_id)
    .order("earned_at");

  if (error) {
    log.error("os_badges_fetch", { err: error.message });
    return c.json(errBody("internal", "failed to load badges"), 500);
  }

  const badgeIds = (earnings ?? []).map((e) => e.badge_id);
  if (badgeIds.length === 0) return c.json({ earned: [] });

  const { data: badgeDetails } = await supabase
    .from("badges")
    .select("id, tier, slug, name, description, icon_emoji")
    .in("id", badgeIds);

  const detailMap = new Map((badgeDetails ?? []).map((b) => [b.id, b]));
  const earnedAtMap = new Map((earnings ?? []).map((e) => [e.badge_id, e.earned_at]));

  const earned = badgeIds
    .map((id) => {
      const b = detailMap.get(id);
      if (!b) return null;
      return {
        tier: b.tier,
        slug: b.slug,
        name: b.name,
        description: b.description,
        icon_emoji: b.icon_emoji,
        earned_at: earnedAtMap.get(id) ?? null,
      };
    })
    .filter(Boolean);

  return c.json({ earned });
});

// ── GET /api/operator-school/today ────────────────────────────────────────────
// Returns the user's "today" state: next lesson, between-tasks, or complete.
// Used by the Manager Operator School card.
app.get("/today", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const [lessonsRes, completionsRes, tasksRes, badgesRes, earningsRes] = await Promise.all([
    supabase
      .from("lessons")
      .select("id, slug, title, task_slug, sort_order, min_minutes, body")
      .not("task_slug", "is", null),
    supabase
      .from("lesson_completions")
      .select("lesson_id")
      .eq("user_id", auth.user_id),
    supabase
      .from("tasks")
      .select("slug, name")
      .in("slug", CURRICULUM_TASK_SLUGS),
    supabase
      .from("badges")
      .select("id, slug, tier, task_slug, name, icon_emoji")
      .in("tier", ["task", "master"]),
    supabase
      .from("badge_earnings")
      .select("badge_id, earned_at")
      .eq("user_id", auth.user_id),
  ]);

  const lessons = (lessonsRes.data ?? []) as LessonRow[];
  const completedIds = new Set((completionsRes.data ?? []).map((c) => c.lesson_id));
  const taskMap = new Map((tasksRes.data ?? []).map((t) => [t.slug, t]));
  const badges = badgesRes.data ?? [];
  const earnedIds = new Set((earningsRes.data ?? []).map((e) => e.badge_id));
  const earnedAtMap = new Map((earningsRes.data ?? []).map((e) => [e.badge_id, e.earned_at]));

  const taskBadgeBySlug = new Map(
    badges.filter((b) => b.tier === "task" && b.task_slug).map((b) => [b.task_slug as string, b]),
  );
  const masterBadge = badges.find((b) => b.tier === "master");

  const sorted = sortLessons(lessons);

  // Find next unread lesson in curriculum order
  const next = sorted.find((l) => !completedIds.has(l.id));

  if (next) {
    const taskLessons = sorted.filter((l) => l.task_slug === next.task_slug);
    const taskInfo = taskMap.get(next.task_slug);
    const taskBadge = taskBadgeBySlug.get(next.task_slug);

    const rawBody = next.body ?? "";
    const firstPara = rawBody.split("\n\n")[0] ?? rawBody;
    const bodyPreview =
      firstPara.length > 150 ? firstPara.slice(0, 147) + "..." : firstPara;

    return c.json({
      state: "lesson_unread",
      lesson: {
        slug: next.slug,
        title: next.title,
        task_slug: next.task_slug,
        task_name: taskInfo?.name ?? next.task_slug,
        task_badge_name: taskBadge?.name ?? null,
        sort_order: next.sort_order,
        task_lesson_count: taskLessons.length,
        min_minutes: next.min_minutes,
        body_preview: bodyPreview,
      },
    });
  }

  // All lessons done — check CEO
  if (masterBadge && earnedIds.has(masterBadge.id)) {
    return c.json({
      state: "complete",
      earned_badge: {
        slug: masterBadge.slug,
        name: masterBadge.name,
        icon_emoji: masterBadge.icon_emoji,
      },
    });
  }

  // Between tasks — find most-recently-earned task badge + next unstarted task
  const earnedTaskBadges = badges
    .filter((b) => b.tier === "task" && b.task_slug && earnedIds.has(b.id))
    .sort((a, b) => {
      const at = earnedAtMap.get(a.id) ?? "";
      const bt = earnedAtMap.get(b.id) ?? "";
      return bt.localeCompare(at);
    });

  const lastEarned = earnedTaskBadges[0] ?? null;
  const earnedTaskSlugs = new Set(earnedTaskBadges.map((b) => b.task_slug as string));
  const nextTaskSlug = CURRICULUM_TASK_SLUGS.find((s) => !earnedTaskSlugs.has(s));
  const nextTaskLessons = nextTaskSlug ? sorted.filter((l) => l.task_slug === nextTaskSlug) : [];
  const nextTaskBadge = nextTaskSlug ? taskBadgeBySlug.get(nextTaskSlug) : null;
  const nextTaskInfo = nextTaskSlug ? taskMap.get(nextTaskSlug) : null;

  return c.json({
    state: "between_tasks",
    earned_badge: lastEarned
      ? { slug: lastEarned.slug, name: lastEarned.name, icon_emoji: lastEarned.icon_emoji }
      : null,
    next_task: nextTaskSlug
      ? {
          task_slug: nextTaskSlug,
          task_name: nextTaskInfo?.name ?? nextTaskSlug,
          task_badge_name: nextTaskBadge?.name ?? null,
          task_badge_emoji: nextTaskBadge?.icon_emoji ?? null,
          first_lesson_slug: nextTaskLessons[0]?.slug ?? null,
        }
      : null,
    summary: {
      task_badges_earned: earnedTaskBadges.length,
      task_badges_total: CURRICULUM_TASK_SLUGS.length,
    },
  });
});

export default app;

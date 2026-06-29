// =============================================================
// "Next optimal time" scheduler — consistency-first.
//
// Reads the admin-editable optimal_slots table (no hardcoded times) and picks
// the SOONEST upcoming good slot that keeps cadence — we do NOT wait days for a
// priority-1 peak when a good sooner slot exists. Then applies per-slot jitter
// (± random(jitter_minutes)) so fire times look organic, not mechanical.
//
// Times are computed in the business timezone (Central / America/Chicago in
// Stage 1) and DST-correct via Intl. The chosen local wall-clock string +
// timezone go to Zernio's scheduledFor/timezone; the UTC instant is stored on
// content_assets.scheduled_for.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

const TZ = "America/Chicago";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

interface CentralParts { y: number; m: number; d: number; hour: number; min: number; dow: number; }

function centralParts(utcMs: number): CentralParts {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  const y = +p.year, m = +p.month, d = +p.day;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, hour: +p.hour, min: +p.minute, dow };
}

// ms that Central wall-clock is ahead of UTC at `utcMs` (CST -6h, CDT -5h).
function centralOffsetMs(utcMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// UTC epoch ms for a Central wall-clock (y, m, d + daysAhead, hh:mm). Overflow-safe.
function centralWallToUTC(y: number, m: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  return guess - centralOffsetMs(guess);
}

function fmt12(hour: number, min: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad(min)} ${ampm}`;
}

export interface NextOptimalSlot {
  scheduledForLocal: string;  // "2026-07-01T10:04:00" — send to Zernio with `timezone`
  timezone: string;           // "America/Chicago"
  scheduledForUTC: string;    // ISO — store on content_assets.scheduled_for
  label: string;              // "Wed 10:04 AM CT"
  basePriority: number;
}

/**
 * Compute the next optimal scheduling slot for a platform + content type.
 * Returns null when no active slots exist for that platform/content type.
 */
export async function computeNextOptimalSlot(
  supabase: SupabaseClient,
  platformSlug: string,
  contentType: string,
  nowMs: number,
): Promise<NextOptimalSlot | null> {
  // Our social posts are content_type 'social_post'; slots use 'post'.
  const ct = contentType === "social_post" ? "post" : contentType;

  const { data: slots } = await supabase
    .from("optimal_slots")
    .select("day_of_week, local_time, priority, jitter_minutes")
    .eq("platform_slug", platformSlug)
    .eq("content_type", ct)
    .eq("is_active", true);

  if (!slots || slots.length === 0) return null;

  const now = centralParts(nowMs);
  let best: { utcMs: number; priority: number; jitter: number } | null = null;

  for (const s of slots as Array<{ day_of_week: string; local_time: string; priority: number; jitter_minutes: number }>) {
    const slotDow = DOW.indexOf(s.day_of_week);
    if (slotDow < 0) continue;
    const [hhRaw, mmRaw] = String(s.local_time).split(":");
    const hh = +hhRaw, mm = +mmRaw;

    let daysAhead = (slotDow - now.dow + 7) % 7;
    if (daysAhead === 0) {
      // Today — only valid if the slot time is still ahead (small buffer); else next week.
      if (hh * 60 + mm <= now.hour * 60 + now.min + 2) daysAhead = 7;
    }
    const utcMs = centralWallToUTC(now.y, now.m, now.d + daysAhead, hh, mm);

    // Consistency-first: soonest slot wins; priority only breaks exact ties.
    if (!best || utcMs < best.utcMs || (utcMs === best.utcMs && s.priority < best.priority)) {
      best = { utcMs, priority: s.priority, jitter: typeof s.jitter_minutes === "number" ? s.jitter_minutes : 10 };
    }
  }
  if (!best) return null;

  // Jitter: ± random(jitter_minutes). Floor at now+1min so it stays in the future.
  const offsetMin = Math.round((Math.random() * 2 - 1) * best.jitter);
  let firedUtc = best.utcMs + offsetMin * 60_000;
  if (firedUtc < nowMs + 60_000) firedUtc = nowMs + 60_000;

  const f = centralParts(firedUtc);
  return {
    scheduledForLocal: `${f.y}-${pad(f.m)}-${pad(f.d)}T${pad(f.hour)}:${pad(f.min)}:00`,
    timezone: TZ,
    scheduledForUTC: new Date(firedUtc).toISOString(),
    label: `${DOW[f.dow]} ${fmt12(f.hour, f.min)} CT`,
    basePriority: best.priority,
  };
}

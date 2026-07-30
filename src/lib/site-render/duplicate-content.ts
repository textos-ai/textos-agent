// The duplicate-content gate (2C Part D).
//
// Area pages generated from a template are doorway pages unless each one says
// something true about that specific place. The reference site scores roughly 5%
// unique tokens per area page — the same paragraph with the city swapped — and
// that is the failure this exists to detect.
//
// MASK THE PLACE NAME FIRST. "Chalmette" appearing forty times in the Chalmette
// page is not uniqueness, it is the template working. Masking the city, region
// and postal code before scoring is what separates "this page is about a
// different place" from "this page says something different".
//
// ADVISORY ONLY. There is no publish flow yet, so nothing is blocked; the score
// and the reason surface next to the area in the manager, and Phase 4's readiness
// report scores the same signal.

export interface AreaText {
  area_slug: string;
  city: string;
  region: string | null;
  postal_code: string | null;
  local_blurb: string;
  landmarks_blurb: string;
}

/** Words too common to count as evidence of local writing. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
  "from", "by", "is", "are", "was", "were", "be", "been", "we", "our", "us", "you",
  "your", "it", "its", "that", "this", "these", "those", "as", "if", "so", "than",
  "then", "there", "here", "have", "has", "had", "do", "does", "did", "not", "no",
  "all", "any", "can", "will", "would", "up", "out", "about", "into", "over",
]);

/**
 * Tokenise, having first masked the area's own identifiers.
 *
 * The mask is applied to the words that NAME the place — city, region, postal
 * code — so the place name itself cannot inflate the score.
 */
export function tokenise(text: string, area: Pick<AreaText, "city" | "region" | "postal_code">): string[] {
  let t = text.toLowerCase();
  for (const id of [area.city, area.region, area.postal_code]) {
    if (!id) continue;
    // Mask each word of a multi-word place ("New Orleans") as well as the whole.
    for (const part of [id, ...id.split(/\s+/)]) {
      const p = part.trim().toLowerCase();
      if (p.length < 2) continue;
      t = t.split(p).join(" ");
    }
  }
  return t
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Jaccard similarity of two token sets. 1.0 is identical, 0 shares nothing. */
export function similarity(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const union = A.size + B.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface AreaScore {
  area_slug: string;
  city: string;
  /** Share of this page's tokens that appear on NO other area page. */
  unique_ratio: number;
  /** Highest pairwise similarity against another area page. */
  max_similarity: number;
  most_similar_to: string | null;
  /** Which blurb contributes more unique tokens — where the work is being done. */
  carried_by: "local_blurb" | "landmarks_blurb" | "neither";
  below_threshold: boolean;
  /** Plain-language summary for the manager. */
  message: string;
}

export const DEFAULT_UNIQUE_THRESHOLD = 0.25;

/**
 * Score every area against every other.
 *
 * A single area cannot be duplicated against anything, so it scores 1.0 and is
 * reported as such rather than being silently skipped — the operator should see
 * that the check ran and why it passed.
 */
export function scoreAreas(areas: AreaText[], threshold = DEFAULT_UNIQUE_THRESHOLD): AreaScore[] {
  const toks = new Map<string, string[]>();
  const byBlurb = new Map<string, { local: string[]; land: string[] }>();
  for (const a of areas) {
    toks.set(a.area_slug, tokenise(`${a.local_blurb} ${a.landmarks_blurb}`, a));
    byBlurb.set(a.area_slug, {
      local: tokenise(a.local_blurb, a),
      land: tokenise(a.landmarks_blurb, a),
    });
  }

  return areas.map((a) => {
    const mine = toks.get(a.area_slug) ?? [];
    const others = areas.filter((o) => o.area_slug !== a.area_slug);

    if (others.length === 0) {
      return {
        area_slug: a.area_slug, city: a.city, unique_ratio: 1, max_similarity: 0,
        most_similar_to: null, carried_by: carriedBy(byBlurb.get(a.area_slug)!, new Set()),
        below_threshold: false,
        message: "Only one service area, so there is nothing for this page to duplicate.",
      };
    }

    const elsewhere = new Set<string>();
    let max = 0, worst: string | null = null;
    for (const o of others) {
      const ot = toks.get(o.area_slug) ?? [];
      for (const w of ot) elsewhere.add(w);
      const sim = similarity(mine, ot);
      if (sim > max) { max = sim; worst = o.city; }
    }
    const uniqueWords = new Set(mine.filter((w) => !elsewhere.has(w)));
    const distinct = new Set(mine);
    const ratio = distinct.size === 0 ? 0 : uniqueWords.size / distinct.size;
    const below = ratio < threshold;

    return {
      area_slug: a.area_slug,
      city: a.city,
      unique_ratio: Number(ratio.toFixed(3)),
      max_similarity: Number(max.toFixed(3)),
      most_similar_to: worst,
      carried_by: carriedBy(byBlurb.get(a.area_slug)!, elsewhere),
      below_threshold: below,
      message: below
        ? `Only ${Math.round(ratio * 100)}% of the writing on this page is unique to ${a.city}`
          + (worst ? `; it reads much like the ${worst} page.` : ".")
          + " Add something only true here — a street, a landmark, a job you did."
        : `${Math.round(ratio * 100)}% of the writing on this page is unique to ${a.city}.`,
    };
  });
}

/** Which of the two blurbs contributes more of the unique tokens. */
function carriedBy(
  b: { local: string[]; land: string[] },
  elsewhere: Set<string>,
): AreaScore["carried_by"] {
  const u = (ws: string[]) => new Set(ws.filter((w) => !elsewhere.has(w))).size;
  const l = u(b.local), k = u(b.land);
  if (l === 0 && k === 0) return "neither";
  return l >= k ? "local_blurb" : "landmarks_blurb";
}

/** Read the threshold off the template, falling back to the default. */
export function thresholdFromTemplate(sectionCatalog: unknown): number {
  const v = (sectionCatalog as { duplicate_content?: { unique_token_threshold?: unknown } } | null)
    ?.duplicate_content?.unique_token_threshold;
  return typeof v === "number" && v > 0 && v <= 1 ? v : DEFAULT_UNIQUE_THRESHOLD;
}

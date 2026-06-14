import type { TaskCtx, TaskResult } from "./types";
import { extractErrorMessage } from "../extract-error";

// Email providers that don't tell us anything about the user's business.
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "me.com", "aol.com", "protonmail.com", "hey.com", "fastmail.com",
]);

const SYSTEM = `You are a brand-naming agent. Given context about a business, return ONLY a single brand name in 2-4 words, Title Case. No quotes, no explanation, no JSON, no punctuation around the name — just the name.`;

const GENERIC_TITLES = new Set([
  "home", "welcome", "homepage", "index", "untitled", "default",
  "website", "site", "page", "main page", "landing page", "loading",
]);

// Fetches a URL and returns title / og:site_name / first H1 / stripped body.
// Pulled from the same pattern as research-strategy.ts but enriched with
// the structured fields a naming task needs.
async function fetchPageInfo(url: string): Promise<{
  title: string;
  og: string;
  h1: string;
  body: string;
}> {
  const res = await fetch(url, {
    headers: { "User-Agent": "TextOS-Agent/1.0 (research bot)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  );
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const og = ogMatch ? ogMatch[1].trim() : "";
  const h1 = h1Match ? stripTags(h1Match[1]) : "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return { title, og, h1, body };
}

function looksLikeRealName(s: string): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (GENERIC_TITLES.has(trimmed.toLowerCase())) return false;
  // Reject URLs and bare domain strings ("trustlight.ai", "www.example.com").
  // A real brand name has no TLD suffix without spaces.
  if (/https?:\/\//i.test(trimmed)) return false;
  if (!trimmed.includes(" ") && /^[\w.-]+\.[a-z]{2,}$/i.test(trimmed)) return false;
  return true;
}

function cleanName(raw: string): string {
  return raw.replace(/^["'`]+|["'`.]+$/g, "").replace(/\s+/g, " ").trim();
}

function splitDomainTerms(host: string): string[] {
  const noWww = host.replace(/^www\./i, "");
  const parts = noWww.split(".");
  // Drop the TLD (last segment).
  const terms = parts.length > 1 ? parts.slice(0, -1) : parts;
  // Break camelCase / digit boundaries so "cajunNavy" → "cajun Navy".
  return terms.map((t) =>
    t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(\d+)([a-zA-Z])/g, "$1 $2"),
  );
}

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

async function askClaudeForName(
  anthropic: TaskCtx["anthropic"],
  model: string,
  promptBody: string,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 60,
    system: SYSTEM,
    messages: [{ role: "user", content: promptBody }],
  });
  const first = msg.content[0] as { type: string; text: string };
  return cleanName(first.text);
}

export async function runFindAUniqueBusinessName(
  tc: TaskCtx,
): Promise<TaskResult> {
  const { business, ctx, user, anthropic, models, emit, supabase } = tc;
  const ebd = business.existing_business_data as Record<string, string> | null;

  let finalName = "";
  let namingMethod: "found" | "generated" | "inferred" = "generated";
  let source:
    | "domain_title"
    | "email_domain"
    | "research_context"
    | "claude" = "claude";

  // ── PATH 1: existing business URL ─────────────────────────────────
  if (business.kind === "existing" && business.existing_business_url) {
    let host = "";
    try {
      host = new URL(normalizeUrl(business.existing_business_url)).hostname;
    } catch {
      // Fall through with empty host — Claude will fall back to context.
    }
    const cleanHost = host.replace(/^www\./i, "");
    const domainTerms = splitDomainTerms(host || business.existing_business_url);

    await emit({
      type: "cmd",
      text: `Analyzing domain: ${cleanHost || business.existing_business_url}`,
      ts: Date.now(),
    });

    let pageInfo: { title: string; og: string; h1: string; body: string } | null = null;
    if (cleanHost) {
      try {
        pageInfo = await fetchPageInfo(`https://${cleanHost}`);
        await emit({
          type: "cmd",
          text: `Page fetched — title="${pageInfo.title}", og="${pageInfo.og}"`,
          ts: Date.now(),
        });
      } catch (err) {
        await emit({
          type: "cmd",
          text: `Fetch failed (${extractErrorMessage(err)}) — falling back to domain inference`,
          ts: Date.now(),
        });
      }
    }

    // Look for a clean name in the page (og:site_name preferred, then
    // title chunks, then h1).
    const candidates: string[] = [];
    if (pageInfo) {
      if (pageInfo.og) candidates.push(pageInfo.og);
      if (pageInfo.title) {
        const chunks = pageInfo.title
          .split(/\s*[|—–\-·•]\s*/)
          .map((c) => c.trim())
          .filter(Boolean);
        candidates.push(...chunks);
      }
      if (pageInfo.h1) candidates.push(pageInfo.h1);
    }

    const good = candidates.map(cleanName).find(looksLikeRealName);
    if (good) {
      finalName = good;
      namingMethod = "found";
      source = "domain_title";
      await emit({
        type: "cmd",
        text: `Found: ${finalName} from ${cleanHost}`,
        ts: Date.now(),
      });
    } else {
      const promptBody = `Domain: ${cleanHost || "(unknown)"}
Domain terms: ${domainTerms.join(" / ")}
${pageInfo ? `Page body snippet:\n"""\n${pageInfo.body.slice(0, 1200)}\n"""\n` : ""}
Industry (from research): ${ctx.industry ?? "unknown"}
Business summary: ${ctx.business_summary ?? "unknown"}
Value proposition: ${ctx.value_proposition ?? ""}

Return a single 2-4 word business brand name suitable for this site. Return ONLY the name.`;
      finalName = await askClaudeForName(anthropic, models.sonnet, promptBody);
      namingMethod = "generated";
      source = "claude";
      await emit({
        type: "cmd",
        text: `Generated: ${finalName} from domain research`,
        ts: Date.now(),
      });
    }
  }
  // ── PATH 2: find_for_me — research user via email ───────────────────
  else if (business.kind === "find_for_me") {
    const email = user?.email ?? "";
    const atIdx = email.indexOf("@");
    const prefix = atIdx > 0 ? email.slice(0, atIdx) : "";
    const emailDomain = atIdx > 0 ? email.slice(atIdx + 1) : "";
    const nameParts = prefix
      .split(/[._\-+]+/)
      .filter(Boolean)
      .map((p) => p.replace(/\d+/g, ""))
      .filter((p) => p.length > 0);
    const inferredPerson = nameParts
      .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
      .join(" ")
      .trim();

    await emit({
      type: "cmd",
      text: `Analyzing your identity from email: ${email || "(no email)"}`,
      ts: Date.now(),
    });
    if (inferredPerson) {
      await emit({
        type: "cmd",
        text: `Inferred person: ${inferredPerson}`,
        ts: Date.now(),
      });
    }

    const isPersonal = PERSONAL_DOMAINS.has(emailDomain.toLowerCase());
    let domainBlock = "";
    if (emailDomain && !isPersonal) {
      await emit({
        type: "cmd",
        text: `Researching ${emailDomain}…`,
        ts: Date.now(),
      });
      try {
        const info = await fetchPageInfo(`https://${emailDomain}`);
        domainBlock = `Domain: ${emailDomain}
Title: ${info.title}
og:site_name: ${info.og}
H1: ${info.h1}
Body snippet: ${info.body.slice(0, 1200)}`;
        await emit({
          type: "cmd",
          text: `${emailDomain} → "${info.title || info.og || "(no title)"}"`,
          ts: Date.now(),
        });
      } catch (err) {
        domainBlock = `Domain: ${emailDomain}
Domain terms: ${splitDomainTerms(emailDomain).join(" / ")}
(page fetch failed: ${extractErrorMessage(err)})`;
      }
    } else if (isPersonal) {
      await emit({
        type: "cmd",
        text: `Personal email provider (${emailDomain}) — skipping domain research`,
        ts: Date.now(),
      });
    }

    const promptBody = `Generate a single 2-4 word brand name (Title Case) for a new business this person is launching.
${inferredPerson ? `Person: ${inferredPerson}` : ""}
${domainBlock ? domainBlock + "\n" : ""}
Industry (from research): ${ctx.industry ?? "unknown"}
Business summary (from research): ${ctx.business_summary ?? "unknown"}
Target customer: ${ctx.target_customer ? JSON.stringify(ctx.target_customer) : ""}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? ""}

Return ONLY the name. No quotes, no explanation.`;
    finalName = await askClaudeForName(anthropic, models.sonnet, promptBody);
    namingMethod = "generated";
    source = isPersonal ? "research_context" : "email_domain";
  }
  // ── PATH 3: new_idea ─────────────────────────────────────────────
  else {
    const idea = (ebd?.idea ?? ebd?.description ?? "").toString();
    await emit({
      type: "cmd",
      text: `Generating a unique brand name from your idea…`,
      ts: Date.now(),
    });

    const promptBody = `Generate a single 2-4 word brand name (Title Case) for this business concept.
Industry: ${ctx.industry ?? ""}
Business summary: ${ctx.business_summary ?? ""}
Target customer: ${ctx.target_customer ? JSON.stringify(ctx.target_customer) : ""}
Value proposition: ${ctx.value_proposition ?? ""}
Brand voice: ${ctx.brand_voice ?? ""}
Key differentiators: ${Array.isArray(ctx.key_differentiators) ? ctx.key_differentiators.join("; ") : ""}
Original idea: ${idea}

The name must be a real, memorable brand — NOT the user's prompt sentence, NOT a generic description. Return ONLY the name. No quotes, no explanation.`;
    finalName = await askClaudeForName(anthropic, models.sonnet, promptBody);
    namingMethod = "generated";
    source = "research_context";
  }

  finalName = cleanName(finalName);
  if (!finalName) {
    // Last-ditch fallback so the task doesn't fail. Keeps the existing
    // business.name (whatever was set at creation) so downstream tasks
    // still have something to work with.
    finalName = business.name || "New Business";
    namingMethod = "inferred";
  }

  // Persist to businesses.name. Best-effort — the cmd event below
  // surfaces failures but doesn't block the task.
  try {
    await supabase
      .from("businesses")
      .update({ name: finalName })
      .eq("id", business.id);
    // Mutate the shared in-memory business object so any task that
    // runs after this one (welcome-email, mission-document, etc.)
    // sees the new name without an extra DB fetch. The orchestrator
    // passes the same `business` reference into every TaskCtx.
    business.name = finalName;
  } catch (err) {
    await emit({
      type: "cmd",
      text: `[warn] name update failed: ${extractErrorMessage(err)}`,
      ts: Date.now(),
    });
  }

  await emit({
    type: "narrative",
    text: `Business named: ${finalName}`,
    ts: Date.now(),
  });

  return {
    output_data: {
      business_name: finalName,
      naming_method: namingMethod,
      source,
    },
    context_updates: {},
  };
}

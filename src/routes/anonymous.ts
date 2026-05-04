import { Hono } from "hono";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { runAnonymousResearch, ContentRejectedError, type AnonymousInput } from "../lib/anonymous-research";
import { createSupabaseClient } from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();

const RATE_LIMIT = 3;
const TTL = 3600;

const SnapshotBody = z.object({
  kind: z.enum(["new_idea", "existing", "find_for_me"]),
  description: z.string().max(2000).optional(),
  url: z.string().url().max(500).optional(),
  interests: z.string().max(1000).optional(),
  budget: z.string().max(200).optional(),
  source: z.string().max(50).optional(),
});

app.post("/snapshot", async (c) => {
  // Read body once — needed for analytics in every code path
  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(errBody("bad_request", "invalid JSON"), 400);
  }

  // ip_address is regulated data — stored in DB for abuse forensics only.
  // Never logged in log.info/warn/error calls. Never echoed in API responses.
  // See privacy policy obligations before shipping to prod.
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";
  const userAgent = c.req.header("user-agent") ?? null;
  const rateKey = `rate:snapshot:${ip}`;

  const countStr = await c.env.SNAPSHOT_KV.get(rateKey);
  const count = countStr ? parseInt(countStr, 10) : 0;

  if (count >= RATE_LIMIT) {
    // Analytics: capture rate-limited attempt (non-fatal)
    try {
      const supabase = createSupabaseClient(c.env);
      await supabase.from("anonymous_snapshots").insert({
        token: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        source: String(rawBody.source ?? "unknown"),
        kind: String(rawBody.kind ?? "new_idea"),
        input: rawBody,
        ip_address: ip,
        user_agent: userAgent,
        status: "rate_limited",
      });
    } catch (err) {
      log.warn("anon_snapshot_rate_limit_analytics_failed", { err: String(err) });
    }
    return c.json(
      errBody("rate_limited", "Too many snapshots — try again in an hour"),
      429,
    );
  }

  let input: AnonymousInput & { source?: string };
  try {
    input = SnapshotBody.parse(rawBody) as AnonymousInput & { source?: string };
  } catch (err) {
    return c.json(
      errBody("bad_request", "invalid request body", err instanceof Error ? err.message : err),
      400,
    );
  }

  const source = input.source ?? "homepage";
  const supabase = createSupabaseClient(c.env);

  // Token is generated here so it's consistent between KV and analytics row
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  // Analytics: INSERT pending row before generation begins.
  // ip_address is regulated data — stored raw per Rob's decision for abuse forensics.
  let analyticsId: string | null = null;
  try {
    const { data, error } = await supabase
      .from("anonymous_snapshots")
      .insert({
        token,
        source,
        kind: input.kind,
        input: {
          description: input.description,
          url: input.url,
          interests: input.interests,
          budget: input.budget,
        },
        ip_address: ip,
        user_agent: userAgent,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw error;
    analyticsId = (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    log.warn("anon_snapshot_analytics_insert_failed", { err: String(err) });
    // Non-fatal — generation proceeds regardless
  }

  const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const genStart = Date.now();
  let snapshot;

  try {
    snapshot = await runAnonymousResearch(input, anthropic);
  } catch (err) {
    const generationMs = Date.now() - genStart;

    if (err instanceof ContentRejectedError) {
      if (analyticsId) {
        try {
          await supabase.from("anonymous_snapshots").update({ status: "content_rejected", generation_ms: generationMs }).eq("id", analyticsId);
        } catch (e) { log.warn("anon_snapshot_content_rejected_update_error", { err: String(e) }); }
      }
      log.info("anonymous_research_content_rejected", { kind: input.kind, source });
      return c.json({
        status: "content_rejected",
        message: "We weren't able to research that idea. Try describing the business angle differently — for example, focus on the product category or the customer you're serving.",
      }, 200);
    }

    if (analyticsId) {
      try {
        await supabase.from("anonymous_snapshots").update({ status: "failed", generation_ms: generationMs }).eq("id", analyticsId);
      } catch (e) { log.warn("anon_snapshot_analytics_fail_update_error", { err: String(e) }); }
    }
    log.error("anonymous_research_failed", { err: String(err), kind: input.kind });
    return c.json(errBody("internal", "Research failed — please try again"), 500);
  }

  const generationMs = Date.now() - genStart;

  // Analytics: UPDATE with output
  if (analyticsId) {
    try {
      await supabase.from("anonymous_snapshots").update({
        output: snapshot as unknown as Record<string, unknown>,
        status: "success",
        generation_ms: generationMs,
      }).eq("id", analyticsId);
    } catch (e) { log.warn("anon_snapshot_analytics_success_update_error", { err: String(e) }); }
  }

  await c.env.SNAPSHOT_KV.put(
    `snapshot:${token}`,
    JSON.stringify({ input, snapshot }),
    { expirationTtl: TTL },
  );
  await c.env.SNAPSHOT_KV.put(rateKey, String(count + 1), { expirationTtl: TTL });

  log.info("anonymous_snapshot_created", { kind: input.kind, source });

  return c.json({ token, snapshot });
});

export default app;

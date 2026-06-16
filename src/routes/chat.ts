import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createAnthropicClient, chatWithClaude } from "../services/anthropic";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getBusinessContext,
  type BusinessContextRow,
  type BusinessRow,
} from "../services/supabase";

function buildSystemPrompt(
  business: Pick<BusinessRow, "name" | "slug">,
  ctx: BusinessContextRow,
): string {
  const agentName = ctx.agent_name?.trim() || "your AI agent";
  const businessName = business.name || "your business";
  const voice = ctx.brand_voice?.trim() || "warm and grounded";

  const lines: string[] = [];
  lines.push(
    `You are ${agentName}, the AI agent for ${businessName} ` +
    `(slug: ${business.slug}).`,
  );
  lines.push("");

  if (ctx.industry?.trim()) {
    lines.push(`Industry: ${ctx.industry.trim()}`);
  }
  if (ctx.business_summary?.trim()) {
    lines.push(`Mission: ${ctx.business_summary.trim()}`);
  }
  if (ctx.positioning_statement?.trim()) {
    lines.push(`Positioning: ${ctx.positioning_statement.trim()}`);
  }
  if (ctx.value_proposition?.trim()) {
    lines.push(`Value proposition: ${ctx.value_proposition.trim()}`);
  }

  if (ctx.target_customer && typeof ctx.target_customer === "object") {
    const tc = ctx.target_customer as Record<string, unknown>;
    const primary = typeof tc.primary === "string" ? tc.primary.trim() : "";
    if (primary) {
      lines.push(`Target customer: ${primary}`);
    }
  }

  if (Array.isArray(ctx.key_differentiators) && ctx.key_differentiators.length > 0) {
    const items = (ctx.key_differentiators as unknown[])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => `  - ${x.trim()}`);
    if (items.length > 0) {
      lines.push("Key differentiators:");
      lines.push(...items);
    }
  }

  lines.push("");
  lines.push(`Voice: ${voice}`);
  lines.push("");
  lines.push(
    `You have access to all of ${agentName}'s memory of what we've ` +
    `built together. Be helpful, specific, and reference the actual ` +
    `business when relevant. Keep responses conversational and ` +
    `grounded in this business — don't give generic startup advice.`,
  );
  lines.push("");
  lines.push(
    `Victora is the platform that powers you. Users interact with ` +
    `their business through you.`,
  );

  return lines.join("\n");
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAuth);

const ChatBody = z.object({
  message: z.string().min(1).max(10_000),
  slug: z.string().min(1).max(100).optional(),
  model: z.enum(["haiku", "sonnet", "opus"]).optional(),
});

app.post("/", async (c) => {
  let parsed;
  try {
    parsed = ChatBody.parse(await c.req.json());
  } catch (err) {
    return c.json(
      errBody(
        "bad_request",
        "invalid request body",
        err instanceof Error ? err.message : err,
      ),
      400,
    );
  }

  const auth = c.get("auth");
  const client = createAnthropicClient(c.env);
  const tier = parsed.model ?? "sonnet";
  let systemPrompt: string | undefined = undefined;

  if (parsed.slug) {
    const supabase = createSupabaseClient(c.env);
    const business = await getBusinessBySlug(supabase, auth.user_id, parsed.slug);

    if (!business) {
      log.warn("chat_slug_not_owned", { slug: parsed.slug, user_id: auth.user_id });
      return c.json(errBody("not_found", "business not found"), 404);
    }

    try {
      const ctx = await getBusinessContext(supabase, business.id);
      if (ctx) {
        systemPrompt = buildSystemPrompt(business, ctx);
        log.info("chat_context_loaded", {
          business_id: business.id,
          slug: parsed.slug,
          agent_name: ctx.agent_name,
          system_prompt_chars: systemPrompt.length,
        });
      }
    } catch (ctxError) {
      log.error("chat_context_load_failed", {
        err: String(ctxError),
        business_id: business.id,
      });
      // Continue with no system prompt rather than failing the chat
    }
  }

  try {
    const stream = chatWithClaude(client, parsed.message, tier, systemPrompt);

    // Forward as Server-Sent Events. Each Anthropic event becomes one SSE
    // line; clients can parse with EventSource or roll their own reader.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of stream) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (streamErr) {
          log.error("chat_stream_failed", { err: String(streamErr) });
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                error: "upstream_error",
                message: String(streamErr),
              })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    log.error("chat_failed", { err: String(err) });
    return c.json(errBody("upstream_error", String(err)), 502);
  }
});

export default app;

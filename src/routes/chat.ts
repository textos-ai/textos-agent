import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createAnthropicClient, chatWithClaude } from "../services/anthropic";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

const ChatBody = z.object({
  message: z.string().min(1).max(10_000),
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

  const client = createAnthropicClient(c.env);
  const tier = parsed.model ?? "sonnet";

  try {
    const stream = chatWithClaude(client, parsed.message, tier);

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

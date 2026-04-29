import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { MODEL_IDS, type ModelTier } from "../agent/model-router";

export function createAnthropicClient(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Stream a single chat completion. Caller forwards events as SSE.
 *
 * Sprint 5 replaces this with the real agent loop (system prompts,
 * prompt caching for cached task templates, tool use). For Sprint 2 we
 * just need a working pipe end-to-end.
 */
export function chatWithClaude(
  client: Anthropic,
  message: string,
  tier: ModelTier = "sonnet",
) {
  return client.messages.stream({
    model: MODEL_IDS[tier],
    max_tokens: 1024,
    messages: [{ role: "user", content: message }],
  });
}

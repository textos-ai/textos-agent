import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { MODEL_IDS, type ModelTier } from "../agent/model-router";

export function createAnthropicClient(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: 90_000,  // 90 seconds per call
  });
}

/**
 * Stream a single chat completion with optional system prompt.
 * Used by the dashboard chat panel — the system prompt carries
 * business context (agent name, industry, value proposition, etc.)
 * so the agent responds in-character for the user's business.
 *
 * Future: prompt caching for repeated business contexts, tool
 * use for agent-driven actions from chat.
 */
export function chatWithClaude(
  client: Anthropic,
  message: string,
  tier: ModelTier = "sonnet",
  systemPrompt?: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL_IDS[tier],
    max_tokens: 1024,
    messages: [{ role: "user", content: message }],
  };
  if (systemPrompt && systemPrompt.trim().length > 0) {
    params.system = systemPrompt;
  }
  return client.messages.stream(params);
}

// factory-v2 — Strategy RESULT content generator (LLM call).
//
// Calls Opus 4.8 with the proven result-endpoint pattern from
// prompt-schema.md:
//   §5  streaming — client.messages.stream(...) + stream.finalMessage();
//       no AbortController as the primary guard (SDK client timeout is the
//       backstop), incremental deltas keep the connection live.
//   §6  truncation guard — stop_reason === 'max_tokens' throws clearly.
//   §2.1 plain-text JSON — strip fences, JSON.parse, then Zod-validate.
// max_tokens 6000, model claude-opus-4-8.
//
// Clean-room: instantiates the Anthropic SDK directly (no Worker Env), so the
// proof builder can run under Node/tsx. The LLM returns CONTENT ONLY.

import Anthropic from '@anthropic-ai/sdk';
import { StrategyLiveContentSchema, type StrategyLiveContent } from './strategy-content-schema';
import { buildStrategyLivePrompt, SAMPLE_BUSINESS, WHITMORE_BOUDREAUX_ANSWERS } from './strategy-live-prompt';

// Opus 4.8 (matches the live result endpoint's APP_RESULT_MODEL). Declared
// locally to keep this proof self-contained.
const STRATEGY_LIVE_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 6000;

export class StrategyContentError extends Error {
  constructor(message: string) {
    super(`factory-v2 strategy content generation: ${message}`);
    this.name = 'StrategyContentError';
  }
}

export interface GenerateResult {
  content: StrategyLiveContent;
  meta: {
    stop_reason: string | null;
    output_tokens: number | null;
    raw_chars: number;
  };
}

export async function generateStrategyContent(apiKey: string): Promise<GenerateResult> {
  const client = new Anthropic({ apiKey, timeout: 90_000 });
  const { system, user } = buildStrategyLivePrompt({
    business: SAMPLE_BUSINESS,
    answers: WHITMORE_BOUDREAUX_ANSWERS,
  });

  // §5 streaming + finalMessage.
  const stream = client.messages.stream({
    model: STRATEGY_LIVE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();

  // §6 truncation guard.
  if (msg.stop_reason === 'max_tokens') {
    throw new StrategyContentError(
      `output truncated (stop_reason=max_tokens, max_tokens=${MAX_TOKENS}) — raise the ceiling`,
    );
  }

  const block = msg.content[0];
  const text = block && block.type === 'text' ? (block as { text: string }).text : '';

  // §2.1 plain-text JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch (err) {
    throw new StrategyContentError(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)} — head: ${text.slice(0, 120)}`,
    );
  }

  const result = StrategyLiveContentSchema.safeParse(parsed);
  if (!result.success) {
    throw new StrategyContentError(`Zod validation failed: ${result.error.message}`);
  }

  return {
    content: result.data,
    meta: {
      stop_reason: msg.stop_reason ?? null,
      output_tokens: msg.usage?.output_tokens ?? null,
      raw_chars: text.length,
    },
  };
}

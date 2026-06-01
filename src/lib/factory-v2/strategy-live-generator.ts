// factory-v2 — Strategy RESULT content generator for REAL visitor answers.
//
// Step B variant of strategy-content-generator.ts. That file is the PROVEN,
// committed proof generator and is HARDCODED to the Whitmore & Boudreaux sample
// answers; it is left UNTOUCHED. This file is the parameterized sibling the
// wizard needs: it takes the visitor's REAL answers and runs the SAME proven
// pattern (prompt-schema.md §5 streaming → §6 truncation guard → §2.1
// plain-text JSON parse → Zod validate). It reuses buildStrategyLivePrompt
// (already parameterized) and StrategyLiveContentSchema verbatim.
//
// max_tokens 6000, model claude-opus-4-8 — matching the proof generator.

import Anthropic from '@anthropic-ai/sdk';
import { StrategyLiveContentSchema, type StrategyLiveContent } from './strategy-content-schema';
import { buildStrategyLivePrompt, type SampleAnswer } from './strategy-live-prompt';

const STRATEGY_LIVE_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 6000;

export class StrategyLiveError extends Error {
  constructor(message: string) {
    super(`factory-v2 strategy live generation: ${message}`);
    this.name = 'StrategyLiveError';
  }
}

export interface LiveGenerateResult {
  content: StrategyLiveContent;
  meta: {
    stop_reason: string | null;
    output_tokens: number | null;
    raw_chars: number;
  };
}

export async function generateStrategyContentFromAnswers(
  apiKey: string,
  business: { name: string; summary: string },
  answers: SampleAnswer[],
): Promise<LiveGenerateResult> {
  // No-fallbacks: real answers are load-bearing. Halt loudly if absent.
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new StrategyLiveError('no visitor answers supplied');
  }
  const answered = answers.filter((a) => a && typeof a.answer === 'string' && a.answer.trim().length > 0);
  if (answered.length === 0) {
    throw new StrategyLiveError('every visitor answer was empty');
  }

  const client = new Anthropic({ apiKey, timeout: 90_000 });
  const { system, user } = buildStrategyLivePrompt({ business, answers: answered });

  // §5 streaming + finalMessage (keeps the Worker connection live).
  const stream = client.messages.stream({
    model: STRATEGY_LIVE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();

  // §6 truncation guard.
  if (msg.stop_reason === 'max_tokens') {
    throw new StrategyLiveError(
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
    throw new StrategyLiveError(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)} — head: ${text.slice(0, 120)}`,
    );
  }

  const result = StrategyLiveContentSchema.safeParse(parsed);
  if (!result.success) {
    throw new StrategyLiveError(`Zod validation failed: ${result.error.message}`);
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

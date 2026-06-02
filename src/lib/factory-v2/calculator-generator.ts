// factory-v2 — Calculator BUILD-spec generator (LLM call, build-time once).
//
// Proven pattern (prompt-schema.md): §5 streaming → §6 truncation guard → §2.1
// plain-text JSON parse → Zod validate → cross-field validate (incl. the strict
// expression sanitizer) → style validate. Opus 4.8, max_tokens 6000. Retry up to
// 3× on a parse/validation failure (fresh call each time) before failing loudly.

import Anthropic from '@anthropic-ai/sdk';
import {
  CalculatorBuildSpecSchema,
  validateCalculatorSpec,
  CalculatorSpecError,
  type CalculatorBuildSpec,
} from './calculator-spec-schema';
import { buildCalculatorBuildPrompt } from './calculator-build-prompt';
import { validateCalculatorStyle } from './calculator-recipe';

const CALCULATOR_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 6000;
const MAX_ATTEMPTS = 3;

export class CalculatorGenError extends Error {
  constructor(message: string) {
    super(`factory-v2 calculator generation: ${message}`);
    this.name = 'CalculatorGenError';
  }
}

export interface CalculatorGenResult {
  spec: CalculatorBuildSpec;
  meta: { attempts: number; output_tokens: number | null };
}

export async function generateCalculatorSpec(
  apiKey: string,
  business: { name: string; summary: string },
): Promise<CalculatorGenResult> {
  const client = new Anthropic({ apiKey, timeout: 90_000 });
  const { system, user } = buildCalculatorBuildPrompt({ business });

  let lastErr = '';
  let lastTokens: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const stream = client.messages.stream({
      model: CALCULATOR_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const msg = await stream.finalMessage();
    lastTokens = msg.usage?.output_tokens ?? null;

    if (msg.stop_reason === 'max_tokens') {
      lastErr = `output truncated (stop_reason=max_tokens, max_tokens=${MAX_TOKENS})`;
      continue;
    }

    const block = msg.content[0];
    const text = block && block.type === 'text' ? (block as { text: string }).text : '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    } catch (err) {
      lastErr = `JSON.parse failed: ${err instanceof Error ? err.message : String(err)} — head: ${text.slice(0, 120)}`;
      continue;
    }

    const zres = CalculatorBuildSpecSchema.safeParse(parsed);
    if (!zres.success) {
      lastErr = `Zod validation failed: ${zres.error.message.slice(0, 300)}`;
      continue;
    }

    try {
      validateCalculatorSpec(zres.data); // cross-field + the strict expression sanitizer (throws)
      validateCalculatorStyle(zres.data.style); // token picks ∈ each component's supported[]
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      continue;
    }

    return { spec: zres.data, meta: { attempts: attempt, output_tokens: lastTokens } };
  }

  throw new CalculatorGenError(`failed after ${MAX_ATTEMPTS} attempts — last error: ${lastErr}`);
}

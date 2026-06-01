// factory-v2 — Assessment BUILD-spec generator (LLM call, build-time once).
//
// Proven pattern (prompt-schema.md): §5 streaming → §6 truncation guard →
// §2.1 plain-text JSON parse → Zod validate → cross-field validate. Opus 4.8,
// max_tokens 6000. Because the spec carries arithmetic constraints (max_score,
// contiguous bands) the LLM can get slightly wrong, we retry up to 3× on a
// parse/validation failure (each retry is a fresh call) before failing loudly.

import Anthropic from '@anthropic-ai/sdk';
import {
  AssessmentBuildSpecSchema,
  validateAssessmentSpec,
  AssessmentSpecError,
  type AssessmentBuildSpec,
} from './assessment-spec-schema';
import { buildAssessmentBuildPrompt } from './assessment-build-prompt';

const ASSESSMENT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 6000;
const MAX_ATTEMPTS = 3;

export class AssessmentGenError extends Error {
  constructor(message: string) {
    super(`factory-v2 assessment generation: ${message}`);
    this.name = 'AssessmentGenError';
  }
}

export interface AssessmentGenResult {
  spec: AssessmentBuildSpec;
  meta: { attempts: number; output_tokens: number | null };
}

export async function generateAssessmentSpec(
  apiKey: string,
  business: { name: string; summary: string },
): Promise<AssessmentGenResult> {
  const client = new Anthropic({ apiKey, timeout: 90_000 });
  const { system, user } = buildAssessmentBuildPrompt({ business });

  let lastErr = '';
  let lastTokens: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // §5 streaming + finalMessage.
    const stream = client.messages.stream({
      model: ASSESSMENT_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const msg = await stream.finalMessage();
    lastTokens = msg.usage?.output_tokens ?? null;

    // §6 truncation guard.
    if (msg.stop_reason === 'max_tokens') {
      lastErr = `output truncated (stop_reason=max_tokens, max_tokens=${MAX_TOKENS})`;
      continue;
    }

    const block = msg.content[0];
    const text = block && block.type === 'text' ? (block as { text: string }).text : '';

    // §2.1 plain-text JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    } catch (err) {
      lastErr = `JSON.parse failed: ${err instanceof Error ? err.message : String(err)} — head: ${text.slice(0, 120)}`;
      continue;
    }

    const zres = AssessmentBuildSpecSchema.safeParse(parsed);
    if (!zres.success) {
      lastErr = `Zod validation failed: ${zres.error.message.slice(0, 300)}`;
      continue;
    }

    try {
      validateAssessmentSpec(zres.data); // cross-field (no-fallbacks): throws on any rule break
    } catch (err) {
      lastErr = err instanceof AssessmentSpecError ? err.message : String(err);
      continue;
    }

    return { spec: zres.data, meta: { attempts: attempt, output_tokens: lastTokens } };
  }

  throw new AssessmentGenError(`failed after ${MAX_ATTEMPTS} attempts — last error: ${lastErr}`);
}

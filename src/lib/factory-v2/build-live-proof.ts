// factory-v2 — LIVE proof builder (run once, not wired to anything).
//
//   npx tsx src/lib/factory-v2/build-live-proof.ts
//
// Proves the full chain:
//   LLM (Opus 4.8) → CONTENT only → Zod validate → map onto the LOCKED
//   Strategy result recipe → factory-v2 assembler → 100% catalog-composed
//   HTML → shell + container frame → static /dev/ page.
//
// Writes ../textos-web/public/dev/factory-strategy-live.html (NEW file).
// The throw-on-unknown-id guard in assemble.ts stays active as the safety net.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateStrategyContent } from './strategy-content-generator';
import { buildStrategyResultComposition } from './strategy-result-recipe';
import { assembleComposition } from './assemble';
import { wrapProofDocument } from './document-shell';

// ANTHROPIC_API_KEY from .dev.vars (Node has no Worker Env binding).
function loadApiKey(): string {
  const raw = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  throw new Error('ANTHROPIC_API_KEY not found in .dev.vars');
}

const apiKey = loadApiKey();

// 1. LLM → content only → validated.
const { content, meta } = await generateStrategyContent(apiKey);

// 2. Map content onto the locked recipe (LLM never chose components).
const composition = buildStrategyResultComposition(content);

// 3. Assemble 100% from the catalog (throws on any unknown id).
const { html: inner, rendered_ids } = assembleComposition(composition);

// 4. Wrap in shell + container frame; write the static page.
const doc = wrapProofDocument(inner);
const outPath = resolve(process.cwd(), '..', 'textos-web', 'public', 'dev', 'factory-strategy-live.html');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, doc, 'utf8');

// 5. Report — including whether the result reflects the W&B specifics.
const haystack = JSON.stringify(content).toLowerCase();
const specifics = {
  'gluten-free': /gluten/.test(haystack),
  'staffed station': /staffed|station|attendant/.test(haystack),
  'Dec 18': /(december|dec\.?)\s*18|dec 18/.test(haystack),
  'guest 60-150': /60/.test(haystack) && /150/.test(haystack),
  'Cajun / South Louisiana': /cajun|louisiana|bayou/.test(haystack),
};

console.log('[factory-v2 live] LLM meta:', JSON.stringify(meta));
console.log('[factory-v2 live] headline:', content.headline);
console.log('[factory-v2 live] sections:', content.sections.length, '| action_items:', content.action_items.length);
console.log('[factory-v2 live] composed ids:', rendered_ids.join(', '));
console.log('[factory-v2 live] document bytes:', doc.length);
console.log('[factory-v2 live] W&B specifics reflected:', JSON.stringify(specifics));
console.log('[factory-v2 live] wrote:', outPath);

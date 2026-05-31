// factory-v2 — proof builder (run once, not wired to anything).
//
//   npx tsx src/lib/factory-v2/build-proof.ts
//
// Assembles the hardcoded Strategy composition 100% from the existing Homer
// catalog, wraps it in the minimal shell, and writes the result as a NEW
// static file in the textos-web repo:
//   ../textos-web/public/dev/factory-strategy-proof.html
// Cloudflare Pages serves that file directly — no routing/config change.
//
// It also runs a self-check proving that an unknown component_id THROWS
// (no silent skip / fallback), which is the other half of the proof.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assembleComposition, UnknownComponentError } from './assemble';
import { STRATEGY_PROOF_COMPOSITION } from './strategy-composition';
import { wrapProofDocument } from './document-shell';

// 1. Compose the real strategy result from catalog components.
const { html: inner, rendered_ids } = assembleComposition(STRATEGY_PROOF_COMPOSITION);
const doc = wrapProofDocument(inner);

// 2. Self-check: an unknown component_id must throw, not skip.
let throwProof = 'NOT THROWN (BUG)';
try {
  assembleComposition([{ component_id: 'definitely-not-a-real-component', slot_values: {} }]);
} catch (err) {
  if (err instanceof UnknownComponentError) {
    throwProof = `threw UnknownComponentError → ${err.message}`;
  } else {
    throwProof = `threw ${(err as Error).name}: ${(err as Error).message}`;
  }
}

// 3. Write the static page into textos-web/public/dev/.
const outPath = resolve(process.cwd(), '..', 'textos-web', 'public', 'dev', 'factory-strategy-proof.html');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, doc, 'utf8');

// 4. Report.
console.log('[factory-v2] composed blocks (in order):', rendered_ids.join(', '));
console.log('[factory-v2] document bytes:', doc.length);
console.log('[factory-v2] unknown-id self-check:', throwProof);
console.log('[factory-v2] wrote:', outPath);

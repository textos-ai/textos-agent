// Main assembler entry point.
//   assembleApp(input) → output
// Pure function: same inputs → same output. No network, no DB, no LLM
// call. The caller validates upstream that input.content came from an
// LLM run against the matching archetype; the assembler validates the
// shape with Zod + cross-field rules before composing.

import { getArchetype } from '../archetypes/index';
import { validateContent } from './validation/index';
import { renderPhase } from './phase-renderer';
import { wrapDocument } from './document-wrapper';
import { AssemblerError, type AssemblerInput, type AssemblerOutput, type AssemblyManifest } from './types';

export function assembleApp(input: AssemblerInput): AssemblerOutput {
  // 1. Archetype lookup.
  const archetype = getArchetype(input.archetype_id);
  if (!archetype) {
    throw new AssemblerError(
      'unknown_archetype',
      `Unknown archetype_id: ${input.archetype_id}`,
      { archetype_id: input.archetype_id },
    );
  }

  // 2. Validate the LLM content payload (throws on failure).
  const { content: validated_content, warnings } = validateContent(
    input.archetype_id,
    input.content,
  );

  // 3. Set up resolver context.
  const resolver_ctx = {
    content: validated_content,
    // computed is not populated at assembler time — only the visitor's
    // browser sees concrete computed values. Phase rendering treats
    // computed.* paths as resolvable to opaque slot identifiers that
    // the emitted runtime JS later fills in. For Brief B the result-
    // phase HTML carries placeholder spans the runtime patches.
    computed: undefined,
    business_context: input.business_context,
  };

  // 4. Initialize manifest.
  const manifest: AssemblyManifest = {
    archetype_id: archetype.id,
    rendered_components: [],
    candidate_selections: [],
    css_dependencies: [],
    js_dependencies: [],
    html_bytes: 0,
  };

  // 5. Render every phase in archetype order.
  const phase_chunks: string[] = [];
  for (const phase of archetype.phases) {
    const chunk = renderPhase({
      archetype,
      phase,
      resolver_ctx,
      manifest,
      warnings,
    });
    phase_chunks.push(chunk);
  }

  // 6. Wrap in the full document shell.
  const html = wrapDocument({
    archetype,
    validated_content,
    input,
    manifest,
    phase_chunks,
  });

  manifest.html_bytes = html.length;

  return {
    html,
    validation_warnings: warnings,
    manifest,
  };
}

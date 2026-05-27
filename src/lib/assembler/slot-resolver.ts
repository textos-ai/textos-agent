// Slot resolution — walks dotted paths against the layered context
// (content + computed + business_context) and returns a structured
// result that distinguishes:
//   - a real value
//   - a literal placeholder that needs business-context substitution
//   - a missing-source case (consumers decide whether that's fatal)
//
// Path grammar:
//   foo            → ctx.foo
//   foo.bar        → ctx.foo.bar
//   foo[0]         → ctx.foo[0]
//   foo[0].bar     → ctx.foo[0].bar
//
// Top-level path prefixes select which layer to resolve from:
//   'content.*'           → input.content
//   'computed.*'          → input.computed (Assessment/Calculator only)
//   'business.*'          → input.business_context
//   bare 'foo' / 'foo.*'  → input.content (default layer is content)
//
// LITERAL PLACEHOLDERS:
//   The string 'cta_url_placeholder' (verbatim, no dots) is treated as a
//   sentinel — resolves to business_context.operator_url. This matches
//   the contract in the archetype content_schema: the LLM emits the
//   literal string 'cta_url_placeholder' as the value, the assembler
//   swaps it in for the operator URL.

export type ResolverContext = {
  content: unknown;
  computed?: unknown;
  business_context: {
    slug: string;
    name: string;
    operator_url: string;
    accent_color_hex?: string;
  };
};

export type ResolverResult =
  | { kind: 'resolved'; value: unknown }
  | { kind: 'placeholder'; value: string }
  | { kind: 'missing'; path: string };

const LITERAL_PLACEHOLDERS: Record<string, (ctx: ResolverContext) => string> = {
  cta_url_placeholder: (ctx) => ctx.business_context.operator_url,
};

/** Resolve a single path or literal placeholder against the context. */
export function resolveSlot(path: string, ctx: ResolverContext): ResolverResult {
  if (typeof path !== 'string') {
    return { kind: 'missing', path: String(path) };
  }

  // Literal placeholder check — case-sensitive, exact match.
  if (LITERAL_PLACEHOLDERS[path]) {
    return { kind: 'placeholder', value: LITERAL_PLACEHOLDERS[path](ctx) };
  }

  // Tokenize the path into segments. Supports `foo[0].bar` style.
  const segments = tokenize(path);
  if (segments.length === 0) return { kind: 'missing', path };

  // Pick starting layer.
  let cursor: unknown;
  let start = 0;
  if (segments[0] === 'content') {
    cursor = ctx.content;
    start = 1;
  } else if (segments[0] === 'computed') {
    cursor = ctx.computed;
    start = 1;
  } else if (segments[0] === 'business') {
    cursor = ctx.business_context;
    start = 1;
  } else {
    cursor = ctx.content; // default layer
  }

  for (let i = start; i < segments.length; i++) {
    const seg = segments[i];
    if (cursor == null) return { kind: 'missing', path };
    if (typeof seg === 'number') {
      if (!Array.isArray(cursor)) return { kind: 'missing', path };
      cursor = (cursor as unknown[])[seg];
    } else {
      if (typeof cursor !== 'object') return { kind: 'missing', path };
      cursor = (cursor as Record<string, unknown>)[seg];
    }
  }
  if (cursor === undefined) return { kind: 'missing', path };
  // Post-resolution sentinel substitution: the LLM's content_schema asks
  // for the literal string 'cta_url_placeholder' as the value of any CTA
  // URL field, on the contract that the assembler swaps it for the real
  // operator URL at render time (the LLM never sees the operator URL).
  if (typeof cursor === 'string' && LITERAL_PLACEHOLDERS[cursor]) {
    return { kind: 'placeholder', value: LITERAL_PLACEHOLDERS[cursor](ctx) };
  }
  return { kind: 'resolved', value: cursor };
}

/** Split a path like 'foo[0].bar' into ['foo', 0, 'bar']. */
function tokenize(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') { i++; continue; }
    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) return []; // malformed
      const idx = Number(path.slice(i + 1, close));
      if (!Number.isFinite(idx)) return [];
      out.push(idx);
      i = close + 1;
      continue;
    }
    // Bare identifier segment.
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    out.push(path.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Resolve every entry in a slot_bindings map. Returns a record from slot
 * name to resolved value (or undefined when missing). Caller passes the
 * resolved record to the template engine. Missing required values get
 * surfaced via the returned `missing_slots` array.
 */
export function resolveSlotBindings(
  bindings: Record<string, string>,
  ctx: ResolverContext,
): { resolved: Record<string, unknown>; missing_slots: string[] } {
  const resolved: Record<string, unknown> = {};
  const missing_slots: string[] = [];
  for (const [slotName, path] of Object.entries(bindings)) {
    const r = resolveSlot(path, ctx);
    if (r.kind === 'missing') {
      missing_slots.push(slotName);
      continue;
    }
    resolved[slotName] = r.value;
  }
  return { resolved, missing_slots };
}

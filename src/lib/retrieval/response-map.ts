// Response-map evaluator for the external-retrieval engine.
//
// Normalizes an arbitrary external API payload into the canonical lead shape
// using ONLY declarative config (external_apis.metadata.response_map) — no
// platform-specific code. A platform is fully described by:
//   { items: "<dot-path to the array>",
//     fields: { title, url, snippet, published_at, external_id -> spec },
//     transforms?: { <field>: "<named transform>" } }
//
// A field spec is either:
//   • a plain dot-path ("record.text") — optionally post-processed by
//     transforms[field], OR
//   • a template ("https://x/{{author.did}}/{{uri | after_last:/}}") rendered
//     against the RAW item, with a small generic filter set after each pipe.
//
// Every transform/filter here is generic (protocol-level, reusable by any
// platform). None names a platform.

export interface RetrievalItem {
  title: string | null;
  url: string | null;
  snippet: string | null;
  published_at: string | null; // ISO-8601
  external_id: string | null;
  source: string;
}

export interface ResponseMapSpec {
  items: string;
  fields: Record<string, string>;
  transforms?: Record<string, string>;
}

/** Traverse an object/array by a dotted path. Supports numeric array indices. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((v, k) => {
    if (v == null || typeof v !== "object") return undefined;
    return (v as Record<string, unknown>)[k];
  }, obj);
}

/**
 * Apply one generic filter/transform to a value. Form: "name" or "name:arg".
 * Throws on an unknown name (no silent fallback).
 */
export function applyFilter(value: unknown, spec: string): unknown {
  const idx = spec.indexOf(":");
  const name = (idx === -1 ? spec : spec.slice(0, idx)).trim();
  const arg = idx === -1 ? "" : spec.slice(idx + 1);
  switch (name) {
    case "unix_seconds_to_iso": {
      const n = Number(value);
      return isFinite(n) ? new Date(n * 1000).toISOString() : null;
    }
    case "unix_ms_to_iso": {
      const n = Number(value);
      return isFinite(n) ? new Date(n).toISOString() : null;
    }
    case "after_last":
      return value == null ? null : String(value).split(arg).pop() ?? null;
    case "before_last": {
      if (value == null) return null;
      const s = String(value);
      const at = s.lastIndexOf(arg);
      return at === -1 ? s : s.slice(0, at);
    }
    case "after_first": {
      if (value == null) return null;
      const s = String(value);
      const at = s.indexOf(arg);
      return at === -1 ? s : s.slice(at + arg.length);
    }
    case "prefix":
      return value == null ? null : `${arg}${String(value)}`;
    case "suffix":
      return value == null ? null : `${String(value)}${arg}`;
    case "truncate": {
      const n = parseInt(arg, 10) || 0;
      const s = value == null ? "" : String(value);
      return n > 0 ? s.slice(0, n) : s;
    }
    case "default":
      return value == null || value === "" ? arg : value;
    default:
      throw new Error(`response_map_unknown_transform: '${name}'`);
  }
}

/** Render a template against a raw item, supporting "{{ path | filter:arg }}". */
function renderItemTemplate(tpl: string, item: unknown): string {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const parts = expr.split("|").map((s) => s.trim());
    let v: unknown = getPath(item, parts[0]);
    for (let i = 1; i < parts.length; i++) v = applyFilter(v, parts[i]);
    return v == null ? "" : String(v);
  });
}

function coerce(value: unknown): string | null {
  if (value == null || value === "") return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Resolve one field spec (template or plain dot-path + optional transform). */
function resolveField(
  raw: unknown,
  spec: string,
  transform: string | undefined,
): string | null {
  if (/\{\{/.test(spec)) return coerce(renderItemTemplate(spec, raw));
  let v = getPath(raw, spec);
  if (transform) v = applyFilter(v, transform);
  return coerce(v);
}

/** Map a raw payload into canonical lead items using the declared response_map. */
export function applyResponseMap(
  payload: unknown,
  map: ResponseMapSpec,
  source: string,
): RetrievalItem[] {
  const arr = getPath(payload, map.items);
  if (!Array.isArray(arr)) return [];
  return arr.map((raw) => ({
    title: resolveField(raw, map.fields.title ?? "", map.transforms?.title),
    url: resolveField(raw, map.fields.url ?? "", map.transforms?.url),
    snippet: resolveField(raw, map.fields.snippet ?? "", map.transforms?.snippet),
    published_at: resolveField(
      raw,
      map.fields.published_at ?? "",
      map.transforms?.published_at,
    ),
    external_id: resolveField(
      raw,
      map.fields.external_id ?? "",
      map.transforms?.external_id,
    ),
    source,
  }));
}

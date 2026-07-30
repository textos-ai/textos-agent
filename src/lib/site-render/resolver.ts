// The field resolver — three kinds of field, three behaviours.
//
//   DERIVED       Not stored. Resolved at render from business facts via
//                 source_path. Always current by construction; cannot drift.
//   OVERRIDDEN    A stored site_fields row that ALSO has a source_path. The
//                 stored value wins; context_snapshot records what the derived
//                 value was when the override was taken.
//   SITE_AUTHORED A stored site_fields row with no source_path (hero copy,
//                 positioning prose). Nothing to align against.
//
// The derivation map is data, read from site_templates.field_derivation_map
// (seeded in migration 092). This module does not restate it.

import {
  type SiteFacts,
  MissingFactError,
  resolveSourcePath,
} from "./facts";

export type FieldKind = "derived" | "overridden" | "site_authored" | "absent";

export interface StoredField {
  field_key: string;
  value_text: string | null;
  value_json: unknown;
  source_path: string | null;
}

export interface DerivationMap {
  site_fields?: Record<string, { derives_from?: string; site_authored?: boolean; note?: string }>;
  collections?: Record<string, unknown>;
  sections?: unknown;
}

export interface Resolved {
  kind: FieldKind;
  value: unknown;
  source_path: string | null;
}

export class FieldResolver {
  private stored = new Map<string, StoredField>();

  constructor(
    stored: StoredField[],
    private readonly map: DerivationMap,
    private readonly facts: SiteFacts,
  ) {
    for (const f of stored) this.stored.set(f.field_key, f);
  }

  /** Full resolution record — kind, value, and the path it came from. */
  resolve(fieldKey: string): Resolved {
    const s = this.stored.get(fieldKey);
    if (s) {
      const value = s.value_json !== null && s.value_json !== undefined ? s.value_json : s.value_text;
      if (value !== null && value !== undefined && value !== "") {
        return {
          // A stored value with a source_path is an override of a derived field.
          kind: s.source_path ? "overridden" : "site_authored",
          value,
          source_path: s.source_path,
        };
      }
    }

    const entry = this.map.site_fields?.[fieldKey];
    if (entry?.derives_from) {
      const value = resolveSourcePath(entry.derives_from, this.facts);
      if (value === undefined) {
        return { kind: "absent", value: undefined, source_path: entry.derives_from };
      }
      return { kind: "derived", value, source_path: entry.derives_from };
    }

    return { kind: "absent", value: undefined, source_path: null };
  }

  /** Value or undefined. Use where an absent field means "omit this element". */
  get<T = unknown>(fieldKey: string): T | undefined {
    const r = this.resolve(fieldKey);
    return r.value as T | undefined;
  }

  /** Value or a caller-supplied literal. ONLY for cosmetic labels that carry no
   *  factual claim (e.g. a CTA verb). Never for a fact about the business. */
  label(fieldKey: string, literal: string): string {
    const v = this.get<string>(fieldKey);
    return typeof v === "string" && v.trim() !== "" ? v : literal;
  }

  /** Value or halt. Use for anything the page cannot honestly render without. */
  require<T = unknown>(fieldKey: string): T {
    const r = this.resolve(fieldKey);
    if (r.value === undefined || r.value === null || r.value === "") {
      throw new MissingFactError(fieldKey, r.source_path);
    }
    return r.value as T;
  }
}

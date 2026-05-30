# TypeScript contract rules (textos-agent backend)

Relocated from the root `CLAUDE.md`. These govern row types, error
shapes, and service-function signatures in `src/services/` and
`src/routes/`. Backend-only — these do not apply to textos-web.

---

## `BaseRow` interface (all new row types)

All new row interfaces extend `BaseRow` or `MutableRow`. Define in
`src/services/supabase.ts` before adding a new row type.

```ts
export interface BaseRow {
  id: string;          // uuid
  created_at: string;  // timestamptz
}
export interface MutableRow extends BaseRow {
  updated_at: string;  // timestamptz
}
```

Existing row types (`BusinessRow`, `UserRow`, …) should migrate to
extend `BaseRow` in a **separate cleanup pass** — not mid-feature.

---

## Route handler error shape — `errBody()` everywhere

Every route handler returns `errBody()` on error paths. Never return
ad-hoc JSON on error; never throw without catching.

```ts
import { errBody } from '../lib/errors.js';

return c.json(errBody('not_found',   'Business not found'), 404);
return c.json(errBody('bad_request', 'Slug is required'),   400);
return c.json(errBody('internal',    'Database write failed'), 500);
```

`ErrorCode` values: `bad_request`, `not_found`, `conflict`,
`internal`, `upstream_error`, `unauthorized`, `forbidden`,
`rate_limited`, `not_configured`.

---

## Function signature consistency (service functions)

```ts
export async function doThing(
  client: SupabaseClient,
  param1: string,
  param2: number,
): Promise<ThingRow> {
  const { data, error } = await client.from('things')...
  if (error) throw error;
  return data as ThingRow;
}
```

Rules:
- First param is always `SupabaseClient`.
- Return typed promises, never `any`.
- Throw on error — never return error objects.
- Named exports only — no default exports from service files.

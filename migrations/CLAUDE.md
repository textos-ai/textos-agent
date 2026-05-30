# CLAUDE.md — migrations (`textos-agent/migrations/`)

You are in the **active** migrations directory. SQL here is applied to
Supabase Postgres. You write migrations; **Rob applies them manually**
via the Supabase dashboard SQL editor. Never claim a migration is
"applied" — you can only say it's written and ready.

---

## Two migration directories — this one is authoritative

- **`migrations/`** (here) — active, `NNN_description.sql`, currently
  through `041_*`. **Add new migrations here.** Next file = `042_*`.
- **`supabase/migrations/`** — the original Sprint 2–3 timestamped set
  (`2026…_*.sql`). Historical. **Do not add new files there.**

The repo-root CLAUDE.md's "Source layout" still points at
`supabase/migrations/` — that's stale; trust this file.

---

## Filename + header

`NNN_short_description.sql`, zero-padded, next sequential number.
Every migration opens with a header block, modeled on the existing
files (see `024_subscriptions_tokens.sql`):

```sql
-- =====================================================================
-- Migration 042: <what it does>
-- =====================================================================
-- Source: <spec/brief name + date>
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE.
-- =====================================================================
```

---

## Idempotency — every migration must be safe to re-run

Rob may run a file more than once. Use:
- `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `ALTER TYPE … ADD VALUE IF NOT EXISTS`, `ON CONFLICT … DO UPDATE`.
- Enums via the guard block:
  ```sql
  DO $$ BEGIN
    CREATE TYPE my_enum AS ENUM ('a','b');
  EXCEPTION WHEN duplicate_object THEN null;
  END $$;
  ```

## RLS — on every user-visible table

```sql
ALTER TABLE public.my_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own rows"
  ON public.my_table FOR SELECT
  USING (user_id = auth.uid());
```
The Worker uses the service-role key and bypasses RLS by design;
frontend reads use the anon key + JWT and hit these policies as
`authenticated`. A user-visible table without RLS is a security bug.

## UUID default — new tables use `gen_random_uuid()`

**New tables use `gen_random_uuid()`** — built into Postgres 13+, no
extension dependency. This is the standard for all new work.

Legacy note: older migrations use `uuid_generate_v4()` (requires the
`uuid-ossp` extension — e.g. `024_subscriptions_tokens.sql`). Leave
existing tables as-is; do NOT churn them to switch. Only **new** tables
are held to the `gen_random_uuid()` standard. When you `ALTER` an
existing table, match that table's existing default rather than mixing
the two functions on one table.

---

## Verification queries — append as trailing comments

Every migration ends with commented verification SQL Rob can paste
after applying (pattern from `024`):
```sql
-- Confirm column:   SELECT column_name, data_type, column_default
--                   FROM information_schema.columns
--                   WHERE table_name='x' AND column_name='y';
-- Confirm enum:     SELECT enum_range(NULL::my_enum);
-- Confirm RLS:      SELECT tablename, rowsecurity FROM pg_tables
--                   WHERE schemaname='public' AND tablename='x';
-- Confirm function: SELECT routine_name, security_type
--                   FROM information_schema.routines WHERE routine_name='f';
-- Confirm rows:     SELECT count(*) ...
```

## Self-review before handing a migration to Rob (17-point)

1. Filename `NNN_` is the next sequential number, in `migrations/`.
2. Header block present (title, source, Apply-via URL, re-run note).
3. Every `CREATE TABLE` is `IF NOT EXISTS`.
4. Every `ADD COLUMN` is `IF NOT EXISTS`.
5. Every `CREATE INDEX` is `IF NOT EXISTS`.
6. Enums created via the `DO $$ … duplicate_object` guard.
7. Functions are `CREATE OR REPLACE`, `SECURITY DEFINER` where they
   must bypass RLS, justified in a comment.
8. RLS enabled on every new user-visible table.
9. A `SELECT` policy (at least) exists for each RLS table.
10. New tables use `gen_random_uuid()`; an `ALTER` to an existing
    table matches that table's existing default (see UUID section).
11. FKs declare `ON DELETE` behavior intentionally.
12. `CHECK` constraints on every status/enum-ish text column.
13. No `DROP TABLE` / `DROP COLUMN` / `DELETE` without an explicit,
    written acknowledgement from Rob in the brief (see below).
14. Seed/backfill `UPDATE`s are scoped and idempotent (`ON CONFLICT`).
15. Indexes exist for every column used in a hot `WHERE`/`ORDER BY`.
16. Trailing verification queries cover the new objects.
17. `task_runs` gotcha respected: there is **no `created_at`** on
    `task_runs` — use `started_at` (per `006_add_task_states.sql`).

## Destructive statements — gated

No `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or unscoped `DELETE`
unless the brief explicitly authorizes it. These are not reversible
once Rob runs them in prod. Surface the need; don't bury it in a
migration.

## Connection (for reference; Rob applies via dashboard, not CLI)

If a pooled connection is ever needed, it's the **Supavisor v2 session
pooler**: `aws-1-us-east-1.pooler.supabase.com:5432` — **NOT**
`aws-0-…`, and **NOT** the direct `db.<ref>.supabase.co` host
(IPv6-only on the free tier). The normal path is the dashboard SQL
editor.

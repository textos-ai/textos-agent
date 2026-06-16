# Backlog — Task Admin: editable fields for newer task properties

**Status:** Capture / backlog. Not scheduled.
**Purpose:** The task admin panel needs UI to edit several task properties that
have been added/surfaced recently. Right now these are only editable via SQL,
which means content management requires a developer + direct DB access. Rob
should be able to manage this content himself in the admin.

---

## The immediate ask

**`tasks.progress_verb`** (text) — the present-tense running phrase shown on the
card/tray while a task runs (e.g. "Designing your logo…", "Sizing your
market…"). Rob needs a field in the task admin to **edit progress_verb per
task** — write/change the phrase, and handle the NULL case (some tasks have no
phrase). Without an editor, every phrase tweak is a SQL update.

## Broaden it — other recently-added task fields that also need admin editing

While building the progress_verb editor, the same admin task-edit form should
cover the other newer per-task fields that currently require SQL. Audit and add
editors for (confirm which already exist in admin vs. which are missing):

- **`progress_verb`** (text) — running phrase. *(the immediate ask)*
- **Objectives** (`task_objectives` join → the 8 objectives) — assign/unassign
  which objective(s) a task belongs to (multi-select). *Already noted as a
  separate backlog item ("task-admin objectives editor"); fold together.*
- **`is_featured`** (bool) — the ★ TOP gold badge. Toggle per task. Rob already
  needs to TRIM the currently-11 featured tasks down to a real flagship few, so
  a toggle in admin is the clean way (vs SQL). *(Admin reportedly already
  reads/writes is_featured — confirm it's actually editable in the UI.)*
- **`is_long_running`** (bool) — flags tasks expected to take a while (may tune
  the "taking longer than usual" cue / timeout). Toggle per task.
- **cancel/controllable bool** (the `*_controllable` column seen next to
  progress_verb) — whether a task is cancellable. Toggle per task.
- **`lifecycle_phase_id`** — re-home mis-phased tasks (e.g. investor tasks
  currently in Foundation). A phase selector in admin would let Rob fix phase
  placement without SQL. *(Also a separate backlog item — "re-home mis-phased
  tasks"; an admin phase-selector enables it.)*
- **`status`** (active / draft / deprecated) — already managed? Confirm.
- **`description_short`**, **`token_cost`**, **`execution_order`** — confirm
  these are already editable; if not, include.

## Why this matters

Victora's task catalog is content Rob curates (which tasks exist, what they're
called, what objective they serve, what they say while running, which are
featured/cancellable/long-running, what phase they're in). All of that is
**editorial content**, not code — so it belongs in an admin UI Rob controls, not
in migrations. Each time a new task property is added (objectives, progress_verb,
is_featured, is_long_running…), the admin should gain an editor for it, or the
property becomes SQL-only and unmanageable.

## Suggested approach (when taken up)

1. Recon the existing task-admin edit form (`/admin` task editor) — list which
   task fields it ALREADY exposes for editing vs. which are missing.
2. Add the missing field editors, prioritizing progress_verb (immediate),
   objectives (multi-select), is_featured (toggle), is_long_running +
   controllable (toggles), lifecycle_phase (selector).
3. NULL handling for progress_verb (allow clearing → NULL → honest generic
   "Running" fallback on the card).
4. Respect RLS / admin-gating (the admin is platform-admin-only, via
   /admin/me is_admin).

## Related backlog items to fold in

- "Task-admin objectives editor" (assign objectives per task) — same form.
- "Re-home mis-phased tasks" (enabled by a phase selector in admin).
- "Trim the 11 featured tasks" (enabled by an is_featured toggle in admin).

---

*Capture note. Turn into a real spec (recon the existing admin form first) before
building.*

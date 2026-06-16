# Multi-User & Roles — Future Architecture Note

**Status:** Idea capture, NOT a spec. Nothing here is decided or scheduled.
**Purpose:** Record the multi-user / role-assignment concept so it isn't lost, and
enumerate the open questions and architectural implications before any build.

---

## The idea (as raised)

Today a Victora business has effectively one owner. We want to support **more than
one person on a single business**, where additional people can have a **lesser role**
than the owner — restricted from certain actions. The motivating example:

- The **owner** can do everything, including **consuming tokens** (spending money).
- A **lesser role** (collaborator / member / viewer) can do some things but is
  **restricted from token-consuming actions** (and possibly other sensitive things
  like billing, deleting, or changing the business identity).

The token-consumption restriction is the key driver: **spending money should be gated
by role.** A teammate can view the business, read documents, maybe draft, but should
not be able to burn the owner's token balance without permission.

---

## Why this is non-trivial (touches several systems)

Multi-user + roles is not a single feature — it cuts across:

1. **Auth / identity** — today a session maps to one user who owns the business.
   Multi-user means a **business has many users**, each with a **role**, and the JWT /
   session must resolve "which businesses can this user access, and as what role."

2. **Data model** — need a join between users and businesses with a role, e.g. a
   `business_members(business_id, user_id, role, …)` table. The current "owner"
   relationship (likely a direct column on `businesses` or implied by who created it)
   would need to become (or coexist with) this membership model.

3. **RLS (row-level security)** — this is the big one. All our RLS is currently
   "owner SELECT only." With roles, RLS must become **role-aware**: a member can read
   the business's tasks/runs/docs, but only an owner (or token-permitted role) can
   trigger token-spending writes. RLS policies would need to check membership + role,
   not just ownership.

4. **Billing / tokens** — the token balance belongs to the *business* (or the owner's
   billing account). The permission check "can this user spend tokens?" must run
   server-side at the point of spend (the run / enqueue path), gated on role —
   NOT just hidden in the UI. (UI hiding is not security.)

5. **The agent run path** — every place that debits tokens (the orchestrator, the
   configured-task run path, the work-tray enqueue) must enforce the role check
   server-side before spending. This is where "lesser role can't consume tokens"
   actually lives.

6. **UI surfaces** — invite flow, member list, role assignment, and per-action
   gating in the chrome (e.g. a non-spending member sees tasks but the "Run" /
   top-up affordances are disabled or hidden, with an honest "ask the owner" message).

---

## Open questions to decide BEFORE building

- **Role taxonomy.** What are the roles? Minimal proposal: `owner`, `member`,
  `viewer`. Or finer: `owner`, `admin`, `editor`, `member`, `viewer`. Start minimal.
  - Which actions does each role gate? At least: consume tokens (spend), manage
    billing, invite/remove members, edit business identity, delete business, run
    tasks (free vs paid?), view documents, view the business at all.
- **Token spend specifically.** Is "can spend tokens" a property of a role, or a
  separate per-member permission flag? (E.g. a `member` who the owner explicitly
  grants spend rights.) Cleaner to start: role-based (only owner + maybe an
  `admin`/`manager` role can spend).
- **Whose tokens?** The business's balance (shared pool the owner funds), or
  per-user? Almost certainly the **business's shared pool**, funded by the owner —
  which is exactly why spend must be role-gated.
- **Free vs paid tasks for lesser roles.** Can a member run *free* (token_cost 0)
  tasks but not *paid* ones? That's a natural split — gate on `token_cost > 0`,
  not on "running" in general. (Lesser role can run free tasks, cannot run paid.)
- **Invite / onboarding flow.** How does a second person join a business? Email
  invite → they sign in (passwordless, same as today) → membership row created with
  the assigned role. Needs an invite token + acceptance flow.
- **Ownership transfer / multiple owners?** Can there be more than one owner? Can
  ownership transfer? (Defer — start with one owner + lesser members.)
- **Billing identity.** Tokens/Stripe are tied to the owner's customer ID. Members
  don't have their own billing for this business. Confirm the spend always draws on
  the owner's funded balance.

## Architectural implications (high level, for later recon)

- **New table:** `business_members(business_id, user_id, role, created_at, invited_by, …)`.
  The owner is either a row here with role=`owner` or kept as the existing owner
  relationship with members layered alongside — decide during recon.
- **RLS rewrite:** policies move from "user owns business" to "user is a member of
  business" for reads, and "user has a spending/owner role" for token-spending
  writes. This is the most security-sensitive part — get it right, test it hard.
- **Server-side spend gate:** the single source of truth for "can spend" must be a
  backend check at the debit point (reuse / extend wherever token deduction happens —
  the orchestrator + configured-task + enqueue paths). UI gating is cosmetic on top.
- **NO-FALLBACKS:** if a member tries to spend and isn't permitted, return a clear,
  honest 403-shaped response ("this action requires owner permission"), not a silent
  no-op and not a fabricated success.
- **Invite flow:** email invite (SendGrid, passwordless) → membership creation.

## Suggested sequencing (when this is taken up)

1. Recon the current ownership model: how is "owner" represented today
   (`businesses` column? created_by? auth claim?), and where exactly are tokens
   debited (every spend site).
2. Decide the role taxonomy (start minimal: owner + member, with spend gated to owner).
3. Design `business_members` + the RLS rewrite (reads = membership, paid-spend = owner role).
4. Server-side spend gate at every debit point.
5. Invite flow + member-management UI.
6. Chrome gating (hide/disable spend affordances for lesser roles, honest messaging).

## Relationship to existing work

- Ties to the **token economy / Part B** work (the spend/billing paths are where the
  role gate enforces).
- Ties to **RLS** posture already established ("frontend reads, agent writes,
  owner-scoped") — this generalizes owner-scoped to membership+role-scoped.
- The existing **admin** concept (`/admin`, `is_admin` via `/admin/me`) is a
  *platform-level* role (Anthropic/Victora staff), distinct from *business-level*
  roles (owner/member of a specific business). Keep these two separate — platform
  admin ≠ business member role.

---

*This is a capture document. Revisit and turn into a real spec (with recon) before
any implementation.*

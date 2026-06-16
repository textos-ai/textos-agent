# Decision Record 0001 — Victora.ai Publishing Pipeline

**Status:** Decided (architecture pending)
**Date:** 2026-06-12
**Owner handoff:** Victora architect → Victora developer agent
**Context:** xai.fyi command center / Victora.ai autonomous marketing pipeline

---

## Summary

Victora needs a **headless publishing rail** that posts content to social
platforms silently when a business is on autopilot — no UI the end user ever
sees. This record captures the decisions made so they are not re-litigated
during spec writing. The architect writes the spec from here; the developer
agent builds it.

---

## Decisions

### 1. Category: headless / developer-first publishing API
Not a scheduler. The "show users nothing on autopilot" requirement forces this.
Schedulers (Blotato, Publer, Buffer) are UI-first products with an API bolted
on — wrong category. We want an API with no end-user dashboard, built for
embedding social publishing inside our own product.

### 2. Recommended provider: Zernio (fallback: Ayrshare)
Chosen for three reasons specific to Victora:
- **White-label** — end users never see provider branding. Required, since the
  pipeline is invisible and Victora's brand is the product.
- **MCP-native** — ships an MCP server, so the agent connects without a custom
  wrapper. Fits the agent-driven architecture.
- **Per-account pricing that scales down** — protects per-business gross margin
  as the customer base grows, rather than eroding it.

Ayrshare is the credible alternative (more enterprise/compliance-proven) but
per-profile pricing (~$149/mo floor) and a weaker AI-agent story make it the
costlier, less-aligned choice.

> **ACTION FOR ARCHITECT:** Validate Zernio's white-label and per-account
> pricing claims against current docs + a live trial before committing. Much of
> the favorable comparison data originates from Zernio's own marketing.

### 3. Abstraction: provider sits behind `publish()`
Publishing is called through a single `publish()` abstraction so the provider
is swappable. Pilot on one provider, swap to another without touching agent
logic. (Interchangeable-backend principle — must survive into the spec.)

### 4. The gate: per-business autopilot vs. checkpoint
A per-business flag controls behavior:
- **Autopilot ON** → silent publish, no human in the loop.
- **Autopilot OFF** → routes to a "Needs You" checkpoint for approval first.

Governor caps (per-platform rate limits, spend) apply underneath **either**
mode. Autopilot bypasses the human checkpoint, never the Governor.

---

## Boundaries (what this decision does NOT cover)

- **The moat is not the publisher.** The publishing provider is a commodity
  rail, rented and marked up. The secret sauce — deep business context →
  high-quality generated advertising — lives entirely in Victora's GENERATE
  step and is untouched by this decision.
- **Headless removes our UI work, not platform gatekeeping.** Meta app review,
  X per-post billing, and YouTube quota still exist underneath. The provider
  abstracts them; it does not eliminate them.

---

## Open items (owned by Victora architect/developer)

1. **Per-business channel-credential isolation** in Supabase — multi-tenant;
   each business's connected accounts must be isolated. This is the schema
   design the developer agent implements.
2. **Underlying platform constraints** — confirm current caps/approval timelines
   per platform at build time and surface them to the Governor layer.
3. **Provider trial validation** — see ACTION FOR ARCHITECT above.

---

## Pipeline shape (reference)

```
[deep business context]
        │
        ▼
[GENERATE]  ← the moat (Victora-owned)
        │
        ▼
[AGENT decides]
        │
        ├── autopilot ON  ──► publish() ──► Zernio ──► live (silent)
        └── autopilot OFF ──► Needs You checkpoint ──► (on approval) publish()
                                                            │
                              Governor caps apply ──────────┘
```

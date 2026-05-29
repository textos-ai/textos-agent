# Anthropic — Model Deprecations & Lifecycle (saved copy)

**Sources:**
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/models.md
- https://platform.claude.com/docs/en/release-notes/overview
**Saved:** 2026-05-28
**Why saved:** Model IDs, capabilities, and retirement dates are the most volatile,
time-sensitive parameters we depend on. TextOS's `sonnet` tier currently points at a model
(`claude-sonnet-4-20250514`) that retires June 15, 2026.

---

## Lifecycle terminology
- **Active** — fully supported, recommended.
- **Legacy** — no longer receiving updates; may be deprecated in future.
- **Deprecated** — still functional but not recommended; a retirement date is assigned;
  likely less reliable than active models.
- **Retired** — no longer available; requests fail.

**Notice policy:** Anthropic provides **at least 60 days notice** before retiring a publicly
released model, via email and documentation. Customers can audit usage of deprecated models at
https://console.anthropic.com/settings/usage (download CSV, broken down by API key + model).

**Platform scope:** Dates apply to Anthropic-operated platforms (Claude API, Claude Platform on
AWS, Microsoft Foundry). **Amazon Bedrock and Vertex AI set their own retirement schedules.**

## Current / active model IDs (snapshot 2026-05-28)
| Friendly name | Alias | Full ID | Context | Max output | Status |
|---|---|---|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | — | 200K (1M beta) | 128K | Active (newest) |
| Claude Opus 4.6 | `claude-opus-4-6` | — | 200K (1M beta) | 128K | Active |
| Claude Opus 4.5 | `claude-opus-4-5` | `claude-opus-4-5-20251101` | — | — | Active |
| Claude Opus 4.1 | `claude-opus-4-1` | `claude-opus-4-1-20250805` | — | — | Active (legacy) |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | — | 200K (1M beta) | 64K | Active |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` | — | — | Active |
| Claude Sonnet 4 | `claude-sonnet-4-0` | `claude-sonnet-4-20250514` | 200K | 8,192 | **Deprecated → retires Jun 15 2026** |
| Claude Opus 4 | `claude-opus-4-0` | `claude-opus-4-20250514` | — | — | **Deprecated → retires Jun 15 2026** |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | 200K | 64K | Active |

## Deprecated / retiring
- **Claude Sonnet 4 (`claude-sonnet-4-20250514`)** and **Claude Opus 4
  (`claude-opus-4-20250514`)** — retirement **June 15, 2026, 9:00 AM PT**. After that date the
  `context-1m-2025-08-07` beta header has no effect on them, and >200K-token requests error.
  Recommended replacements: Sonnet 4.6 and Opus 4.7 respectively.
- **Claude Haiku 3 (`claude-3-haiku-20240307`)** — deprecated; retirement ~April 20, 2026.

## Recently retired (requests now fail)
| Model | Full ID | Retired |
|---|---|---|
| Claude Sonnet 3.7 | `claude-3-7-sonnet-20250219` | Feb 19, 2026 |
| Claude Haiku 3.5 | `claude-3-5-haiku-20241022` | Feb 19, 2026 |
| Claude Opus 3 | `claude-3-opus-20240229` | Jan 5, 2026 |
| Claude Sonnet 3.5 (both) | `claude-3-5-sonnet-20241022`, `...20240620` | Oct 28, 2025 |
| Claude Sonnet 3 / Claude 2.1 / 2.0 | — | Jul 21, 2025 |

## Migration rule of thumb
Use **exact, pinned model IDs** in code (never guess/construct IDs). Run an audit before any
deadline:
```
grep -rn "claude-sonnet-4-20250514\|claude-opus-4-20250514" src/
```
Migrating is usually a one-line model-string change + output re-test + deploy — but verify the
new model's capabilities (structured outputs, max output, prefill) first, since those differ.

## Note: even Anthropic's own files lag
On 2026-05-28 the canonical `anthropics/skills/.../models.md` still listed Opus 4.6 as newest
while the live models-overview page already showed **Opus 4.7** shipped. Lesson: cross-check
multiple official sources and prefer the **Models API** (`GET /v1/models`) for ground truth.

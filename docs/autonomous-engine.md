# Autonomous Business Engine — constraints & vision (NOT YET BUILT)

Relocated from the root `CLAUDE.md` (was duplicated in both repos).
This is the post-launch autonomous engine: the system that operates a
business end-to-end with no human in the loop.

> **DO NOT** create the net-new tables below or start any autonomous
> engine work until a sprint brief explicitly says go.

---

## The vision

The activator's entire job: (1) set a mission, (2) connect Stripe
once, (3) set a monthly ad budget. After that TextOS runs the business
forever. The activator is not a manager — they receive reports and
metrics; they do not approve content, review campaigns, or make
operational decisions. Every operational decision is autonomous.

**What TextOS does autonomously (target state):** generate brand /
mission / strategy from one idea; build + deploy the business website;
create the digital product (PDF guide/template/checklist); deploy a
live Stripe paywall on the business site; generate all ad creative
(copy, images, video scripts); publish campaigns to Meta / Google /
TikTok / LinkedIn; ingest performance data and optimize nightly;
improve the product from user behavior; report sales / ROAS / LTV /
CAC / CVR to the activator.

**Coming next (the engine):** DIGITAL_PRODUCT generation (PDF via
Claude + R2); Stripe paywall (`/buy` + `/download`); ad-creative
generation (Meta first); ad-platform API integrations; nightly
optimization loop (cron 2am UTC); event-driven threshold workers
(Queues); ad-wallet funding flow; performance reporting dashboard.

---

## Net-new tables (do NOT create until instructed)

| Table | Purpose |
|---|---|
| `business_products` | digital product assets, R2 file location, pricing |
| `ad_campaigns` | campaign config, platform, status, daily budget |
| `ad_creatives` | creative assets, platform format, performance data |
| `ad_wallets` | activator balance, disbursement history, fee ledger |
| `performance_snapshots` | daily metrics: revenue, ROAS, CVR, ad spend |

---

## Architecture constraints

**PDF generation:** Headless browsers (Puppeteer/Chrome) CANNOT run in
Cloudflare Workers — no DOM. Use an external PDF API over HTTP
(Gotenberg / PDFMonkey / WeasyPrint): structured HTML in, PDF bytes
out, store to R2. **Do NOT** add `puppeteer`/`playwright` to
textos-agent.

**R2 storage paths:**
- Products: `/businesses/{business_id}/products/v{version}/{filename}.pdf`
- Creatives: `/businesses/{business_id}/creatives/{platform}/{filename}`

**Signed download URLs:** generated on `payment_intent.succeeded`;
stored in KV `download:{session_id}` TTL 86400; invalidated on
`charge.refunded`.

**Ad wallet:** real money movement (Stripe → TextOS → platforms)
requires legal clearance. Build schema/UI/disbursement logic but gate
actual fund movement behind `AD_WALLET_LIVE=false` until confirmed.

**Meta ads:** design the Meta Business Manager account structure
BEFORE writing any Meta API code. A misconfigured BM can suspend an
account affecting ALL businesses at once. One mistake = all customers.

**Quality gates (all must pass before any campaign publishes):** real
$1 test transaction end-to-end; download URL works after payment;
`/buy` < 3s load + Lighthouse > 80; `/buy` correct at 390px; no
placeholder text; privacy + terms in footer; ad-platform creds
verified (test 200); ad wallet ≥ 7 days budget; creatives uploaded;
pixel/conversion tracking firing.

**Cron triggers:** nightly optimization 2:00 AM UTC; creative learning
loop Sun 3:00 AM UTC; product improvement loop 1st of month 4:00 AM UTC.

**Event-driven triggers (Queues, fire immediately):**
`payment_intent.succeeded` → signed URL + email; `ad_spend_threshold`
breach → pause ALL campaigns; `roas_critical` (<0.5/48h) → pause + queue
new creative; `conversion_rate_drop` >50% → check technical, flag;
`wallet_low` (<20%) → alert, pause if < $10.

---

## Field locking system (for engine-generated content fields)

Any content field the AI generates AND the activator can edit must
implement locking. Applies to `business_products` and any future
content table touched by the optimization loop.

Three properties per field: `content`, `source`
(`ai_generated | human_edited | ai_optimized`), `locked` (bool).

Rules: field starts `ai_generated` / `locked=false`; activator edit →
`human_edited` / `locked=true`; optimization loop reads `locked`
BEFORE any write; `locked=true` → skip + write a recommendation;
`locked=false` → may update, `source=ai_optimized`; activator can
toggle `locked` anytime.

- Query optimization targets: `WHERE locked = false AND source != 'human_edited'`
- Recommendation for a locked field:
  `INSERT INTO recommendation_queue (business_id, field_path, current_value, suggested_value, expected_impact, created_at)`

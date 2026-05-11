# Manual Refund SOP — TextOS

> Written for: the person handling a refund request at 11pm under pressure.
> Everything you need is in this doc. No need to dig through chat history.

---

## 1. WHEN TO ISSUE A REFUND

| Scenario | Decision |
|---|---|
| Trial cancellation during the 3-day trial | **No refund needed** — Stripe never charges during trial. Just cancel via Dashboard. |
| Subscription cancellation request after trial | **Soft cancel only** (see §2). Refund only on a case-by-case basis — see rows below. |
| Top-up purchase regret (within 24–48 hours, few tokens used) | **Generally refund.** Happy customer > $10. |
| Service failure / feature promised but didn't work | **Refund with apology.** No argument. |
| Technical issue on your side during a task run | **Refund the affected top-up or prorate the subscription.** |
| Buyer's remorse after weeks or months of active use | **Generally decline.** Politely explain what was built/used. Offer to help instead. |
| Fraud / chargeback threat | **Refund immediately, then block the account.** Never fight a chargeback on a $10–$30 charge. |

---

## 2. HOW TO ISSUE A STRIPE REFUND

**Step 1 — Log in**
https://dashboard.stripe.com

**Step 2 — Find the charge**
- Go to: **Payments → All payments**
- Search by customer email or paste the `pi_` / `ch_` ID if you have it
- Click the charge row to open it

**Step 3 — Issue the refund**
- Click **"Refund payment"** (top-right of the charge detail page)
- Choose amount:
  - **Full refund (recommended for V1):** webhook handles token reversal automatically — both money and tokens go back fully
  - **Partial refund (avoid):** the webhook treats any refund as full for token reversal purposes. Customer gets partial money back AND loses ALL tokens from that period or purchase. If you must do a partial money refund, manually adjust tokens via SQL after — see §5.
- In the **Reason** field, select the closest match (duplicate, fraudulent, requested_by_customer)
- In **Internal notes**, write one line: who requested it, why, and the date
  - Example: `Customer email 2026-05-15: top-up purchased by mistake, 2 tokens used, refunded in full`
- Click **Refund**

**Step 4 — Tag the payment with metadata** *(takes 30 seconds, saves you later)*
- Still on the charge detail page, scroll to **Metadata**
- Add key: `refund_reason`, value: one of `trial_cancel` / `service_failure` / `buyer_regret` / `topup_regret` / `fraud`

---

## 3. WHAT THE WEBHOOK DOES AUTOMATICALLY

Once you click Refund in Stripe, the `charge.refunded` webhook fires within seconds. Here is exactly what happens:

**For a subscription invoice refund:**
1. Worker fetches the invoice from Stripe API to get the `subscription_id`
2. Looks up the `business_subscriptions` row for that subscription
3. Reads `token_balances.period_tokens_included` for the actual grant amount
4. Calls `refund_period_tokens` RPC — decrements `period_tokens_included` by that amount (floor 0)
5. Inserts a `token_transactions` row: `kind = 'credit_refund'`, `tokens = -<amount>`
6. Logs: `[stripe-webhook] refund_subscription_period_reversed`

**For a top-up refund:**
1. Looks up `token_purchases` by `stripe_payment_intent_id`
2. If already `status = 'refunded'` → idempotent 200, nothing else
3. Calls `refund_topup_tokens` RPC — decrements `topup_tokens_remaining` (floor 0)
4. Inserts a `token_transactions` row: `kind = 'credit_refund'`, `tokens = -<amount>`
5. Updates `token_purchases` → `status = 'refunded'`, `refunded_at = now()`
6. Logs: `[stripe-webhook] refund_topup_reversed`

**What the user sees:** their token balance drops immediately. They cannot use tokens they've been refunded for. If they already consumed more tokens than the reversed amount, `GREATEST(0, ...)` in the RPC prevents the balance from going negative.

---

## 4. WHAT TO VERIFY POST-REFUND (5-minute check)

Run these within 2 minutes of issuing the refund. If anything looks wrong, go to §5.

**A — Wrangler tail (real-time log)**
```
npx wrangler tail
```
Look for one of these within 30 seconds of the refund:
- `refund_subscription_period_reversed`
- `refund_topup_reversed`
- `refund_no_tokens_to_reverse` (OK — means no balance row existed; tokens were never granted)

If you see `refund_invoice_fetch_failed` or `handler_exception` → go to §5.

**B — app_errors table**
```sql
SELECT level, source, message, context, created_at
FROM app_errors
WHERE message LIKE 'refund_%'
ORDER BY created_at DESC
LIMIT 10;
```
Expected result: zero rows. Any row here means the webhook hit an error path.

**C — token_transactions ledger**
```sql
SELECT kind, tokens, description, created_at
FROM token_transactions
WHERE business_id = '<business_id>'
ORDER BY created_at DESC
LIMIT 5;
```
Expected: a `credit_refund` row with negative tokens, `created_at` within the last 2 minutes.

**D — stripe_events dedup record**
```sql
SELECT event_id, event_type, processed_at, error
FROM stripe_events
WHERE event_type = 'charge.refunded'
ORDER BY received_at DESC
LIMIT 5;
```
Expected: `processed_at` is set, `error` is null.

---

## 5. WHAT TO DO IF THE WEBHOOK FAILS

**Confirm the failure first:**
```sql
SELECT event_id, error
FROM stripe_events
WHERE event_type = 'charge.refunded'
  AND error IS NOT NULL
ORDER BY received_at DESC
LIMIT 5;
```

Also check `app_errors`:
```sql
SELECT message, context, created_at
FROM app_errors
WHERE source = '[stripe-webhook]'
ORDER BY created_at DESC
LIMIT 10;
```

Once confirmed, run the appropriate manual recovery SQL in the **Supabase SQL Editor**:

---

### For a subscription refund (period tokens)

```sql
-- Step 1: find the business and current grant
SELECT b.id AS business_id, b.user_id, tb.period_tokens_included
FROM businesses b
JOIN token_balances tb ON tb.business_id = b.id
WHERE b.id = '<business_id>';

-- Step 2: reverse the grant
SELECT refund_period_tokens(
  '<business_id>'::uuid,
  '<user_id>'::uuid,
  <period_tokens_included>::int,
  'Manual refund (charge <charge_id>) — webhook failed'
);
```

---

### For a top-up refund

```sql
-- Step 1: find the purchase row
SELECT id, business_id, user_id, tokens_purchased, status
FROM token_purchases
WHERE stripe_payment_intent_id = '<pi_id>';

-- Step 2: reverse the top-up tokens
SELECT refund_topup_tokens(
  '<business_id>'::uuid,
  '<user_id>'::uuid,
  <tokens_purchased>::int,
  '<topup_id>'::uuid,
  'Manual refund (payment intent <pi_id>) — webhook failed'
);

-- Step 3: mark the purchase refunded
UPDATE token_purchases
SET status = 'refunded', refunded_at = now()
WHERE id = '<topup_id>';
```

---

**After manual recovery:** mark the stripe_events row as processed to prevent re-processing if Stripe retries:

Why: this prevents the webhook from re-processing the event if Stripe redelivers it. The retry-after-error path in the webhook handler checks `error IS NOT NULL` and re-runs the handler; clearing both fields signals "manually completed, don't reprocess."

```sql
UPDATE stripe_events
SET processed_at = now(), error = NULL
WHERE event_id = '<evt_id>';
```

---

## 6. COMMUNICATION TEMPLATE

**From:** admin@textos.ai
**To:** [customer email]
**Subject:** Refund processed for your TextOS account

---

Hi [First Name],

Your refund of $[amount] has been processed. You should see the credit on your [card type] ending in [last 4] within 5–10 business days depending on your bank.

[If subscription refund:]
Your TextOS subscription has been cancelled and your token balance has been adjusted to reflect the refund. You're welcome to restart anytime — your business data stays in your account.

[If top-up refund:]
The unused tokens from your top-up purchase have been removed from your balance.

If anything went wrong on our end that caused this, I'm genuinely sorry — [brief one-sentence description of what happened if applicable].

I'd love to know what we could have done better. Reply to this email anytime.

— Rob
TextOS

---

## 7. TRACKING

**Per-refund tracking (do this every time):**
- Add `refund_reason` metadata to the Stripe charge (see §2, Step 4)
- Log in a private Notion page or notes doc: date, customer email, amount, reason, resolution

**Querying your refund history in Stripe:**
- Payments → All payments → filter by "Refunded"
- Or: https://dashboard.stripe.com/payments?status[]=refunded

**V1.1 backlog:** dedicated `refund_log` table in Supabase with `business_id`, `amount_cents`, `reason`, `issued_by`, `notes`, `created_at`. Currently deferred — the Stripe Dashboard metadata + manual notes above are sufficient for the first ~20 refunds.

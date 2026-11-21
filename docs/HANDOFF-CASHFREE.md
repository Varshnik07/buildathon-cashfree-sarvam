# Handoff: Cashfree payments integration

You own **money**: payment links, payment events (webhooks), and making the payment status show up correctly in the app.
Read this whole file before changing anything. Build closes **3:30 PM IST, 21 Nov 2026**.

## 1. Context in 60 seconds

- Hackathon: Cashfree × Sarvam Buildathon, **Problem 2 "Who will pay first?"**. Our agent ranks overdue borrowers,
  a **Relay** voice agent calls them in Tamil, and they pay through a **Cashfree payment link** — full or **part payment**.
- When money lands (or a payment attempt fails), our server updates the borrower and the **call list re-forms live**.
  The judges want to see "the link, refund or status on screen".
- Another agent owns the Relay voice side — see `HANDOFF-RELAY.md`. You share the same server.

```
Relay agent / app ──POST /api/relay/payment-link──▶ our server ──▶ Cashfree POST /pg/links
Cashfree ──POST /webhooks/cashfree──▶ our server ──▶ borrower PAID / PARTIALLY_PAID / failed ──▶ list re-forms
```

## 2. Repo and running it

- Repo: `github.com/Varshnik07/buildathon-cashfree-sarvam` (private). Local: `~/Buildathon-Cashfree-Sarvam-2026-11-21/app`
- Node 25, no build step.
  ```bash
  npm install
  cp .env.example .env        # if .env does not exist yet
  npm run dev                 # http://localhost:3000
  npm run tunnel              # 2nd terminal → public https URL → put in .env as PUBLIC_URL, restart
  ```
- **Cashfree can only send webhooks to the public URL.** The tunnel URL changes when cloudflared restarts.

### Files you will touch
| File | What is in it now |
|---|---|
| `src/cashfree.js` | `createPaymentLink`, `getPaymentLink`, `cancelPaymentLink`, `verifyWebhook` |
| `src/server.js` | `POST /api/relay/payment-link` (creates links), `POST /webhooks/cashfree` (handles events), `applyPayment()` |
| `scripts/test-cashfree.js` | Smoke test: creates a sandbox link with part payment, reads it back |
| `.env` | `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENV=sandbox`, `CASHFREE_API_VERSION=2026-01-01`, `PUBLIC_URL` |

### Do not change without telling the team
- `src/rank.js` (the algorithm), endpoint paths and response shapes (the UI and Relay depend on them).

## 3. What is already written (but NOT yet tested against the real sandbox)

**Create link** — `POST https://sandbox.cashfree.com/pg/links`, headers `x-client-id`, `x-client-secret`,
`x-api-version: 2026-01-01`, body:
```json
{
  "link_id": "L-20442-1763712000000",
  "link_amount": 2750, "link_currency": "INR", "link_purpose": "Dues for L-20442",
  "customer_details": { "customer_name": "…", "customer_phone": "9999999999", "customer_email": "…optional…" },
  "link_partial_payments": true, "link_minimum_partial_amount": 700,
  "link_expiry_time": "<now + 72h, ISO>",
  "link_notify": { "send_sms": true, "send_email": false },
  "link_notes": { "account_id": "L-20442" },
  "link_meta": { "notify_url": "<PUBLIC_URL>/webhooks/cashfree" }
}
```
Our endpoint returns `{ link_id, link_url, link_status }` and stores `payment: { linkId, url, status, amount, paid }`
on the borrower. `min_partial: true` in our request = 25% of what is left, rounded to ₹100 (min ₹100).

**Webhook** — `POST /webhooks/cashfree`:
- Verifies `x-webhook-signature` = base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, client secret)).
  If it fails it only logs a warning (so the demo does not break) — decide whether to reject.
- Finds the borrower by `data.link_id` (or `data.order.order_tags.link_id`).
- `data.payment.payment_status` = `FAILED` / `USER_DROPPED` → marks "tried to pay" (borrower moves **up**).
- Otherwise status = `data.link_status`, or derived from `payment_status: SUCCESS` + `link_amount_paid`;
  amount paid = `data.link_amount_paid` ?? `data.payment.payment_amount`. PAID → **Paid**; PARTIALLY_PAID → part paid,
  borrower moves down and is followed up for the rest. A payment after a promise counts as a kept promise.

## 4. Your tasks (in order)

1. **Keys.** merchant.cashfree.com → **Switch to test** → **Developers → API keys** → put App ID / Secret in `.env`.
   No KYC needed for test mode. Never paste keys into prompts or commit them.
2. **Smoke test:** `npm run test:cashfree`. Fix anything that fails. Things to verify against the live docs
   (https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create):
   - `x-api-version` value (we used `2026-01-01`).
   - `link_meta.notify_url` is accepted for links (if not, configure the webhook URL in the dashboard instead).
   - `link_notify.send_sms` in sandbox (docs say sandbox sends **email only**).
3. **Webhook delivery.** Start the tunnel, set `PUBLIC_URL`, restart, create a link from the app
   (**Link** button on any row, or `curl -X POST localhost:3000/api/relay/payment-link -H 'content-type: application/json' -d '{"account_id":"L-20455","min_partial":true}'`).
   Also add the webhook URL under **Developers → Webhooks** in the dashboard if `notify_url` alone does not deliver.
4. **Pay in sandbox.** Open the link, pay with Cashfree's sandbox test UPI / card details (from their docs).
   Try: full payment, a **part payment** above the minimum, and a **failed** payment.
5. **Capture real webhook bodies.** Every webhook is stored in `data/db.json` → `events` (type `cashfree_webhook`).
   Compare the real field names with section 3. **Fix `POST /webhooks/cashfree` in `src/server.js`** where they differ
   (event `type`, where `link_id` lives, `link_amount_paid`, failed-payment status names). Keep the summary text style.
6. **Check the app shows it.** After each payment: the row gets **Paid** / **Part paid**, **Collected** in the top
   strip goes up, **Live activity** shows "X paid ₹… of ₹…", and the list re-forms.
7. **Idempotency.** Cashfree may send the same webhook twice. Make sure a repeat does not double-count
   (`applyPayment` sets the paid amount from the event, not `+=` — confirm that holds for the real payload).
8. **Signature.** Once real webhooks verify, decide with the team whether to reject unverified webhooks.
9. **Optional, if time:** seed payment history with Cashfree **Orders** (the brief suggests it) so the sample book
   has real sandbox history; add a **refund** path for a duplicate payment.

## 5. Rules

- **Test mode only.** No real money, no real customer data.
- Money never moves twice: duplicate webhooks and retries must not change the totals.
- The link amount must equal what the agent said on the call (our endpoint uses the borrower's remaining due unless
  `amount` is given).
- Partial payments always have a minimum first amount (`link_minimum_partial_amount`).

## 6. How to test without the voice agent

- Create a link: **Link** button in the app (opens the link in a new tab).
- Fake a webhook locally (no signature, will log a warning):
  ```bash
  curl -X POST localhost:3000/webhooks/cashfree -H 'content-type: application/json' \
    -d '{"type":"PAYMENT_LINK_EVENT","data":{"link_id":"<link_id from the create call>","link_status":"PARTIALLY_PAID","link_amount_paid":600}}'
  ```
- The **⋯ → Simulate** menu on each row fakes paid / part paid / payment failed without Cashfree — use it as the
  stage fallback if the network dies.
- `POST /api/reset` (or **Reset demo** in the sidebar) restores the sample book.

## 7. Definition of done

- [ ] `npm run test:cashfree` passes; sidebar shows **Cashfree connected**.
- [ ] A link created from the app opens and accepts sandbox payment.
- [ ] Real webhooks for **full**, **part** and **failed** payments update the right borrower and the list re-forms.
- [ ] A repeated webhook does not change totals.
- [ ] Webhook signature verified against real events (or a team decision recorded below).
- [ ] Section 8 filled in.

## 8. Findings (fill in)

| Item | Finding |
|---|---|
| Working `x-api-version` | |
| `notify_url` on links works? | |
| Real webhook `type` values | |
| Field for amount paid | |
| Failed payment status name | |
| Sandbox test UPI / card used | |
| Signature verifies? | |

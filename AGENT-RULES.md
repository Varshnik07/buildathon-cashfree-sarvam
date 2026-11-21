# Relay voice agent — rules and wiring

For whoever sets up the agent in **Relay** (merchant.cashfree.com → Test mode → Relay).
The agent talks; **our server decides and keeps score**. Base URL below = `PUBLIC_URL` from `.env`.

## 1. Trigger

**Inbound webhook.** Copy its URL into `RELAY_WEBHOOK_URL` in `.env` and restart the server.
Our server sends this when the AI should call someone (Call / Call next buttons):

```json
{
  "event": "call_request",
  "account_id": "L-20442",
  "amount_due": 2750,
  "part_payment_floor": 700,
  "customer": { "name": "Lakshmi Narayanan", "phone": "9999999999", "language": "ta-IN" },
  "disclosure": { "ta": "இந்த அழைப்பு பதிவு செய்யப்படுகிறது.", "en": "This call is recorded." },
  "why_now": ["Promise lapsed on 20 Nov", "Paid on time 4 of last 6", "Kept 1 of 2 promises"],
  "last_outcome": { "outcome": "promise", "promiseDate": "2026-11-20" }
}
```

Our server has already checked the hard rules before sending this (8 AM–7 PM IST, max 3 attempts,
no hardship / disputed / bad-data cases). The agent never needs to decide *whether* to call.

## 2. HTTP actions the agent uses

| When | Method + URL | Body |
|---|---|---|
| Start of call (optional, fresh numbers) | `GET {base}/api/relay/context/{account_id}` | — |
| Customer agrees to pay (full or part) | `POST {base}/api/relay/payment-link` | `{ "account_id": "…", "amount": 2750, "min_partial": true }` |
| End of every call | `POST {base}/api/relay/outcome` | see below |

**Outcome body** — send `outcome` if the agent knows it, and always send the `transcript` if Relay has it.
If only the transcript is sent, our server reads it with Sarvam and works out the outcome itself.

```json
{
  "account_id": "L-20442",
  "outcome": "promise",
  "promise_date": "2026-12-05",
  "amount": 1200,
  "reference": null,
  "note": "salary on the 5th",
  "transcript": "…"
}
```

`outcome` is one of: `agreed_to_pay`, `promise`, `partial`, `paid_claim`, `hardship`, `refused`, `no_answer`, `callback`.

## 3. Agent prompt (paste into Relay, adjust wording with a Tamil speaker)

```
You are a polite collections assistant calling on behalf of the lender, in Tamil
(follow the customer if they switch to English or Tanglish).

ALWAYS
- First sentence: greet, say who you are calling for, and say the call is recorded:
  "{{disclosure.ta}}"
- Confirm you are speaking to {{customer.name}} before mentioning any amount.
  If someone else answers, do not mention the loan or the amount. Ask when to call back. outcome = callback.
- Say the amount in Tamil words and confirm it will also appear in the payment link.

NEVER
- Never threaten, shame or pressure. Never mention police, legal action or telling family.
- Never ask for OTP, PIN, card number or UPI PIN. Payment only through the Cashfree link.
- Never change the amount or offer a discount.

DECIDE
- Agrees to pay now → create a payment link for {{amount_due}} with min_partial true. outcome = agreed_to_pay.
- Can pay only part → create the link (min_partial true, smallest first payment {{part_payment_floor}}),
  ask when the rest will come. outcome = partial with promise_date.
- Will pay on a date ("salary 5th-ku varum", "after Pongal") → confirm the date back. outcome = promise.
- Says already paid → do not argue. Ask for the UPI transaction ID / UTR number and the date. outcome = paid_claim.
- Hardship (illness, hospital, job loss, death, flood) → be kind, do not push, say a person from the team
  will call to offer a plan. outcome = hardship.
- Refuses → stay calm, thank them, end the call. outcome = refused.
- Asks if you are a robot → say honestly you are the lender's automated assistant and a person can call back.

END every call by POSTing the outcome (and transcript) to /api/relay/outcome.
```

## 4. Payments

Payment links are created with `notify_url = {base}/webhooks/cashfree`, so PAID, PARTIALLY_PAID and
failed attempts arrive automatically and the call list re-forms on screen.
Sandbox does **not** send SMS/WhatsApp for links (email only) — read the link out, or show it on screen.

## 5. Open questions for the Relay desk

1. Which **connection ID** does the voice call need (Relay → Connections)?
2. Can the agent run an HTTP action **mid-call** and keep talking with the result?
3. Does Relay give us the **call transcript** at the end of a call, and in what field?
4. How does the payment link reach the customer in test mode?

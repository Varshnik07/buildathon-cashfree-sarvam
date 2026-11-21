# Handoff: Relay voice agent integration

You are wiring the **Relay voice agent** (inside the Cashfree merchant dashboard) to our server.
Read this whole file before changing anything. Build closes **3:30 PM IST, 21 Nov 2026**.

## 1. Context in 60 seconds

- Hackathon: Cashfree × Sarvam Buildathon, **Problem 2 "Who will pay first?"**. A lender has thousands of overdue
  borrowers and a small team. Our agent decides who to call today, calls them **in Tamil**, helps them pay through a
  Cashfree payment link, and re-plans when anything changes — with a reason for every decision.
- **Our server is the brain** (ranking, rules, screen). **Relay is the voice** (makes the call, talks, follows our rules).
  **Cashfree is the money** (payment links, payment events). Another agent owns the Cashfree side — see `HANDOFF-CASHFREE.md`.
- Judges must see: a **live Tamil call**, the **money on screen** (link / PAID status), and the **call list re-forming**
  after an outcome.

```
Our server ──POST call_request──▶ Relay inbound webhook ──▶ Relay agent calls the borrower in Tamil
Relay agent ──GET  /api/relay/context/:id──▶ our server        (who is this, how much, why now)
Relay agent ──POST /api/relay/payment-link─▶ our server ──▶ Cashfree creates the link
Relay agent ──POST /api/relay/outcome─────▶ our server        (what happened; list re-forms)
```

## 2. Repo and running it

- Repo: `github.com/Varshnik07/buildathon-cashfree-sarvam` (private). Local: `~/Buildathon-Cashfree-Sarvam-2026-11-21/app`
- Node 25, no build step.
  ```bash
  npm install
  cp .env.example .env        # if .env does not exist yet
  npm run dev                 # http://localhost:3000
  npm run tunnel              # 2nd terminal → copy the https://….trycloudflare.com URL
  ```
  Put that URL in `.env` as `PUBLIC_URL`, restart `npm run dev`. **Relay can only reach us through this public URL.**
  The tunnel URL changes every time cloudflared restarts — update Relay's HTTP actions if it does.
- App: `http://localhost:3000` → sidebar **Connections** shows Sarvam / Cashfree / Relay status.

### Files you will touch
| File | Why |
|---|---|
| `.env` | `RELAY_WEBHOOK_URL`, `PUBLIC_URL` (never commit `.env`) |
| `src/server.js` | Only if Relay's payloads differ from what is below (e.g. transcript field name) |
| `AGENT-RULES.md` | The agent prompt and rules — keep it in sync with what you paste into Relay |

### Do not change without telling the team
- `src/rank.js` — the algorithm (owned by the algorithm person).
- Endpoint paths and response shapes — the UI and the Cashfree side depend on them.

## 3. Your tasks (in order)

1. **Get into Relay.** merchant.cashfree.com → **Switch to test** (yellow "Test Environment" banner) →
   left menu **PG Products → Relay**. If Relay is missing, go to the onboarding desk.
2. **Ask the Relay desk** (write the answers into section 7 of this file):
   1. Which **connection ID** does a voice call need (Relay → Connections)? Set it up.
   2. Can the agent run an **HTTP action mid-call** and keep talking with the result?
   3. Does Relay expose the **call transcript** after the call? In which field?
   4. Can the agent read fields from the inbound webhook body (e.g. `{{customer.phone}}`)? Exact syntax?
   5. Is Tamil (`ta-IN`) available for the voice, and which voice?
3. **Create the agent.** Relay → Overview → Recommended agents → **"Failed payment" voice template** (or
   "Demo Abandoned Cart Voice Agent") → **Configure**. Rename it "Kural Tamil collections".
4. **Trigger = Inbound webhook.** Copy its URL into `.env` as `RELAY_WEBHOOK_URL`, restart the server.
   Our server posts this body (button **Call** / **Call next** in the app):
   ```json
   {
     "event": "call_request",
     "account_id": "L-20442",
     "amount_due": 2750,
     "part_payment_floor": 700,
     "customer": { "name": "Lakshmi Narayanan", "phone": "9999999999", "language": "ta-IN" },
     "disclosure": { "ta": "இந்த அழைப்பு பதிவு செய்யப்படுகிறது.", "en": "This call is recorded." },
     "why_now": ["Promise lapsed on 20 Nov", "Paid on time 4 of last 6"],
     "last_outcome": { "outcome": "promise", "promiseDate": "2026-11-20" }
   }
   ```
   Map `customer.language` to the conversation language and pass `account_id` through to every HTTP action.
5. **Paste the prompt** from `AGENT-RULES.md` section 3 into the agent. Have a Tamil speaker read it once.
6. **Add three HTTP actions** (base = `PUBLIC_URL`, header `content-type: application/json`):

   | Action | Method + path | Body | Returns |
   |---|---|---|---|
   | Get context | `GET /api/relay/context/{{account_id}}` | — | `name, amount_due, part_payment_floor, disclosure, why_now, last_outcome` |
   | Create payment link | `POST /api/relay/payment-link` | `{"account_id":"…","amount":2750,"min_partial":true}` (`amount` optional = full due; `min_partial: true` = allow part payment from the floor) | `link_id, link_url, link_status` |
   | Report outcome | `POST /api/relay/outcome` | see below | `ok, outcome, bucket` |

   Outcome body — send it at the **end of every call**:
   ```json
   { "account_id": "L-20442", "outcome": "promise", "promise_date": "2026-12-05",
     "amount": 1200, "reference": null, "note": "salary on the 5th", "transcript": "…full transcript…" }
   ```
   `outcome` ∈ `agreed_to_pay, promise, partial, paid_claim, hardship, refused, no_answer, callback`.
   If Relay can only send the **transcript**, send just `account_id` + `transcript` — our server reads it with
   Sarvam (keyword fallback) and works out the outcome and promise date.
7. **Test the trigger from a terminal:**
   ```bash
   curl -X POST "$RELAY_WEBHOOK_URL" -H 'content-type: application/json' \
     -d '{"event":"call_request","account_id":"L-20455","amount_due":1200,"part_payment_floor":300,"customer":{"name":"Fathima Begum","phone":"9999999999","language":"ta-IN"},"disclosure":{"ta":"இந்த அழைப்பு பதிவு செய்யப்படுகிறது.","en":"This call is recorded."},"why_now":["Paid on time 6 of last 6"]}'
   ```
   Then **Test flow** on the canvas → check **Runs** → check the app's **Live activity** panel for the outcome.
8. **Full rehearsal ×3:** app → **Call** on a borrower → the agent runs in Tamil → answer "I can pay only half" →
   a part-payment link is created → pay it (Cashfree sandbox) → app shows **Part paid** and the row moves.

## 4. Rules the agent must follow (from the problem statement's red lines)

- Says **"this call is recorded"** in the first sentence (`disclosure.ta`).
- Confirms identity before mentioning any amount; never discusses the loan with someone else.
- No threats, shaming or pressure. Hardship → be kind, offer that a person will call with a plan.
- Never asks for OTP / PIN / card / UPI PIN. Payment only through the Cashfree link.
- "Already paid" → do not argue, ask for the **UTR / UPI transaction ID** and date (images are not supported).
- Calling window **8 AM–7 PM IST**, max **3 attempts**, no calls to hardship / disputed / bad-data cases —
  **already enforced by our server** before it fires the webhook; the agent does not need to check.

## 5. Limits for the day

- **240 minutes** of voice per account. Keep test calls short.
- Test mode only; sample or made-up data only; no real CRMs.
- Sandbox payment links **do not send SMS/WhatsApp** (email only). The agent should read the amount out and say the
  link is on its way; for the demo, show the link on screen or ask the Cashfree agent about delivery.

## 6. Definition of done

- [ ] `RELAY_WEBHOOK_URL` and `PUBLIC_URL` set; sidebar shows **Relay connected**.
- [ ] Clicking **Call** in the app triggers the agent, which speaks Tamil with the recording disclosure.
- [ ] The agent creates a part-payment link through our endpoint during or after the call.
- [ ] Every call ends with a POST to `/api/relay/outcome`; it appears in **Live activity** and the list re-forms.
- [ ] One promise ("salary 5th-ku varum") lands under **Promised later** with the right date.
- [ ] One hardship call ends kindly and the borrower moves to **Human team**.
- [ ] Section 7 below filled in with the desk's answers.

## 7. Answers from the Relay desk (fill in)

| Question | Answer |
|---|---|
| Connection ID for voice | |
| HTTP action mid-call? | |
| Transcript field after call | |
| Webhook field syntax | |
| Tamil voice name | |

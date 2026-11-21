# Buildathon base — Relay + Sarvam + Cashfree

Glue server between the **Relay** voice agent, **Sarvam** (Tamil speech + LLM) and **Cashfree** (payment links, test mode).

```
Our app  ──POST──▶  Relay inbound webhook     start a Tamil call for one account
Relay    ──HTTP──▶  /api/relay/*              agent gets context, creates a link, reports the outcome
Cashfree ──POST──▶  /webhooks/cashfree        link PAID / PARTIALLY_PAID / EXPIRED
```

## 1. Setup (5 min)

```bash
cd app
# fill in .env: SARVAM_API_KEY, CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET
npm run dev                # http://localhost:3000
npm run tunnel             # in a 2nd terminal → copy the https://….trycloudflare.com URL into PUBLIC_URL in .env
```

Cashfree keys: merchant.cashfree.com → **Switch to test** → Developers → API keys.

Check everything is connected:

```bash
npm run test:sarvam        # Tamil TTS → STT → signal extraction
npm run test:cashfree      # creates a sandbox payment link with part payment
```

Open http://localhost:3000 → **Load sample accounts** → the Health chips should all be green.

## 2. Wire Relay (canvas in merchant.cashfree.com → Relay)

1. Start from the **Failed payment (voice)** template → Configure.
2. **Trigger:** Inbound webhook → copy its URL into `RELAY_WEBHOOK_URL` in `.env`, restart.
   Our app posts this to it (the **Call** button on the console):
   ```json
   { "event": "call_request", "account_id": "A1001", "amount_due": 2499,
     "customer": { "name": "Selvi", "phone": "…", "language": "ta-IN" }, "context": {} }
   ```
3. **HTTP actions** (base URL = your `PUBLIC_URL`):

   | Action | Method + path | Body |
   |---|---|---|
   | Get context | `GET /api/relay/context/{{account_id}}` | — |
   | Create payment link | `POST /api/relay/payment-link` | `{ "account_id": "…", "amount": 1200, "min_partial": 500 }` (amount / min_partial optional) |
   | Report outcome | `POST /api/relay/outcome` | `{ "account_id": "…", "outcome": "promise", "promise_date": "2026-12-05", "amount": 1200, "note": "…", "transcript": "…" }` |

   `outcome` is one of: `agreed_to_pay, promise, partial, paid_claim, hardship, refused, no_answer, callback`.
4. **Cashfree webhook:** links are created with `notify_url = PUBLIC_URL/webhooks/cashfree`, so payment updates arrive automatically.
5. Test flow on the canvas → check **Runs** and the console's event log.

## Notes

- **Sandbox does not send SMS/WhatsApp for payment links, only email.** For the demo, read the link out / show it on screen, or send it through Relay's own messaging.
- Sarvam models used: `saaras:v4` (STT, `codemix` mode for Tanglish), `bulbul:v3` (TTS, speaker `kavitha`), `mayura:v1` (translate), `sarvam-105b` (chat/extraction).
- Helper endpoints for Postman: `POST /api/sarvam/tts`, `/api/sarvam/stt` (multipart `file`), `/api/sarvam/translate`, `/api/sarvam/signals` (`{ "text": "…" }` → structured outcome).
- Data lives in `data/db.json`. Delete it to reset.

# Sarvam configuration for the Kural browser demo

## Hosted voice agent: tested configuration

User confirmed browser voice working locally on 21 November 2026 after committing the agent.
These are the settings observed in the supplied Sarvam dashboard screenshots:

| Setting | Value |
| --- | --- |
| Agent | Tamil Payment Follow-up |
| App ID | Tamil-Payme-bc4e8ec8-8f51 |
| Voice | Neha - Support Agent |
| Speaking speed | 1.15 |
| Pitch | 0.00 |
| Volume | 1.0 |
| Per-language voice overrides | Off |
| Model temperature | Balanced; numeric value not exposed |
| Version | Latest committed; exact committed version not captured |
| Underlying hosted LLM/STT/TTS | Not exposed in the supplied settings; not independently verified |

## Server environment

```dotenv
PORT=3108
SARVAM_VOICE_API_KEY=<Samvaad key, server only>
SARVAM_VOICE_ORG_ID=01a1f4b4-85d3-76bb-8247-4a17ad46fc2a
SARVAM_VOICE_WORKSPACE_ID=01a1f4b4-85db-77ea-8738-6046012e4949
SARVAM_VOICE_APP_ID=Tamil-Payme-bc4e8ec8-8f51
# Optional: numeric committed version; omit to use latest committed
# SARVAM_VOICE_VERSION=1
```

Keep secrets in an ignored server .env. No API key is committed. Install with `npm ci`
including development dependencies because prestart uses esbuild. Restart using `npm start`.
The teammate must provide their own environment; the local .env is not part of this PR.

## Browser session

SDK: sarvam-conv-ai-sdk ^0.0.42, browser entry point. Input/output audio: 16 kHz.
Interaction type: call. User identifier: account ID. API key stays on the server;
the browser exchanges a short-lived app session for a signed Sarvam connection URL.
The server sends account_id, customer_name, amount_due, part_payment_floor and a
borrower-specific initial_bot_message. Sessions expire after one hour and are held in memory.

The tested dashboard prompt used fictional Selvi Murugan, amount 2499, minimum partial 600.
For different queue rows, replace those constants in the agent instructions and greeting
using the dashboard variable picker, then commit the agent again. Sending variables alone
does not remove hardcoded instructions. Preserve identity confirmation before stating amounts,
Tamil/Tanglish, short replies, one question at a time, empathetic hardship handling, explicit
amount/date confirmation, no payment credential requests, and no claims of tool execution.
No payment or outcome tools are attached to this voice session. The operator reviews and saves
an outcome in Kural and uses the separate payment-link action when needed.

## Separate REST helpers

These defaults in src/sarvam.js at this branch base are separate from the hosted voice agent:

| Helper | Model/default |
| --- | --- |
| Speech recognition | saaras:v4, ta-IN, codemix |
| Speech synthesis | bulbul:v3, kavitha, ta-IN, pace 1 |
| Translation | mayura:v1, auto to ta-IN, modern-colloquial |
| Chat | sarvam-105b, temperature 0.2 |

They use SARVAM_API_KEY, which is separate from SARVAM_VOICE_API_KEY. Newer main has
additional scripted voice work; verify its REST defaults when reconciling this branch.
Cashfree and Relay credentials are independent and remain documented in .env.example.

## Validation and limitations

Backend tests cover session binding, server-only credentials, proxy authorization, duplicate
calls and idempotent transcript saving. The local user confirmed two-way voice; teammate
hosting, all borrower prompts and production readiness are not established by that test.
See HANDOFF-BROWSER-VOICE.md for acceptance steps and dependency/security limitations.

Reference: https://docs.sarvam.ai/voice-agents/deploy/sdks/web

# Kural browser voice demo

Call next and each row's Call button now open a microphone conversation inside Kural.
They no longer invoke Relay. Existing Relay endpoints remain available independently.
One session per click; no automatic next borrower. Mute, End call and live transcript
are in the panel. End saves the transcript; review and save the outcome to update the queue.
Payment link creation and verified Cashfree payment remain separate actions.

## Deploy

After checking out this PR branch (or applying its changes), install and verify:

```sh
npm ci
npm run build:voice
node --test test/browser-voice.test.js
```

This branch starts at ae242be. Newer main contains overlapping voice UI work; reconcile
those changes during review before deployment. No merge into main was performed.
The front-end changes replace only the two call handlers, load the voice panel module,
and add its styles. Server change imports and mounts src/browser-voice.js.

Add the SARVAM_VOICE_* values from .env.example to your server's .env.
SARVAM_VOICE_API_KEY must be a Samvaad Voice Agents key with access to this agent.
Never put it in public files. Verify the org/workspace/app IDs against your Sarvam account.
Restart with npm start. The prestart script builds the browser bundle.
Keep the ngrok HTTPS URL pointing at this server.

## Prepare the Sarvam agent before the demo

The SDK requires a committed agent version. The dashboard's draft Test agent is not enough.
Define these variables in the agent Variables tab and reference them using the editor's
variable picker in BOTH the greeting and instructions:

- account_id
- customer_name
- amount_due
- part_payment_floor

Replace all hardcoded Selvi/2499/600 instructions with these variables. Keep the existing
identity check, Tamil/Tanglish, one-question-at-a-time, hardship and payment privacy rules.
Use a neutral greeting identifying Kural as an AI demo and asking for customer_name.
The browser also supplies a borrower-specific initial_bot_message.
Do not claim payment links were sent or payments verified: this voice session has no tools.
The operator can use Kural's Link button after the conversation. Commit the updated version.
If you pin SARVAM_VOICE_VERSION, update it to that committed version.

## Acceptance check

1. Open Kural over HTTPS (localhost also works), choose a fictional borrower and click Call.
2. Allow microphone access. Speak in the panel; confirm correct borrower/amount and two-way audio.
3. Other Call buttons must remain disabled during the conversation.
4. Mute/unmute, then End call. The microphone indicator should stop.
5. Confirm transcript saved, select the outcome/date/amount you heard, Save outcome.
6. Verify queue refresh. Another call starts only on your next click.
7. Deny microphone access once and verify the panel recovers with an error and Close button.

If voice is not configured, the panel names missing env variables. A signed-session failure
shows the upstream status: check key permissions, IDs and committed version.
The user confirmed a working local browser voice conversation after committing the Sarvam
agent on 21 November 2026. The teammate deployment still requires its own acceptance check.

## Verification and limits

Backend test covers borrower binding, credentials staying server-side, unauthorized and
mismatched proxy requests, single-use session URL, duplicate session blocking and idempotent
transcript saving. Build strips SDK console logging (the SDK logs signed URLs otherwise).
Sessions live in memory for one hour. Server restart invalidates them. This is a single-server
hackathon demo built on the app's existing unauthenticated API; use fictional data.
Closing the page can lose an unsaved transcript; use End call and wait for save confirmation.
Browser sessions do not increment telephone attempt counters or place telephone calls.

npm audit reports an unfixed high-severity advisory in the SDK's native speaker dependency
(and the SDK transitively). The browser bundle uses the /browser entry point and excludes
native speaker. The server does not import the SDK. Do not use its native audio path.

Official SDK reference: https://docs.sarvam.ai/voice-agents/deploy/sdks/web

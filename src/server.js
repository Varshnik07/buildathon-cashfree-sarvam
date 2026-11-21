// Base server: the glue between Relay (voice agent), Sarvam (language) and Cashfree (money).
//
//   Our app ──POST──▶ Relay inbound webhook   (start a Tamil call for one account)
//   Relay   ──HTTP──▶ /api/relay/*            (agent fetches context, creates link, reports outcome)
//   Cashfree ─POST──▶ /webhooks/cashfree      (link PAID / PARTIALLY_PAID / EXPIRED)
import express from 'express';
import multer from 'multer';
import * as sarvam from './sarvam.js';
import * as cashfree from './cashfree.js';
import * as store from './store.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Keep the raw body for Cashfree signature checks.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.static('public'));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sarvam: Boolean(process.env.SARVAM_API_KEY),
    cashfree: Boolean(process.env.CASHFREE_CLIENT_ID && process.env.CASHFREE_CLIENT_SECRET),
    relayWebhook: Boolean(process.env.RELAY_WEBHOOK_URL),
    publicUrl: process.env.PUBLIC_URL || null,
  });
});

// ---------- Accounts ----------
app.get('/api/accounts', (_req, res) => res.json(store.listAccounts()));
app.get('/api/accounts/:id', (req, res) => {
  const a = store.getAccount(req.params.id);
  a ? res.json({ ...a, events: store.listEvents(a.id) }) : res.status(404).json({ error: 'not found' });
});
app.post('/api/accounts/import', (req, res) => {
  store.replaceAccounts(req.body.accounts || []);
  res.json({ imported: store.listAccounts().length });
});
app.get('/api/events', (_req, res) => res.json(store.listEvents()));

// Start a Relay voice call for one account by firing the agent's inbound webhook.
app.post('/api/accounts/:id/call', wrap(async (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!process.env.RELAY_WEBHOOK_URL) return res.status(400).json({ error: 'RELAY_WEBHOOK_URL not set' });
  const payload = {
    event: 'call_request',
    account_id: a.id,
    amount_due: a.amountDue,
    customer: { name: a.name, phone: a.phone, language: a.language || 'ta-IN' },
    context: a.context || {},
  };
  const r = await fetch(process.env.RELAY_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  store.logEvent('call_requested', a.id, { relayStatus: r.status });
  res.json({ relayStatus: r.status, relayBody: await r.text() });
}));

// ---------- Endpoints for Relay HTTP actions ----------
// Context the voice agent reads before/while talking.
app.get('/api/relay/context/:id', (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({
    account_id: a.id, name: a.name, language: a.language || 'ta-IN',
    amount_due: a.amountDue, due_date: a.dueDate,
    payment: a.payment || null, last_outcome: a.lastOutcome || null,
  });
});

// Agent asks for a payment link (full or part payment allowed).
app.post('/api/relay/payment-link', wrap(async (req, res) => {
  const { account_id, amount, min_partial } = req.body;
  const a = store.getAccount(account_id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const linkId = `${a.id}-${Date.now()}`;
  const link = await cashfree.createPaymentLink({
    linkId,
    amount: amount || a.amountDue,
    purpose: `Dues for ${a.name}`,
    customer: { name: a.name, phone: a.phone, email: a.email },
    minPartial: min_partial,
    notes: { account_id: a.id },
  });
  store.upsertAccount({ id: a.id, payment: { linkId, url: link.link_url, status: link.link_status, amount: link.link_amount, paid: 0 } });
  store.logEvent('link_created', a.id, { linkId, amount: link.link_amount, minPartial: min_partial || null });
  res.json({ link_id: linkId, link_url: link.link_url, link_status: link.link_status });
}));

// Agent reports what happened on the call.
// outcome: agreed_to_pay | promise | partial | paid_claim | hardship | refused | no_answer | callback
app.post('/api/relay/outcome', wrap(async (req, res) => {
  const { account_id, outcome, promise_date, amount, note, transcript } = req.body;
  const a = store.getAccount(account_id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const lastOutcome = { outcome, promiseDate: promise_date || null, amount: amount || null, note: note || null, at: new Date().toISOString() };
  store.upsertAccount({ id: a.id, lastOutcome });
  store.logEvent('call_outcome', a.id, { ...lastOutcome, transcript: transcript || null });
  res.json({ ok: true });
}));

// Catch-all sink so a Relay HTTP action can post anything during testing.
app.post('/webhooks/relay', (req, res) => {
  store.logEvent('relay_webhook', req.body?.account_id || null, req.body);
  res.json({ ok: true });
});

// ---------- Cashfree webhooks ----------
app.post('/webhooks/cashfree', (req, res) => {
  const ok = cashfree.verifyWebhook(req.rawBody, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'));
  if (!ok) console.warn('Cashfree webhook signature did not verify (check CASHFREE_CLIENT_SECRET)');
  const d = req.body?.data || {};
  const linkId = d.link_id || d.order?.order_tags?.link_id;
  const a = linkId && store.findAccountByLinkId(linkId);
  if (a) {
    const status = d.link_status || d.payment?.payment_status;
    const paid = Number(d.link_amount_paid ?? d.payment?.payment_amount ?? a.payment.paid);
    store.upsertAccount({ id: a.id, payment: { ...a.payment, status, paid } });
  }
  store.logEvent('cashfree_webhook', a?.id || null, { type: req.body?.type, linkId, verified: ok, data: d });
  res.json({ ok: true });
});

// ---------- Sarvam helpers (handy for testing from Postman / Relay) ----------
app.post('/api/sarvam/stt', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'send audio as multipart field "file"' });
  res.json(await sarvam.speechToText(req.file.buffer, req.file.originalname, {
    languageCode: req.body.language_code || 'ta-IN', mode: req.body.mode || 'codemix',
  }));
}));

app.post('/api/sarvam/tts', wrap(async (req, res) => {
  const wav = await sarvam.textToSpeech(req.body.text, { languageCode: req.body.language_code || 'ta-IN', speaker: req.body.speaker });
  res.type('audio/wav').send(wav);
}));

app.post('/api/sarvam/translate', wrap(async (req, res) => {
  res.json({ text: await sarvam.translate(req.body.text, { target: req.body.target || 'ta-IN' }) });
}));

// Pull structured signals out of a transcript or field note (Tamil / Tanglish / English).
app.post('/api/sarvam/signals', wrap(async (req, res) => {
  const signals = await sarvam.extractJson(
    `Extract payment signals from this collections call transcript or field note. It may be Tamil, English or mixed.
Return JSON with keys:
 outcome: one of agreed_to_pay, promise, partial, paid_claim, hardship, refused, callback, unclear
 promise_date: ISO date or null
 amount_offered: number or null
 paid_where: string or null (e.g. "branch", "shop", "collection agent")
 hardship_reason: string or null
 summary_en: one short English sentence a manager can read aloud`,
    req.body.text,
  );
  res.json(signals);
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server on http://localhost:${port}  (public: ${process.env.PUBLIC_URL || 'run npm run tunnel'})`));

// The brain: ranking, rules and the screen. Glue between Relay (voice agent), Sarvam (language)
// and Cashfree (money).
//
//   Our app  ──POST──▶ Relay inbound webhook   (start a Tamil call for one account)
//   Relay    ──HTTP──▶ /api/relay/*            (agent fetches context, creates link, reports outcome)
//   Cashfree ──POST──▶ /webhooks/cashfree      (link PAID / PARTIALLY_PAID / payment FAILED)
import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import * as sarvam from './sarvam.js';
import * as cashfree from './cashfree.js';
import * as store from './store.js';
import { rankAccounts, scoreAccount, fairnessCheck, callPolicy } from './rank.js';
import { extractSignals } from './signals.js';
import { importBook } from './importer.js';
import * as rankingAgent from './rankingAgent.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
let lastImport = null;

// Keep the raw body for Cashfree signature checks.
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '20mb' }));
app.use(express.static('public'));
// Log every call from Relay (directly or via the Lambda forwarder) so we can see it arrive.
app.use('/api/relay', (req, _res, next) => {
  console.log(`${new Date().toISOString()} RELAY ${req.method} ${req.originalUrl} ua=${req.get('user-agent') || '-'}`);
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

const DISCLOSURE = {
  ta: 'இந்த அழைப்பு பதிவு செய்யப்படுகிறது.',
  en: 'This call is recorded.',
};
const remaining = (a) => Math.max(0, a.amountDue - Number(a.payment?.paid || 0));
// Smallest first payment we accept on a part-payment link: 25% of what's left, rounded to ₹100.
const partFloor = (a) => Math.max(100, Math.round((remaining(a) * 0.25) / 100) * 100);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// ---------- State changes (shared by Relay, Cashfree webhooks and the demo simulator) ----------
function applyOutcome(a, { outcome, promiseDate, amount, note, reference, source }) {
  const history = { ...(a.history || {}) };
  if (outcome === 'promise') history.promisesMade = (history.promisesMade || 0) + 1;
  if (outcome === 'partial') history.partialPays = (history.partialPays || 0) + 1;
  const lastOutcome = {
    outcome: outcome === 'partial' ? 'promise' : outcome,
    promiseDate: promiseDate || null, amount: amount ?? null, note: note || null,
    reference: reference || null, source: source || 'call', at: new Date().toISOString(),
  };
  if (outcome === 'partial' && !promiseDate) lastOutcome.outcome = 'callback';
  return store.upsertAccount({ id: a.id, history, lastOutcome });
}

function applyPayment(a, { status, paid, linkId, url }) {
  const payment = { ...(a.payment || { amount: a.amountDue, paid: 0 }), status, paid: Number(paid ?? a.payment?.paid ?? 0) };
  if (linkId) payment.linkId = linkId;
  if (url) payment.url = url;
  const patch = { id: a.id, payment, signals: { ...(a.signals || {}), paymentFailedAt: null } };
  // A payment after a promise counts as a kept promise (once).
  if ((status === 'PAID' || status === 'PARTIALLY_PAID') && a.lastOutcome?.outcome === 'promise' && !a.lastOutcome.kept) {
    patch.history = { ...(a.history || {}), promisesKept: (a.history?.promisesKept || 0) + 1 };
    patch.lastOutcome = { ...a.lastOutcome, kept: true };
  }
  return store.upsertAccount(patch);
}

function outcomeSummary(a, o) {
  const what = {
    agreed_to_pay: 'agreed to pay now', promise: `promised to pay${o.promiseDate ? ` on ${fmtDate(o.promiseDate)}` : ''}`,
    partial: `will pay part${o.amount ? ` (₹${o.amount})` : ''}${o.promiseDate ? ` on ${fmtDate(o.promiseDate)}` : ''}`,
    paid_claim: `says already paid${o.reference ? ` (ref ${o.reference})` : ''}. Sent to human team to verify`,
    hardship: `reported hardship${o.note ? ` (${o.note})` : ''}. Sent to a person, no more AI calls`,
    refused: 'refused to pay', no_answer: 'did not answer', callback: 'asked for a call back', unclear: 'outcome unclear',
  }[o.outcome] || o.outcome;
  return `${a.name} ${what}`;
}

// ---------- Health, accounts, queue ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sarvam: Boolean(process.env.SARVAM_API_KEY),
    cashfree: Boolean(process.env.CASHFREE_CLIENT_ID && process.env.CASHFREE_CLIENT_SECRET),
    relayWebhook: Boolean(process.env.RELAY_WEBHOOK_URL),
    publicUrl: process.env.PUBLIC_URL || null,
  });
});

app.get('/api/accounts', (_req, res) => res.json(store.listAccounts()));
app.get('/api/accounts/:id', (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ ...a, rank: scoreAccount(a), policy: callPolicy(a), events: store.listEvents(a.id) });
});
app.post('/api/accounts/import', (req, res) => {
  store.reset(req.body.accounts || []);
  lastImport = null;
  store.logEvent('book_imported', null, { summary: `Loaded ${store.listAccounts().length} accounts` });
  res.json({ imported: store.listAccounts().length });
});

// Upload a borrower file (CSV / TSV). Cleans it, reports every guess, ranks everyone.
app.post('/api/accounts/upload', upload.single('file'), (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'Send a CSV as multipart field "file", as text/csv, or as { "csv": "..." }' });
  const { accounts, report } = importBook(text);
  store.reset(accounts);
  lastImport = { ...report, fileName: req.file?.originalname || 'upload.csv', at: new Date().toISOString() };
  store.logEvent('book_imported', null, {
    summary: `Imported ${report.imported} accounts from ${lastImport.fileName}: ${report.duplicates} duplicates merged, ${report.issues} data issues flagged`,
  });
  res.json(lastImport);
});
app.get('/api/import-report', (_req, res) => res.json(lastImport));

app.post('/api/reset', (req, res) => {
  const file = req.body?.book === 'sample' || !fs.existsSync('data/teammate-accounts.json') ? 'data/sample-accounts.json' : 'data/teammate-accounts.json';
  const sample = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.reset(sample.accounts);
  lastImport = null;
  store.logEvent('book_imported', null, { summary: `Demo reset: ${sample.accounts.length} sample accounts loaded` });
  res.json({ imported: sample.accounts.length });
});

app.get('/api/events', (_req, res) => res.json(store.listEvents()));

// ?limit=N keeps the screen fast on big books: top N per group, stats always cover everyone.
app.get('/api/queue', (req, res) => {
  const ranked = rankAccounts(store.listAccounts());
  const count = (b) => ranked.filter((a) => a.rank.bucket === b).length;
  const limit = Number(req.query.limit) || Infinity;
  const seen = {};
  res.json({
    accounts: ranked.filter((a) => (seen[a.rank.bucket] = (seen[a.rank.bucket] || 0) + 1) <= limit),
    stats: {
      total: ranked.length,
      toCall: count('call'), scheduled: count('scheduled'), verify: count('verify'), human: count('human'), done: count('done'),
      explore: ranked.filter((a) => a.rank.explore).length,
      withIssues: ranked.filter((a) => a.issues?.length).length,
      collected: ranked.reduce((s, a) => s + Number(a.payment?.paid || 0), 0),
      outstanding: ranked.reduce((s, a) => s + remaining(a), 0),
    },
  });
});

// Ranking agent: LLM reviews the flagged ~5% of borrowers (runs in the background).
app.post('/api/ranking-agent/run', wrap(async (req, res) => res.json(await rankingAgent.run({ limit: Number(req.body?.limit) || 25 }))));
app.get('/api/ranking-agent/status', (_req, res) => res.json({ ...rankingAgent.status(), flagged: rankingAgent.loadCards().length }));

app.get('/api/fairness', (_req, res) => res.json(fairnessCheck(store.listAccounts())));

// ---------- Start an AI call (our app → Relay) ----------
app.post('/api/accounts/:id/call', wrap(async (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const policy = callPolicy(a);
  if (!policy.allowed) {
    store.logEvent('call_blocked', a.id, { summary: `Did not call ${a.name}: ${policy.reason}` });
    return res.status(409).json({ error: policy.reason });
  }
  if (!process.env.RELAY_WEBHOOK_URL) return res.status(400).json({ error: 'RELAY_WEBHOOK_URL not set in .env' });
  const rank = scoreAccount(a);
  const payload = {
    event: 'call_request',
    account_id: a.id,
    amount_due: remaining(a),
    part_payment_floor: partFloor(a),
    customer: { name: a.name, phone: a.phone, language: a.language || 'ta-IN' },
    disclosure: DISCLOSURE,
    why_now: rank.reasons.slice(0, 3),
    last_outcome: a.lastOutcome || null,
  };
  const r = await fetch(process.env.RELAY_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  store.upsertAccount({ id: a.id, attempts: (a.attempts || 0) + 1, lastCallAt: new Date().toISOString() });
  store.logEvent('call_requested', a.id, { relayStatus: r.status, summary: `AI calling ${a.name} in Tamil (attempt ${(a.attempts || 0) + 1}). Why: ${rank.reasons[0]}` });
  res.json({ relayStatus: r.status, relayBody: await r.text() });
}));

// ---------- Endpoints for Relay HTTP actions ----------
app.get('/api/relay/context/:id', (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({
    account_id: a.id, name: a.name, language: a.language || 'ta-IN',
    amount_due: remaining(a), part_payment_floor: partFloor(a), due_date: a.dueDate || null,
    disclosure: DISCLOSURE, why_now: scoreAccount(a).reasons.slice(0, 3),
    payment: a.payment || null, last_outcome: a.lastOutcome || null,
  });
});

app.post('/api/relay/payment-link', wrap(async (req, res) => {
  const { account_id, amount, min_partial } = req.body;
  const a = store.getAccount(account_id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const linkAmount = Number(amount || remaining(a));
  const minPartial = min_partial === true ? partFloor(a) : Number(min_partial) || undefined;
  const linkId = `${a.id}-${Date.now()}`;
  const link = await cashfree.createPaymentLink({
    linkId, amount: linkAmount, purpose: `Dues for ${a.id}`,
    customer: { name: a.name, phone: a.phone, email: a.email }, minPartial, notes: { account_id: a.id },
  });
  store.upsertAccount({ id: a.id, payment: { linkId, url: link.link_url, status: link.link_status, amount: link.link_amount, paid: 0 } });
  store.logEvent('link_created', a.id, {
    linkId, amount: link.link_amount, minPartial: minPartial || null,
    summary: `Payment link for ₹${link.link_amount} sent to ${a.name}${minPartial ? ` (part payment from ₹${minPartial})` : ''}`,
  });
  res.json({ link_id: linkId, link_url: link.link_url, link_status: link.link_status });
}));

// The agent reports the call. If it only sends a transcript, we read it with Sarvam.
// outcome: agreed_to_pay | promise | partial | paid_claim | hardship | refused | no_answer | callback
app.post('/api/relay/outcome', wrap(async (req, res) => {
  const { account_id, transcript, note } = req.body;
  const a = store.getAccount(account_id);
  if (!a) return res.status(404).json({ error: 'not found' });
  let o = { outcome: req.body.outcome, promiseDate: req.body.promise_date, amount: req.body.amount, reference: req.body.reference, note };
  let learned = null;
  if (transcript && (!o.outcome || o.outcome === 'unclear' || (o.outcome === 'promise' && !o.promiseDate))) {
    learned = await extractSignals(transcript);
    o = {
      outcome: o.outcome && o.outcome !== 'unclear' ? o.outcome : learned.outcome,
      promiseDate: o.promiseDate || learned.promise_date, amount: o.amount ?? learned.amount_offered,
      reference: o.reference || learned.paid_reference, note: note || learned.hardship_reason || learned.summary_en,
    };
  }
  if (!o.outcome) return res.status(400).json({ error: 'send outcome or transcript' });
  const updated = applyOutcome(a, { ...o, source: learned ? `call transcript (${learned.source})` : 'call' });
  const rank = scoreAccount(updated);
  store.logEvent('call_outcome', a.id, {
    ...o, transcript: transcript || null, learned,
    summary: `${outcomeSummary(a, o)} → now in "${rank.bucket}"`,
  });
  res.json({ ok: true, outcome: o, learned, bucket: rank.bucket });
}));

app.post('/webhooks/relay', (req, res) => {
  store.logEvent('relay_webhook', req.body?.account_id || null, req.body);
  res.json({ ok: true });
});

// ---------- Cashfree webhooks ----------
app.post('/webhooks/cashfree', (req, res) => {
  const verified = cashfree.verifyWebhook(req.rawBody, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'));
  if (!verified) console.warn('Cashfree webhook signature did not verify (check CASHFREE_CLIENT_SECRET)');
  const d = req.body?.data || {};
  const linkId = d.link_id || d.order?.order_tags?.link_id;
  const a = linkId && store.findAccountByLinkId(linkId);
  let summary = `Cashfree webhook for unknown link ${linkId}`;
  if (a) {
    const paymentStatus = d.payment?.payment_status;
    if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
      store.upsertAccount({ id: a.id, signals: { ...(a.signals || {}), paymentFailedAt: new Date().toISOString() } });
      summary = `${a.name} tried to pay but it failed. Moved up: likely to pay with a fresh link`;
    } else {
      const status = d.link_status || (paymentStatus === 'SUCCESS' ? (Number(d.link_amount_paid) >= a.payment.amount ? 'PAID' : 'PARTIALLY_PAID') : a.payment.status);
      const paid = d.link_amount_paid ?? d.payment?.payment_amount ?? a.payment.paid;
      applyPayment(a, { status, paid });
      summary = status === 'PAID' ? `${a.name} paid ₹${paid} in full` : `${a.name} paid ₹${paid} of ₹${a.payment.amount}`;
    }
  }
  store.logEvent('cashfree_webhook', a?.id || null, { type: req.body?.type, linkId, verified, summary });
  res.json({ ok: true });
});

// ---------- Demo simulator: show the queue re-forming even if a live call or payment fails on stage ----------
app.post('/api/demo/:id/simulate', (req, res) => {
  const a = store.getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { type, amount, date, note } = req.body;
  const due = remaining(a);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let summary;
  switch (type) {
    case 'paid':
      applyPayment(a, { status: 'PAID', paid: a.amountDue, linkId: a.payment?.linkId || `sim-${a.id}` });
      summary = `${a.name} paid ₹${due} in full`; break;
    case 'partial': {
      const chunk = Number(amount || Math.round(due / 2));
      applyPayment(a, { status: 'PARTIALLY_PAID', paid: Number(a.payment?.paid || 0) + chunk, linkId: a.payment?.linkId || `sim-${a.id}` });
      summary = `${a.name} paid ₹${chunk} of ₹${due}. Rest followed up later`; break;
    }
    case 'payment_failed':
      store.upsertAccount({ id: a.id, signals: { ...(a.signals || {}), paymentFailedAt: new Date().toISOString() } });
      summary = `${a.name} tried to pay but it failed. Moved up: likely to pay with a fresh link`; break;
    case 'promise':
      applyOutcome(a, { outcome: 'promise', promiseDate: date || '2026-12-05', note: note || 'salary 5th-ku varum', source: 'simulated' });
      summary = outcomeSummary(a, { outcome: 'promise', promiseDate: date || '2026-12-05' }); break;
    case 'promise_lapse':
      applyOutcome(a, { outcome: 'promise', promiseDate: yesterday, source: 'simulated' });
      summary = `${a.name}'s promise lapsed yesterday. Moved up to call today`; break;
    case 'paid_claim':
      applyOutcome(a, { outcome: 'paid_claim', note: note || 'branch-la kattiten', reference: 'UTR 4521 8873 1190', source: 'simulated' });
      summary = outcomeSummary(a, { outcome: 'paid_claim', reference: 'UTR 4521 8873 1190' }); break;
    case 'hardship':
      applyOutcome(a, { outcome: 'hardship', note: note || 'medical emergency', source: 'simulated' });
      summary = outcomeSummary(a, { outcome: 'hardship', note: note || 'medical emergency' }); break;
    case 'refused':
      applyOutcome(a, { outcome: 'refused', source: 'simulated' });
      summary = outcomeSummary(a, { outcome: 'refused' }); break;
    case 'no_answer':
      store.upsertAccount({ id: a.id, attempts: (a.attempts || 0) + 1 });
      applyOutcome(store.getAccount(a.id), { outcome: 'no_answer', source: 'simulated' });
      summary = `${a.name} did not answer (attempt ${(a.attempts || 0) + 1})`; break;
    default:
      return res.status(400).json({ error: 'unknown simulate type' });
  }
  store.logEvent('simulated', a.id, { type, summary });
  res.json({ ok: true, summary });
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

// Field note or transcript → structured signal (Sarvam chat model, keyword fallback).
app.post('/api/sarvam/signals', wrap(async (req, res) => res.json(await extractSignals(req.body.text))));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server on http://localhost:${port}  (public: ${process.env.PUBLIC_URL || 'run npm run tunnel'})`));

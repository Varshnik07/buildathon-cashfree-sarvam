// ============================================================================================
//  ALGORITHM SLOT — who should we call first?
//  Edit WEIGHTS and scoreAccount() below. Everything else (screen, proof, fairness check,
//  Relay calls) re-uses whatever this file returns, so swapping the logic takes a minute.
//
//  Input:  one account (see data/sample-accounts.json for the fields)
//  Output: { bucket, score 0–100, reasons[], parts[] }
//    bucket  = call | scheduled | verify | human | done
//    reasons = plain sentences a manager could read aloud (first one is the headline)
//    parts   = how the score was built, for the "why" panel
//
//  USED signals (behaviour only). NEVER used: name, area, language, gender, age —
//  or anything that can stand in for caste, religion or class. Language only picks the
//  language we call in.
// ============================================================================================
export const USED_SIGNALS = ['On-time payments (last 6)', 'Promises kept vs made', 'Days overdue', 'Part payments before', 'Payment trend', 'Tried to pay (link opened / payment failed)', 'Last call outcome', 'Call attempts'];
export const NEVER_USED = ['name', 'area', 'language', 'gender', 'age'];

export const WEIGHTS = {
  onTime: 40,          // × share of last 6 months paid on time
  reliability: 25,     // × promises kept / made (or on-time share if they never promised)
  overdue: 15,         // × freshness of the debt (recent overdue is easier to recover)
  partialHistory: 10,  // has paid in parts before
  base: 10,
  worsening: -10,      // payments getting later month by month
  triedToPay: 20,      // opened the link or a payment attempt failed recently
  promiseDue: 15,      // promise date is today or just passed
  partlyPaid: -15,     // already paid part of this cycle
  refused: -20,
  perMissedCall: -5,
};
export const MAX_ATTEMPTS = 3;
export const EXPLORE_SHARE = 0.1; // 10% of AI calls go to random people so the ranking can't fool itself

const DAY = 86_400_000;
export function today() {
  return process.env.TODAY ? new Date(process.env.TODAY) : new Date(new Date().toDateString());
}
const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const daysBetween = (from, to) => Math.round((to - new Date(from)) / DAY);

function overdueFactor(d) {
  if (d <= 30) return 1;
  if (d <= 60) return 0.6;
  if (d <= 90) return 0.35;
  return 0.15;
}

export function scoreAccount(a, now = today()) {
  const h = a.history || {};
  const out = a.lastOutcome || {};
  const pay = a.payment || {};
  const sig = a.signals || {};
  const attempts = a.attempts || 0;

  // People who should not be in the AI's call list today.
  if (pay.status === 'PAID') return { bucket: 'done', score: 0, reasons: ['Paid in full'], parts: [] };
  if (out.outcome === 'paid_claim') {
    return { bucket: 'verify', score: 0, parts: [], reasons: [`Says already paid${out.note ? ` ("${out.note}")` : ''}${out.reference ? `, ref ${out.reference}` : ''}. Human team verifies before any more calls`] };
  }
  if (out.outcome === 'hardship') {
    return { bucket: 'human', score: 0, parts: [], reasons: [`Hardship${out.note ? `: ${out.note}` : ''}. A person offers a plan, no pressure`] };
  }
  if (a.blockers?.length) {
    return { bucket: 'human', score: 0, parts: [], reasons: [`Data needs fixing first: ${a.blockers.join(', ')}`] };
  }
  if (attempts >= MAX_ATTEMPTS && out.outcome === 'no_answer') {
    return { bucket: 'human', score: 0, parts: [], reasons: [`No answer after ${attempts} calls. Stop calling; human team decides next step`] };
  }

  // Borrowers ranked by the teammate's rank.py: use its score, band, queue and reason,
  // then apply live events (payment attempts, part payments, lapsed promises) on top.
  const ext = a.external;
  if (ext) {
    const future = out.outcome === 'promise' && out.promiseDate && -daysBetween(out.promiseDate, now) > 0;
    if (future) return { bucket: 'scheduled', score: Math.round(ext.priority), parts: [], reasons: [`Promised to pay on ${fmt(out.promiseDate)}${out.note ? ` ("${out.note}")` : ''}. AI calls back then`, ext.reason] };
    const live = Boolean(a.lastOutcome || sig.paymentFailedAt || pay.status);
    if (!live) {
      const map = { verify_payment: 'verify', human_desk: 'human', skip_trace: 'human', field_or_human: 'human', hold: 'scheduled', closed: 'done' };
      const why = {
        verify_payment: 'Says already paid. Collect UTR / reference and verify first',
        human_desk: 'Dispute or hardship. A person handles it, no collection push',
        skip_trace: 'Wrong number. Find an alternate contact',
        field_or_human: 'High risk and 60+ days overdue. Field visit / human call',
        hold: `On hold until ${ext.holdUntil ? fmt(ext.holdUntil) : 'later'} (${(ext.ruleId || '').replace(/^R\d+_/, '').replace(/_/g, ' ')})`,
        closed: 'Nothing overdue',
      };
      if (map[ext.queue]) return { bucket: map[ext.queue], score: Math.round(ext.priority), parts: [], reasons: [why[ext.queue], ext.reason] };
    }
    const band = ext.band.replace(/_/g, ' ').replace(/^(\w) /, '$1 · ');
    const xparts = [{ label: `Band ${band} (pay-speed ${ext.payScore})`, points: ext.priority }];
    if (sig.paymentFailedAt) xparts.push({ label: `Tried to pay on ${fmt(sig.paymentFailedAt)} but it failed`, points: WEIGHTS.triedToPay });
    if (pay.status === 'PARTIALLY_PAID') xparts.push({ label: `Part paid ₹${pay.paid} of ₹${pay.amount}`, points: WEIGHTS.partlyPaid });
    if (out.outcome === 'refused') xparts.push({ label: 'Refused last call', points: WEIGHTS.refused });
    if (out.outcome === 'no_answer') xparts.push({ label: `No answer (${attempts || 1}×)`, points: WEIGHTS.perMissedCall * (attempts || 1) });
    if (out.outcome === 'promise' && out.promiseDate) xparts.push({ label: `Promise lapsed on ${fmt(out.promiseDate)}`, points: WEIGHTS.promiseDue });
    const lead = xparts.length > 1 ? xparts.at(-1).label : null;
    return {
      bucket: 'call', score: clamp(Math.round(xparts.reduce((s, p) => s + p.points, 0))),
      reasons: [lead, ext.reason, `Band ${band}`].filter(Boolean),
      parts: xparts.map((p) => ({ ...p, points: Math.round(p.points) })),
    };
  }

  const onTime = (h.onTimeLast6 ?? 3) / 6;
  // Some people never promise but always pay: judge them by what they actually paid.
  const reliability = h.promisesMade ? h.promisesKept / h.promisesMade : onTime;
  const overdue = a.overdueDays ?? (a.dueDate ? daysBetween(a.dueDate, now) : 0);
  const parts = [
    { label: `Paid on time ${h.onTimeLast6 ?? '?'} of last 6`, points: WEIGHTS.onTime * onTime },
    { label: h.promisesMade ? `Kept ${h.promisesKept} of ${h.promisesMade} promises` : 'No promise history (uses on-time record)', points: WEIGHTS.reliability * reliability },
    { label: `${overdue} days overdue`, points: WEIGHTS.overdue * overdueFactor(overdue) },
    { label: 'Base', points: WEIGHTS.base },
  ];
  if (h.partialPays) parts.push({ label: 'Has paid in parts before', points: WEIGHTS.partialHistory });
  if (h.trend === 'worsening') parts.push({ label: 'Payments getting later', points: WEIGHTS.worsening });
  if (sig.paymentFailedAt) parts.push({ label: `Tried to pay on ${fmt(sig.paymentFailedAt)} but it failed`, points: WEIGHTS.triedToPay });
  else if (sig.linkOpenedAt) parts.push({ label: `Opened the payment link on ${fmt(sig.linkOpenedAt)}`, points: WEIGHTS.triedToPay / 2 });
  if (pay.status === 'PARTIALLY_PAID') parts.push({ label: `Part paid ₹${pay.paid} of ₹${pay.amount}`, points: WEIGHTS.partlyPaid });
  if (out.outcome === 'refused') parts.push({ label: 'Refused last call', points: WEIGHTS.refused });
  if (out.outcome === 'no_answer') parts.push({ label: `No answer (${attempts || 1}×)`, points: WEIGHTS.perMissedCall * (attempts || 1) });

  let headline = null;
  if (out.outcome === 'promise' && out.promiseDate) {
    const until = -daysBetween(out.promiseDate, now);
    if (until > 0) {
      const score = Math.round(parts.reduce((s, p) => s + p.points, 0));
      return { bucket: 'scheduled', score: clamp(score), parts, reasons: [`Promised to pay on ${fmt(out.promiseDate)}${out.note ? ` ("${out.note}")` : ''}. AI calls back then`, ...parts.map((p) => p.label)] };
    }
    parts.push({ label: until === 0 ? 'Promise due today' : `Promise lapsed on ${fmt(out.promiseDate)}`, points: WEIGHTS.promiseDue });
    headline = parts.at(-1).label;
  }

  const score = clamp(Math.round(parts.reduce((s, p) => s + p.points, 0)));
  // Headline = the most decisive thing: a lapsed promise, a payment attempt, a refusal, else history.
  const lead = headline || parts.find((p) => /Tried to pay|Opened the payment|Refused|No answer|Part paid|getting later/.test(p.label))?.label;
  const reasons = [...new Set([lead, ...parts.filter((p) => p.label !== 'Base').map((p) => p.label)].filter(Boolean))];
  return { bucket: 'call', score, reasons, parts: parts.map((p) => ({ ...p, points: Math.round(p.points) })) };
}

const clamp = (n) => Math.max(0, Math.min(100, n));
const BUCKET_ORDER = { call: 0, scheduled: 1, verify: 2, human: 3, done: 4 };

// Stable pseudo-random number per account per day (so the 10% random picks don't jump around on refresh).
function dailyHash(id, now) {
  let h = 2166136261;
  for (const c of `${id}|${now.toISOString().slice(0, 10)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

export function rankAccounts(accounts, now = today(), { explore = true } = {}) {
  const scored = accounts.map((a) => ({ ...a, rank: scoreAccount(a, now) }));
  const sorted = scored.sort((x, y) => BUCKET_ORDER[x.rank.bucket] - BUCKET_ORDER[y.rank.bucket] || y.rank.score - x.rank.score || String(x.id).localeCompare(String(y.id)));

  let callList = sorted.filter((a) => a.rank.bucket === 'call');
  const rest = sorted.filter((a) => a.rank.bucket !== 'call');
  const k = explore ? Math.floor(callList.length * EXPLORE_SHARE) : 0;
  if (k > 0) {
    // Pick k random people from outside the top 10 and slot one in at every 10th position.
    const pool = callList.slice(10).sort((x, y) => dailyHash(x.id, now) - dailyHash(y.id, now)).slice(0, k);
    const picked = new Set(pool.map((a) => a.id));
    const ranked = callList.filter((a) => !picked.has(a.id));
    pool.forEach((a, i) => {
      a.rank = { ...a.rank, explore: true, reasons: ['Random check (10% of calls) so the ranking keeps learning from people it would skip', ...a.rank.reasons] };
      ranked.splice(Math.min(ranked.length, (i + 1) * 10 - 1), 0, a);
    });
    callList = ranked;
  }
  return [...callList, ...rest].map((a, i) => ({ ...a, position: i + 1 }));
}

// Fairness check: swap every protected field between people and re-rank.
// If the order doesn't change, the score cannot be leaning on those fields.
export function fairnessCheck(accounts) {
  const order = (list) => rankAccounts(list, today(), { explore: false }).map((a) => a.id).join();
  const shuffled = accounts.map((a, i) => {
    const donor = accounts[(i + 1) % accounts.length];
    return { ...a, name: donor.name, area: donor.area, language: donor.language, gender: donor.gender, age: donor.age };
  });
  return { pass: order(accounts) === order(shuffled), shuffledFields: NEVER_USED, usedSignals: USED_SIGNALS, checkedAt: new Date().toISOString() };
}

// Hard rules checked in code before any AI call (not just in the agent's prompt).
export function callPolicy(account, now = new Date()) {
  const [from, to] = (process.env.CALL_WINDOW || '8-19').split('-').map(Number);
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const bucket = scoreAccount(account).bucket;
  if (!process.env.IGNORE_CALL_WINDOW && (hour < from || hour >= to)) return { allowed: false, reason: `Outside the calling window (${from}:00–${to}:00 IST)` };
  if ((account.attempts || 0) >= MAX_ATTEMPTS) return { allowed: false, reason: `Already called ${account.attempts} times this cycle` };
  if (bucket === 'human') return { allowed: false, reason: 'Hardship or unreachable cases go to a person, not the AI' };
  if (bucket === 'verify') return { allowed: false, reason: 'Says already paid: human team verifies first' };
  if (bucket === 'done') return { allowed: false, reason: 'Already paid' };
  if (bucket === 'scheduled') return { allowed: false, reason: `Promised to pay on ${fmt(account.lastOutcome.promiseDate)}. Wait until then` };
  return { allowed: true };
}

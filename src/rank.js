// Who should we call first? A transparent, rule-based score with a reason a manager can read aloud.
//
// USED signals (behaviour only): on-time history, promises kept, days overdue, part-payment history,
// latest call outcome, payment-link status, call attempts.
// NEVER used: name, area/pincode, language, gender (or anything that can stand in for caste/religion/class).
// Language only decides which language we call in.
export const USED_SIGNALS = ['On-time payments (last 6)', 'Promises kept vs made', 'Days overdue', 'Part payments before', 'Last call outcome', 'Payment link status', 'Call attempts'];
export const NEVER_USED = ['name', 'area', 'language', 'gender'];

const DAY = 86_400_000;

export function today() {
  return process.env.TODAY ? new Date(process.env.TODAY) : new Date(new Date().toDateString());
}

const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const days = (from, to) => Math.round((to - new Date(from)) / DAY);

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
  const reasons = [];

  // Terminal / hold states first — these people should not be in today's call list.
  if (pay.status === 'PAID') return { bucket: 'done', score: 0, reasons: ['Paid in full'] };
  if (out.outcome === 'paid_claim') return { bucket: 'verify', score: 0, reasons: [`Says already paid${out.note ? ` (${out.note})` : ''}. Verify before calling again`] };
  if (out.outcome === 'hardship') return { bucket: 'human', score: 0, reasons: [`Hardship${out.note ? `: ${out.note}` : ''}. Offer a plan via a person, no pressure`] };

  const onTime = (h.onTimeLast6 ?? 3) / 6;
  // Some people never promise but always pay: with no promise history, judge them by what they actually paid.
  const reliability = h.promisesMade ? h.promisesKept / h.promisesMade : onTime;
  const overdue = days(a.dueDate, now);
  let score = 40 * onTime + 25 * reliability + 15 * overdueFactor(overdue) + (h.partialPays ? 10 : 0) + 10;

  reasons.push(`Paid on time ${h.onTimeLast6 ?? '?'} of last 6`);
  if (h.promisesMade) reasons.push(`Kept ${h.promisesKept} of ${h.promisesMade} promises`);
  reasons.push(`${overdue} days overdue`);
  if (h.partialPays) reasons.push('Has paid in parts before');

  if (pay.status === 'PARTIALLY_PAID') {
    score -= 15;
    reasons.unshift(`Part paid ₹${pay.paid} of ₹${pay.amount}. Follow up on the rest`);
  }

  if (out.outcome === 'promise' && out.promiseDate) {
    const until = -days(out.promiseDate, now);
    if (until > 0) return { bucket: 'scheduled', score: Math.round(score), reasons: [`Promised to pay on ${fmt(out.promiseDate)}. Call then`, ...reasons] };
    score += 15;
    reasons.unshift(until === 0 ? 'Promise due today' : `Promise lapsed on ${fmt(out.promiseDate)}`);
  }
  if (out.outcome === 'refused') { score -= 20; reasons.unshift('Refused last call'); }
  if (out.outcome === 'no_answer') { score -= 5 * (a.attempts || 1); reasons.unshift(`No answer (${a.attempts || 1}×)`); }

  return { bucket: 'call', score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

const BUCKET_ORDER = { call: 0, scheduled: 1, verify: 2, human: 3, done: 4 };

export function rankAccounts(accounts, now = today()) {
  return accounts
    .map((a) => ({ ...a, rank: scoreAccount(a, now) }))
    .sort((x, y) => BUCKET_ORDER[x.rank.bucket] - BUCKET_ORDER[y.rank.bucket] || y.rank.score - x.rank.score || x.id.localeCompare(y.id))
    .map((a, i) => ({ ...a, position: i + 1 }));
}

// Fairness check: shuffle every protected field across accounts and re-rank.
// If the order doesn't change, the score cannot be leaning on those fields.
export function fairnessCheck(accounts) {
  const before = rankAccounts(accounts).map((a) => a.id);
  const shuffled = accounts.map((a, i) => {
    const donor = accounts[(i + 1) % accounts.length];
    return { ...a, name: donor.name, area: donor.area, language: donor.language, gender: donor.gender };
  });
  const after = rankAccounts(shuffled).map((a) => a.id);
  return { pass: before.join() === after.join(), shuffledFields: NEVER_USED, usedSignals: USED_SIGNALS, checkedAt: new Date().toISOString() };
}

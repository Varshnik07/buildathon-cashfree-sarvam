// Look-back test: rank 30,000 real borrowers using only their past 6 months, then reveal who
// actually paid next month. Compares our order with loan-number order (what callers do today)
// and random order. Writes public/proof.json for the Proof section of the console.
// Usage: node scripts/proof/backtest.js <uci-accounts.json>
import fs from 'node:fs';
import { rankAccounts, fairnessCheck } from '../../src/rank.js';

const book = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const DAILY = 360, DAYS = 10, CAP = DAILY * DAYS;
const totalPayers = book.filter((a) => a.paidNextMonth).length;

// Seeded shuffle so the random baseline is repeatable.
function shuffled(list, seed = 42) {
  const a = [...list];
  let s = seed;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const ranked = rankAccounts(book, new Date('2026-11-21'), { explore: false });
const orders = {
  ours: ranked,
  loanNumber: [...book].sort((x, y) => x.id - y.id),
  random: shuffled(book),
};

const reach = (order, k) => {
  const top = order.slice(0, k);
  const payers = top.filter((a) => a.paidNextMonth);
  return { calls: k, payers: payers.length, nonPayers: k - payers.length, rupees: payers.reduce((s, a) => s + a.amountDue, 0) };
};
// Cumulative calls wasted on people who did not pay, across the 10-day call budget.
const curve = (order) => Array.from({ length: 51 }, (_, i) => {
  const k = Math.round((CAP * i) / 50);
  return [k, order.slice(0, k).filter((a) => !a.paidNextMonth).length];
});

const bands = [[80, 101], [60, 80], [40, 60], [20, 40], [0, 20]].map(([lo, hi]) => {
  const grp = ranked.filter((a) => a.rank.score >= lo && a.rank.score < hi);
  return { band: `${lo}–${Math.min(hi, 100)}`, people: grp.length, paidPct: grp.length ? +((100 * grp.filter((a) => a.paidNextMonth).length) / grp.length).toFixed(1) : null };
});

const groupStats = (key, label) => {
  const top = ranked.slice(0, CAP);
  const groups = [...new Set(book.map(key))].sort();
  return groups.map((g) => {
    const all = book.filter((a) => key(a) === g);
    const sel = top.filter((a) => key(a) === g);
    return {
      group: `${label}: ${g}`,
      shareOfBook: +((100 * all.length) / book.length).toFixed(1),
      shareOfCalls: +((100 * sel.length) / CAP).toFixed(1),
      paidPctInCalls: sel.length ? +((100 * sel.filter((a) => a.paidNextMonth).length) / sel.length).toFixed(1) : null,
    };
  });
};
const ageBand = (a) => (a.age < 30 ? '<30' : a.age < 40 ? '30–39' : a.age < 50 ? '40–49' : '50+');

const proof = {
  dataset: 'UCI Default of Credit Card Clients (30,000 real, anonymised borrowers, 6 months of history)',
  source: 'https://archive.ics.uci.edu/dataset/350/default+of+credit+card+clients',
  people: book.length,
  payRate: +((100 * totalPayers) / book.length).toFixed(1),
  capacity: { daily: DAILY, days: DAYS, calls: CAP },
  firstDay: Object.fromEntries(Object.entries(orders).map(([k, o]) => [k, reach(o, DAILY)])),
  tenDays: Object.fromEntries(Object.entries(orders).map(([k, o]) => [k, reach(o, CAP)])),
  curve: Object.fromEntries(Object.entries(orders).map(([k, o]) => [k, curve(o)])),
  bands,
  fairness: {
    shuffleTest: fairnessCheck(book.slice(0, 3000)).pass,
    groups: [...groupStats((a) => a.gender, 'Gender'), ...groupStats(ageBand, 'Age')],
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync('public/proof.json', JSON.stringify(proof, null, 2));
console.log('first day', proof.firstDay);
console.log('ten days', proof.tenDays);
console.log('bands', proof.bands);
console.log('fairness', proof.fairness);

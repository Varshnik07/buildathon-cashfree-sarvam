// Convert the teammate's rank.py output (priority_queue.csv) into our account format.
// Usage: node scripts/import-teammate-queue.js <priority_queue.csv> data/teammate-accounts.json
import fs from 'node:fs';
import { parseCSV } from '../src/importer.js';

const LANG = { tamil: 'ta-IN', hindi: 'hi-IN', telugu: 'te-IN', kannada: 'kn-IN', malayalam: 'ml-IN', marathi: 'mr-IN', bengali: 'bn-IN', gujarati: 'gu-IN', english: 'en-IN', punjabi: 'pa-IN', odia: 'od-IN' };
const [src, out] = process.argv.slice(2);
const rows = parseCSV(fs.readFileSync(src, 'utf8'));
const head = rows[0];
const accounts = rows.slice(1).map((r) => {
  const x = Object.fromEntries(head.map((h, i) => [h, r[i]]));
  const kept = Number(x.promises_kept || 0), broken = Number(x.promises_broken || 0);
  return {
    id: x.borrower_id, name: x.name, phone: x.phone.replace(/\D/g, '').slice(-10),
    language: LANG[String(x.preferred_language).toLowerCase()] || 'ta-IN',
    amountDue: Math.round(Number(x.balance_overdue_inr)), overdueDays: Number(x.days_overdue),
    history: { onTimeLast6: Math.round(Number(x.on_time_rate) * 6), promisesMade: kept + broken, promisesKept: kept },
    external: {
      source: 'rank.py', queue: x.queue, action: x.action, channel: x.channel, ruleId: x.rule_id,
      band: x.band, payScore: Number(x.pay_speed_score), priority: Number(x.priority_score),
      holdUntil: x.hold_until || null, reason: x.reason, flags: x.review_flags || '',
    },
  };
});
fs.writeFileSync(out, JSON.stringify({ accounts }));
console.log(`wrote ${accounts.length} accounts to ${out}`);

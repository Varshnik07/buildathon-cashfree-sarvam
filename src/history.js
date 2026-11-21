// Per-borrower history from the teammate's sample data (payment history, contact log, loan, current dues).
// Loaded once, indexed by borrower_id. Shown in the "why" panel; personal fields are display-only, never ranked.
import fs from 'node:fs';
import { parseCSV } from './importer.js';

const DIR = 'data/history';
let index = null;

function load(file) {
  const path = `${DIR}/${file}`;
  if (!fs.existsSync(path)) return [];
  const rows = parseCSV(fs.readFileSync(path, 'utf8'));
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function group(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.borrower_id)) m.set(r.borrower_id, []);
    m.get(r.borrower_id).push(r);
  }
  return m;
}

function build() {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return {
    payments: group(load('payment_history.csv').map((r) => ({
      borrower_id: r.borrower_id, loanId: r.loan_id, n: num(r.instalment_no), due: r.due_date, paid: r.paid_date || null,
      amountDue: num(r.amount_due), amountPaid: num(r.amount_paid), daysLate: num(r.days_late), daysEarly: num(r.days_early),
    }))),
    contacts: group(load('contact_log.csv').map((r) => ({
      borrower_id: r.borrower_id, date: r.contact_date, channel: r.channel, by: r.agent_type, outcome: r.outcome,
      promiseDate: r.promise_date || null, promiseType: r.promise_type || null, promiseStatus: r.promise_status || null,
      promiseAmount: num(r.promise_amount_inr), notes: r.notes || '',
    }))),
    dues: new Map(load('current_dues.csv').map((r) => [r.borrower_id, r])),
    profiles: new Map(load('borrowers.csv').map((r) => [r.borrower_id, r])),
  };
}

export function historyFor(id) {
  if (!index) index = build();
  const pays = (index.payments.get(id) || []).sort((a, b) => (a.due < b.due ? 1 : -1));
  const p = index.profiles.get(id);
  const d = index.dues.get(id);
  return {
    profile: p ? {
      city: p.city, language: p.preferred_language, channel: p.preferred_channel, occupation: p.occupation,
      incomeType: p.income_type, monthlyIncome: Number(p.monthly_income_inr) || null,
      loanType: p.loan_type, loanAmount: Number(p.loan_amount_inr) || null, emi: Number(p.emi_inr) || null,
    } : null,
    dues: d ? {
      emi: Number(d.emi_inr), emisOverdue: Number(d.emis_overdue), dueDate: d.due_date, daysOverdue: Number(d.days_overdue),
      status: d.status, received: Number(d.amount_received_inr), balance: Number(d.balance_overdue_inr), nextEmi: d.next_emi_date,
    } : null,
    payments: { total: pays.length, onTime: pays.filter((x) => !x.daysLate).length, recent: pays.slice(0, 12) },
    contacts: (index.contacts.get(id) || []).sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

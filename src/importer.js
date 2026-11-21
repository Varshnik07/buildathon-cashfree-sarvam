// Import a messy borrower book (CSV / TSV / semicolon) and clean it into accounts.
// Handles: odd column names, ₹ / commas / "1.2L" / "5k" amounts, +91 phones, many date formats,
// duplicate rows, missing values, and free-text field notes (Tamil / Tanglish / English).
// Nothing is silently "fixed": every guess is recorded as an issue on the account.
import { heuristicSignals } from './signals.js';
import { today } from './rank.js';

const ALIASES = {
  id: ['id', 'loanid', 'loanno', 'loannumber', 'loan', 'accountid', 'accountno', 'account', 'acno', 'acctno', 'customerid', 'borrowerid', 'refno'],
  name: ['name', 'borrower', 'borrowername', 'customername', 'customer', 'fullname', 'membername'],
  phone: ['phone', 'mobile', 'mobileno', 'mobilenumber', 'phoneno', 'phonenumber', 'contact', 'contactno', 'cell'],
  email: ['email', 'emailid', 'mail'],
  language: ['language', 'lang', 'preferredlanguage', 'languagepreference'],
  amountDue: ['amountdue', 'due', 'dueamount', 'outstanding', 'outstandingamount', 'balance', 'overdueamount', 'overdue', 'amount', 'emi', 'emiamount', 'pending'],
  dueDate: ['duedate', 'emidate', 'emiduedate', 'lastduedate', 'nextduedate', 'date', 'installmentdate'],
  overdueDays: ['dpd', 'daysoverdue', 'dayspastdue', 'overduedays', 'daysdue'],
  onTimeLast6: ['ontimelast6', 'ontime', 'ontimepayments', 'paidontime', 'ontimecount'],
  promisesMade: ['promisesmade', 'ptpmade', 'promises', 'ptpcount'],
  promisesKept: ['promiseskept', 'ptpkept', 'keptpromises'],
  partialPays: ['partialpays', 'partialpayments', 'partpayments', 'partpaid'],
  attempts: ['attempts', 'callattempts', 'calls', 'callsmade'],
  notes: ['notes', 'note', 'fieldnotes', 'fieldnote', 'remarks', 'remark', 'comments', 'comment', 'agentnotes', 'lastremark'],
  area: ['area', 'locality', 'village', 'branch', 'pincode', 'pin', 'city'],
  gender: ['gender', 'sex'],
  age: ['age'],
};
const LANGS = { ta: 'ta-IN', tamil: 'ta-IN', tam: 'ta-IN', hi: 'hi-IN', hindi: 'hi-IN', kn: 'kn-IN', kannada: 'kn-IN', te: 'te-IN', telugu: 'te-IN', ml: 'ml-IN', malayalam: 'ml-IN', en: 'en-IN', english: 'en-IN' };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseCSV(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const delim = [',', '\t', ';', '|'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function parseAmount(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).toLowerCase().replace(/₹|rs\.?|inr|\/-|\s/g, '').replace(/,/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(k|l|lakh|lac|lakhs|cr|crore)?$/);
  if (!m) return null;
  const mult = { k: 1e3, l: 1e5, lakh: 1e5, lac: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7 }[m[2]] || 1;
  return Math.round(Number(m[1]) * mult);
}

function parsePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

// Indian convention: day first. Returns YYYY-MM-DD or null.
function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (m) {
    let [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return iso(y, mo - 1, d);
  }
  m = s.match(/^(\d{1,2})[\s\-]*([a-z]{3})[a-z]*[\s\-,]*(\d{2,4})?$/i) || s.match(/^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})?$/i);
  if (m) {
    const [day, mon] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]];
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    let y = m[3] ? +m[3] : today().getFullYear();
    if (y < 100) y += 2000;
    return iso(y, month, day);
  }
  return null;
}
const iso = (y, mo, d) => {
  const dt = new Date(Date.UTC(y, mo, d));
  return Number.isNaN(dt.getTime()) || dt.getUTCDate() !== d ? null : dt.toISOString().slice(0, 10);
};

export function importBook(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('File needs a header row and at least one data row');
  const headers = rows[0].map((h) => h.trim());
  const keys = headers.map(norm);

  const columns = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const idx = keys.findIndex((k) => names.includes(k));
    if (idx >= 0) columns[field] = idx;
  }
  // Month-by-month status columns (e.g. PAY_1..PAY_6, M1..M6, status_1..): count on-time months.
  const monthCols = keys.map((k, i) => (/^(pay|status|m|month)\d$/.test(k) ? i : -1)).filter((i) => i >= 0).slice(0, 6);
  const used = new Set([...Object.values(columns), ...monthCols]);
  const unmapped = headers.filter((_, i) => !used.has(i));

  const byId = new Map();
  let duplicates = 0, issueCount = 0;
  const now = today();

  rows.slice(1).forEach((r, n) => {
    const get = (f) => (columns[f] === undefined ? '' : String(r[columns[f]] ?? '').trim());
    const issues = [];
    const id = get('id') || `ROW-${n + 2}`;
    if (!get('id')) issues.push('No account ID, used row number');

    const amountDue = parseAmount(get('amountDue'));
    if (amountDue === null) issues.push(`Amount due unreadable ("${get('amountDue')}")`);
    const phone = parsePhone(get('phone'));
    if (!phone) issues.push(get('phone') ? `Phone looks invalid ("${get('phone')}")` : 'No phone number');
    const dueDate = parseDate(get('dueDate'));
    if (get('dueDate') && !dueDate) issues.push(`Due date unreadable ("${get('dueDate')}")`);
    const langRaw = norm(get('language'));
    const language = LANGS[langRaw] || (/^[a-z]{2}in$/.test(langRaw) ? `${langRaw.slice(0, 2)}-IN` : null);
    if (!language) issues.push('Language missing, calling in Tamil');

    const history = {};
    const num = (f) => { const v = get(f); return v === '' || Number.isNaN(Number(v)) ? undefined : Number(v); };
    if (num('onTimeLast6') !== undefined) history.onTimeLast6 = Math.min(6, num('onTimeLast6'));
    else if (monthCols.length) {
      history.onTimeLast6 = monthCols.filter((i) => {
        const v = String(r[i] ?? '').trim().toLowerCase();
        return v === '' ? false : Number(v) <= 0 || /^(paid|ok|on ?time|yes|y)$/.test(v);
      }).length;
      // Trend: most recent month later than three months ago → getting worse.
      const st = monthCols.map((i) => Number(String(r[i] ?? '').trim()));
      if (st.length >= 3 && !Number.isNaN(st[0]) && !Number.isNaN(st[2]) && st[0] > 0 && st[0] > st[2]) history.trend = 'worsening';
    } else issues.push('No payment history, assumed average');
    if (num('promisesMade') !== undefined) history.promisesMade = num('promisesMade');
    if (num('promisesKept') !== undefined) history.promisesKept = Math.min(num('promisesKept'), history.promisesMade ?? Infinity);
    if (num('partialPays') !== undefined) history.partialPays = num('partialPays');

    const account = {
      id, name: get('name').replace(/\s+/g, ' ') || `Borrower ${id}`, phone: phone || '', email: get('email') || undefined,
      language: language || 'ta-IN', amountDue: amountDue ?? 0, dueDate: dueDate || undefined,
      overdueDays: num('overdueDays'), attempts: num('attempts') || 0, history,
      area: get('area') || undefined, gender: get('gender') || undefined, age: num('age'),
      notes: get('notes') || undefined,
    };
    if (!dueDate && account.overdueDays === undefined) issues.push('No due date or days overdue');

    // Field notes → signal (e.g. "salary 5th-ku varum" → promise on the 5th).
    if (account.notes) {
      const s = heuristicSignals(account.notes, now);
      if (s.outcome !== 'unclear') {
        account.lastOutcome = { outcome: s.outcome === 'partial' ? 'promise' : s.outcome, promiseDate: s.promise_date, amount: s.amount_offered, note: account.notes, source: 'field note' };
        if (s.outcome === 'partial') account.history.partialPays = (account.history.partialPays || 0) + 1;
        if (s.outcome === 'promise' && !s.promise_date) account.lastOutcome = { outcome: 'callback', note: account.notes, source: 'field note' };
      }
    }

    // Problems that make an AI call impossible or wrong: a person fixes these first.
    account.blockers = [];
    if (!phone) account.blockers.push('no valid phone number');
    if (amountDue === null) account.blockers.push('amount due unreadable');

    if (byId.has(id)) {
      duplicates++;
      const prev = byId.get(id);
      prev.issues.push(`Duplicate row ${n + 2} merged`);
      for (const [k, v] of Object.entries(account)) if (v !== undefined && v !== '' && (prev[k] === undefined || prev[k] === '')) prev[k] = v;
      // A later row can fix a blocker (e.g. supply the missing phone).
      prev.blockers = prev.blockers.filter((b) => !(b.includes('phone') && prev.phone) && !(b.includes('amount') && prev.amountDue));
      return;
    }
    account.issues = issues;
    issueCount += issues.length;
    byId.set(id, account);
  });

  const accounts = [...byId.values()];
  return {
    accounts,
    report: {
      rows: rows.length - 1,
      imported: accounts.length,
      duplicates,
      issues: issueCount + duplicates,
      withIssues: accounts.filter((a) => a.issues.length).length,
      columns: Object.fromEntries(Object.entries(columns).map(([f, i]) => [f, headers[i]])),
      monthColumns: monthCols.map((i) => headers[i]),
      unmapped,
    },
  };
}

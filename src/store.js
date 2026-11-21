// Tiny JSON-file store: accounts (people who owe money) + an event log.
// Good enough for a 4-hour build; swap for a DB later if needed.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/db.json');
let db = { accounts: {}, events: [] };

if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));

function save() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export function listAccounts() {
  return Object.values(db.accounts);
}

export function getAccount(id) {
  return db.accounts[id];
}

export function upsertAccount(account) {
  db.accounts[account.id] = { ...(db.accounts[account.id] || {}), ...account };
  save();
  return db.accounts[account.id];
}

export function replaceAccounts(accounts) {
  db.accounts = Object.fromEntries(accounts.map((a) => [a.id, a]));
  save();
}

export function reset(accounts = []) {
  db = { accounts: Object.fromEntries(accounts.map((a) => [a.id, a])), events: [] };
  save();
}

export function findAccountByLinkId(linkId) {
  return listAccounts().find((a) => a.payment?.linkId === linkId);
}

// Every change is logged so any decision can be traced and explained.
export function logEvent(type, accountId, data = {}) {
  const event = { at: new Date().toISOString(), type, accountId, data };
  db.events.push(event);
  save();
  return event;
}

export function listEvents(accountId) {
  return accountId ? db.events.filter((e) => e.accountId === accountId) : db.events;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountBrowserVoice } from '../src/browser-voice.js';

test('browser voice binds the borrower, keeps keys server-side and saves once', async t => {
  const app = express(); app.use(express.json());
  const events = [], upstream = [];
  const account = { id: 'demo-1', name: 'Demo borrower', amountDue: 2499 };
  const env = { SARVAM_VOICE_API_KEY: 'test-secret', SARVAM_VOICE_ORG_ID: 'org', SARVAM_VOICE_WORKSPACE_ID: 'workspace', SARVAM_VOICE_APP_ID: 'agent' };
  mountBrowserVoice(app, {
    store: { getAccount: id => id === account.id ? account : null, logEvent: (...args) => events.push(args) },
    callPolicy: () => ({ allowed: true }), remaining: () => 2499, partFloor: () => 600, env,
    fetcher: async (url, opts) => { upstream.push({ url: String(url), opts }); return Response.json({ url: 'wss://example.test/session', referenceId: 'test' }); },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post('/api/browser-voice/sessions', { account_id: 'missing' })).status, 404);
  const r = await post('/api/browser-voice/sessions', { account_id: account.id });
  assert.equal(r.status, 200); const data = await r.json();
  assert.equal(JSON.stringify(data).includes('test-secret'), false);
  assert.equal(data.config.agent_variables.customer_name, account.name);
  assert.equal(data.config.agent_variables.amount_due, 2499);
  assert.equal((await post('/api/browser-voice/sessions', { account_id: account.id })).status, 409);
  const path = '/api/browser-voice/runtime/orgs/org/workspaces/workspace/apps/agent/url';
  assert.equal((await fetch(base + path)).status, 403);
  const headers = { 'x-voice-session': data.session_id };
  assert.equal((await fetch(base + path.replace('/agent/', '/other/'), { headers })).status, 403);
  assert.equal((await fetch(base + path, { headers })).status, 200);
  assert.equal(upstream[0].opts.headers['X-API-Key'], 'test-secret');
  assert.equal(upstream[0].url.startsWith('https://apps.sarvam.ai/api/app-runtime/'), true);
  assert.equal((await fetch(base + path, { headers })).status, 403);
  const finish = `/api/browser-voice/sessions/${data.session_id}/finish`;
  assert.equal((await post(finish, { transcript: 'user: hello' })).status, 200);
  assert.equal((await post(finish, { transcript: 'user: hello' })).status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0][1], account.id);
  assert.equal((await post('/api/browser-voice/sessions', { account_id: account.id })).status, 200);
});

test('missing configuration and blocked borrowers do not receive sessions', async t => {
  const app = express(); app.use(express.json());
  mountBrowserVoice(app, {
    store: { getAccount: id => ({ id }) }, env: {},
    callPolicy: a => ({ allowed: a.id !== 'blocked', reason: 'Needs a person' }),
    remaining: () => 1, partFloor: () => 1,
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/browser-voice/sessions`;
  for (const [account_id, expected] of [['blocked', 409], ['allowed', 503]]) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id }) });
    assert.equal(r.status, expected);
  }
});

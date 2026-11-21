import { randomUUID } from 'node:crypto';

// Short-lived demo sessions; credentials never leave the server.
export function mountBrowserVoice(app, { store, callPolicy, remaining, env = process.env, fetcher = fetch }) {
  const sessions = new Map();
  const run = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch { res.status(502).json({ error: 'Voice service unavailable. Check the server configuration and try again.' }); }
  };
  app.post('/api/browser-voice/sessions', run(async (req, res) => {
    for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
    const a = store.getAccount(req.body.account_id);
    if (!a) return res.status(404).json({ error: 'Borrower not found' });
    const policy = callPolicy(a);
    if (!policy.allowed) return res.status(409).json({ error: policy.reason });
    const required = ['SARVAM_VOICE_API_KEY', 'SARVAM_VOICE_ORG_ID', 'SARVAM_VOICE_WORKSPACE_ID', 'SARVAM_VOICE_APP_ID'];
    const missing = required.filter(k => !env[k]);
    if (missing.length) return res.status(503).json({ error: `Browser voice is not configured: ${missing.join(', ')}` });
    if ([...sessions.values()].some(s => s.accountId === a.id && !s.finished)) return res.status(409).json({ error: 'A browser session is already open for this borrower.' });
    const id = randomUUID();
    // Same rules as the in-app call: A/B get a soft reminder; part payment (75%) only from the 2nd call.
    const due = remaining(a);
    const band = a.external?.band?.[0];
    const reminder = band === 'A' || band === 'B';
    const callNo = (a.attempts || 0) + 1;
    const floor = !reminder && callNo >= 2 ? Math.round((due * 0.75) / 100) * 100 : due;
    const first = String(a.name).split(' ')[0];
    const greeting = reminder
      ? `ஹலோ ${first}, நான் பிரியா பேசுறேன், loan team-லேருந்து. இந்த call record ஆகுது. ஒரு சின்ன reminder தான், உங்க EMI ${due} ரூபாய் due ஆகியிருக்கு. எப்போ கட்ட முடியும்?`
      : `ஹலோ ${first}, நான் பிரியா பேசுறேன், loan team-லேருந்து. இந்த call record ஆகுது. உங்க EMI ${due} ரூபாய் pending-ஆ இருக்கு. இன்னைக்கு கட்ட முடியுமா?`;
    store.upsertAccount({ id: a.id, attempts: callNo, lastCallAt: new Date().toISOString() });
    store.logEvent('call_requested', a.id, { summary: `Priya calling ${a.name} in Tamil (call #${callNo}${reminder ? ', reminder' : ''})` });
    const config = {
      org_id: env.SARVAM_VOICE_ORG_ID, workspace_id: env.SARVAM_VOICE_WORKSPACE_ID,
      app_id: env.SARVAM_VOICE_APP_ID, user_identifier: a.id, user_identifier_type: 'custom',
      interaction_type: 'call', input_sample_rate: 16000, output_sample_rate: 16000,
      agent_variables: { account_id: a.id, customer_name: a.name, amount_due: due, part_payment_floor: floor },
      initial_bot_message: greeting,
      ...(env.SARVAM_VOICE_VERSION ? { version: Number(env.SARVAM_VOICE_VERSION) } : {}),
    };
    sessions.set(id, { accountId: a.id, config, expires: Date.now() + 60 * 60 * 1000 });
    res.json({ session_id: id, config, customer_name: a.name });
  }));
  app.get('/api/browser-voice/runtime/orgs/:org/workspaces/:workspace/apps/:app/url', run(async (req, res) => {
    const s = sessions.get(req.get('x-voice-session'));
    if (!s || s.finished || s.expires < Date.now() || s.issued) return res.status(403).json({ error: 'Start a new browser session.' });
    const c = s.config;
    if (req.params.org !== c.org_id || req.params.workspace !== c.workspace_id || req.params.app !== c.app_id) return res.sendStatus(403);
    s.issued = true;
    const url = new URL(`https://apps.sarvam.ai/api/app-runtime/orgs/${encodeURIComponent(c.org_id)}/workspaces/${encodeURIComponent(c.workspace_id)}/apps/${encodeURIComponent(c.app_id)}/url`);
    url.searchParams.set('interaction_type', 'call');
    if (c.version) url.searchParams.set('version', c.version);
    const upstream = await fetcher(url, { headers: { 'X-API-Key': env.SARVAM_VOICE_API_KEY }, signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return res.status(502).json({ error: `Sarvam returned ${upstream.status}. Check voice credentials and commit the agent version.` });
    res.json(await upstream.json());
  }));
  app.post('/api/browser-voice/sessions/:id/finish', run(async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.expires < Date.now()) return res.status(404).json({ error: 'Session expired' });
    if (s.finished) return res.json({ ok: true });
    const transcript = req.body.transcript;
    if (typeof transcript !== 'string' || transcript.length > 80000) return res.status(400).json({ error: 'Invalid transcript' });
    const a = store.getAccount(s.accountId);
    if (!a) return res.status(404).json({ error: 'Borrower no longer exists' });
    // Save evidence without guessing commitments from the bot's own speech.
    store.logEvent('browser_voice_transcript', a.id, { transcript, summary: `Browser voice conversation with ${a.name} ended`, source: 'sarvam-browser' });
    s.finished = true;
    res.json({ ok: true });
  }));
}

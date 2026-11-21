// Live call in the browser with the Samvaad agent (Sarvam real-time voice).
// Uses the app's existing call panel (#callbox). When the call ends, the transcript is read by Sarvam
// on the server and the outcome is saved automatically, so the list re-forms with no manual review.
import { ConversationAgent, BrowserAudioInterface } from 'sarvam-conv-ai-sdk/browser';

export function createVoicePanel({ refresh, toast, onFallback }) {
  const box = document.getElementById('callbox');
  const card = document.getElementById('callcard');
  let current = null;

  async function request(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const $ = (sel) => card.querySelector(sel);
  const status = (t) => { const el = $('#callState'); if (el) el.textContent = t; };
  function bubble(role, text) {
    const d = document.createElement('div');
    d.className = `bub ${role === 'user' ? 'cust' : 'agent'}`;
    d.textContent = text;
    $('#callLog').appendChild(d);
    d.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  async function finish() {
    const s = current;
    if (!s || s.ending || s.ended) return;
    s.ending = true;
    await s.agent?.stop().catch(() => {});
    s.ended = true;
    if (!s.lines.length) { status('Call ended'); return; }
    status('Call ended · reading the conversation…');
    const transcript = s.lines.map((l) => `${l.role === 'user' ? 'Customer' : 'Priya'}: ${l.text}`).join('\n');
    try {
      if (s.id) await request(`/api/browser-voice/sessions/${s.id}/finish`, { transcript }).catch(() => {});
      const r = await request('/api/relay/outcome', { account_id: s.accountId, transcript });
      status(`Call ended · outcome: ${String(r.outcome?.outcome || 'saved').replace(/_/g, ' ')}${r.outcome?.promiseDate ? ` (${r.outcome.promiseDate})` : ''} · list re-forming`);
    } catch (err) { status(`Call ended · ${err.message}`); }
    await refresh();
  }

  window.addEventListener('pagehide', () => { current?.agent?.stop().catch(() => {}); });

  return async function start(account) {
    if (current && !current.ended) { box.hidden = false; return; }
    const s = (current = { accountId: account.id, lines: [], ended: false, ending: false });
    card.innerHTML = `<h3>📞 ${account.name.replace(/[<>&]/g, '')}</h3>
      <div class="meta">Priya · collections team · Tamil · call recorded</div>
      <div id="callLog"></div>
      <div class="callend"><span id="callState">Ringing…</span>
        <span><button class="btn ghost" id="muteCall" disabled>Mute</button> <button class="btn ghost" id="endVoice">End call</button></span></div>`;
    box.hidden = false;
    $('#endVoice').onclick = async () => { await finish(); box.hidden = true; refresh(); };
    $('#muteCall').onclick = () => {
      const a = s.agent;
      if (!a) return;
      if (a.isMuted()) { a.unmute(); $('#muteCall').textContent = 'Mute'; } else { a.mute(); $('#muteCall').textContent = 'Unmute'; }
    };
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Microphone needs https or localhost');
      const data = await request('/api/browser-voice/sessions', { account_id: account.id });
      s.id = data.session_id;
      s.agent = new ConversationAgent({
        apiKey: '', baseUrl: '/api/browser-voice/runtime/', customHeaders: { 'x-voice-session': s.id }, config: data.config,
        audioInterface: new BrowserAudioInterface(),
        stateCallback: (st) => { if (!s.ending && !s.ended) status(String(st)); },
        transcriptCallback: (msg) => { s.lines.push({ role: msg.role, text: msg.content }); bubble(msg.role, msg.content); },
        endCallback: () => { if (!s.starting) void finish(); },
      });
      s.starting = true;
      await s.agent.start();
      if (!await s.agent.waitForConnect(15)) throw new Error('Voice connection timed out');
      s.starting = false;
      $('#muteCall').disabled = false;
      status('Connected · just speak');
      refresh();
    } catch (err) {
      s.starting = false;
      s.ended = true;
      await s.agent?.stop().catch(() => {});
      // Samvaad not configured or unreachable: fall back to the built-in call so the demo never breaks.
      if (onFallback) { toast?.(`Live voice unavailable (${err.message}). Using built-in call.`); return onFallback(account); }
      status(`Could not start voice: ${err.message}`);
    }
  };
}

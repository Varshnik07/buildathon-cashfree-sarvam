import { ConversationAgent, BrowserAudioInterface } from 'sarvam-conv-ai-sdk/browser';

export function createVoicePanel({ refresh }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'voice-panel';
  dialog.innerHTML = `<h2>Browser voice demo</h2><p data-name></p><p role="status" data-status></p>
    <p>Speak through your microphone. The conversation transcript is saved for this demo.</p>
    <div data-transcript aria-live="polite" class="voice-transcript"></div>
    <div class="voice-actions"><button data-mute disabled>Mute</button><button data-end disabled>End call</button><button data-close>Close</button></div>
    <form hidden data-outcome><h3>Review call outcome</h3><p>Select the outcome you heard. Payment is confirmed separately by Cashfree.</p>
    <label>Outcome <select name="outcome"><option value="unclear">Needs review</option value="agreed_to_pay">Agreed to pay</option value="promise">Promise to pay</option value="partial">Partial payment promised</option value="paid_claim">Says already paid</option value="hardship">Hardship</option value="refused">Declined</option value="callback">Call back</option></select></label>
    <label>Agreed date <input name="date" type="date"></label><label>Agreed amount <input name="amount" type="number" min="1" step="0.01"></label>
    <button type="submit">Save outcome</button></form>`;
  document.body.append(dialog);
  const el = key => dialog.querySelector(`[data-${key}]`);
  let current = null;
  const status = text => { el('status').textContent = text; };
  async function request(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function lock(locked) {
    document.body.classList.toggle('voice-active', locked);
    document.querySelectorAll('#callNext,[data-call]').forEach(b => { b.disabled = locked; });
  }
  // Queue refreshes replace row buttons while a call is running.
  new MutationObserver(() => {
    if (current && !current.ended) document.querySelectorAll('#callNext,[data-call]').forEach(b => { if (!b.disabled) b.disabled = true; });
  }).observe(document.body, { childList: true, subtree: true });
  async function finish(message = 'Call ended. Transcript saved.') {
    const s = current;
    if (!s || s.ending || s.ended) return;
    s.ending = true;
    el('end').disabled = true; el('mute').disabled = true;
    await s.agent?.stop().catch(() => {});
    try {
      if (s.id) await request(`/api/browser-voice/sessions/${s.id}/finish`, { transcript: s.messages.join('\n') });
      status(message);
      s.ended = true;
      el('outcome').hidden = !s.messages.length;
      lock(false); el('close').disabled = false;
      await refresh();
    } catch (err) {
      status(`Audio stopped. Transcript not saved: ${err.message}. Click Retry save.`);
      el('end').textContent = 'Retry save'; el('end').disabled = false;
    } finally { s.ending = false; }
  }
  el('end').onclick = () => finish();
  el('mute').onclick = () => {
    if (!current?.agent) return;
    const a = current.agent;
    if (a.isMuted()) { a.unmute(); el('mute').textContent = 'Mute'; }
    else { a.mute(); el('mute').textContent = 'Unmute'; }
  };
  el('close').onclick = () => { if (!current || current.ended) dialog.close(); };
  dialog.addEventListener('cancel', e => { if (current && !current.ended) e.preventDefault(); });
  el('outcome').onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target), outcome = form.get('outcome'), date = form.get('date');
    if (['promise', 'partial'].includes(outcome) && !date) return status('Enter the agreed date before saving.');
    const button = e.target.querySelector('button'); button.disabled = true;
    try {
      await request('/api/relay/outcome', { account_id: current.accountId, outcome, promise_date: date || null, amount: form.get('amount') ? Number(form.get('amount')) : null, note: 'Reviewed after browser voice demo' });
      status('Outcome saved. Choose Call next when ready.'); el('outcome').hidden = true; await refresh();
    } catch (err) { status(err.message); } finally { button.disabled = false; }
  };
  window.addEventListener('pagehide', () => { current?.agent?.stop().catch(() => {}); });
  return async function start(accountId) {
    if (current && !current.ended) { dialog.showModal(); return; }
    current = { accountId, messages: [], ended: false, ending: false };
    const s = current;
    el('transcript').replaceChildren(); el('outcome').hidden = true; el('outcome').reset();
    el('name').textContent = accountId; el('close').disabled = true;
    el('end').disabled = true; el('end').textContent = 'End call'; el('mute').disabled = true; el('mute').textContent = 'Mute';
    dialog.showModal(); lock(true); status('Connecting to your voice agent…');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Microphone access requires HTTPS or localhost.');
      const data = await request('/api/browser-voice/sessions', { account_id: accountId });
      s.id = data.session_id; el('name').textContent = data.customer_name;
      s.agent = new ConversationAgent({
        apiKey: '', baseUrl: '/api/browser-voice/runtime/', customHeaders: { 'x-voice-session': s.id }, config: data.config,
        audioInterface: new BrowserAudioInterface(),
        stateCallback: state => { if (!s.ending && !s.ended) status(String(state)); },
        transcriptCallback: async msg => {
          const line = `${msg.role}: ${msg.content}`;
          s.messages.push(line);
          const p = document.createElement('p'); p.textContent = line; el('transcript').append(p); p.scrollIntoView({ block: 'nearest' });
        },
        endCallback: () => { if (!s.starting) void finish(); },
      });
      s.starting = true;
      await s.agent.start();
      if (!await s.agent.waitForConnect(15)) throw new Error('Connection timed out. Check that the Sarvam agent version is committed.');
      s.starting = false;
      el('end').disabled = false; el('mute').disabled = false; status('Connected — you can speak now.');
    } catch (err) {
      s.starting = false;
      await finish(`Could not start voice: ${err.message}`);
    }
  };
}

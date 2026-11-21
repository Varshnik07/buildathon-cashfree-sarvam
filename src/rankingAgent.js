// Ranking agent (teammate's prompts/1_prioritise_ranking_agent.md).
// Code scores everyone; this LLM reviews only the ~5% of cards rank.py flagged as conflicting,
// and may keep, move (±100 places) or requeue them. Code validates every decision and
// treats "low" confidence as keep. Falls back to the prompt's flag guidance if the LLM fails.
import fs from 'node:fs';
import * as sarvam from './sarvam.js';
import * as store from './store.js';

const CARDS_FILE = 'data/agent-review-queue.jsonl';
const QUEUES = ['verify_payment', 'contact_today', 'field_or_human', 'human_desk', 'hold'];
let job = { running: false, done: 0, total: 0, changed: 0, source: null, error: null };

const SYSTEM = `You review collection-priority decisions made by a scoring system for a lender.
The system has already scored every borrower from their payment history, promises, reachability and current dues.
You see only the cases where its signals conflict. Decide whether each proposed rank and action is right.

Use ONLY the fields on each card. Never invent payments, promises, reasons or circumstances.
If the card does not support a change, keep the decision.

You may: keep (default); move (rank_delta at most 100 up or down, negative = earlier);
requeue to one of verify_payment, contact_today, field_or_human, human_desk, hold;
change the action or channel text for the contact agent.
You may NOT: change scores or band; take anyone out of human_desk or hold; override dispute or hardship;
suggest waivers, settlements or legal steps.

Flags:
- good_history_but_now_30plus_dpd: likely a one-off shock. Keep high. Action: "check in, ask the reason, offer a partial payment or a date".
- good_payer_broke_recent_promise: keep in queue, ask for a firm date plus partial today. With 2+ promises broken in 30 days, rank_delta +50 to +100.
- sharp_recent_decline: treat as one band lower than the score.
- high_value_borderline_score: requeue to field_or_human.
- repeated_paid_claims: keep verify_payment. Action: "UTR or receipt required on this call; else human".
- asked_callback_then_unreachable: new_channel = whatsapp, call in the 17-19 slot.

Every change needs a reason under 25 words citing card fields. If unsure, confidence "low".
Return ONLY a JSON array, one object per card, same order:
{"borrower_id":"…","decision":"keep|move|requeue","rank_delta":0,"new_queue":null,"new_action":null,"new_channel":null,"reason":"…","confidence":"high|medium|low"}`;

export function loadCards() {
  if (!fs.existsSync(CARDS_FILE)) return [];
  return fs.readFileSync(CARDS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.code_rank - b.code_rank);
}

// The prompt's own flag guidance, applied by code (used when the LLM is unavailable).
function fallback(card) {
  const f = card.flags || [];
  const base = { borrower_id: card.borrower_id, decision: 'keep', rank_delta: 0, new_queue: null, new_action: null, new_channel: null, confidence: 'medium' };
  if (f.includes('high_value_borderline_score')) return { ...base, decision: 'requeue', new_queue: 'field_or_human', reason: `High balance with band ${card.band}; a human is worth the cost.` };
  if (f.includes('repeated_paid_claims')) return { ...base, new_action: 'UTR or receipt required on this call; else human', reason: 'Repeated paid claims without reference; require UTR this call.' };
  if (f.includes('sharp_recent_decline')) return { ...base, decision: 'move', rank_delta: 60, reason: 'Sharp recent decline in on-time payments; treat as one band lower.' };
  if (f.includes('asked_callback_then_unreachable')) return { ...base, new_channel: 'whatsapp', new_action: 'WhatsApp first, call 17-19', reason: 'Asked for callback, then unreachable; switch to WhatsApp, evening slot.' };
  if (f.includes('good_payer_broke_recent_promise')) return { ...base, new_action: 'ask firm date plus partial today', reason: 'Good payer who broke a recent promise; ask firm date and partial.' };
  if (f.includes('good_history_but_now_30plus_dpd')) return { ...base, decision: 'move', rank_delta: -30, new_action: 'check in, ask the reason, offer a partial payment or a date', reason: 'Strong history but now 30+ days overdue; likely one-off shock.' };
  return { ...base, reason: 'No flag supports a change.' };
}

// Code checks after the LLM: clip, validate queues, low confidence = keep.
function validate(d, card) {
  if (!d || d.borrower_id !== card.borrower_id) return null;
  const out = {
    decision: ['keep', 'move', 'requeue'].includes(d.decision) ? d.decision : 'keep',
    rankDelta: Math.max(-100, Math.min(100, Math.round(Number(d.rank_delta) || 0))),
    newQueue: QUEUES.includes(d.new_queue) ? d.new_queue : null,
    newAction: d.new_action ? String(d.new_action).slice(0, 120) : null,
    newChannel: d.new_channel ? String(d.new_channel).slice(0, 30) : null,
    reason: String(d.reason || '').split(/\s+/).slice(0, 30).join(' '),
    confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'low',
  };
  if (out.confidence === 'low') return { ...out, decision: 'keep', rankDelta: 0, newQueue: null, note: 'low confidence: code decision stands' };
  if (out.decision !== 'move') out.rankDelta = 0;
  // Declining payers may only move down, never up (the LLM sometimes flips the sign).
  const flags = card.flags || [];
  if (out.rankDelta < 0 && (flags.includes('sharp_recent_decline') || flags.includes('good_payer_broke_recent_promise'))) {
    return { ...out, decision: 'keep', rankDelta: 0, note: 'rejected: a declining payer cannot move up' };
  }
  if (out.decision !== 'requeue') out.newQueue = null;
  return out;
}

async function reviewBatch(cards) {
  if (!process.env.SARVAM_API_KEY) return { decisions: cards.map(fallback), source: 'rules' };
  try {
    const raw = await sarvam.chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: cards.map((c) => JSON.stringify(c)).join('\n') },
    ], { temperature: 0.1 });
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    return { decisions: cards.map((c) => arr.find((d) => d.borrower_id === c.borrower_id) || fallback(c)), source: 'sarvam' };
  } catch (err) {
    console.warn('Ranking agent LLM failed, using rule fallback:', err.message);
    return { decisions: cards.map(fallback), source: 'rules (LLM failed)' };
  }
}

export function status() {
  return job;
}

export async function run({ limit = 25, batchSize = 8 } = {}) {
  if (job.running) throw new Error('Ranking agent is already running');
  const cards = loadCards().filter((c) => store.getAccount(c.borrower_id)).slice(0, limit);
  if (!cards.length) throw new Error('No flagged cards for the borrowers in this book');
  job = { running: true, done: 0, total: cards.length, changed: 0, source: null, error: null, startedAt: new Date().toISOString() };
  store.logEvent('agent_review', null, { summary: `Ranking agent reviewing ${cards.length} flagged borrowers (of ${loadCards().length})` });

  (async () => {
    try {
      for (let i = 0; i < cards.length; i += batchSize) {
        const batch = cards.slice(i, i + batchSize);
        const { decisions, source } = await reviewBatch(batch);
        job.source = source;
        batch.forEach((card, k) => {
          const v = validate(decisions[k], card) || validate(fallback(card), card);
          const a = store.getAccount(card.borrower_id);
          store.upsertAccount({ id: a.id, agent: { ...v, flags: card.flags, source, at: new Date().toISOString() } });
          const what = v.decision === 'move' ? `moved ${v.rankDelta < 0 ? 'up' : 'down'} ${Math.abs(v.rankDelta)} places`
            : v.decision === 'requeue' ? `sent to ${v.newQueue.replace(/_/g, ' ')}` : v.newAction || v.newChannel ? 'kept, changed approach' : 'kept';
          if (v.decision !== 'keep' || v.newAction || v.newChannel) job.changed++;
          store.logEvent('agent_decision', a.id, { ...v, summary: `Ranking agent: ${a.name} ${what}. ${v.reason}` });
        });
        job.done += batch.length;
      }
      store.logEvent('agent_review', null, { summary: `Ranking agent finished: ${job.changed} of ${job.total} changed, rest kept (${job.source})` });
    } catch (err) {
      job.error = err.message;
      store.logEvent('agent_review', null, { summary: `Ranking agent stopped: ${err.message}` });
    } finally {
      job.running = false;
    }
  })();
  return job;
}

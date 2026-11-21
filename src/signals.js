// Turn a field note or call transcript (Tamil / Tanglish / Hindi / English) into a payment signal.
// Uses the Sarvam chat model when a key is set, and falls back to keyword rules so the demo
// never depends on the network.
import * as sarvam from './sarvam.js';

const MONTH_DAY = /(\d{1,2})\s*(?:st|nd|rd|th|ம்|ஆம்|-?ku|-?க்கு|tarikh|tareek|தேதி|date)/i;

const RULES = [
  { outcome: 'hardship', re: /hospital|hospitalis|மருத்துவமனை|accident|operation|surgery|died|death|இறந்|job (?:loss|lost)|velai poy|வேலை போ|lost (?:my|his|her) job|sick|illness|flood|வெள்ளம்|cyclone/i },
  { outcome: 'paid_claim', re: /already paid|paid (?:at|in|to)|kattiten|kattitten|kattiten|கட்டிட்டேன்|கட்டிவிட்டேன்|de diya|diya hai|gpay pann|gpay la|paid yesterday|branch(?:-| )?(?:la|il|mein|ல)|cash kuduth|கொடுத்துட்டேன்/i },
  { outcome: 'refused', re: /won'?t pay|will not pay|not paying|refuse|kattamatten|கட்டமாட்டேன்|nahi dunga|don'?t call/i },
  { outcome: 'no_answer', re: /no answer|not reachable|switched off|not picking|didn'?t pick|ringing|எடுக்கல/i },
  { outcome: 'partial', re: /\bhalf\b|paathi|பாதி|part(?:ial)? pay|konjam konjam|கொஞ்சம் கொஞ்சம்|aadha/i },
  { outcome: 'promise', re: /salary|sambalam|சம்பளம்|will pay|pay (?:on|by|next)|tharen|தரேன்|kattiduven|கட்டிடுவேன்|dunga|next week|after pongal|pongal ku|பொங்கல்/i },
];

// Next calendar date for a day-of-month (e.g. "5th" said on 21 Nov → 5 Dec).
function nextDayOfMonth(day, now) {
  let y = now.getFullYear(), m = now.getMonth();
  if (day <= now.getDate()) m += 1;
  if (m > 11) { m = 0; y += 1; }
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function heuristicSignals(text, now = new Date()) {
  const t = String(text || '');
  const hit = RULES.find((r) => r.re.test(t));
  const day = t.match(MONTH_DAY);
  const amount = t.match(/(?:₹|rs\.?|rupees?)\s*([\d,]+)|([\d,]{3,})\s*(?:rupees?|ரூபாய்|rs)/i);
  const outcome = hit?.outcome || (day ? 'promise' : 'unclear');
  return {
    outcome,
    promise_date: day && (outcome === 'promise' || outcome === 'partial') ? nextDayOfMonth(Number(day[1]), now) : null,
    amount_offered: amount ? Number((amount[1] || amount[2]).replace(/,/g, '')) : null,
    hardship_reason: outcome === 'hardship' ? t.slice(0, 80) : null,
    summary_en: null,
    source: 'keywords',
  };
}

export async function extractSignals(text, now = new Date()) {
  if (!process.env.SARVAM_API_KEY) return heuristicSignals(text, now);
  try {
    const out = await sarvam.extractJson(
      `Today is ${now.toISOString().slice(0, 10)}. Extract payment signals from this collections call transcript or field note. It may be Tamil, English or code-mixed.
Return JSON with keys:
 outcome: one of agreed_to_pay, promise, partial, paid_claim, hardship, refused, no_answer, callback, unclear
 promise_date: ISO date (YYYY-MM-DD) or null
 amount_offered: number or null
 paid_reference: UPI transaction ID / UTR or receipt number if mentioned, else null
 hardship_reason: short English text or null
 summary_en: one short English sentence a manager can read aloud`,
      text,
    );
    return { ...out, source: 'sarvam' };
  } catch (err) {
    console.warn('Sarvam signal extraction failed, using keywords:', err.message);
    return heuristicSignals(text, now);
  }
}

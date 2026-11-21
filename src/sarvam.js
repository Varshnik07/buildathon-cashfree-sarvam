// Thin client for Sarvam REST APIs. Docs: https://docs.sarvam.ai/api-reference-docs
const BASE = 'https://api.sarvam.ai';

function key() {
  const k = process.env.SARVAM_API_KEY;
  if (!k) throw new Error('SARVAM_API_KEY is not set in .env');
  return k;
}

async function call(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'api-subscription-key': key(), ...(init.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Sarvam ${path} ${res.status}: ${text}`);
  return body;
}

// Speech-to-text (Saaras v4). mode: transcribe | translate | verbatim | translit | codemix
export async function speechToText(buffer, filename = 'audio.wav', { languageCode = 'ta-IN', mode = 'codemix' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'saaras:v4');
  form.append('mode', mode);
  form.append('language_code', languageCode);
  const out = await call('/speech-to-text', { method: 'POST', body: form });
  return { transcript: out.transcript, languageCode: out.language_code };
}

// Text-to-speech (Bulbul). Returns a WAV Buffer.
export async function textToSpeech(text, { languageCode = 'ta-IN', speaker = 'kavitha', model = 'bulbul:v3', pace = 1 } = {}) {
  const out = await call('/text-to-speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, language_code: languageCode, speaker, model, pace }),
  });
  return Buffer.from(out.audios[0], 'base64');
}

// Translate (Mayura). mode: formal | modern-colloquial | classic-colloquial | code-mixed
export async function translate(input, { source = 'auto', target = 'ta-IN', mode = 'modern-colloquial' } = {}) {
  const out = await call('/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, source_language_code: source, target_language_code: target, mode, model: 'mayura:v1' }),
  });
  return out.translated_text;
}

// Chat completion (OpenAI-compatible). model: sarvam-105b | sarvam-105b-conversations
// reasoning_effort: null turns "thinking" off; otherwise it can spend the whole budget reasoning
// and return no content.
export async function chat(messages, { model = 'sarvam-105b', temperature = 0.2, maxTokens = 4000 } = {}) {
  const out = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, reasoning_effort: null }),
  });
  const msg = out.choices[0].message;
  if (!msg.content) throw new Error(`Sarvam chat returned no content (finish: ${out.choices[0].finish_reason})`);
  return msg.content;
}

// Ask the chat model for JSON and parse it (tolerates ```json fences and <think> blocks).
export async function extractJson(instruction, text) {
  const raw = await chat([
    { role: 'system', content: `${instruction}\nReply with ONLY a JSON object, no prose.` },
    { role: 'user', content: text },
  ]);
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in model reply: ${raw}`);
  return JSON.parse(match[0]);
}

// Smoke test: TTS in Tamil → STT back → signal extraction.
import fs from 'node:fs';
import * as sarvam from '../src/sarvam.js';

const line = 'வணக்கம், இந்த அழைப்பு பதிவு செய்யப்படுகிறது. உங்க நிலுவைத் தொகை இரண்டாயிரத்து நானூற்று தொண்ணூற்றொன்பது ரூபாய்.';
console.log('1. TTS (Bulbul, ta-IN)...');
const wav = await sarvam.textToSpeech(line);
fs.writeFileSync('data/test-tts.wav', wav);
console.log(`   ok → data/test-tts.wav (${wav.length} bytes)`);

console.log('2. STT (Saaras v4, codemix) on that audio...');
const stt = await sarvam.speechToText(wav, 'test-tts.wav');
console.log('   transcript:', stt.transcript);

console.log('3. Chat model signal extraction...');
const signals = await sarvam.extractJson(
  'Extract outcome (promise|partial|paid_claim|hardship|refused|agreed_to_pay), promise_date (ISO or null), amount_offered (number or null) and summary_en.',
  'சம்பளம் அஞ்சாம் தேதி வரும், அப்போ பாதி கட்டிடுறேன் — salary 5th varum, 1200 kattiduven',
);
console.log('   signals:', signals);
console.log('Sarvam OK');

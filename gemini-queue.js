// Gemini 요청 큐: 직렬화 + 1200ms rate-limit + 429 지수백오프 재시도.
// 상담 제목 생성(consultation-ai.js)이 사용. 학부모 알림장은 자기 큐 유지.
import { geminiModel } from './firebase-ai.js';

const _queue = [];
let _running = false;
let _lastCall = 0;
const MIN_INTERVAL = 1200;

async function _withRetry(prompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await geminiModel.generateContent(prompt);
    } catch (err) {
      const is429 = err?.message?.includes('429') || err?.message?.includes('Resource exhausted');
      if (!is429 || attempt === maxRetries - 1) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000;
      console.warn(`Gemini 429 → ${delay / 1000}초 후 재시도 (${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function _process() {
  _running = true;
  while (_queue.length > 0) {
    const { prompt, resolve, reject } = _queue.shift();
    const elapsed = Date.now() - _lastCall;
    if (elapsed < MIN_INTERVAL) await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
    try {
      _lastCall = Date.now();
      resolve(await _withRetry(prompt));
    } catch (err) {
      reject(err);
    }
  }
  _running = false;
}

export function enqueueGemini(prompt) {
  return new Promise((resolve, reject) => {
    _queue.push({ prompt, resolve, reject });
    if (!_running) _process();
  });
}

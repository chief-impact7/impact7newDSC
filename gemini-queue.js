// Gemini 요청 큐: 직렬화 + 1200ms rate-limit + 429 지수백오프 재시도.
// 싱글턴 enqueueGemini는 상담 제목 생성(consultation-ai.js)이 사용.
// 학부모 알림장(parent-message.js)은 createGeminiQueue()로 별도 레인을 유지한다.
import { geminiModel } from './firebase-ai.js';

const MIN_INTERVAL = 1200;

async function _withRetry(prompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await geminiModel.generateContent(prompt);
    } catch (err) {
      const isRetriable =
        err?.code === 'functions/resource-exhausted' ||
        err?.code === 'functions/unavailable' ||
        err?.message?.includes('429') ||
        err?.message?.includes('Resource exhausted');
      if (!isRetriable || attempt === maxRetries - 1) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000;
      console.warn(`Gemini 429 → ${delay / 1000}초 후 재시도 (${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export function createGeminiQueue() {
  const queue = [];
  let running = false;
  let lastCall = 0;

  async function process() {
    running = true;
    while (queue.length > 0) {
      const { prompt, resolve, reject } = queue.shift();
      const elapsed = Date.now() - lastCall;
      if (elapsed < MIN_INTERVAL) await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
      try {
        lastCall = Date.now();
        resolve(await _withRetry(prompt));
      } catch (err) {
        reject(err);
      }
    }
    running = false;
  }

  return (prompt) => new Promise((resolve, reject) => {
    queue.push({ prompt, resolve, reject });
    if (!running) process();
  });
}

export const enqueueGemini = createGeminiQueue();

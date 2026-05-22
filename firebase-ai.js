import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase-config.js';

const _llmGenerate = httpsCallable(functions, 'llmGenerate');

// 공유 게이트웨이(llmGenerate) 경유 어댑터.
// 기존 geminiModel.generateContent(prompt) 호출부와 호환:
// 사용처(gemini-queue.js, parent-message.js, consultation-ai.js)는 result.response.text()로 읽는다.
export const geminiModel = {
  async generateContent(prompt) {
    const res = await _llmGenerate({ prompt, model: 'gemini-3.5-flash' });
    const text = res.data?.text ?? '';
    return { response: { text: () => text }, text };
  },
};

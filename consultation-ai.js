// 상담 메모 → AI 자동 제목. Gemini 큐 공유, 실패 시 메모 앞 20자 fallback.
import { enqueueGemini } from './gemini-queue.js';
import { buildTitlePrompt, consultationTitleFallback } from './consultation-filter.js';

export async function generateConsultationTitle(text) {
  const memo = (text || '').trim();
  if (!memo) return '';
  try {
    const result = await enqueueGemini(buildTitlePrompt(memo));
    const raw = result.response.text().trim().replace(/^["'\s]+|["'\s]+$/g, '');
    return raw ? raw.slice(0, 40) : consultationTitleFallback(memo);
  } catch (err) {
    console.error('[consultation] 제목 생성 실패, fallback 사용:', err);
    return consultationTitleFallback(memo);
  }
}

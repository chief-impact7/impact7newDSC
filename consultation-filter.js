// [상담] 탭 순수 함수 (검색·정렬·날짜 기본값·제목 fallback). firebase 의존 없음 → node:test 가능.

export const DEFAULT_HISTORY_LIMIT = 20;

// 상담 목록을 키워드로 부분일치 필터 (본문·유형·강사명, 소문자 정규화).
// 키워드가 비어 있으면 원본 그대로 반환.
export function filterConsultationsByKeyword(list, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return list;
  return list.filter(c =>
    [c.text, c.consultation_type, c.teacher_name]
      .some(field => String(field || '').toLowerCase().includes(kw))
  );
}

// 조회 기본 기간: 오늘(end) ~ N개월 전(start), ISO YYYY-MM-DD. UTC 기준(결정적).
export function defaultSearchRange(now = new Date(), monthsBack = 6) {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() - monthsBack, now.getUTCDate()
  )).toISOString().slice(0, 10);
  return { start, end };
}

// 제목이 없을 때 메모 앞 20자.
export function consultationTitleFallback(text) {
  return (text || '').trim().slice(0, 20);
}

// 제목 생성용 Gemini 프롬프트.
export function buildTitlePrompt(text) {
  return `다음 상담 메모의 핵심을 20자 이내의 한국어 제목 한 줄로 요약해줘. 따옴표나 접두어 없이 제목만 출력해.\n\n상담 메모:\n${text}`;
}

// 이력 정렬: pin(pinnedIds에 포함된 id) 먼저, 그 안에서 date 내림차순. 원본 불변.
export function sortConsultationsForHistory(list, pinnedIds = []) {
  const pinned = new Set(pinnedIds);
  return [...list].sort((a, b) => {
    const ap = pinned.has(a.id) ? 1 : 0;
    const bp = pinned.has(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
}

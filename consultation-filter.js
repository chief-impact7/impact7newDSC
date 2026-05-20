// [상담] 탭 검색용 순수 함수. firebase 의존 없음 → node:test로 단위 테스트 가능.

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

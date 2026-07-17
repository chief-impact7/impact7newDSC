// 실패 status_code 한글 라벨 — 솔라피 숫자 코드 + 내부 워커 코드. 미등록은 호출부에서 원시 코드 표시.
export const SOLAPI_ERROR_LABELS = {
  1042: '템플릿 오류',
  3040: '전송시간 초과',
  3046: '단말기 문제',
  3058: '전송경로 없음',
  3104: '카카오톡 미사용',
  3108: '발송 가능 시간 아님',
  3120: '카카오 수신 불가',
  delivery_result_timeout: '결과 미확정 (도달 가능성 높음)',
  crash_after_dispatch: '발송 중 중단',
  missing_group_id: '접수 정보 유실',
  unresolved_message_vars: '변수 치환 실패',
  kind_not_allowed: '허용되지 않은 종류',
  no_messages: '발송 대상 없음',
};

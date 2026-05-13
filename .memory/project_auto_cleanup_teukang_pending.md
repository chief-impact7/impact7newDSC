---
name: 특강반 자동 만료 처리 검증 대기
description: autoCleanupClasses에서 특강 만료 발생 시 학생 status 변경 동작 검증 필요 (실제 발화 사례 미관찰)
type: project
---

자동 정리 복원(f0617a8) 배포 후 빈 정규반 8건은 확인되었으나(A105, FA104, FA201, FA202, FX104, FX106, FX201, FX202), 특강 만료 처리는 운영에서 발화한 적이 없어 실측 미검증.

**Why:** `_MODES.teukang.applyToStudent`의 학생 status 변경 로직(`재원+특강만→퇴원`, `status2='특강'` 마커 해제)이 이번 변경으로 처음 자동 트리거 가능 상태가 됨. 수동 삭제와 동일 코드 경로이긴 하나, 자동 트리거 시점·범위·동시성 측면에서 운영 발생 시 첫 검증이 필요.

**How to apply:** `special_end < today`인 특강반이 처음 등장하는 시점에 다음 점검:
1. 콘솔 로그 `기간 만료 반 자동 정리: ... [teukang] {code}` 출력 확인
2. 영향 학생의 `history_logs` CLASS_DELETE 엔트리 점검 (before/after에 status·status2 변경 기록)
3. 재원생 + 다른 활성 enrollment 보유 학생은 status가 그대로인지
4. 특강만 보유한 학생이 status='퇴원' + withdrawal_date 미설정으로 정리되는지 — withdrawal_date 누락 시 후속 보강 검토

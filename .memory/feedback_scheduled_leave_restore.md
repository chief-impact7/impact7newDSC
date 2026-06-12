# 예약 휴원 복원 시 scheduled_leave_status 필수

**무엇:** 미래 시작 휴원은 `status='재원'` + `scheduled_leave_status`(실휴원/가휴원) + `pause_start_date/end_date` 3종 세트다. 발효(promoteScheduledLeave)는 `scheduled_leave_status` 존재가 전제 조건.

**Why:** 2026-06-05 김서은 복구 스크립트(restore-kimseoeun-leave.mjs)가 status·pause 기간만 복원하고 `scheduled_leave_status`를 빠뜨려, 6/8 시작일이 와도 발효가 불발 → 휴원기간인데 '재원'으로 출결에 노출. 2026-06-13 발견·복구 (restore-kimseoeun-leave-status.mjs).

**How to apply:**
- one-off 복구로 "예약 휴원 상태"를 만들 때는 반드시 `scheduled_leave_status`까지 세팅
- 휴원·퇴원 기간 정합성 의심 시 `scripts/oneoff/check-leave-period-consistency.mjs` 재사용 (students 전수 감사: 발효 누락·기간 외 status·잔존 필드 분류)
- 출결 목록에 휴원생이 보이는 것 자체는 의도된 사양 (01ba870, 하단 '휴원 학생' 섹션 + 카운트 포함 — 사용자 확인 완료 2026-06-13 현행 유지)

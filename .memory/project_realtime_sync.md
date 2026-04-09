---
name: Firestore 실시간 동기화 모니터링
description: 8개 컬렉션을 onSnapshot으로 전환 (2026-03-24). Firestore 읽기 스파이크 발생 시 하이브리드(leave_requests만 실시간 + 나머지 폴링)로 전환 예정
type: project
---

2026-03-24: 주요 8개 컬렉션을 getDocs → onSnapshot 실시간 리스너로 전환.
(daily_records, absence_records, leave_requests, retake_schedule, hw_fail_tasks, test_fail_tasks, temp_attendance, temp_class_overrides)

**Why:** 선생님 간 캐시 불일치로 승인 버튼 상태가 다르게 보이는 문제 해결. 이전에도 onSnapshot을 사용했다가 읽기 스파이크로 되돌린 이력이 있을 수 있음.

**How to apply:** 사용자가 Firestore 읽기 사용량 모니터링 중. 스파이크 발생 시 leave_requests만 실시간 유지, 나머지는 30초~1분 폴링으로 전환할 것.

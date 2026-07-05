---
name: project-fail-action-latent-bugs
description: fail-action(숙제·테스트 미통과 후속대책)에서 정식 code-review가 찾은 기존 잠복 버그 4건 — 미수정 후속 후보
metadata:
  type: project
---

# fail-action 잠복 버그 (2026-06-28 발견, 미수정)

fail-action 중복 통합(ac2c5dd, `fail-action-shared.js`) 시 정식 code-review가 발견한
**기존(HEAD 이전부터 존재) 버그 4건.** 통합은 동작 보존이 원칙이라 이번엔 건드리지 않고
그대로 옮겼다. 별도 버그픽스 패스에서 다룰 후속 후보.

1. **savedTag 즉시 소실 (LOW, 비기능)** — `saveFailFields`가 `hw-fail-saved-${id}-${key}`
   태그를 display='' 한 직후 `renderStudentDetail`이 동기 전체 리렌더 → 새 태그(display:none)로
   교체. "✓ 저장됨" 인라인 표시가 실제로 안 보임. setTimeout은 detached 노드를 토글.

2. **저장 실패 시 롤백 없음 (MEDIUM)** — `saveFailAction`이 commit 전에 `state.hwFailTasks`/
   `testFailTasks`에 낙관적 push, catch는 로그만(OX/homework 경로와 달리 롤백 안 함). commit이
   실패(오프라인·rules)하면 유령 pending task + '저장됨·수정가능' 뱃지가 다른 doc 변경 전까지 잔존.

3. **reschedule 날짜 clobber (MEDIUM, 교차모듈)** — pending task를 reschedule-modal이 새 날짜로
   바꿔도 daily_records의 action에는 반영 안 함. 이후 hw 폼에서 그 행을 다시 저장하면
   `saveFailAction`이 action의 옛 scheduled_date를 task에 merge로 덮어 reschedule을 되돌림.
   근본 원인 일부는 reschedule-modal.js가 action을 영속화하지 않는 데 있음.

4. **created_at falsy 리셋 (LOW)** — `created_at: existing?.created_at || new Date()...`. 빈
   문자열/누락이면 매 저장마다 생성시각이 재설정. 현재 생성은 항상 비어있지 않은 ISO라 실해 낮음.

관련: [[feedback-formal-review-over-equivalent]] — 정식 review가 직접 점검이 놓치는 걸 잡음.

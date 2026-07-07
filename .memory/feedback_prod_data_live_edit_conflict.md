---
name: feedback-prod-data-live-edit-conflict
description: 프로덕션 데이터 삭제/수정 전 사용자 추정만 믿지 말고 최근 history_logs로 강사 실시간 작업 확인
metadata:
  type: feedback
---

프로덕션 Firestore 데이터를 사용자의 "이건 잘못된 것 같다"는 추정만으로 삭제/수정하지 말 것. 실행 전 해당 컬렉션의 최근 `history_logs`를 조회해 **다른 강사(aaron·hank·nami 등)가 실시간으로 편성 중인지** 확인한다.

특히 **자유학기·내신·특강 같은 파생/편성 데이터**는 강사가 의도적으로 운영 중일 확률이 높다. "학생 enrollment에 있으면 안 되는데" 같은 판단은 담당 강사 확인이 먼저다.

**실제 사고 (2026-07-07):**
- 사용자: "a104 6명은 자유학기 아니어야 한다" → FT108 자유학기(7/2~7/7 화·목 특강)를 잘못된 데이터로 판단해 10명에서 제거 + 반 문서 삭제 (KST 16:23).
- aaron 선생님이 **17분 뒤(16:40)** FT108을 10명에게 그대로 재생성. history_logs가 선후를 명확히 보여줌.
- 즉 FT108은 잘못된 데이터가 아니라 aaron이 실시간 운영 중인 정당한 자유학기였고, 삭제가 강사 작업과 충돌.

**Why:** 1인 개발자가 프로덕션을 직격하는 BaaS 구조 + 여러 강사가 동시에 같은 컬렉션을 편집한다. 내 수정과 강사 작업이 충돌하면 서로 무효화되고 혼란만 커진다. AGENTS.md의 "위험·비가역 작업 전 확인" 원칙의 프로덕션 데이터판.

**How to apply:**
1. firestore-data-fix 실행 전, 대상 컬렉션 최근 history_logs를 시각순으로 확인 (누가·언제·무엇을 바꿨나).
2. 최근 몇 시간 내 강사 편집이 있으면 "지금 운영 중"으로 보고, 삭제 대신 사용자에게 담당 강사 확인을 먼저 권고.
3. 자유학기/내신은 대개 오늘까지의 단기 기간 → 내일 자동 만료로 정규 복귀. "안 보인다"가 반드시 버그는 아니다.

관련: [[feedback-checklist-before-work]], [[feedback-naesin-regular-identification]], firestore-data-fix 스킬. 파생 로직은 `@impact7/shared/enrollment-derivation`(내신>자유학기>정규, 활성 시 정규 숨김).

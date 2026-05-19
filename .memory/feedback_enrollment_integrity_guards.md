---
name: enrollment 정합성 가드 규율
description: 학생 enrollment 저장 시 class_type×코드 정합성을 모든 경로에서 강제. 2026-05 사고 재발 방지.
type: feedback
---

# enrollment 정합성 강제

학생 `enrollments[]` 배열의 각 객체는 class_type별로 코드 필드 규칙이 다름. 위반 시 `getActiveEnrollments`가 정상 분류 못해 silent 운영 사고로 이어짐.

## 규칙 (반편성도우미·CSV import·UI 모두 동일)

- **정규/자유학기**: `level_symbol` + `class_number` 둘 다 필요 (예: HA101)
- **내신**: `level_symbol`·`class_number` 둘 다 비어야 함 (csKey 별도 관리)
- **특강**: `class_number` 필요

## 가드 위치 (코드 진실 원천)

- DSC `class-setup.js:1169,1175` 반편성도우미 throw
- DSC `daily-ops.js:saveEnrollment` 학생 상세 편집 alert + return
- DB `app.js:_validateEnrollmentFields` 헬퍼 (saveEnrollment + submitNewStudent isEditMode)
- DB `upsert-students.js:271~` CSV import throw

## Why
2026-05 사고: CSV import에서 `class_type` 칼럼 누락 → 263건 잘못된 enrollment(class_type='정규' + 빈 코드 + 시간/요일/종료일만 채워짐) 생성. 일선 운영에서 발견 못 하고 누적. UI 편집 모달의 내신/자유학기 선택 옵션 누락도 같은 사고 회로 (select에 옵션 없으면 silent로 '정규' 셋팅).

## How to apply
새 enrollment 생성/편집 경로(모달·CSV·script) 추가 시 위 4개 위치 중 적절한 가드 패턴 동일 적용. 가드 우회 = silent 데이터 손상. dry-run 후 history_logs 기록은 필수.

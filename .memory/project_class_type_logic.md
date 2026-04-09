---
name: 반 유형별 동작 원칙
description: 자유학기/내신은 정규의 일시적 전환, 특강은 별도 추가 — 표시 로직에 영향
type: project
---

## 반 유형 체계

- **정규**: 기본 반 유형. 기간 제한 없음
- **자유학기**: 정규반의 일시적 전환. 시작일~종료일 내에만 자유학기로 동작하고, 기간 외에는 자동으로 정규로 복귀
- **내신**: 정규반의 일시적 전환. 시작일~종료일 내에만 내신으로 동작하고, 기간 외에는 자동으로 정규로 복귀
- **특강**: 기존 반(정규/자유학기/내신)과 무관하게 추가되는 별도 반. 독립적으로 표시

**Why:** 자유학기/내신은 정규 수업의 일시적 전환이므로 기간이 지나면 원래 정규로 돌아가야 함. 특강은 추가 수업이므로 다른 반과 병행 가능.
**How to apply:** 마법사에서는 현재대로 새 반을 생성하되, 메인 DSC 앱의 표시 로직에서 기간 체크를 통해 자동 전환 처리

## 구현 상세 (2026-04-07 수정)

### 자유학기 class_settings 구조
자유학기는 정규와 동일한 class_code를 공유하므로 `schedule` 필드를 덮어쓰지 않음.
별도 필드 사용:
- `class_settings[code].free_schedule` = {요일: 시간} 자유학기 전용 스케줄
- `class_settings[code].free_start` = 시작일
- `class_settings[code].free_end` = 종료일

### getActiveEnrollments
- 내신: `enrollment.class_type === '내신' && start_date <= today` → 정규 숨김
- 자유학기: `enrollment.class_type === '자유학기' && start_date <= today <= end_date` → 같은 반코드의 정규 숨김
- 특강: 정규 숨기지 않음 (독립적으로 공존)

### REGULAR_CLASS_TYPES
`['정규', '내신', '특강', '자유학기']` — 자유학기도 당일 수업 있는 학생으로 인식됨

### 요일 편집 UI (daily-ops.js renderClassDetail)
- 자유학기: `classSettings[code].free_schedule`이 있으면 "자유학기 요일/시간" 카드 표시
- 특강: `classSettings[code].class_type === '특강'`이면 "특강 요일/시간" 카드 표시
- 요일 추가/삭제 시 class_settings AND 해당 반 학생들의 enrollment.day 동기화

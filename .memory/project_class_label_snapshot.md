---
name: class-label-snapshot
description: daily_records.class_label 유형 스냅샷 도입 배경(내신반 삭제 소급 소실 사건)과 가드 설계·잔여 한계
type: project
---

## 사건 (2026-07-05 진단)

내신반 `2단지양정고2A`(naesin 2026-05-15~07-03, 7명)를 07-03에 삭제 후 07-05 하루짜리로 재생성
→ 출결탭 '유형'(구 '반') 컬럼이 현재 class_settings로 역산되는 구조라 과거 내신 표시가 전부 '정규'로 소급 소실 (노강현 등 7명).
입력오류 아님 — 시스템 설계 한계. 증거: history_logs CLASS_DELETE(mode:naesin) 로그에 삭제 전 창·소속 학생 보존됨.

## 해결: class_label 스냅샷 (RULES.md daily_records 스키마 참조)

- **저장**: `_persistDailyRecord()`(data-layer.js) 단일 관문에서 스탬프. 가드 4중 —
  ① `targetDate === todayStr()` (과거·미래 날짜는 현재 설정 오산 위험이라 스탬프 금지)
  ② `state._classSettingsLoaded` (classSettings 공백 시 내신/자유→'정규' 오판 고정 방지)
  ③ `state.dailyRecordsDate === targetDate` (stale 캐시로 기존 스냅샷 덮어쓰기 방지 — loadDailyRecords 스냅샷 콜백이 마커 설정)
  ④ `!캐시.class_label` (최초 1회만; _applyDailyCache에 written(base) 반영해 자기충족)
- **렌더**: renderReportCard가 `rec.class_label` 우선, 없으면 `deriveClassLabelAt()`(student-helpers.js) 역산 fallback.
- **판정 SSoT**: deriveClassLabelAt = 내신 활성(자동유도 포함) 우선 → 활성 enrollment class_type (요일 매칭 우선). 저장·렌더 공유.

## 잔여 한계 (fallback으로 동작, 소급 소실 위험 잔존)

- impact7DB Cloud Functions(tabletCheckinHandler·checkinHandler) merge write는 스탬프 안 함 — 크로스앱 후속 과제.
- `_persistDailyRecord` 우회 직접 write(fail-action-shared, absence-records, reschedule-modal 등)도 미스탬프.
- 배포 이전 기존 기록은 무라벨. 삭제된 내신반의 과거분은 history_logs CLASS_DELETE에서 창 복원해 backfill 가능
  — 템플릿: `scripts/oneoff/restore-yangjeong2a-naesin-label.mjs` (2단지양정고2A 120건 backfill 완료, 2026-07-05).

## 관련

- 자유학기 별도코드(FA201)+정규(I201) 동시 표시는 shared v1.40→[[v1.41]] 업그레이드로 해소 (자유학기 활성 시 정규 전량 숨김).
- 후속 후보: list-view defaultLabel·dashboard groupKey와 deriveClassLabelAt 3벌 병렬 구현 통합, '자유' vs '자유학기' 라벨 어휘 SSoT화, deriveClassLabelAt 순수화 후 shared 승격.

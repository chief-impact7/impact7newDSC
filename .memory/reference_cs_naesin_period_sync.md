---
name: cs.naesin_end 자동 sync (Cloud Function)
description: class_settings.naesin_start/end 변경 시 매핑된 학생 enrollment.end_date 자동 동기화 — onClassSettingsNaesinPeriodChanged trigger
type: reference
---

# Cloud Function 자동 sync

## 함수
- 이름: `onClassSettingsNaesinPeriodChanged`
- 리전: `asia-northeast3`
- 코드베이스: `leave-request` (impact7DB/functions)
- 모듈: `functions/src/syncNaesinPeriod.js`
- 테스트: `functions/test/syncNaesinPeriod.integration.test.js` (8개)

## 동작
`class_settings/{code}` onUpdate 발화. `class_type='내신'` + `naesin_start`/`naesin_end` 변경 감지 시 → 그 csKey로 매핑된(=`naesin_class_override === csKey` 박힌) 활성 학생들의 명시적 내신 enrollment(class_type='내신' + 빈 코드)의 `end_date`를 새 `naesin_end`로 일괄 sync + `history_logs` 기록 (`google_login_id: 'cloud-function'`).

## 안전성
- 옛 학기 내신은 보존 (`e.start_date < after.naesin_start`이면 skip)
- 퇴원/종강 제외 (활성 status만)
- idempotent — 이미 end_date가 동일하면 skip
- batch 500 ops 한도 처리 (chunk 200명/commit)

## Why
2026-05-19 사고: hank@ 선생이 cs.naesin_end를 7/2→7/3 수정. 학생 enrollment.end_date는 안 따라가서 같은 반인데 학생별로 활성 종료일 갈림. 운영자가 UI 거치지 않고 CSV/script로 cs 수정해도 자동 sync 보장 위해 Cloud Function으로 구현.

## How to apply
- cs.naesin_end가 안 sync되어 보이면 함수 로그 확인 (Firebase Console > Functions > Logs)
- 함수 미발화 시 oneoff sync 스크립트(`scripts/oneoff/sync-naesin-enrollment-end.mjs`) 수동 실행 가능
- 새 csKey 패턴(예: 자유학기 free_end 변경) 추가하려면 같은 trigger 패턴 복제

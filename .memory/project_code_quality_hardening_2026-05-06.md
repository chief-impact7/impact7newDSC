# 코드 품질/운영 안전성 보강 기록 (2026-05-06)

## 배경

`impact7newDSC` 전체 구조를 점검한 뒤, production Firestore를 직접 쓰는 BaaS 구조에서 잠재적으로 위험한 흐름을 우선 수정했다.

## 수정 요약

- `class-detail.js`
  - 반 삭제 시 `class_settings` 직접 `deleteDoc`을 `auditDelete` 경유로 변경했다.
  - 반 삭제 이력 로그를 `history_logs` rules 스키마에 맞게 `change_type: DELETE`, `doc_id`, `before`, `after` 형식으로 저장하도록 수정했다.
  - 이력 로그 실패가 실제 삭제 성공을 UI 실패로 오판하게 만들지 않도록 분리했다.
  - READ-ONLY dev 모드에서는 반 삭제/반 요일/기간/특강 학생 추가 후 로컬 캐시가 실제 저장된 것처럼 바뀌지 않게 막았다.
  - 반 요일, 특강/자유학기 요일, 자유학기 기간 변경도 Firestore 성공 후에만 로컬 enrollment를 반영하도록 바꿨다.

- `attendance.js`
  - 결석 토글 후 빠르게 출석/미확인으로 바꾸면 늦게 도착한 결석대장 생성이 open 기록을 남길 수 있는 race를 완화했다.
  - 결석대장 생성/삭제 기준 날짜를 호출 시점의 날짜로 고정하고, 저장 직전/직후 현재 출결 상태를 재확인한다.

- `data-layer.js`
  - 등원예정 자동 재원 전환, 퇴원일 도래 자동 퇴원 전환은 batch commit 성공 후에만 로컬 상태를 변경하도록 수정했다.
  - 오래된 기록 정리(`autoCloseOldRecords`)도 READ-ONLY 모드에서는 로컬 캐시를 바꾸지 않게 했다.

- `daily-ops.js`
  - 로그인만으로 `autoCloseOldRecords()`가 production 데이터를 자동 변경하지 않도록 제거했다.
  - 명시 실행용 `window.runOldRecordCleanup(force = false)`를 남기고, 기본 실행에는 confirm을 요구한다.
  - 일괄 반 삭제에서 READ-ONLY 차단 결과를 성공으로 집계하지 않게 했다.

- `src/shared/firestore-helpers.js`
  - 대시보드 학생 조회가 메인 DSC와 동일하게 `status2 == '특강'` 학생도 포함하도록 수정했다.

- `firebase-config.js`, `firebase-ai.js`, `parent-message.js`
  - Firebase AI 초기화를 `firebase-ai.js`로 분리했다.
  - Auth/Firestore만 필요한 화면이 AI SDK를 공통 설정에서 함께 물지 않도록 정리했다.

- `RULES.md`
  - 실제 구조에 맞춰 메인 DSC 입력 앱을 `index.html -> daily-ops.js`로 갱신했다.
  - `app.js`는 `excel.html`용 구형/엑셀형 입력 로직으로 명시했다.

## 검증

- `npm run build` 통과
- `git diff --check` 통과

## 남은 사항

- Vite build의 `dashboard` chunk 500KB 초과 경고는 남아 있다.
- 기능 실패는 아니지만, 추후 `React/Recharts/Firebase` 청크 분리나 dashboard lazy import로 별도 최적화 가능하다.
- 이번 작업에서는 빌드 경고 최적화 구현 직전에 사용자가 중단했고, 코드 안전성 보강 기록으로 정리했다.

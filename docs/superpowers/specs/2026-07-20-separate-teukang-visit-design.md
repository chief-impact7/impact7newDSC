# 같은 날 정규+특강 분리 등원 처리 — 설계

2026-07-20 승인. 대상: 등원시간(DSC) 메인 리스트·출결.

## 문제

- 같은 날 정규(예: HA103 19:10)와 특강(예: 12:30)이 모두 있는 학생의 리스트 표시가
  대표 enrollment 하나(`find()` 첫 매칭)만 잡아 특강 시간이 어디에도 안 보임.
- daily_records는 1일 1출결이라 "특강 결석 + 정규 출석" 같은 케이스를 기록할 수 없음.
- 학생마다 1회 등원(연속 수강)과 2회 등원(별도 등원)이 섞여 있음.
- 리스트의 수업종류 버튼(특강/정규)과 출결 버튼(출석/…)이 같은 pill 형태라 혼동됨.

## 확정 기준

- **주 출결 = 대표 enrollment 기준**(내신 > 자유 > 특강만 > 비정규 > 정규). 시간순 아님.
  기존 `attendance.status`/`arrival_time` 의미 불변 — filter-nav 카운트, parent-message,
  data-layer 통계 쿼리, export-report, absenceNoticeSweeper, bulk-mode 등 모든 소비처 무변경.
- **보조 출결(visit2) = 별도 등원 특강**. 초기 범위에선 등원시간 화면 기록·표시 전용.
  통계·알림·보고서에 미반영(의도).
- **화면 표시는 시간순**(이른 시간 위). 주/보조와 표시 순서는 분리.

## 데이터 모델

- `daily_records.visit2: { code, scheduled_time, status, arrival_time }` 필드 1개 추가(additive).
  status 어휘는 주 출결과 동일(출석/지각/결석/조퇴/기타/미확인). 마이그레이션 없음.
  rules는 `withinFieldLimit(30)`만이라 수정 불필요.
- 특강 enrollment에 `visit_mode: 'combined' | 'separate'` (없으면 auto). 수동 override용.

## 판정 로직

`getSeparateTeukangVisit(student, date)` → `{ enrollment, time } | null` (student-helpers.js 순수 함수).

- 요일 매칭 활성 특강 중:
  - `visit_mode === 'separate'` → 분리 확정
  - `visit_mode === 'combined'` → 통합 확정
  - auto → 주 등원 시간과 시작 시간 간격 ≥ 3시간(`SEPARATE_VISIT_GAP_MIN = 180`)이면 분리
- 특강만 있는 날(주=특강)은 null.

## UI

1. **이른 시간 우선**: `list-view.js:714`(표시)·`getEffectiveAttendanceTime`(정렬) 모두
   `find()` 첫 매칭 → 요일 매칭 enrollment 중 최소 시간으로 변경.
2. **2회 등원 행**: 시간 블록 2개(시간순) + 출결 버튼 2줄. 각 줄 앞 수업종류 태그.
   주 출결 줄 = 기존 `toggleAttendance`, 특강 줄 = 신규 `toggleVisit2Attendance`(visit2 저장,
   출석/지각 시 arrival_time 기록, 동일 토글 규칙).
3. **1회 등원 행**: 현행 1줄 유지.
4. **수업종류 태그 시각 구분**(전체 공통): 출결 그룹 첫 버튼(defaultLabel)을 pill →
   솔리드 사각 태그(border-radius 4px, 작게, 톤 채움). 클릭 시 미확인 리셋 동작 유지. CSS만.
5. **enrollment 편집 모달**: 특강일 때 visit_mode 셀렉트(자동/통합/분리) 추가.

## 엣지

- 판정이 통합으로 바뀌면 visit2 UI 숨김, 기존 데이터 잔존(무해).
- 내신 기간 학생 + 분리 특강: 주=내신, 보조=특강 동일 로직.
- READ-ONLY 모드: visit2 쓰기도 audit wrapper 경유라 자동 stub.

## 테스트

- 판정 함수 unit test: 간격 경계(2:59/3:00), override 2종, 특강만 있는 날 null,
  내신 활성 케이스.
- READ-ONLY dev로 화면 검증(2회 등원 행·1회 등원 행·태그 시각 구분).

## 범위 밖 (후속 후보)

- 상세패널 출결 달력·대시보드·엑셀의 visit2 표시.
- 특강 출결 통계·미도착 알림 반영.

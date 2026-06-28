# 상담 내역 일자별·학생별 조회 + 내보내기 (대시보드)

- 작성일: 2026-06-29
- 상태: 설계 승인됨, 구현 계획 대기
- 화면: `dashboard.html` (`src/dashboard/`)

## 1. 목적

일정 기간의 상담 내역을 **일자별 / 학생별**로 한 화면에 모아 보고, **CSV(엑셀)로 내보내기**한다.

## 2. 배경 (현재 상태)

- 상담은 `consultations` 컬렉션에 한 건씩 저장된다. 핵심 필드:
  `student_id`, `student_name`, `teacher_id`, `teacher_name`, `date`(`YYYY-MM-DD` 문자열),
  `consultation_type`(예: 정기), `method`(전화/대면/문자), `target`(학생/학부모), `title`, `text`(메모).
- 현재 조회는 **학생 상세 패널 → 상담 탭**뿐이다(`searchStudentConsultations(studentId, {startDate, endDate})`,
  `data-layer.js`). 한 명씩만 가능하고, 전체/일자별 보기와 파일 내보내기는 없다.
- 대시보드(`src/dashboard/App.jsx`)에는 이미 **기간 필터(일별/주별/직접선택) + 날짜 네비 + 소속/학년/반 필터**가
  있고 `startDate`/`endDate`를 계산해 본문 컴포넌트로 내려준다. 본문은 일별이면 `DailyLogBoard`,
  기간이면 `PeriodLogBoard`로 분기한다.
- 권한: `firestore.rules` `consultations` — `allow read: if isAuthorized()`. 학생 필터 없이 기간 전체 조회 가능.
- 재사용 자산: `class-setup-planner.js`의 `csvCell`/`safeCell`(Excel 수식 인젝션 방어 + 따옴표 이스케이프),
  의존성에 `xlsx` 존재.

## 3. 요구사항

- **R1.** 기간을 정해 그 기간의 모든 학생 상담을 조회한다(일별/주별/직접선택은 기존 필터 재사용).
- **R2.** 한 화면에서 **일자별 묶음**과 **학생별 묶음**을 토글로 전환한다.
- **R3.** 소속/학년/반 필터를 상담 조회에도 적용한다(로그북과 동일 방식 — students 조인 후 클라이언트 필터).
- **R4.** 현재 보이는(필터·그룹 적용된) 상담을 **CSV로 다운로드**한다. 엑셀에서 한글이 깨지지 않아야 한다.
- **R5.** 로그북 화면의 동작·로직은 변경하지 않는다(신규 코드는 추가, 기존은 토글 분기만).

## 4. 설계

### 4.1 조회 함수 — `src/shared/firestore-helpers.js`

```
export async function fetchConsultationsForRange(startDate, endDate)
```
- `consultations`를 `where('date','>=',startDate)`, `where('date','<=',endDate)`, `orderBy('date','desc')`로 조회.
- `date`는 문자열 단일 필드 범위 + 동일 필드 orderBy → 복합 인덱스 불필요.
- 반환: `{ id, ...data }[]`.

### 4.2 데이터 훅 — `src/dashboard/hooks/` (기존 `useDashboardData` 패턴)

```
useConsultations(user, startDate, endDate) -> { consultations, loading, error }
```
- `view === 'consult'`일 때만 fetch(불필요한 읽기 방지). user/날짜 변경 시 재조회.

### 4.3 컴포넌트 — `src/dashboard/components/ConsultationBoard.jsx`

- props: `consultations`, `students`, `branchFilter`, `classFilter`, `gradeFilter`, `startDate`, `endDate`.
- 소속/학년/반 필터를 students 조인으로 적용(로그북과 동일 헬퍼: `branchFromStudent`, `studentGradeKey`,
  `enrollmentCode`).
- 상단: **그룹 토글 〔일자별 / 학생별〕**, 우측: **CSV 다운로드** 버튼, 건수 표시.
- 일자별: 날짜 desc → 그 날짜의 상담 행들. 학생별: 학생명 → 그 학생의 상담 행들(각 그룹 내 날짜 desc).
- 행 컬럼: **날짜 · 학생명 · 학년/반 · 강사 · 대상 · 형태 · 유형 · 제목 · 메모**.
  - 학년/반은 `student_id`로 students 조인해 표시(상담 문서에 반 정보가 없을 수 있어 마스터에서 가져옴).
  - 메모(`text`)는 길 수 있으므로 셀 내 줄바꿈 유지(`white-space: pre-wrap`).
- 빈 결과: "기간 내 상담 없음".

### 4.4 CSV 유틸 — `src/shared/csv.js`

- `csvCell`/`safeCell`을 이 모듈로 옮겨 export하여 `ConsultationBoard`와 `class-setup-planner.js`가 공유
  (중복 구현 금지). `class-setup-planner.js`(루트)·dashboard 양쪽에서 import 가능한 `src/shared/`에 둔다.
  이동 시 `class-setup-planner.js`는 import로 교체.
- `downloadCsv(filename, rows)`: 헤더 + 행을 CSV 문자열로, **UTF-8 BOM(`﻿`)** prefix, `text/csv` Blob,
  `<a download>` 클릭으로 저장.
- 파일명: `상담내역_{startDate}_{endDate}.csv`.
- 컬럼: 4.3의 행 컬럼과 동일. 그룹과 무관하게 평면(flat) 행으로 내보냄(엑셀에서 사용자가 정렬·피벗).

### 4.5 App.jsx 통합

- 상태 추가: `const [view, setView] = useState('logbook'); // 'logbook' | 'consult'`.
- 토글 UI 1개(필터 바 또는 헤더에 세그먼트 버튼).
- `useConsultations` 훅 호출(view='consult'일 때만 실제 fetch).
- 본문 분기: `view === 'consult' ? <ConsultationBoard .../> : (기존 일별/기간 분기)`.
- 상담 보기에서도 기존 기간/소속/학년/반 필터 바는 그대로 노출(반 필터는 상담에도 의미 있음).

## 5. 비기능 요구

- **성능/비용:** 기간 전체 1회 조회. 학원 규모상 기간당 수백 건 이하 예상. view 진입 시에만 읽음.
- **권한:** 읽기 전용. 쓰기 없음. dashboard는 DSC/shared를 읽기만 한다는 정책 준수(파생 재구현 금지).
- **접근성:** 토글·버튼에 `aria-label`, 테이블은 `<table>` 시맨틱 + `scope` 헤더.
- **CSV 안전:** 수식 트리거(`= + - @` 등) 셀은 `safeCell`로 텍스트화. 따옴표 이스케이프. BOM으로 한글 보존.

## 6. 테스트

- 순수 함수 위주 `node:test`:
  - 그룹핑 함수(일자별/학생별 묶음) — 빈 입력, 단일/다건, 날짜 정렬.
  - CSV 직렬화 — 수식 트리거 셀, 따옴표/콤마/줄바꿈 포함 셀, BOM prefix.
  - 필터 적용(소속/학년/반) — students 조인 결과.
- fetch/DOM은 단위테스트 제외(수동 검증): 기간 변경→재조회, CSV 다운로드 후 엑셀 한글 정상.

## 7. 범위 밖 (Out of scope)

- 상담 내용 편집·삭제(조회/내보내기 전용).
- PDF/인쇄 전용 레이아웃(이번엔 CSV + 화면만; 추후 별도).
- 강사·유형 등 상담 전용 추가 필터(필요 시 후속).
- 상담 AI 산출물(`consultation_ai`) 노출.

## 8. 변경 파일 요약

| 파일 | 변경 |
|------|------|
| `src/shared/firestore-helpers.js` | `fetchConsultationsForRange` 추가 |
| `src/dashboard/hooks/useConsultations.js` (신규) | 기간 상담 조회 훅 |
| `src/dashboard/components/ConsultationBoard.jsx` (신규) | 일자별/학생별 보기 + CSV 버튼 |
| `src/shared/csv.js` (신규) | `csvCell`/`safeCell` 공용화 + `downloadCsv` |
| `class-setup-planner.js` | CSV 셀 헬퍼를 공용 모듈 import로 교체 |
| `src/dashboard/App.jsx` | `view` 상태·토글·본문 분기·훅 호출 |

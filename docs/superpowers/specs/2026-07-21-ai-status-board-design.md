# 로그북 AI 종합상태 뷰 (AiStatusBoard) 설계

날짜: 2026-07-21
상태: 설계 승인됨

## 배경

학생별 AI 종합상태(`student_status_summaries`)는 매월 자동 배치 + 수시 수동 생성으로 만들어지지만,
현재는 메인앱 우측 상세패널을 학생마다 열어야만 볼 수 있다. 전체 학생을 상태별로 한눈에 조망하는
화면이 없다.

## 결정 사항 (사용자 확정)

| 항목 | 결정 |
|------|------|
| 위치 | dashboard.html(로그북) 뷰 토글에 `AI` 추가 — `로그북 \| 상담 \| AI` |
| 행 밀도 | 압축 행 + 클릭 확장 (`<details>` 패턴, 상담 뷰와 동일 문법) |
| 담당 필터 | 드롭다운, 기본 전체 |
| 부담당 | 미포함 — 주담당(`class_settings.teacher`)만 매칭 |
| 생성 액션 | 없음 — 읽기 전용. 생성/갱신은 메인앱 상세패널 + 월 자동배치 유지 |

## 아키텍처

- `src/dashboard/App.jsx`: `view` state에 `'ai'` 추가, 토글 버튼 1개 추가.
- `src/dashboard/components/AiStatusBoard.jsx` 신규 — ConsultationBoard처럼 `lazy()` 로드
  (echarts 미사용, 일별 첫 페인트 영향 없음).
- 데이터 훅 `useStudentStatusSummaries(user, enabled)` (`hooks/useFirestore.js`에 추가):
  - `enabled`(view==='ai' 최초 진입) 시 `student_status_summaries` 전체 1회 `getDocs`.
  - onSnapshot 사용 안 함 — 월 단위 갱신 데이터. 세션 내 캐시(뷰 전환 후 재진입해도 재로드 없음).
- 담당 파생: `class_settings` 문서들의 `teacher`(주담당) 이메일 → 반코드 집합 → 해당 반
  enrollment 보유 학생. 드롭다운 목록은 실제 담당 배정이 있는 교수만 노출.
  표시이름은 HR `staff_directory.english_name` 규칙(bd56042)을 따른다 — 이메일 파생 신규 도입 금지.
- 재사용(재구현 금지):
  - 마크다운 렌더: 기존 `renderMarkdown`(ui-utils.js) 사용, React에서는 `dangerouslySetInnerHTML`.
  - 학생 표기: `studentShortLabel` 축약형("양정중2").
  - enrollment 분류·대표선택: shared/DSC 함수만 사용 (dashboard 자체 파생 금지 —
    `feedback_dashboard_reads_dsc_only`).
  - 상태 톤(양호/주의/위험) 라벨·색: student-status-card.js의 `STATUS_TONE` 의미와 일치시킨다.

## 필터바 동작 (AI 뷰 활성 시)

- **기간 필터 숨김** — AI 요약은 생성 시점 기준 최근 3개월 스냅샷이라 기간 개념이 없다.
- 소속·학년·반 기존 필터 그대로 적용.
- **담당 드롭다운 추가** (AI 뷰에서만 표시). 기본 전체.
- 검색: 상담 뷰와 동일 — 활성 필터 범위 내 학생 이름 검색
  (`feedback_search_scoped_by_design` 준수, 전역 검색 아님).

## 목록 구조

- 상태별 `<details>` 그룹, 순서 고정: **위험 → 주의 → 양호 → 미생성**.
  - 위험·주의: 기본 펼침. 양호·미생성: 기본 접힘. (검색 중엔 상담 뷰처럼 전부 펼침)
- 헤더 총계: `위험 3 · 주의 12 · 양호 87 · 미생성 5` (필터 적용 후 수치).
- 압축 행 구성:
  - 이름 + 학교학년 축약 + 대표 반코드
  - 0이 아닌 카운트만: 결석 N · 숙제미제출 N · 테스트미달 N
  - 상담공백 경고(`consultation_gap_warning`): "상담공백 N일" 또는 "상담기록 없음"
  - 생성일(`generated_at`, KST 축약). **30일 초과 시 `오래됨` 배지** (표시만, 액션 없음).
- 클릭 확장(행 내부): `summary_markdown` 전문 + 위험신호(`risk_flags`) + 권장조치(`action_items`)
  + 출결/숙제/테스트 코멘트.
- 그룹 내 정렬: 이름 가나다순.
- **미생성 그룹**: 필터 적용된 재원생 중 summary 문서가 없는 학생. 이름·반만 나열하고
  "생성은 메인앱 상세패널에서" 안내 문구 1줄.
- 읽기 전용: 생성·갱신·수정 버튼 일절 없음.

## 에러·엣지 케이스

- summaries 로드 실패: 에러 카드 + 재시도 버튼 (기존 dash 에러 패턴).
- 퇴원생 summary 문서 존재 가능: 현재 재원생 목록(`useStudents`)과 조인해 재원생만 표시.
- summary는 있는데 학생 문서가 없으면(퇴원·삭제) 표시하지 않는다.
- READ-ONLY 모드: 읽기 전용 뷰라 영향 없음.
- 아이콘: `@impact7/ui` `Icon`/`IconButton`만. 이모지 금지.

## 비용

- AI 뷰 진입 시 재원생 수 규모의 문서 1회 읽기(수백 건). 세션당 1회. onSnapshot 없음.
- rules 변경 불필요: `student_status_summaries` read는 이미 `isAuthorized()` 허용, write 서버 전용.

## 검증

- `npm run build` 통과.
- 브라우저(READ-ONLY dev): 뷰 토글 진입, 상태 그룹·총계, 담당/소속/학년/반/검색 필터 조합,
  행 확장, 오래됨 배지, 미생성 그룹 확인.
- 커밋 전 `/simplify` → `/code-review`.

## 범위 밖 (명시적 제외)

- 목록에서 AI 생성/갱신 실행 (읽기 전용 결정).
- 부담당 매칭.
- 로그북·상담 뷰에 담당 필터 확장 (AI 뷰 전용으로 시작).
- 메인앱 상세패널로의 딥링크 (dashboard와 index는 별도 entry — 추후 필요 시).

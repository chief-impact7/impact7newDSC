# dashboard 로그북은 DSC/shared 로직을 "읽기만" 한다 — 자체 재구현 금지

## 규칙
`src/dashboard/`(React 대시보드)는 enrollment 분류·대표선택·active 판정을 **자체 구현하지 않는다.**
DSC 메인앱이 쓰는 함수(shared `@impact7/shared/*` 또는 `student-helpers.js`/`student-core.js`)를 **import해서 읽기만** 한다.

## 왜
dashboard가 DSC와 같은 로직을 자체 재구현하면 **drift**가 난다. DSC를 고쳐도 dashboard는 안 고쳐지고, 버그가 한쪽에만 생긴다.

## 사건 (2026-06-15)
`DailyLogBoard.jsx`가 `activeEnrollments`·`isFreeActive`·`isNaesinActive`·`virtualFreeEnrollment`·`virtualNaesinEnrollment`·`hasAutoNaesin` 등을 **자체 재구현**했다.
- DSC 메인앱: `getActiveEnrollments` → shared `applyNaesinFreeDerivation` (자유학기/내신을 **맨 앞=대표**로 정렬해 반환)
- dashboard 자체구현: `current.filter`로 **배열 순서 보존**
- 결과: 정규+자유학기(별도코드 FT101)를 가진 학생이, enrollment 배열에 **정규가 앞이면** 대표가 정규로 잡혀 자유학기 그룹인데 정규 반코드(A101)로 표시됨.
  - 류하율 `[정규 A101, 자유 FT101]` → A101 (오류)
  - 송채이 `[자유 FT101, 정규 A101]` → FT101 (우연히 정상)
- 같은 증상 자유학기 학생 43명 전원 잠재. shared를 쓰면 입력순서 무관 항상 FT101.

## 해결
DailyLogBoard 자체 파생함수 제거 → shared `applyNaesinFreeDerivation` 직접 호출(classSettings를 props로 넘김, 순수함수). 대표 enrollment = 파생결과 `[0]`. group 판정도 `enrolls[0].class_type` 기반.

## 적용 지침
- dashboard에서 enrollment 분류/라벨/코드가 필요하면 **먼저 DSC/shared에 있는 함수를 찾아 import**한다.
- 순수함수면 그대로(classSettings 인자), state 의존(`getActiveEnrollments`)이면 내부 shared 함수를 직접 호출.
- 없으면 shared에 추가를 제안(로컬 재구현 금지). [[project_regular_enddate_policy]]와 같은 SSoT 원칙.

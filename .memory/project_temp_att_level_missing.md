# temp_attendance level/필드 누락 → rules update 차단 사고 (2026-06-13)

## 증상
진단평가 미시행 모달 "시험취소"(confirmDiagnosticCancel)·우측 패널 취소 모두 "저장 실패".
원인은 payload가 아니라 **doc 자체가 rules 필수 필드(school/level/grade/branch) 중 하나가 빈 문자열**이라
`temp_attendance` 모든 update가 rules(firestore.rules:579~601, create/update 공통 `is string && size()>0`)에서 거부된 것.

## 근본 원인
- 온라인 신청서는 **Cloud Run 서비스 `/Users/jongsooyi/IMPACT7/newtest/cloudrun/src/index.js`** (`source:"diagnostic_apply"`)가
  admin SDK로 temp_attendance를 생성한다 → **rules 우회**라 빈 level로도 생성됨.
- `dscLevelFromGrade(grade)`는 grade에 초/중/고 단서 없으면("6학년") ""를 반환 → level 빔.
- 표시(`schoolLevelGradeLabel`)는 빈 level을 base 0(=초등)으로 가정해 grade 숫자만으로 "목원초6"을 만들어
  **초등 학생만 우연히 맞게 보임**(중/고면 틀림). 저장된 level 필드는 여전히 빔.

## 조치
1. forward: cloudrun `domain.js`에 `dscLevelFromApplication`(grade 우선, 없으면 학교명 초/중/고 접미 보완) 추가,
   `dscTempAttendanceData`가 사용. `validateApplicationGrade`(grade에 숫자 없거나 level 미상이면 제출 차단) 추가.
   → **cloudrun은 별도 Cloud Run 배포 필요** (DSC push와 별개).
2. 데이터: 기존 9건 백필(`scripts/oneoff/restore-temp-att-missing-fields.mjs`). branch 누락 6건→"선택안함",
   민주찬 grade=1, 류하율 grade=1, 이서준 level=초등+grade=6 (값은 사용자 확정).
3. DSC: `confirmDiagnosticCancel`/`saveDiagnosticReschedule`에 `_visitStatusPending` clear + `temp_arrival: deleteField()` 정렬.

## 교훈
- temp_attendance가 "저장 실패"면 **payload보다 doc의 필수 필드 공백을 먼저 의심**.
  점검: `scripts/oneoff/check-temp-att-missing-fields.mjs` (READ-ONLY, 9→0 확인).
- 진단평가 신청 흐름은 DSC가 아니라 **newtest/cloudrun**에 있다 (admin write라 rules 안 걸림).
- 학교급 추론 한계: `school.includes` 순서(초→중→고)라 "초지고등학교"+"3학년"처럼 grade 단서 없으면 오분류 가능(기존 동작, 후속 과제).

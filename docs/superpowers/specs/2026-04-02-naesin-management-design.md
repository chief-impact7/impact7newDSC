# 내신 반 관리 시스템 설계

> DSC에 내신(중간/기말고사 대비) 학생 관리 기능을 추가한다. 정규 반코드(A101) 대신 학교+학년(신서중2) 기반으로 반을 편성하고, 전용 상세패널을 제공한다.

---

## 1. 배경

- 내신 기간에 학생은 정규 반이 아닌 학교+학년 단위로 관리해야 한다.
- 현재 내신 enrollment도 정규 반코드(HX108 등)를 사용하여 학교별 조회/검색이 불가능하다.
- 내신 상세패널은 정규(숙제/테스트/후속대책 등)와 완전히 다른 항목이 필요하다.

---

## 2. 접근법

**별도 모듈 분리** — `naesin.js`를 신규 생성하여 내신 전용 로직을 분리한다.

- daily-ops.js가 이미 10,000줄+이므로 통합 시 관리 불가
- 정규 코드에 영향 없이 독립적으로 개발/수정 가능
- 공통 함수는 `window.*`로 접근 (기존 패턴 유지, daily-ops.js의 함수들이 이미 window로 노출됨)

---

## 3. 파일 구조

```
impact7newDSC/
├── app.js              ← 변경 없음
├── daily-ops.js        ← getStudentStartTime() 수정 + L2 필터에 내신 분기 추가
├── naesin.js           ← ⭐ 신규: 내신 전용 모듈
├── firestore.rules     ← class_settings allowed fields 추가
└── index.html          ← 변경 없음 (Vite가 import 추적)
```

### 모듈 책임

| 모듈 | 책임 | 변경 |
|------|------|------|
| `naesin.js` | 내신 리스트 렌더링, 상세패널, 메모 CRUD, 반 설정 UI | 신규 |
| `daily-ops.js` | L2에 "내신" 추가, 내신 선택 시 naesin.js로 분기, getStudentStartTime()에 요일 파라미터 추가 | 최소 수정 |
| `app.js` | 변경 없음 (enrollmentCode, getActiveEnrollments 기존 동작 유지) | 없음 |
| `firestore.rules` | class_settings에 naesin_start/naesin_end/schedule 허용 | 수정 |

### 함수 공유 방식

naesin.js는 daily-ops.js의 공통 함수를 `window.*`로 접근한다 (기존 onclick 핸들러 패턴과 동일):
- `window.applyAttendance()` — 출결 토글
- `window.saveExtraVisit()` — 클리닉 저장
- `window.saveDailyRecord()` — daily_records 저장
- `window.showSaveIndicator()` — 저장 상태 표시

naesin.js도 자체 함수를 `window.*`로 노출하여 onclick에서 호출 가능하게 한다.

---

## 4. UI 설계

### 4.1 L2/L3 필터

```
L1: [출결] [숙제] [테스트] [자동화] [행정]
L2: [비정규] [정규 128] [내신 42]        ← 내신 추가
L3 (정규 선택 시): [A101] [A103] [B201] ...
L3 (내신 선택 시): [신목중2A 12] [신목중2B 11] [진명여중2A 8] ...
```

L2 필터 구조 (daily-ops.js의 filters 객체에 추가):
```js
attendance: [
    { key: 'scheduled_visit', label: '비정규', children: [...] },
    { key: 'pre_arrival', label: '정규' },
    { key: 'naesin', label: '내신' }  // children은 동적 생성 (학교+학년별)
]
```

- 내신 선택 시 숙제/테스트/자동화 L1 탭 비활성화 (출결, 행정만 사용)
- L3 반코드 = `enrollmentCode(e)` = `level_symbol + class_number` (예: "신서" + "중2")
- L3 children은 활성 내신 enrollment에서 동적으로 추출
- 내신 학생 수 0명이면 "내신 0" 칩 표시하되 클릭 가능 (빈 상태 안내 표시)

### 4.2 학생 리스트

- 정규와 동일한 레이아웃 (이름 + 등원시간 + 출결 버튼)
- 시간은 해당 요일의 시간 표시 (요일별로 다를 수 있음)
- 반 담당 선생님 표시 — `@impact7.kr`/`@gw.impact7.kr` 제거하고 아이디만 표시
  - 예: `edward@gw.impact7.kr` → `edward`
  - 기존 `callerName()` 패턴 재사용 (teachers 목록에서 display_name 우선, 없으면 이메일 아이디)

### 4.3 내신 학생 상세패널 (순서대로)

1. **출결** — 등원전/출석/지각/결석 (정규와 동일 토글)
2. **등원요일·시간** — 반 기본값 표시 + 개별 override 가능
   - 오늘 요일은 주황 뱃지로 강조
   - 개별 시간은 빨간색으로 표시 "(개별)"
   - 각 요일별 "수정" 링크
   - 하단에 반 기본 스케줄 참고 표시
3. **메모** — 하루 1개 자유 텍스트 메모 (카드 우상단 + 버튼으로 입력 영역 토글)
   - `daily_records`의 `naesin_memo` 필드에 저장
   - 날짜별 1개 (당일 메모 수정 가능, 과거 메모는 읽기 전용)
   - 메모 목록은 최근 N일간의 daily_records에서 naesin_memo가 있는 것을 조회
4. **클리닉** — 추가 등원 예약 (카드 우상단 + 버튼으로 추가)

### 4.4 담당 선생님 표시

모든 UI에서 담당 선생님은 이메일 도메인을 제거하고 아이디만 표시:
- `edward@gw.impact7.kr` → `edward`
- teachers 목록에 display_name이 있으면 우선 사용

### 정규 대비 제외 항목

숙제 1차/2차, 테스트 1차/2차, 후속대책, 다음숙제, 귀가점검, 학부모알림 작성

---

## 5. Firestore 데이터 구조

### 5.1 반 설정 — `class_settings/{반코드}`

```json
// class_settings/신목중2A
{
  "teacher": "edward@gw.impact7.kr",
  "naesin_start": "2026-03-09",
  "naesin_end": "2026-05-03",
  "schedule": {
    "월": "18:00",
    "수": "17:00",
    "금": "18:00"
  }
}

// class_settings/신목중2B
{
  "teacher": "edward@gw.impact7.kr",
  "naesin_start": "2026-03-09",
  "naesin_end": "2026-05-03",
  "schedule": {
    "화": "18:00",
    "목": "18:00"
  }
}
```

기존 정규 class_settings(`domains`, `test_sections`, `default_time` 등)와 같은 컬렉션에 공존. 내신 반코드(신목중2A)는 정규 반코드(A101)와 겹치지 않으므로 충돌 없음. A = 홀수 그룹, B = 짝수 그룹.

### 5.2 학생 enrollment — `students/{id}.enrollments[]`

```json
{
  "class_type": "내신",
  "level_symbol": "신목",
  "class_number": "중2A",
  "start_date": "2026-03-09",
  "end_date": "2026-05-03",
  "day": ["월", "수", "금"],
  "schedule": { "월": "17:30" }
}
```

- **반 그룹**: A = 홀수 그룹(정규 끝자리 홀수에 대응), B = 짝수 그룹(정규 끝자리 짝수에 대응)
  - 예: 신목중2A(월수금), 신목중2B(화목)
  - 같은 학교+학년이라도 요일 그룹이 다르면 다른 반
- **semester 없음** — start_date~end_date로 기간 관리
- **day** — 이 학생이 실제 등원하는 요일 (월~일 모두 가능)
- **schedule** — 반 기본 시간과 다른 요일만 기록 (없으면 반 기본값 사용)
- **enrollmentCode** = "신목" + "중2A" = "신목중2A" (기존 함수 그대로 동작)
- **schedule은 enrollments[] 내부 필드** — students 컬렉션의 top-level allowed fields 변경 불필요 (Firestore rules는 배열 내부 subfield를 검증하지 않음)

### 5.3 내신 메모 — `daily_records/{studentId}_{date}`

```json
{
  "student_id": "홍길동_1234567890",
  "date": "2026-04-02",
  "attendance": { "status": "출석" },
  "naesin_memo": "2과 진도 완료. 3과 시작. 서술형 연습 필요.",
  "naesin_memo_by": "edward",
  "naesin_memo_at": "2026-04-02T18:30:00"
}
```

- 하루 1개 자유 텍스트 (`naesin_memo`)
- 작성자/시간 기록 (`naesin_memo_by`, `naesin_memo_at`)
- daily_records는 `withinFieldLimit(30)`만 체크하므로 별도 규칙 변경 불필요

### 5.4 시간 조회 우선순위

```
enrollment.schedule[요일]                    // 1순위: 학생 개별 시간
  → classSettings[반코드].schedule[요일]     // 2순위: 반 기본 시간
  → ""                                      // 없으면 빈값
```

`getStudentStartTime(enrollment)` → `getStudentStartTime(enrollment, dayName)` 시그니처 변경:
- dayName이 없으면 기존 동작 유지 (정규 호환)
- dayName이 있고 enrollment.schedule 또는 classSettings.schedule이 있으면 요일별 조회
- 이 함수는 `daily-ops.js`에 위치 (app.js가 아님)

---

## 6. 코드 흐름

### L2 "내신" 클릭 시

```
daily-ops.js renderSubFilters()
  → currentSubFilter에 'naesin' 포함 감지
  → naesin.js renderNaesinClassList() 호출
  → allStudents에서 class_type === '내신' && getActiveEnrollments()로 활성 필터
  → 학교+학년별 그룹핑 → L3 반 칩 렌더링
```

### 학생 클릭 시 — 내신 모드 감지 로직

```
daily-ops.js renderStudentDetail(studentId)
  → currentSubFilter에 'naesin' 포함?
  → YES: naesin.js renderNaesinDetail(studentId) 호출
  → NO: 기존 정규 상세패널 렌더링
```

내신 모드 판별은 **L2 필터 상태(`currentSubFilter`)** 기준. 학생의 enrollment type이 아닌 현재 UI 컨텍스트로 판별한다.

### renderListPanel() 분기

```
daily-ops.js renderListPanel()
  → currentSubFilter에 'naesin' 포함?
  → YES: naesin.js renderNaesinList() 호출 (내신 학생 리스트)
  → NO: 기존 정규 리스트 렌더링
```

---

## 7. 기존 코드 재사용

| 기능 | 출처 | 재사용 방식 |
|------|------|------------|
| 출결 토글 | daily-ops.js | window.applyAttendance() |
| 클리닉 | daily-ops.js | window.saveExtraVisit() |
| enrollmentCode() | app.js | 그대로 동작 ("신서" + "중2" = "신서중2") |
| getActiveEnrollments() | app.js / daily-ops.js | 두 파일에 존재하나 기능 동일. naesin.js는 daily-ops.js 버전 사용 (window 접근) |
| branchFromStudent() | app.js | 그대로 사용. 내신 학생은 반드시 student.branch 필드가 있어야 함 (class_number가 "중2" 형태라 branchFromClassNumber() fallback 불가) |
| daily_records 저장 | daily-ops.js | window.saveDailyRecord() |
| 담당 이름 표시 | daily-ops.js | callerName() 패턴 재사용 (@도메인 제거, display_name 우선) |

---

## 8. Firestore Rules 변경

### students 컬렉션 — 변경 불필요

`schedule`은 `enrollments[]` 배열 내부 subfield. Firestore rules의 `hasOnlyAllowedStudentFields()`는 top-level keys만 검증하므로 변경 불필요.

### class_settings 컬렉션 — 3개 필드 추가

`hasOnlyAllowedClassSettingsFields()`에 추가:

```
let allowed = [
  'domains', 'test_sections', 'teacher', 'sub_teacher',
  'default_time', 'default_time_updated_by', 'default_time_updated_at',
  'naesin_start', 'naesin_end', 'schedule'    // ← 추가
];
```

### daily_records 컬렉션 — 변경 불필요

이미 `withinFieldLimit(30)`만 체크. `naesin_memo`, `naesin_memo_by`, `naesin_memo_at` 추가에 별도 규칙 변경 불필요.

---

## 9. 범위 밖 (Out of Scope)

- **enrollment 겹침 검증** — 같은 학생의 내신 enrollment 간 기간 겹침은 DB 업로드 시 처리 (DSC 범위 밖)
- **RULES.md 데이터 구조 업데이트** — 구현 완료 후 후속 작업으로 진행
- **내신 반 생성/삭제 UI** — 1차에서는 DB 업로드 또는 Firestore 콘솔로 데이터 생성, DSC는 조회/편집만

---
name: 내신 반 관리 체계 설계
description: DSC 내신 class_type 반 편성/필터/상세패널 설계 (학교+학년 기반 반코드, 요일별 시간)
type: project
---

내신 반 관리 체계를 정규와 분리하여 구현 예정.

**Why:** 내신 학생은 정규 반코드(A101 등)가 아닌 학교+학년(신목중2 등)으로 관리해야 함. 현재 DSC에서 학교별 반 편성/검색 불가.

**How to apply:**

## 데이터 구조

### 반 설정 (`class_settings/신목중2`)
```json
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
```

### 학생 enrollment (`students/{id}.enrollments[]`)
```json
{
  "class_type": "내신",
  "level_symbol": "신목",
  "class_number": "중2",
  "start_date": "2026-03-09",
  "end_date": "2026-05-03",
  "day": ["월", "금"],
  "schedule": { "월": "17:30" }
}
```
- semester 불필요 (start_date~end_date로 기간 관리)
- 반 그룹: A=홀수그룹(월수금 등), B=짝수그룹(화목 등) — 정규 끝자리 홀짝 대응
- 예: level_symbol="신목", class_number="중2A" → enrollmentCode = "신목중2A"
- day: 학생이 실제 오는 요일 (월~일 모든 요일 가능)
- schedule: 반 기본 시간과 다른 요일만 기록 (없으면 반 기본값)

### 시간 조회 fallback
```
학생.schedule[요일] → 반 class_settings.schedule[요일]
```

## 구현 진행 상황 (2026-04-02)

### 완료
- Firestore rules: class_settings에 naesin 필드 허용 + 배포
- getStudentStartTime(): dayName 파라미터 + schedule 맵 조회
- naesin.js: 기본 모듈 생성, 학생 필터링, 리스트 렌더링, 상세패널(출결+등원요일시간+메모+클리닉)
- daily-ops.js: L2 내신 필터, renderListPanel/renderStudentDetail 분기
- 반 설정: L2 정규/내신 탭, L3 반코드 목록, 내신 반 상세(담당/기간/요일시간)
- 내신 반코드 자동 유도: 학생의 school+level+grade+A/B (정규반 끝자리 홀짝)
- 요일별 A/B 필터: 월수금=A, 화목토=B
- 초등부 제외

### 완료 (2026-04-02 2차 세션)
- **내신 자동 전환** ✅ — naesin.js: `getNaesinInfo()` 헬퍼로 정규 enrollment + class_settings 기간 자동 감지. `getNaesinStudents()`, `getNaesinClasses()`, `renderNaesinList()`, `renderNaesinDetail()`, `editNaesinTime()` 전부 업데이트.
- **정규 탭 숨김** ✅ — daily-ops.js `getActiveEnrollments()`: class_settings naesin_start~naesin_end 기간 내이면 정규 enrollment 숨김.
- 시간 개별 override: `enrollment.naesin_schedule[day]`에 저장 (Firestore rules 불변, enrollments 배열 내부)
- toggleNaesinDay 제거 (요일은 class_settings.schedule 키 기준)

### 완료 (2026-04-17 세션)
- **수동 추가/제거 UI** ✅ — 반설정상세패널에 "학생 추가" 카드, 내신학생상세패널에 "반에서 제거" 버튼. 특강과 대칭.
- **`enrollment.naesin_class_override` 필드 도입** — 첫 정규 enrollment에 저장:
  - `undefined`: 자동 유도 (기본)
  - `"<csKey>"`: 강제 매핑
  - `""`: 명시적 배제
- **`resolveNaesinCsKey(student, regularEnroll)` 헬퍼** (student-helpers.js) — 자동 유도 + override를 통합 처리. window.resolveNaesinCsKey로도 노출.
- 적용 위치: `naesin.js:getNaesinInfo`, `daily-ops.js:_getAllClassCodes`/`getNaesinStudentsByDerivedCode`, `student-helpers.js:getActiveEnrollments`/`isNaesinActiveToday`.
- 추가/제거 시 naesin_days·naesin_schedule 초기화. status2 건드리지 않음 (정규 모드 유지).

### 완료 (2026-04-02 3차 세션)
- **renderNaesinDetail CSS 전환** ✅ — 인라인 스타일 전부 제거, CSS 클래스 활용
  - detail-card / detail-card-title / detail-card-title-row / card-add-btn
  - naesin-att-btn + att-{active/present/late/absent}
  - naesin-day-badge + naesin-day-{active/today/inactive}
  - naesin-day-chips (신규), naesin-schedule-row, naesin-time, naesin-time-override
  - naesin-time-label, naesin-edit-btn, naesin-schedule-footer (border-top 추가)
  - naesin-memo-item/meta/empty/input/submit, naesin-clinic-item/status, clinic-done/pending
- **RULES.md 데이터 구조 업데이트** ✅ — students.enrollments naesin_schedule 필드, class_settings 컬렉션 추가

## DSC UI 구조
```
L2: 비정규 | 정규 | 내신
L3 (정규): A101 | A103 | B201 | ...
L3 (내신): 신목중2 | 진명여2 | 월촌중1 | ...
```

### 내신 학생 상세패널 (순서대로)
1. 출결 (등원전/출석/지각/결석)
2. 등원요일 + 시간 (반 기본값 표시, 개별 override 가능)
3. 메모 (중요 — 내신 진도, 상담내용 등)
4. 클리닉 (추가 등원 예약)

### 정규에서 제외되는 항목
- 숙제 1차/2차, 테스트 1차/2차, 후속대책, 다음숙제, 귀가점검, 학부모알림 작성

## 영향 범위
- DB: 업로드 템플릿에 내신 반코드 체계 추가
- DSC: L2 필터에 내신 추가, L3 동적 전환, 내신 전용 상세패널
- DSC: getStudentStartTime() 로직에 schedule 지원 추가
- Firestore rules: students allowed fields에 schedule 추가

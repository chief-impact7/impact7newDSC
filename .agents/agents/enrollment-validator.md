# Enrollment Validator

## 핵심 역할

학생 `enrollments[]` 배열의 class_type × 코드 필드 정합성을 두 가지 축으로 검증하는 감사 에이전트.

1. **정적 가드 감사**: 4개 필수 가드 위치에 검증 로직이 살아 있는지 확인
2. **스크립트 생성**: 실제 Firestore 데이터의 위반 건을 탐지하는 oneoff 스크립트 작성

## 정합성 규칙 (Firestore 진실 원천)

| class_type | level_symbol | class_number | 비고 |
|------------|-------------|--------------|------|
| 정규 / 자유학기 | 필수 (non-empty) | 필수 (non-empty) | 둘 중 하나라도 비면 위반 |
| 내신 | 비어야 함 | 비어야 함 | csKey는 별도 관리 |
| 특강 | - | 필수 (non-empty) | level_symbol은 선택 |

## 정적 가드 위치 (반드시 살아 있어야 하는 4곳)

1. `class-setup.js` — 반편성도우미 throw (line 1169, 1175 부근)
2. `daily-ops.js:saveEnrollment` — 학생 상세 편집 alert + return
3. `~/projects/impact7DB/app.js:_validateEnrollmentFields` — CSV import + 신규 학생 등록
4. `~/projects/impact7DB/upsert-students.js` line 271~ — CSV import throw

## 작업 순서

### Phase 1: 정적 가드 감사

각 위치에서 다음을 확인한다:

- `class_type`이 `'정규'` 또는 `'자유학기'`일 때 `level_symbol`·`class_number` 비어 있으면 오류 처리하는 코드가 있는가?
- `class_type`이 `'내신'`일 때 `level_symbol`·`class_number`가 비어야 한다는 검증이 있는가?
- `class_type`이 `'특강'`일 때 `class_number` 검증이 있는가?

결과를 표로 정리한다:

| 가드 위치 | 정규/자유학기 검증 | 내신 검증 | 특강 검증 | 판정 |
|----------|-------------------|----------|----------|------|
| class-setup.js | ✅/⚠️ | ✅/⚠️ | ✅/⚠️ | OK/누락 |
| daily-ops.js | ... | ... | ... | ... |
| impact7DB/app.js | ... | ... | ... | ... |
| impact7DB/upsert-students.js | ... | ... | ... | ... |

### Phase 2: 데이터 감사 스크립트 생성

`scripts/oneoff/check-enrollment-integrity.mjs`를 생성한다.

**스크립트 구조:**
```javascript
// check-enrollment-integrity.mjs
// Firestore Admin SDK로 students 컬렉션 전체를 읽어
// enrollments[] 각 항목의 class_type×코드 정합성을 검증한다.
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// 위반 분류:
// VIOLATION_REGULAR: 정규/자유학기인데 level_symbol 또는 class_number가 비어있음
// VIOLATION_NAESIN: 내신인데 level_symbol 또는 class_number가 비어있지 않음
// VIOLATION_TEUKANG: 특강인데 class_number가 비어있음
// UNKNOWN_TYPE: 알 수 없는 class_type
```

스크립트 완성 후 실행 방법을 알려준다:
```bash
node scripts/oneoff/check-enrollment-integrity.mjs
```

### Phase 3: 결과 보고

`_workspace/enrollment_integrity_report.md`에 저장:
- 정적 감사: 가드 현황 표
- 누락 가드 있으면 구체적 수정 위치와 예시 코드
- 데이터 감사 스크립트 경로 및 실행 방법
- 발견된 위반이 있으면 수정 가이드 (firestore-data-fix 패턴 참고)

## 주의사항

- 가드 위치 확인 시 라인 번호가 바뀌었을 수 있으므로 함수명·패턴으로 검색한다
- 데이터 감사 스크립트는 **읽기 전용**으로만 작성한다 (수정은 firestore-data-fix 패턴으로 별도 진행)
- `impact7DB/app.js`와 `impact7DB/upsert-students.js`는 `~/projects/impact7DB/` 경로에 있음

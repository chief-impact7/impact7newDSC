# 상담 이력 검색 (학생 상세 [상담] 탭) — Design Spec

작성일: 2026-05-20
대상 프로젝트: impact7newDSC
배경: v1 [상담] 탭은 한 학생의 상담 이력을 "최근 10건 고정"으로만 표시. 누적 상담이 많아지면 과거 상담을 찾기 어려움. 기간·키워드 검색을 추가한다.

## 1. 목적 / 범위

- **목적:** 학생 상세 [상담] 탭에서 해당 학생의 상담 이력을 기간 + 키워드로 검색.
- **범위:** `consultation-card.js`(UI), `data-layer.js`(쿼리) 2파일. Firestore 스키마·rules·인덱스 변경 없음.
- **범위 외 (후속 과제):**
  - **퇴원생 상담 UI 접근** — 데이터는 보존되나 진입 UI는 별도 (아래 4절)
  - **Excel/Google Sheets import** — 별도 spec
  - **학원 전체(학생 무관) 상담 검색** — 본 spec은 한 학생 범위만

## 2. 디자인

### 2.1 컴포넌트

**검색 바** (`consultation-card.js`의 `renderHistoryCard` 위에 신규 렌더):
- 시작일 `input[type=date]` + 종료일 `input[type=date]`
- 키워드 `input[type=text]` (메모 본문·유형·강사명 부분일치)
- `[검색]` / `[초기화]` 버튼
- 스타일은 DSC 기존 `.card`·`.row` 패턴 따름 (별도 시각 디자인 변경 없음; 학원 통일 기준은 `DESIGN-starbucks.md`)

### 2.2 하이브리드 쿼리

`data-layer.js`에 신규 함수:

```js
export async function searchStudentConsultations(studentId, { startDate, endDate, limitCount = 20 } = {}) {
  // 기간 지정 여부로 쿼리 분기
  const hasRange = Boolean(startDate || endDate);
  if (!hasRange) {
    return listStudentConsultations(studentId, limitCount);  // 기존 함수 재사용 (최근 N건)
  }
  const clauses = [where('student_id', '==', studentId)];
  if (startDate) clauses.push(where('date', '>=', startDate));
  if (endDate)   clauses.push(where('date', '<=', endDate));
  const q = query(collection(db, 'consultations'), ...clauses, orderBy('date', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

- **기간 지정** → Firestore 쿼리 (`student_id ==` + `date >=`/`<=` + `orderBy date desc`)
- **기간 미지정** → 기존 `listStudentConsultations(studentId, 20)`
- 기존 `student_id ASC + date DESC` composite 인덱스로 커버 → **추가 인덱스 불필요** (이미 impact7DB에 배포됨)

### 2.3 키워드 필터 (순수 함수)

`consultation-card.js`에 추출:

```js
export function filterConsultationsByKeyword(list, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return list;
  return list.filter(c =>
    [c.text, c.consultation_type, c.teacher_name]
      .some(field => String(field || '').toLowerCase().includes(kw))
  );
}
```

- 두 쿼리 경로 모두 결과에 동일 적용
- 순수 함수 → 단위 테스트 가능

### 2.4 데이터 흐름

```
[검색바 입력] → onSearchConsultations(studentId)
  → searchStudentConsultations(studentId, {startDate, endDate})   // 하이브리드
  → filterConsultationsByKeyword(결과, 키워드)                      // 클라이언트
  → renderHistoryCard(필터된 결과)
```

**건수 일관성:** 초기 렌더·검색 미지정·`[초기화]` 모두 동일하게 **최근 20건**(`DEFAULT_HISTORY_LIMIT = 20`)을 기본 로드한다. 기존 초기 렌더가 10건이었으나 검색 기능과의 일관성·가시성을 위해 20으로 상향한다 (유일한 기존 동작 변경점). 기간 지정 시에는 limitCount 없이 해당 기간 전체를 가져온다.

## 3. 에러 처리

| 상황 | 처리 |
|------|------|
| 시작일 > 종료일 | 경고 토스트(`_deps.toast`), 쿼리 안 함 |
| 결과 0건 | "검색 결과 없음 (기간/키워드를 조정하세요)" 표시 |
| 쿼리 실패 | 기존 "로드 실패" 메시지 패턴 재사용 |
| 키워드만 입력(기간 없음) | 최근 20건(`DEFAULT_HISTORY_LIMIT`) 로드 후 키워드 필터 (전체 이력이 아닌 최근 20건 범위임을 hint로 안내) |

## 4. 퇴원생 상담 보존 (현황 + 후속 과제)

- **데이터 레이어:** `consultations` 컬렉션은 `student_id` 기준 영구 보존. 학생 `status`(재원/퇴원)와 무관하게 문서 유지. 자동 삭제 정책 없음.
- **현재 UI 한계:** DSC 학생 목록·검색은 `ACTIVE_STUDENT_STATUSES`(`재원`/`등원예정`/`실휴원`/`가휴원`/`상담`)만 로드(`data-layer.js:181`, `firestore-helpers.js:275`). 퇴원생(`퇴원`/`종강`)은 `loadWithdrawnStudents()`로 분리 관리되나 [상담] 탭 진입 경로가 없음.
- **후속 과제 (본 spec 범위 외):** 퇴원생 상세 진입 → [상담] 탭 read-only 표시. `state.withdrawnStudents`가 이미 존재하므로 진입 경로 + read-only 모드만 추가하면 됨. 별도 spec/plan으로 진행.

## 5. 영향 / 호환성

- **Firestore 스키마/rules/인덱스:** 변경 없음 (기존 인덱스 재사용)
- **기존 동작:** 초기 [상담] 탭 표시 건수만 10→20 상향 (2.4). 그 외 입력·저장·요약·브리핑 렌더는 무변경
- **하위 호환:** `listStudentConsultations`는 그대로 유지하고 `searchStudentConsultations`가 그것을 재사용

## 6. 검증 방법

1. **단위:** `filterConsultationsByKeyword` 순수 함수 테스트 (키워드 없음→전체, 본문 일치, 유형 일치, 강사명 일치, 대소문자 무시, 0건)
2. **수동(브라우저):**
   - 기간만 지정 → 해당 기간 상담만
   - 키워드만 지정 → 최근 20건 중 일치분
   - 기간+키워드 → 교집합
   - 시작일 > 종료일 → 경고
   - 결과 0건 → 빈 상태 메시지
   - [초기화] → 최근 20건 복원
3. **회귀:** 검색 미사용 시 기존 "최근 10건" 표시 동일

## 7. 비결정 항목 / 리스크

- **(LOW)** 키워드만 입력 시 "최근 20건" 범위로 제한됨 — 전체 이력 키워드 검색을 원하면 기간을 넓게 지정해야 함. UI hint로 안내. 향후 전체 로드 옵션 검토 가능.
- **(LOW)** DSC에 JS 단위 테스트 인프라가 없으면 `filterConsultationsByKeyword`만 격리 테스트하거나 수동 검증. 구현 plan에서 확인.
- **(NONE)** Firestore 비용: 한 학생 범위 쿼리라 read 수 미미.

## 8. 후속 과제 (이번 범위 외, 사용자 확인됨)

- 퇴원생 상담 UI 접근 (4절)
- Excel/Google Sheets → consultations import (별도 spec)
- AI 누적요약·다음 상담 브리핑은 이미 `consultation-card.js`에 표시 구현됨 — 데이터(`consultation_summaries`/`briefings`)가 채워지면 자동 표시. 추가 개발 불요.

# [상담] 탭 redesign + 입력/조회 분리 — Design Spec

작성일: 2026-05-20
대상 프로젝트: impact7newDSC
배경: v1 [상담] 탭은 입력폼·요약·브리핑·이력이 한 화면에 텍스트로 나열되어 있고, 탭에서 빠져나오는 명시적 UI가 없으며, 입력 메타데이터(대상·형태·반명)가 부족하다. 입력/조회 서브탭으로 분리하고 redesign한다.

전제: impact7newDSC PR #1 (feat/consultation-search, 기간+키워드 검색)이 먼저 master에 머지된 상태. 본 작업은 그 위에서 시작하며 검색 로직(`searchStudentConsultations`, `filterConsultationsByKeyword`, `DEFAULT_HISTORY_LIMIT`)을 조회 탭에 재사용한다.

## 1. 목적 / 범위

- **목적:** [상담] 탭을 입력/조회 서브탭으로 분리, 입력 메타데이터 확장, 명시적 닫기, starbucks 톤 redesign.
- **범위:** `consultation-card.js`(UI 전면 개편), `data-layer.js`(addConsultation 신규 필드), `daily-ops.css`(상담 스타일 정의), `student-detail.js`(닫기 연동 — 필요 시).
- **범위 외:**
  - 퇴원생 상담 UI 접근 (후속)
  - Excel import (후속)
  - consultation 폴더 AI 파이프라인 변경 (신규 필드는 선택적 활용; 필수 아님 — 6절)

## 2. 탭 구조

학생 상세 [상담] 탭 진입 시 내부에 헤더 바 + 2개 서브탭(입력/조회).

```
┌─ 🗨 상담                                    [× 닫기] ─┐   헤더 바 (House Green)
├──────────────────────────────────────────────────────┤
│  [ 입력 ]  [ 조회 ]                          서브탭     │
├──────────────────────────────────────────────────────┤
│  (선택된 서브탭 콘텐츠)                                  │
└──────────────────────────────────────────────────────┘
```

- 기본 진입 서브탭: **입력**
- 서브탭 전환: `window.onConsultationSubtab(studentId, tab)` — 'input' | 'search'
- 서브탭 상태는 모듈 변수(`_activeSubtab`)로 유지. 저장·검색 시 해당 서브탭만 재렌더.

## 3. 입력 탭

```
┌─ 다음 상담 브리핑 (AI) ──────────────┐   접기 가능, 데이터 없으면 placeholder
│ (briefing_markdown)                  │
└──────────────────────────────────────┘
┌─ 이번 상담 입력 ─────────────────────┐
│ 상담일 [2026-05-20]   입력일 (자동)    │   메타 2열 그리드
│ 반명 (자동: 고1A)     학생명 (자동: 홍길동)│
│ 대상 ◉학생 ○학부모    형태 [대면 ▾]     │
│ 유형 [정기 ▾]                          │   consultation_type 유지
│ ┌──────────────────────────────────┐ │
│ │ 메모 (textarea)                   │ │
│ └──────────────────────────────────┘ │
│                          [ 저장 ]      │   pill 버튼
└──────────────────────────────────────┘
```

**필드 위젯:**
| 필드 | 위젯 | 값/소스 |
|------|------|---------|
| 상담일 | `input[date]` | 기본 오늘 |
| 입력일 | 표시만(read-only hint) | 저장 시 `created_at`(serverTimestamp). 신규 입력 시 "저장 시 자동 기록" 표기 |
| 반명 | 표시만(read-only) | `activeClassCodes(student, 상담일)` → `class_name`. 복수면 콤마 결합 |
| 학생명 | 표시만(read-only) | `student.name` |
| 대상 | 라디오 | `학생` \| `학부모` (기본 `학생`) |
| 형태 | `select` | `전화` \| `문자` \| `대면` \| `기타` (기본 `대면`) |
| 유형 | `select` | 기존 6종 `정기/휴원/퇴원/복귀/학부모요청/기타` |
| 메모 | `textarea` | 자유 입력 |

- 저장 검증: 상담일 + 메모 필수 (기존 동일). 대상·형태·유형은 기본값 있어 항상 채워짐.
- READ_ONLY 모드면 입력폼 disabled (기존 `_deps.readonly` 유지).

## 4. 조회 탭

```
┌─ AI 누적 요약 ───────────────────────┐   접기 가능, placeholder
│ (summary_markdown)                   │
└──────────────────────────────────────┘
┌─ 검색 ───────────────────────────────┐   PR #1 재사용
│ 시작일 [ ] 종료일 [ ] 키워드 [      ]  │
│              [검색] [초기화]   hint     │
└──────────────────────────────────────┘
┌─ 상담 이력 (최근 20건) ──────────────┐
│ ▸ 2026-05-18  [정기·대면·학생] (김쌤)  │   배지에 유형·형태·대상
│   메모 본문...                         │
└──────────────────────────────────────┘
```

- 검색: `searchStudentConsultations(studentId, {startDate, endDate})` + `filterConsultationsByKeyword(raw, keyword)` (PR #1)
- 이력 배지: `[consultation_type · method · target]` — 구 데이터는 method/target 없으면 해당 칸 생략(`undefined` 미표시)
- AI 누적요약: `getStudentSummary` (기존)

## 5. 스키마 변경 (consultations 신규 필드 — 공존)

| 필드 | 값 | 비고 |
|------|-----|------|
| `target` | `'학생'` \| `'학부모'` | 신규 |
| `method` | `'전화'` \| `'문자'` \| `'대면'` \| `'기타'` | 신규 |
| `class_name` | string (예: `'고1A'`, 복수 `'고1A, 고2B'`) | 신규, 자동 |
| `consultation_type` | 기존 6종 | **유지** |

기존 필드(student_id·student_name·teacher_id·teacher_name·date·text·ai_processed·ai_processed_at·created_at·updated_at) 그대로.

**rules 영향: 없음 (4앱 동기화 불필요).** impact7DB `firestore.rules:1024-1027`의 consultations create rule은 `request.resource.data.keys().hasAll([필수 8필드])` — **필수 목록 방식**이라 추가 필드를 막지 않는다(`hasOnly` 아님). 신규 3필드는 자유롭게 추가 가능. 또한 rule이 `consultation_type`을 필수로 요구하므로 "유형 공존" 결정이 rule과 정합.

`addConsultation`(data-layer.js:808) payload에 `target`, `method`, `class_name` 추가. 나머지 로직 동일.

## 6. consultation 폴더 AI 파이프라인 영향

- `fetch.js`는 consultations에서 `student_id`/`date`/`ai_processed` 기준으로 페치하고 `.data()` 전체를 워크스페이스로 넘김 → 신규 필드는 자동으로 따라감. **fetch.js 변경 불필요.**
- tagger는 `consultation_type` 라벨/본문 불일치를 데이터 품질 검사로 사용 → 유형 유지로 호환. 신규 `target`/`method`는 tagger가 추가 신호로 활용할 수 있으나 **이번 범위에서 에이전트 정의 변경은 하지 않음**(선택적 후속).
- **결론:** consultation 폴더 변경 없음. 신규 필드는 하위 호환으로 흘러감.

## 7. redesign (starbucks 톤)

기존 CSS 변수 재사용 (`style.css:6-16`): `--primary #00754A`, `--surface #f2f0eb`, `--border #e7e3db`. 추가 색이 필요하면 House Green `#1E3932`를 `--consult-header` 등 지역 변수로.

- **헤더 바:** House Green 배경 + 흰 텍스트 + 우측 닫기(×) 버튼
- **서브탭:** `.detail-tab` 패턴 준용 (활성 시 `--primary` 하단 보더)
- **카드:** 12px radius + soft shadow (`0 0 6px rgba(0,0,0,.14)` 류)
- **칩/배지:** `대상`·`형태`·`유형` 선택 UI + 이력 `.type-badge` — `daily-ops.css`에 `.consultation-*` 클래스 체계적 신규 정의 (현재 인라인/미정의)
- **입력폼:** 메타 필드 2열 그리드, 메모 textarea full-width
- starbucks의 색·spacing 토큰을 모방하되 markdown이 아닌 실제 CSS로 적용. DSC 기존 컴포넌트와 이질감 없게.

## 8. 닫기 동작

- 헤더 바 우측 `[× 닫기]` → 일일현황 탭으로 전환.
- `student-detail.js`의 `switchDetailTab` 호출 (탭 id는 구현 시 index.html에서 확인 — 일일현황 탭의 정확한 id/핸들러). 인라인 `onclick="onCloseConsultation()"` → `switchDetailTab('<daily-tab-id>')`.
- 효과: 상담 탭 콘텐츠가 길어 탭 바가 스크롤 밖으로 밀려도 명시적 이탈 경로 확보.

## 9. 컴포넌트 분리 (consultation-card.js 비대화 방지)

- `renderConsultationTab(studentId)` → 헤더 + 서브탭 바 + 활성 서브탭 디스패치
- `renderInputTab(studentId)` → 브리핑(접기) + 입력폼
- `renderSearchTab(studentId)` → 요약(접기) + 검색 바 + 이력
- 순수 헬퍼 후보(테스트 가능): `buildConsultationPayload({...})` — 입력값 → Firestore payload 객체 변환 (target/method/class_name 포함). `consultation-filter.js` 같은 패턴으로 분리하면 node:test 가능.
- 기존 `renderInputForm`/`renderHistoryCard`/`renderSummaryCard`/`renderBriefingCard`는 재사용·재배치.

## 10. 에러 처리 / 호환성

- 구 데이터(target/method/class_name 없음): 이력 배지에서 해당 칸 생략, 상세는 정상 표시
- 저장 실패: 기존 toast 패턴
- 서브탭 전환 중 데이터 로딩: 기존 placeholder 패턴
- 하위 호환: 신규 필드는 옵셔널, 기존 조회·AI 파이프라인 무영향

## 11. 검증 방법

1. **단위(node:test):** `buildConsultationPayload` 순수 함수 (필수 필드 + 신규 필드 + 기본값). `filterConsultationsByKeyword`(PR #1) 회귀.
2. **수동(브라우저):**
   - 헤더 닫기(×) → 일일현황 탭 전환
   - 서브탭 입력↔조회 전환
   - 입력: 대상·형태·유형 선택 + 메모 → 저장 → Firestore에 신규 필드 포함 확인 → 조회탭 이력에 배지 표시
   - 조회: 검색(PR #1) 동작 + AI 요약 표시
   - 반명·학생명·입력일 자동 채움 확인
   - READ_ONLY 모드 입력 disabled
3. **빌드:** `npm run build` 성공

## 12. 후속 (범위 외)

- 퇴원생 상담 UI 접근
- Excel import
- tagger/trends가 `target`·`method`를 추가 신호로 활용 (consultation 폴더 에이전트 정의 확장)
- AI 산출물 markdown의 starbucks 색 HTML 렌더

## 13. 참고

- 전제 PR: impact7newDSC PR #1 (feat/consultation-search) — 머지 후 본 작업 시작
- 검색 로직: `consultation-filter.js`, `data-layer.js:searchStudentConsultations`
- rules: impact7DB `firestore.rules:1021-1037` (변경 없음 확인)
- 시각 통일: 루트 `DESIGN-starbucks.md`

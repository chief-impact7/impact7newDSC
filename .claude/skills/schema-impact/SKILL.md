---
name: schema-impact
description: "Firestore 스키마 변경 영향 분석. 컬렉션/필드명을 주면 해당 데이터를 읽거나 쓰는 모든 코드 위치를 추적하고 수정 가이드를 생성한다. '필드 추가', '스키마 변경', '컬렉션 수정', '영향 분석', '어디어디 고쳐야', 'Firestore 필드', '필드 이름 변경', '필드 삭제', '데이터 모델 변경' 관련 요청 시 반드시 사용. 'enrollments 변경', 'status 필드', 'students 컬렉션' 등 구체적 Firestore 경로 언급 시에도 사용. 후속: '다른 필드도 분석', '수정 가이드 업데이트', '영향 범위 재확인' 시에도 사용."
---

# Schema Impact Analyzer

Firestore 컬렉션/필드 변경 시 영향받는 모든 코드를 추적하여, 빠짐없는 수정 가이드를 생성한다. 이 프로젝트는 Vanilla JS + React 하이브리드이고 동일 Firestore 데이터를 양쪽에서 접근하므로, 한쪽만 수정하면 다른 쪽이 깨진다. 이 스킬이 양쪽을 모두 추적한다.

## 실행 모드: 서브 에이전트

schema-tracer 에이전트가 코드 추적을 수행하고, 오케스트레이터가 결과를 영향 보고서로 종합한다.

## 에이전트 구성

| 에이전트 | 파일 | 역할 | 출력 |
|---------|------|------|------|
| schema-tracer | `.claude/agents/schema-tracer.md` | 코드 내 필드 사용처 완전 추적 | `_workspace/schema_trace.md` |

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/schema_trace.md` 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1로 진행
   - **존재 + 다른 필드 분석 요청** → 새 trace 파일을 `_workspace/schema_trace_{field}.md`로 생성
   - **존재 + 같은 필드 재분석** → 기존 파일 덮어쓰기

### Phase 1: 입력 파싱

사용자 요청에서 추출:
- **대상 컬렉션**: (예: students, daily_checks, class_settings)
- **대상 필드**: (예: enrollments, status, hw_reading)
- **변경 유형**: 추가 / 이름 변경 / 타입 변경 / 삭제
- 명시되지 않은 정보는 사용자에게 질문

RULES.md를 읽어 해당 컬렉션/필드의 데이터 모델 컨텍스트를 파악한다.

### Phase 2: 코드 추적 (schema-tracer 에이전트)

schema-tracer 에이전트를 스폰한다:

```
Agent(
  description: "Firestore 스키마 영향 추적",
  prompt: "에이전트 정의 `.claude/agents/schema-tracer.md`를 먼저 읽고 따르라.
    대상: {컬렉션}.{필드}, 변경 유형: {유형}.
    RULES.md를 읽어 데이터 모델을 파악한 뒤 추적을 시작하라.
    결과를 `_workspace/schema_trace.md`에 저장하라.",
  model: "opus"
)
```

### Phase 3: 영향 보고서 생성

schema-tracer 결과를 읽고 종합 보고서를 생성한다:

```markdown
# 스키마 영향 분석: {컬렉션}.{필드}

## 변경 내용
- 변경 유형: {추가/이름변경/타입변경/삭제}
- 대상: {컬렉션}.{필드}

## 영향 요약
- 영향받는 파일: {N}개
- 수정 필요 위치: {M}개
- 위험도: {높음/보통/낮음} — 기준: 수정 위치 수 + 데이터 손실 가능성

## 영향받는 코드

### 읽기 (Read) — {N}개 위치
| 파일:라인 | 용도 | 수정 방법 |
|----------|------|----------|

### 쓰기 (Write) — {N}개 위치
| 파일:라인 | 용도 | 수정 방법 |
|----------|------|----------|

### 쿼리 (Query) — {N}개 위치
| 파일:라인 | 용도 | 수정 방법 |
|----------|------|----------|

### Firestore Rules — {N}개 위치
| 라인 | 규칙 | 수정 방법 |
|------|------|----------|

### React 컴포넌트/훅 — {N}개 위치
| 파일:라인 | 용도 | 수정 방법 |
|----------|------|----------|

## 권장 수정 순서
1. firestore.rules 수정 + 4프로젝트 동기화 (`/firestore-rules-sync`)
2. firestore-helpers.js 유틸 수정 (공유 함수부터)
3. 백엔드 로직 (app.js, daily-ops.js, naesin.js, class-setup.js)
4. React 훅(useFirestore.js) + 컴포넌트
5. `npm run build`로 빌드 검증

## 주의사항
- {변경으로 인한 하위 호환성 이슈}
- {기존 Firestore 문서에 해당 필드가 없는 경우 처리}
```

## 데이터 흐름

```
[사용자: 컬렉션.필드 + 변경 유형]
    │
    ├── RULES.md (데이터 모델 컨텍스트)
    │
    └──→ Agent(schema-tracer) → _workspace/schema_trace.md
                │
                ↓
         [오케스트레이터: 종합] → 영향 보고서 출력
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 필드가 코드에서 미발견 | "사용처 없음 — 새 필드이거나 필드명 오타 확인" 안내 |
| 동적 접근 (bracket notation) | 정적 분석 한계 명시 + 수동 확인 권장 위치 표시 |
| 4개 프로젝트 중 일부 접근 불가 | 접근 가능한 프로젝트만 분석, 누락 명시 |
| 대량 결과 (50+ 위치) | 파일별 그룹핑 + 핵심 수정 포인트 하이라이트 |

## 테스트 시나리오

### 정상 흐름 (단순 필드 추가)
1. "students 컬렉션에 phone 필드 추가하려는데 영향 분석해줘"
2. Phase 1: 대상=students.phone, 유형=추가
3. Phase 2: schema-tracer가 students 관련 코드 전체 추적
4. Phase 3: 5개 파일 12개 위치 → 수정 가이드 포함 보고서

### 복잡한 필드 (enrollments 배열 내 필드)
1. "enrollments에 level 필드 추가"
2. 배열 내부 필드 → 배열 조작 코드(.map, .filter, .find)까지 확장 추적
3. daily-ops.js에서 20+ 위치 발견 → 파일별 그룹핑으로 가독성 확보

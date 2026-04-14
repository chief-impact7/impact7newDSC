---
name: module-splitter
description: "대규모 JavaScript 파일을 안전하게 모듈로 분리하는 오케스트레이터. 의존관계 분석 → 분리 계획 → 단계별 분리 실행 → 빌드 검증을 순차 수행한다. 'daily-ops 분리', '모듈 분리', '파일 쪼개기', '파일 분할', '리팩토링 분리', '대규모 파일 정리', '11000줄', '파일이 너무 크다' 요청 시 반드시 사용. 후속: '나머지 모듈 분리', '분리 계속', '다음 클러스터', '분리 결과 확인', '분리 되돌리기' 시에도 사용."
---

# Module Splitter

대규모 JavaScript 파일(daily-ops.js 11,500+줄 등)을 비즈니스 기능 단위로 안전하게 분리한다. 핵심 원칙: 한 번에 하나의 모듈만 분리하고, 매 단계마다 빌드를 검증하여 깨지지 않는 분리를 보장한다.

## 실행 모드: 서브 에이전트 (파이프라인)

분석 → 실행이 순차 의존이므로 서브 에이전트를 순차 호출한다. 에이전트 간 통신은 파일(`_workspace/`) 기반이다.

## 에이전트 구성

| 에이전트 | 파일 | 역할 | 출력 |
|---------|------|------|------|
| dependency-analyzer | `.claude/agents/dependency-analyzer.md` | 함수 의존관계 분석 + 클러스터링 | `_workspace/dependency_analysis.md` |
| module-executor | `.claude/agents/module-executor.md` | 단계별 모듈 분리 실행 + 빌드 검증 | 분리된 파일들 + `_workspace/module_execution_log.md` |

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/` 디렉토리 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1부터
   - **dependency_analysis.md만 존재** → 분석 완료 상태. Phase 3(사용자 확인)부터
   - **module_execution_log.md 존재 + 미완료 클러스터** → 이어서 분리. Phase 4 재개
   - **사용자가 "분리 되돌리기" 요청** → git으로 해당 분리 단계 되돌리기

### Phase 1: 대상 결정

1. 사용자가 파일을 지정했으면 해당 파일 사용
2. 미지정이면 프로젝트에서 가장 큰 JS 파일을 자동 감지 (기본: daily-ops.js)
3. 파일 줄 수 확인. 500줄 미만이면 "분리 불필요" 안내 후 종료

### Phase 2: 의존관계 분석 (dependency-analyzer)

```
Agent(
  description: "JS 파일 의존관계 분석",
  prompt: "에이전트 정의 `.claude/agents/dependency-analyzer.md`를 먼저 읽고 따르라.
    분석 대상: {파일경로}.
    RULES.md를 읽어 비즈니스 도메인(숙제/테스트/출결/특강/내신)을 파악한 뒤 분석하라.
    결과를 `_workspace/dependency_analysis.md`에 저장하라.",
  model: "opus"
)
```

### Phase 3: 분리 계획 확인 (사용자 승인)

dependency-analyzer 결과를 읽고 사용자에게 제시:

```markdown
## 모듈 분리 계획

| # | 모듈명 | 포함 기능 | 예상 줄 수 | 분리 난이도 |
|---|--------|----------|-----------|-----------|
| 1 | daily-ops-homework.js | 숙제 관리 | ~2,500 | 쉬움 |
| 2 | daily-ops-test.js | 테스트/재시험 | ~2,000 | 보통 |
| ... | | | | |

공유 자원: {전역 변수 N개, 공통 함수 N개}
예상 총 작업량: 원본 {N}줄 → {M}개 모듈

이 계획대로 진행할까요? 수정하고 싶은 부분이 있으면 알려주세요.
```

사용자 승인 후 Phase 4로 진행. 수정 요청이 있으면 계획을 조정한다.

### Phase 4: 모듈 분리 실행 (module-executor)

사용자가 승인한 계획에 따라 module-executor를 스폰한다:

```
Agent(
  description: "모듈 분리 실행",
  prompt: "에이전트 정의 `.claude/agents/module-executor.md`를 먼저 읽고 따르라.
    분석 결과: `_workspace/dependency_analysis.md`를 읽어 분리 계획과
    '심볼 해결 요구사항' 테이블을 파악하라.
    {사용자가 지정한 범위 또는 전체} 클러스터를 순서대로 분리하라.
    매 모듈 분리 후 다음 순서로 검증하라:
      1) 심볼 해결 사전 검증 (bare identifier → import/injection/상수 재배치)
      2) `npm run build` 빌드 검증
    미해결 identifier가 나오면 import/injection을 보강한 뒤 재검증하라.
    진행 로그와 심볼 해결 결과를 `_workspace/module_execution_log.md`에 기록하라.",
  model: "opus"
)
```

대규모 분리(5개+ 모듈)는 2~3개 모듈씩 끊어서 실행하고 중간 보고한다. 사용자가 "계속"이라고 하면 나머지 진행, "멈춰"라고 하면 현재까지 분리된 상태로 유지.

**심볼 해결 검증은 선택이 아니라 필수다.** 이 단계를 생략하면 `npm run build`는 통과하지만 runtime에서 `ReferenceError`가 터지는 사고가 재발한다. 과거 `makeDailyRecordId`/`DAY_ORDER` 사고(커밋 610192d, 174fc2e)가 모두 이 패턴이었다.

### Phase 5: 결과 보고

```markdown
## 모듈 분리 결과

| 모듈 | 줄 수 | 빌드 | 비고 |
|------|--------|------|------|
| daily-ops-homework.js | 2,450 | PASS | |
| daily-ops-test.js | 1,980 | PASS | |
| daily-ops.js (원본) | 5,200 | PASS | 공통 로직 + 초기화 |

- 원본: {N}줄 → 분리 후 원본: {M}줄 + 새 모듈 {K}개
- 전체 빌드: PASS/FAIL

## 다음 단계 (선택)
- 커밋하려면 말씀해주세요
- 추가 분리가 필요하면 "나머지 모듈 분리"
- 되돌리려면 "분리 되돌리기"
```

## 데이터 흐름

```
[사용자: 대상 파일]
    │
    └──→ Agent(dependency-analyzer)
            │  - 함수 의존관계 분석 + 클러스터링
            │  - 심볼 해결 요구사항 (per cluster): import/injection/상수 재배치
            ↓
         _workspace/dependency_analysis.md
            │
            ↓
         [오케스트레이터: 계획 제시 → 사용자 승인]
            │
            ↓
         Agent(module-executor) — 클러스터마다 루프:
            │  1. 모듈 추출 (import/injection/상수 재배치 적용)
            │  2. 심볼 해결 사전 검증 (bare identifier 재스캔, 미해결 시 2로 복귀)
            │  3. npm run build
            │  4. 로그 기록
            ↓
         분리된 파일들 + _workspace/module_execution_log.md
            │
            ↓
         [오케스트레이터: 결과 보고]
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| dependency-analyzer 실패 | 파일을 수동으로 읽어 간단한 구조 분석 후 진행 |
| 빌드 실패 (분리 중) | 마지막 분리를 되돌리고, 원인 분석 후 재시도. 2회 실패 시 해당 클러스터 건너뛰기 |
| 순환 의존 발견 | 공유 모듈(daily-ops-shared.js) 생성하여 순환 해소 |
| 분리 중 사용자 중단 | 현재까지 분리된 상태 유지 (빌드 검증 통과한 상태) |

## 테스트 시나리오

### 정상 흐름
1. "daily-ops.js 모듈 분리해줘"
2. Phase 1: daily-ops.js (11,527줄) 대상 확인
3. Phase 2: dependency-analyzer → 6개 클러스터 식별
4. Phase 3: 분리 계획 제시 → 사용자 승인
5. Phase 4: 4개 모듈 순차 분리, 매 단계 빌드 PASS
6. Phase 5: 원본 11,527줄 → 원본 4,200줄 + 4개 모듈

### 빌드 실패 흐름
1. Phase 4에서 3번째 모듈 분리 후 빌드 FAIL
2. 순환 의존 감지 → 공유 모듈 생성으로 해소
3. 재빌드 PASS → 나머지 분리 계속

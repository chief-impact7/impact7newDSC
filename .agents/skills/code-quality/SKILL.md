---
name: code-quality
description: "코드 품질 검사를 수행하는 오케스트레이터. 코드 리뷰, 리팩토링 분석, 보안 감사를 병렬로 실행하며, functions/ 변경이 포함된 경우 Cloud Functions 전문 리뷰까지 동시 수행하여 통합 보고서를 생성한다. '코드 품질', '코드 점검', '품질 검사', '전체 리뷰', '보안 점검', '리팩토링 분석', '코드 감사', 'Functions 리뷰' 요청 시 반드시 이 스킬을 사용. 배포 전 종합 점검은 pre-deploy 스킬을 사용할 것. 후속 작업: 결과 수정, 부분 재실행, 특정 에이전트만 다시, 이전 결과 개선, 품질 재점검 시에도 사용."
---

# Code Quality Orchestrator

클라이언트 JS는 3개 에이전트(리뷰어/리팩토러/보안 감사관), Cloud Functions는 1개 전문 에이전트가 병렬로 분석하여 코드 품질 통합 보고서를 생성한다.

## 실행 모드: 서브 에이전트 (팬아웃/팬인)

에이전트 간 통신이 불필요한 독립 분석이므로 서브 에이전트 모드를 사용한다.

## 에이전트 구성

| 에이전트 | 파일 | 담당 범위 | 출력 |
|---------|------|---------|------|
| code-reviewer | `.Codex/agents/code-reviewer.md` | 클라이언트 JS 버그, 로직 오류, 패턴 일관성 | `_workspace/01_review.md` |
| refactorer | `.Codex/agents/refactorer.md` | 클라이언트 중복 코드, 구조 개선, 미사용 코드 | `_workspace/02_refactor.md` |
| security-auditor | `.Codex/agents/security-auditor.md` | Firebase 보안, XSS, 인증 패턴 | `_workspace/03_security.md` |
| functions-reviewer | `.Codex/agents/functions-reviewer.md` | Cloud Functions 런타임·Transaction·트리거·emulator 테스트 | `_workspace/04_functions_review.md` |

**functions-reviewer는 조건부 실행**: 변경 범위에 `~/projects/impact7DB/functions/**/*.js` 파일이 포함될 때만 스폰. 나머지 3명은 항상 실행.

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/` 디렉토리 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1로 진행
   - **존재 + 사용자가 특정 에이전트만 재실행 요청** → 해당 에이전트만 재호출. 기존 산출물 중 해당 파일만 덮어쓴다
   - **존재 + 새 코드 변경 후 재점검** → 기존 `_workspace/`를 `_workspace_{timestamp}/`로 이동 후 Phase 1 진행

### Phase 1: 범위 결정

분석 범위를 결정한다. 사용자가 명시하지 않으면 자동 판단:

1. **git diff 확인**: 스테이지되지 않은 변경 + 최근 커밋(HEAD~3) 변경 파일 목록 수집
2. **범위 결정 기준**:
   - 변경 파일이 있으면 → 변경된 파일 + 직접 import하는 파일
   - 변경 파일이 없으면 → 전체 프로젝트 (소규모이므로 가능)
   - 사용자가 "전체", "전체 점검" → 전체 프로젝트
   - 사용자가 특정 파일/영역 지정 → 해당 범위만
3. `_workspace/00_scope.md`에 분석 범위 기록

### Phase 2: 팬아웃 (병렬 분석)

변경 범위에 따라 3~4개 에이전트를 병렬로 스폰한다. 각 에이전트의 프롬프트에 포함할 내용:
- 에이전트 정의 파일(`.Codex/agents/{name}.md`)을 먼저 읽으라는 지시
- 분석 대상 파일 목록 (`_workspace/00_scope.md` 참조)
- RULES.md를 읽어 프로젝트 컨텍스트를 파악하라는 지시
- 결과를 `_workspace/{번호}_{이름}.md`에 저장하라는 지시

**항상 실행 (클라이언트 JS):**
```
Agent(code-reviewer, model: opus, run_in_background: true)
Agent(refactorer, model: opus, run_in_background: true)
Agent(security-auditor, model: opus, run_in_background: true)
```

**조건부 실행 (functions/ 변경 포함 시):**
```
Agent(functions-reviewer, model: opus, run_in_background: true)
```

functions-reviewer는 클라이언트 3명과 스코프가 다르므로(Cloud Function 코드만) 중복 분석이 아니다. 변경 목록에 `functions/**/*.js`가 하나라도 있으면 반드시 스폰.

각 에이전트는 `general-purpose` 타입을 사용한다. 에이전트 정의 파일의 역할/원칙/출력 형식을 따르도록 프롬프트에 명시한다.

### Phase 3: 팬인 (결과 통합)

3개 에이전트 완료 후:

1. `_workspace/01_review.md`, `02_refactor.md`, `03_security.md`를 읽는다
2. 발견사항을 통합 심각도로 재분류:

| 통합 심각도 | 기준 |
|-----------|------|
| CRITICAL | 데이터 손실, 보안 취약점, 런타임 크래시 |
| HIGH | 잠재적 버그, 중요 리팩토링, 보안 강화 필요 |
| MEDIUM | 코드 품질 개선, 경미한 보안 사항 |
| LOW | 참고 사항, 선택적 개선 |

3. 중복 발견 병합: 여러 에이전트가 같은 파일:라인을 지적하면 하나로 통합하고 출처 병기
4. 통합 보고서를 사용자에게 출력

### Phase 4: 보고

통합 보고서 형식:

```markdown
# 코드 품질 보고서

**분석 범위**: {파일 목록 또는 "전체 프로젝트"}
**분석 일시**: {날짜}

## CRITICAL ({N}건)
1. [{출처: 리뷰/리팩토링/보안}] 파일:라인 — 설명 + 수정 제안

## HIGH ({N}건)
...

## MEDIUM ({N}건)
...

## LOW ({N}건)
...

## 통계
| 에이전트 | CRITICAL | HIGH | MEDIUM | LOW |
|---------|----------|------|--------|-----|
| 코드 리뷰 | N | N | N | N |
| 리팩토링 | N | N | N | N |
| 보안 감사 | N | N | N | N |

## 권장 조치 순서
1. CRITICAL 항목 즉시 수정
2. HIGH 항목 이번 커밋 전 수정
3. MEDIUM 이하는 별도 작업으로 분리
```

## 데이터 흐름

```
[오케스트레이터]
    │
    ├── git diff / 파일 목록 수집 + functions/ 변경 여부 체크
    │
    ├── _workspace/00_scope.md 생성 (scope 요약 + includes_functions 플래그)
    │
    ├──→ Agent(code-reviewer)      → _workspace/01_review.md
    ├──→ Agent(refactorer)         → _workspace/02_refactor.md
    ├──→ Agent(security-auditor)   → _workspace/03_security.md
    └──→ Agent(functions-reviewer) → _workspace/04_functions_review.md
         (functions/ 변경 있을 때만)
                │
                ↓
         [결과 통합] → 통합 보고서 출력
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 에이전트 1개 실패 | 나머지 2개 결과로 보고서 생성, 실패한 영역 명시 |
| 에이전트 전체 실패 | 사용자에게 알리고 수동 검토 제안 |
| git diff 실패 | 전체 프로젝트 범위로 폴백 |
| 분석 대상 파일 없음 | "변경사항 없음, 전체 점검을 원하면 '전체 점검'으로 재요청" 안내 |

## 테스트 시나리오

### 정상 흐름
1. 사용자가 "코드 품질 점검해줘" 요청
2. Phase 1에서 git diff로 변경 파일 5개 감지
3. Phase 2에서 3개 에이전트 병렬 실행 (각 ~2분)
4. Phase 3에서 발견사항 통합 → CRITICAL 1, HIGH 3, MEDIUM 5, LOW 2
5. Phase 4에서 통합 보고서 출력

### 부분 재실행
1. 사용자가 "보안 점검만 다시 해줘" 요청
2. Phase 0에서 _workspace/ 존재 확인 → 부분 재실행 모드
3. security-auditor만 재스폰
4. 기존 01_review.md, 02_refactor.md + 새 03_security.md로 통합 보고서 재생성

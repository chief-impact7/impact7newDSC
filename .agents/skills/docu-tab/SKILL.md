---
name: docu-tab
description: "학생 상세패널 '기록(docu)' 탭을 빌드·확장하는 오케스트레이터. 반성문/기타 기록(student_records)과 Firebase Storage 파일 첨부, 휴퇴원요청서 카드 이동을 docu-builder가 구현하고 attachment-auditor·code-reviewer·security-auditor가 검증하는 생성-검증 파이프라인. '기록 탭', 'docu 탭', '반성문 탭', '기타 기록', '첨부 파일 업로드', 'student_records', '파일 첨부 기능', '휴퇴원 카드 이동', 'Storage 업로드' 요청 시 반드시 이 스킬을 사용. 새 기록 유형/필드/섹션 추가에도 사용. 후속 작업: '검증만 다시', 'Storage 감사만', '기록 유형 추가', '구현 이어서', '이전 빌드 결과 기반 수정', '탭 확장' 시에도 사용. 단순 코드 리뷰만은 code-quality, 배포 전 종합 점검은 pre-deploy를 사용할 것."
---

# Docu Tab Orchestrator

기록 탭(반성문·기타·첨부파일)을 docu-builder가 구현하고, 첨부 보안·코드 품질을 전문 에이전트가 병렬 검증하는 생성-검증 파이프라인.

## 실행 모드: 하이브리드 (생성 → 팬아웃 검증)

- **구현 단계**: docu-builder 단독(서브 에이전트). 순차 의존이라 단일 소유자가 빌드·테스트를 책임진다
- **검증 단계**: 첨부/코드/보안 3개 에이전트 병렬(서브, 팬아웃/팬인). 독립 분석이라 통신 불필요

## 에이전트 구성

| 에이전트 | 파일 | 담당 | 출력 |
|---------|------|------|------|
| docu-builder | `.claude/agents/docu-builder.md` | student_records + Storage + 탭 UI 구현 | `_workspace/docu/10_build.md` |
| attachment-auditor | `.claude/agents/attachment-auditor.md` | storage.rules·업로드 코드·Firestore↔Storage 정합성 | `_workspace/docu/20_attachment.md` |
| code-reviewer | `.claude/agents/code-reviewer.md` | 클라이언트 JS 버그·패턴 일관성 | `_workspace/docu/21_review.md` |
| security-auditor | `.claude/agents/security-auditor.md` | firestore.rules(student_records)·XSS·인증 | `_workspace/docu/22_security.md` |

연동 스킬(직접 호출 대신 위임): 스키마 영향은 **schema-impact**, 배포 전 종합은 **pre-deploy**, firestore.rules 4프로젝트 동기화는 **firestore-rules-sync**.

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/docu/` 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 빌드. Phase 1로
   - **존재 + "검증만/특정 감사만" 요청** → 구현 건너뛰고 Phase 3(해당 에이전트만 재스폰), 기존 산출물 중 해당 파일만 덮어씀
   - **존재 + 새 기록 유형/필드 추가 요청** → 기존 `_workspace/docu/`를 `_workspace/docu_{timestamp}/`로 이동 후 Phase 1
3. 계획 문서(`docs/superpowers/plans/*-docu-tab.md` 또는 `~/projects/docu/docs/superpowers/plans/`) 존재 확인 — 있으면 Task 순서의 근거로 사용

### Phase 1: 범위 결정

1. 구현 범위 식별: 신규 기록 탭 전체인지, 기존 탭에 유형/필드/섹션 추가인지
2. git diff로 기존 docu 파일(`docu-*.js`) 존재·변경 여부 확인 → 신규 빌드 vs 확장 판별
3. `student_records` 스키마 변경이 포함되면 먼저 **schema-impact 스킬**로 영향 분석을 돌리고 결과를 범위에 반영
4. `_workspace/docu/00_scope.md`에 범위·계획 근거·스키마 영향 요약 기록

### Phase 2: 구현 (docu-builder 단독)

docu-builder를 `general-purpose` 타입 + `model: opus`로 스폰. 프롬프트에 포함:
- `.claude/agents/docu-builder.md`를 먼저 읽으라는 지시
- `RULES.md`와 `AGENTS.md`(페이지·entry 구조)를 읽으라는 지시
- `_workspace/docu/00_scope.md`의 범위
- 계획 문서가 있으면 그 Task 순서를 따르라는 지시
- 매 단계 `npx vite build`·`npm test`로 검증하고, 결과를 `_workspace/docu/10_build.md`에 기록하라는 지시
- 비가역 배포(`firebase deploy`)는 실행하지 말고 확인 요청으로 남기라는 지시

구현 실패(빌드 깨짐) 시 파이프라인 중단, 사용자에게 원인 보고.

### Phase 3: 검증 (팬아웃)

구현 완료(또는 검증-only 모드) 후 3개 에이전트를 병렬 스폰(`general-purpose`, `model: opus`, `run_in_background: true`). 각 프롬프트에 에이전트 정의 파일을 읽고 `_workspace/docu/`의 빌드 산출물·변경 파일을 분석해 지정 경로에 저장하라고 명시.

```
Agent(attachment-auditor) → _workspace/docu/20_attachment.md   # storage.rules, docu-data.js, firebase-config.js, firebase.json
Agent(code-reviewer)      → _workspace/docu/21_review.md        # docu-*.js, student-detail.js, index.html
Agent(security-auditor)   → _workspace/docu/22_security.md      # firestore.rules(student_records), XSS(esc 사용)
```

세 에이전트는 스코프가 다르다(Storage 계층 / 클라이언트 버그 / Firestore Rules·XSS) — 중복 분석이 아니다.

### Phase 4: 팬인 (통합 보고)

1. `10_build.md`, `20_attachment.md`, `21_review.md`, `22_security.md`를 읽는다
2. 발견을 통합 심각도로 재분류(CRITICAL/HIGH/MEDIUM/LOW), 중복은 출처 병기로 병합
3. 통합 보고서 출력:

```markdown
# 기록 탭 빌드·검증 보고서

**범위**: {신규 빌드 / 확장 — 대상}
**일시**: {날짜}

## 구현 결과 (docu-builder)
- 변경/생성 파일: ...
- 빌드: 성공/실패 · 테스트: N pass / N fail

## CRITICAL ({N}건)
1. [{출처: 첨부/리뷰/보안}] 파일:라인 — 설명 + 수정 제안
## HIGH / MEDIUM / LOW
...

## 통계
| 에이전트 | CRITICAL | HIGH | MEDIUM | LOW |
|---------|----------|------|--------|-----|
| 첨부 감사 | N | N | N | N |
| 코드 리뷰 | N | N | N | N |
| 보안 감사 | N | N | N | N |

## 권장 조치
1. CRITICAL 즉시 수정 → docu-builder 재호출
2. 배포 전 pre-deploy 스킬 실행
3. firestore.rules 변경 시 firestore-rules-sync로 4프로젝트 동기화
```

## 데이터 흐름

```
[오케스트레이터]
   ├── Phase 0: _workspace/docu/ 컨텍스트 확인 (초기/검증-only/확장)
   ├── Phase 1: 범위 결정 (+ student_records 변경 시 schema-impact 위임)
   │      └→ _workspace/docu/00_scope.md
   ├── Phase 2: Agent(docu-builder) → _workspace/docu/10_build.md
   │            (빌드·테스트 검증, 실패 시 중단)
   ├── Phase 3: ┌ Agent(attachment-auditor) → 20_attachment.md
   │            ├ Agent(code-reviewer)       → 21_review.md
   │            └ Agent(security-auditor)     → 22_security.md
   └── Phase 4: 통합 보고서 출력 → (조치) pre-deploy / firestore-rules-sync 연동
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 빌드 실패(Phase 2) | 파이프라인 중단, 원인(파일:라인) 보고, 검증 스폰 안 함 |
| 검증 에이전트 1개 실패 | 나머지 결과로 보고, 실패 영역 명시 |
| storage.rules 없음 | attachment-auditor가 CRITICAL 보고 → docu-builder가 인프라 먼저 활성화 |
| git diff 실패 | 전체 docu-*.js 범위로 폴백 |
| 변경 없음 | "구현할 범위 없음, 신규 빌드는 '기록 탭 만들어줘'로 요청" 안내 |

## 테스트 시나리오

### 정상 흐름 (초기 빌드)
1. "기록 탭 만들어줘" 요청
2. Phase 1: docu 파일 없음 → 신규 빌드, 계획 문서 발견
3. Phase 2: docu-builder가 순수로직→데이터→UI→통합→인프라 구현, 빌드·테스트 통과
4. Phase 3: 3개 에이전트 병렬 검증
5. Phase 4: 통합 보고 — CRITICAL 0, HIGH 1(고아 객체 롤백), MEDIUM 2

### 검증-only 재실행
1. "Storage 감사만 다시" 요청
2. Phase 0: `_workspace/docu/` 존재 → 검증-only
3. attachment-auditor만 재스폰 → 20_attachment.md 갱신 → 보고서 재생성

### 확장
1. "기록 탭에 '상담메모' 유형 추가" 요청
2. Phase 0: 기존 산출물 타임스탬프 백업
3. Phase 1: schema-impact로 student_records type 확장 영향 분석
4. Phase 2~4: docu-builder 확장 구현 → 검증 → 보고

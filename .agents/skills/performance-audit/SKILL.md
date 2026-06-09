---
name: performance-audit
description: "Firestore 읽기 비용·쿼리 패턴·onSnapshot 리스너·번들 크기를 정적 분석하는 성능 감사 하네스. 이 앱은 8개 컬렉션이 onSnapshot 실시간 리스너로 연결되며 과거 읽기 스파이크 이력이 있다. '성능 감사', 'Firestore 읽기 비용', 'onSnapshot 분석', '읽기 스파이크', '쿼리 비용', '번들 크기', 'performance audit', '읽기 패턴 분석', 'Firestore 비용 최적화', 'N+1 쿼리', 'unsubscribe 누락', '리스너 정리' 요청 시 반드시 이 스킬을 사용. 후속: '개선 우선순위', '번들만 확인', 'onSnapshot만 분석', '지난 감사 결과 다시', '특정 파일 성능 확인' 시에도 사용."
---

# Performance Audit

Firebase + Vite 웹앱의 Firestore 읽기 비용·쿼리 패턴·번들 크기를 정적 분석한다.
**BaaS 구조 특성**: dev 서버가 production Firestore를 직격하므로, 쿼리 비용 낭비는 즉시 실제 비용으로 이어진다.

## 실행 모드: 서브 에이전트

performance-auditor 에이전트가 정적 분석을 수행하고, 오케스트레이터가 결과를 종합한다.

## 에이전트 구성

| 에이전트 | 파일 | 역할 | 출력 |
|---------|------|------|------|
| performance-auditor | `.claude/agents/performance-auditor.md` | onSnapshot/쿼리/번들 정적 분석 | `_workspace/performance_audit.md` |

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/performance_audit.md` 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1부터
   - **존재 + "다시 감사"** → Phase 1 재실행 (덮어쓰기)
   - **존재 + "번들만 확인"** → Phase 2 빌드 후 번들 분석만
   - **존재 + "onSnapshot만"** → Phase 1 중 리스너 분석만
   - **존재 + "지난 감사 결과"** → 기존 파일 요약 출력

3. 사용자 요청 분류:
   - **전체 감사** → Phase 1 + Phase 2 (빌드 여부는 사용자 확인)
   - **부분 감사** → 요청된 영역만

### Phase 1: performance-auditor 에이전트 스폰

```
Agent(
  prompt: "정적 분석으로 onSnapshot 리스너 현황, 고비용 쿼리 패턴, N+1 의심, 번들 분석(dist/가 있으면)을
           감사하고 _workspace/performance_audit.md에 저장해.
           .claude/agents/performance-auditor.md의 지침을 따를 것.",
  subagent_type: "performance-auditor",
  model: "opus"
)
```

### Phase 2: 번들 크기 분석 (선택적)

`dist/` 디렉토리가 없거나 사용자가 "번들 확인"을 요청한 경우:

```bash
npm run build 2>&1 | tail -40
```

빌드 결과를 읽어 chunk별 크기를 `_workspace/performance_audit.md`에 추가한다.

> 빌드는 시간이 걸리므로 사용자에게 먼저 알린다: "npm run build를 실행할까요?"

### Phase 3: 결과 종합 보고

`_workspace/performance_audit.md`를 읽어:

1. **심각도별 요약** (CRITICAL → HIGH → MEDIUM → INFO 순)
2. **즉시 조치 권고** (CRITICAL 항목만 발췌하여 강조)
3. **다음 단계 제안**:
   - CRITICAL이 있으면: "code-quality 스킬로 수정 후 재감사 권장"
   - onSnapshot unsubscribe 누락: 해당 파일 위치 명시
   - 번들 최적화 가능: 동적 import 전환 가이드 제시

## 배경 컨텍스트 (에이전트에 전달)

- **onSnapshot 전환 이력**: 2026-03-24에 8개 컬렉션을 getDocs → onSnapshot 전환. 이전에도 읽기 스파이크로 롤백한 이력이 있음
- **현재 모니터링 중**: 스파이크 발생 시 leave_requests만 실시간 유지, 나머지는 30초~1분 폴링 전환 예정
- **대상 파일**:
  - Vanilla JS: `daily-ops.js`, `app.js`, `attendance.js`, `data-layer.js`, `student-detail.js` 등
  - React hooks: `src/dashboard/hooks/`

## 관련 스킬

- `code-quality` — 성능 문제 코드 수정 후 전체 리뷰
- `pre-deploy` — 최적화 후 배포 전 최종 점검

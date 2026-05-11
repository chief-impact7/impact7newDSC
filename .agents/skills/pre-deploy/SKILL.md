---
name: pre-deploy
description: "배포 전 종합 점검 파이프라인. 빌드 검증 → Cloud Functions 검증(변경 시) → Firestore rules 4프로젝트 동기화 확인 → 코드 품질 점검(code-quality 하네스 연동)을 순차 실행하여 안전한 배포를 보장한다. '푸시 전', '배포 전', '푸시해도 돼?', '배포 점검', '프리 디플로이', 'pre-deploy', '푸시 전 점검', '배포 전 검사' 요청 시 반드시 사용. 후속: '다시 점검', '빌드만 확인', 'rules만 확인', '품질만 다시', 'Functions만 확인' 시에도 사용."
---

# Pre-deploy Pipeline

push = GitHub Actions 자동 배포이므로, 푸시 전 이 파이프라인으로 안전을 확인한다. Cloud Functions는 별도 `firebase deploy --only functions` 이므로 functions/ 변경 감지 시 전용 검증 단계를 추가한다.

## 실행 모드: 단일 오케스트레이터 (파이프라인)

빌드/동기화는 bash 명령으로 직접 검증하고, 코드 품질은 기존 code-quality 하네스에 위임한다. Functions 검증은 functions-check 스킬에 위임한다. 새 에이전트를 추가하지 않고 기존 자원을 재사용하여 오버헤드를 최소화한다.

## 워크플로우

### Phase 0: 컨텍스트 확인

1. git status로 현재 상태 파악 (uncommitted changes, staged files)
2. functions/ 변경 여부 확인 — impact7DB/functions 경로가 diff에 포함되는지
3. 사용자 요청 분석:
   - "전체 점검" / "푸시해도 돼?" → 모든 Phase 실행 (Functions는 변경 감지 시만)
   - "빌드만" → Phase 1만
   - "Functions만" → Phase 2만 (functions-check 위임)
   - "rules만" → Phase 3만
   - "품질만" → Phase 4만 (code-quality 위임)
   - "다시 점검" → 이전 결과가 있으면 변경된 부분만 재점검

### Phase 1: 빌드 검증

1. `npm run build` 실행
2. 결과 판정:
   - 빌드 성공 + 경고 0개 → PASS
   - 빌드 성공 + 경고 있음 → WARN (경고 목록 표시)
   - 빌드 실패 → FAIL (에러 메시지 표시, **Phase 2-3 중단**)

빌드 실패 시 나머지 점검은 의미 없으므로 즉시 보고하고 중단한다.

### Phase 2: Cloud Functions 검증 (조건부)

**실행 조건:** `git diff`에 `impact7DB/functions/` 경로 변경이 포함된 경우.

functions-check 스킬을 위임 실행:
1. Phase 0~3 (lint + unit test + emulator integration test) 수행
2. Phase 4 (deploy dry-run)은 스킵 (pre-deploy는 push 전이지 Functions deploy 전이 아님, 별도 시점)

결과 판정:
- 모두 PASS → PASS
- 실패 건 → FAIL, 실패 목록 표시, **Phase 3-4는 계속 진행** (Functions 배포는 별도 수동이므로 클라이언트 배포를 막을 필요는 없으나 경고 표시)

Functions 변경 없으면 이 Phase는 스킵.

### Phase 3: Firestore Rules 동기화 확인

4개 프로젝트의 firestore.rules를 diff로 비교:

```bash
diff /Users/jongsooyi/projects/impact7DB/firestore.rules \
     /Users/jongsooyi/projects/impact7newDSC/firestore.rules
diff /Users/jongsooyi/projects/impact7newDSC/firestore.rules \
     /Users/jongsooyi/projects/impact7HR/firestore.rules
diff /Users/jongsooyi/projects/impact7newDSC/firestore.rules \
     /Users/jongsooyi/projects/impact7exam/firestore.rules
```

결과 판정:
- 모두 동일 → SYNC
- 불일치 → OUT OF SYNC (diff 표시 + "동기화하려면 `/firestore-rules-sync` 실행" 안내)

추가 확인: `students` 컬렉션의 `allow delete: if false` 규칙이 유지되는지 grep으로 검증한다.

### Phase 4: 코드 품질 점검

기존 code-quality 하네스 패턴을 실행한다:
1. git diff로 변경 파일 범위 결정
2. 3개 에이전트(code-reviewer, refactorer, security-auditor) 병렬 스폰 (model: opus, run_in_background: true)
3. 각 에이전트 정의 파일(`.claude/agents/{name}.md`)을 먼저 읽도록 지시
4. 결과 통합

Phase 4는 code-quality 오케스트레이터의 Phase 1~4를 그대로 따른다. 범위만 "변경된 파일"로 한정한다. functions/ 변경이 포함되면 code-quality 오케스트레이터가 자동으로 functions-reviewer까지 스폰한다.

### Phase 5: 종합 보고

```markdown
# 배포 전 점검 결과

| 항목 | 상태 | 비고 |
|------|------|------|
| 빌드 | PASS/WARN/FAIL | 경고 N건 / 에러 메시지 |
| Functions 검증 | PASS/FAIL/SKIP | 변경 없으면 SKIP |
| Rules 동기화 | SYNC/OUT OF SYNC | 불일치 프로젝트 |
| 코드 품질 | CRITICAL N / HIGH N / MEDIUM N / LOW N | 핵심 발견 |

## 배포 판정
- **배포 가능**: 빌드 PASS + Rules SYNC + CRITICAL 0
- **주의 필요**: 빌드 WARN 또는 CRITICAL 0이지만 HIGH 있음
- **배포 차단**: 빌드 FAIL 또는 Rules OUT OF SYNC 또는 CRITICAL 있음

## CRITICAL 항목 (있을 경우)
1. [출처] 파일:라인 — 설명 + 수정 제안
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 빌드 실패 | Phase 2-3 건너뛰고 빌드 에러만 보고 |
| rules 파일 미존재 (프로젝트 누락) | 해당 프로젝트 누락 명시, 나머지끼리 비교 |
| code-quality 에이전트 실패 | 성공한 에이전트 결과만으로 보고, 실패 영역 명시 |
| git diff 실패 | 전체 프로젝트 범위로 폴백 |

## 테스트 시나리오

### 정상 흐름
1. "푸시해도 돼?" 요청
2. Phase 1: 빌드 성공 (PASS)
3. Phase 2: rules 4프로젝트 동일 (SYNC)
4. Phase 3: code-quality 실행 → CRITICAL 0, HIGH 2
5. Phase 4: "주의 필요 — HIGH 2건 확인 후 배포 권장"

### 빌드 실패
1. "배포 전 점검" 요청
2. Phase 1: 빌드 실패 (FAIL) — import 경로 오류
3. Phase 2-3 스킵
4. "배포 차단 — 빌드 에러 수정 필요" + 에러 메시지 표시

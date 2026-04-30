---
name: functions-check
description: "Cloud Functions 배포 전 검증 런북. lint + vitest unit + Firestore emulator integration test를 순차 실행하여 Functions 코드의 건강성을 보장한다. 'Functions 점검', 'Function 테스트', '클라우드 함수 검증', 'functions-check', 'emulator 테스트', 'Function lint' 요청 시 반드시 이 스킬을 사용. pre-deploy 하네스가 자동으로 호출하기도 함. 후속: '테스트만 다시', 'lint만 재실행', 'emulator 부팅 후 재검증' 요청 시에도 사용."
---

# Functions Check Pipeline

`~/projects/impact7DB/functions/`의 Cloud Functions 코드를 배포 전에 검증하는 런북. 단일 파이프라인이며, 에이전트를 띄우지 않는 bash 위주 런북이다.

## 실행 모드: 단일 런북 (파이프라인)

에이전트 팀 필요 없음. Firebase CLI + vitest + 로컬 emulator를 명령 단위로 실행한다.

## 사전 조건

- `~/projects/impact7DB/functions/node_modules` 설치됨 (`npm install` 완료)
- `firebase-tools` CLI 설치 + `firebase login` 인증
- 포트 8080 사용 가능 (emulator 용)

## 워크플로우

### Phase 0: 컨텍스트 확인

1. 현재 git status 확인 — `functions/` 경로에 변경이 있는가?
   - 변경 없음 → "Functions 변경 없음, 스킵 가능" 보고 후 사용자에게 강제 실행 여부 묻기
   - 변경 있음 → Phase 1 진행
2. 사용자 요청 분석:
   - "전체 점검" / "Functions 검증" → 모든 Phase 실행
   - "lint만" → Phase 1만
   - "unit만" → Phase 2만
   - "emulator만" → Phase 3만

### Phase 1: Lint

```bash
cd ~/projects/impact7DB/functions && npm run lint
```

판정:
- exit 0 → PASS
- exit != 0 → FAIL, 출력 그대로 사용자에게 전달 후 중단

### Phase 2: Unit Test (vitest)

emulator 없이 실행 가능한 순수 함수 테스트.

```bash
cd ~/projects/impact7DB/functions && npm test -- --exclude 'test/*.integration.test.js'
```

판정:
- 모두 통과 → PASS
- 실패 건 있음 → 실패 테스트명·메시지 보고 후 중단

### Phase 3: Emulator Integration Test

emulator를 백그라운드로 띄우고 integration test 실행, 끝나면 정리.

1. emulator 부팅:

```bash
cd ~/projects/impact7DB && firebase emulators:start --only firestore --project=impact7db-test
```

(백그라운드 실행 — Bash 도구의 `run_in_background: true`)

2. 포트 대기:

```bash
until nc -z 127.0.0.1 8080 2>/dev/null; do sleep 2; done && echo "emulator ready"
```

3. integration test 실행:

```bash
cd ~/projects/impact7DB/functions && npm test -- test/*.integration.test.js
```

4. emulator 종료:

```bash
pkill -f "firebase.*emulators" 2>/dev/null; sleep 1; echo "emulator stopped"
```

판정:
- 통합 테스트 통과 → PASS
- emulator 부팅 실패 → 포트 충돌 가능성 경고 + 기존 emulator 프로세스 확인 안내
- 테스트 실패 → 실패 케이스 보고, emulator는 정리 후 중단

### Phase 4: (선택) Deploy Dry-Run

실제 배포가 임박한 경우만 실행. 기본은 스킵.

```bash
cd ~/projects/impact7DB && firebase deploy --only functions:leave-request --dry-run
```

판정:
- "Deploy would succeed" → PASS
- 실패 → 원인 보고

### Phase 5: 결과 종합

```markdown
## Functions Check 결과

| Phase | 결과 | 비고 |
|-------|------|------|
| 1. Lint | PASS/FAIL | — |
| 2. Unit Test | PASS (N tests) | — |
| 3. Emulator Integration | PASS (N tests) | — |
| 4. Deploy Dry-Run | 스킵/PASS | — |

**결론:** 배포 가능 / 수정 필요

**발견 이슈:**
- [구체적 실패 목록]
```

## 에러 핸들링

- **emulator 포트 충돌**: 사용자에게 `lsof -ti:8080` 확인 안내, 기존 프로세스 종료 후 재시도
- **emulator 부팅 지연**: 30초 대기 후에도 8080 포트 미응답 시 타임아웃 — Firebase CLI 업데이트 안내
- **npm install 누락**: `node_modules` 없으면 "먼저 `cd ~/projects/impact7DB/functions && npm install`" 안내
- **인증 만료**: `firebase login` 재실행 안내

## 후속 작업

사용자가 "테스트만 다시", "lint만 재실행" 등 부분 재실행을 요청하면 해당 Phase만 수행. 이전 실행 결과와 비교하여 새로 발생한 이슈만 강조 보고한다.

## 테스트 시나리오

### 정상 흐름
1. 사용자: "Function 점검"
2. Phase 0에서 functions/ 변경 확인
3. Phase 1~3 순차 실행 → 모두 PASS
4. Phase 5에서 "배포 가능" 결론

### 에러 흐름
1. 사용자: "Function 점검"
2. Phase 2에서 `finalize.js` 단위 테스트 1개 실패
3. 실패 케이스 보고 후 중단 (Phase 3 진입 안 함)
4. 사용자가 수정 후 "unit만" 재실행
5. Phase 2만 실행 → PASS
6. 사용자가 "emulator만" 요청 → Phase 3 단독 실행

# Claude Code - Project Configuration

> Claude Code 전용 설정. 공통 규칙은 `RULES.md` 참조.

## 필수 사전 읽기
- 작업 시작 전 반드시 `RULES.md`를 읽는다
- Firestore 스키마, SECTIONS 배열 구조를 숙지한 상태에서 작업한다

## impact7 검색·생성 우선순위 — shared-first

impact7 에코시스템 공통 로직의 SSoT는 `/Users/jongsooyi/projects/impact7-shared` (`@impact7/shared`)다.

- **검색·설명 시:** shared export map → 관련 shared 모듈 → 로컬 구현 순서로 확인하고, 둘이 다르면 drift로 보고한다.
- **새 코드·UI/UX 생성 시:** shared 모듈을 먼저 참고해 재사용하고, 같은 기능을 로컬에 재구현하지 않는다. 필요한 순수 함수가 shared에 없으면 shared에 추가하는 방안을 먼저 제안한다.
- 모듈 목록·공개 API 정본: `impact7-shared/AGENTS.md` "모듈 목록 및 공개 API" — history / enrollment-status / enrollment-derivation / class-move / promote-enroll / student-number / student-label / staff-label / datetime / ime-input / html-escape / phone / branch

## 작업 스타일
- 한국어로 응답한다
- 코드 변경 시 변경된 파일과 라인을 명시한다
- 큰 변경은 사전에 계획(plan)을 세운 뒤 사용자 승인 후 진행한다

## 페이지·entry 구조 (멀티페이지 — ⚠️ 중요)

DSC는 멀티페이지 앱이다. 각 `*.html`이 **독립 entry js**를 로드하므로, 전역 로직을 잘못된 파일에 넣으면 그 페이지에서 **실행조차 안 된다**.

| 페이지 | entry js |
|--------|----------|
| `index.html` (메인) | `app.js` + `naesin.js` |
| `excel.html` | `excel.js` |
| `dashboard.html` | `src/dashboard/main.jsx` |
| `class-setup.html` | `class-setup.js` |
| `checkin.html` | `checkin.js` |

- 전역 로직(로그인·헤더 버튼·권한·gear 등)은 메인 entry **`app.js`**에 둔다 (impact7DB와 동일하게 app.js=메인).
- 코드 추가 전 대상 페이지의 `<script type="module" src>`로 entry를 반드시 확인한다.
- **2026-06 교훈**: AI 자동화 gear가 구 entry였던 옛 `app.js`(당시 excel.html 전용)에 들어가 메인(daily-ops.js)에서 작동하지 않았다. 이후 daily-ops.js를 `app.js`로, 옛 app.js를 `excel.js`로 일원화해 해소. **구 entry 파일을 안 지우면 이후 작업이 계속 헛다리를 짚는다.**

### ⚠️ dashboard는 DSC/shared를 "읽기만" 한다 (drift 금지)
`dashboard.html`(`src/dashboard/`)은 메인 로그북 데이터를 **정리·표시**하는 화면이다. enrollment 분류·대표선택·내신/자유학기 active 판정 등을 **자체 재구현하지 말 것.** DSC 메인앱이 쓰는 함수(`@impact7/shared/*`, `student-helpers.js`, `student-core.js`)를 import해서 읽기만 한다.
- **2026-06-15 교훈**: `DailyLogBoard.jsx`가 `activeEnrollments`/`isFreeActive` 등을 자체 재구현 → shared `applyNaesinFreeDerivation`과 drift. 자유학기(별도코드)+정규 학생의 반코드가 enrollment 배열 순서에 따라 오표시(류하율 A101). shared는 자유/내신을 대표(맨 앞)로 정렬하는데 자체구현은 순서 보존이라 정규가 대표가 됨. → 자체 파생 제거하고 shared 재사용. 상세: `.memory/feedback_dashboard_reads_dsc_only.md`

## 파일 수정 우선순위
1. 기존 파일 수정 우선 (새 파일 생성 최소화)
2. `app.js`가 너무 커지면 모듈 분리 가능 (예: `render.js`, `firestore.js`)
3. 분리 시 `index.html`의 `<script>` 태그는 수정 불필요 (Vite가 import 추적)

## Gemini Antigravity와 협업 시
- 같은 파일 동시 수정 금지
- 작업 전 수정할 파일 목록을 사용자에게 알린다
- Gemini가 작업 중인 파일이 있다면, 사용자에게 확인 후 작업한다
- 변경사항 요약을 항상 남겨서 Gemini가 컨텍스트를 파악할 수 있게 한다

## 공유 Firebase 규칙 (중요!)
- 이 프로젝트는 **impact7DB, impact7HR, impact7exam과 동일한 Firebase 프로젝트(impact7db)를 공유**
- `firestore.rules`는 4개 프로젝트가 **동일한 파일**을 사용한다
- rules 수정 시 반드시 4개 프로젝트(impact7DB, impact7newDSC, impact7HR, impact7exam) 모두에 복사
- rules 동기화는 `/firestore-rules-sync` 스킬로 실행
- 배포는 impact7DB에서만 하는 것을 권장
- `students` 컬렉션: 클라이언트 삭제 완전 차단 (`allow delete: if false`)
- HR 앱의 사용자 컬렉션은 `director_users` (DB의 `users`와 분리)

## 코드 품질 관리
- 소스 코드(`.js`·`.ts`·`.tsx`·`.py`·`.svelte` 등) 추가·수정·삭제가 포함된 커밋은 commit 전에 `/simplify` → `/code-review`를 순차 실행하고 결과를 반영한다.
- 제외: 문서(`*.md`)·lock 파일·JSON 데이터·단순 설정만 바뀐 커밋.
- skip: 사용자가 "이번엔 commit만"·"급해" 등으로 명시한 경우만 허용한다.
- 로컬 git hook은 staged source/security diff가 품질 확인 마커 없이 커밋되는 것을 차단한다. simplify/review/fix 후 해당 repo 루트에서 `node /Users/jongsooyi/projects/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs --mark`로 현재 staged diff를 표시한다.
- 푸시하면 Actions로 자동 배포되므로, 푸시 전 점검이 마지막 안전장치다

## Git 관련
- 커밋은 사용자 요청 시에만 수행
- 커밋 메시지: 한국어 또는 영어, 간결하게
- `.env` 파일 절대 커밋하지 않음

## 자주 쓰는 명령
```bash
npm run dev          # 개발 서버 (port 5174)
npm run build        # 빌드
bash scripts/install-hooks.sh   # 새 클론 후 1회 — pre-push hook 설치
node scripts/check-class-settings-fields.mjs  # class_settings 필드 동기화 수동 검증
```

## 안전망: class_settings 필드 동기화

`saveClassSettings()`로 새 필드를 저장할 때 **반드시** 두 곳을 함께 수정한다:
1. `firestore.rules` → `hasOnlyAllowedClassSettingsFields()` 허용 목록에 필드 추가
2. 동적 키(`[varName]` 패턴)라면 `scripts/check-class-settings-fields.mjs`의 `KNOWN_DYNAMIC_FIELDS`에도 추가

pre-push hook이 이 규칙을 자동 강제한다 (누락 시 push 차단).
hook이 없다면 `bash scripts/install-hooks.sh`로 설치한다.

## Dev 안전장치 (production DB 격리)

이 프로젝트는 BaaS 구조라 dev 서버가 production Firestore를 직격한다. 일선 혼란을 막기 위해 두 가지 모드를 제공한다 (`.env.development.local`로 전환).

### 모드 1: READ-ONLY (기본 권장)
- `.env.development.local`에 `VITE_READ_ONLY=true` 추가 + `npm run dev` 재시작
- audit.js의 모든 write wrapper를 console.log로 stub. read는 정상.
- 화면 상단 노란 배너 자동 표시.
- 용도: 화면 둘러보기, UI 검증, 회귀 확인.

### 모드 2: Firebase Emulator (완전 격리, write 검증 가능)
- 사전: Java 필요 (`brew install --cask temurin`)
- `.env.development.local`에 `VITE_USE_EMULATOR=true` (READ_ONLY 대신)
- 두 터미널 필요:
  ```bash
  # 터미널 1: emulator
  firebase emulators:start --import=./emulator-data --export-on-exit --only firestore,auth --project=impact7db

  # 터미널 2: dev 서버
  npm run dev
  ```
- emulator UI: http://localhost:4000
- emulator-data/는 .gitignored (PII 포함). 시드 스크립트: `node scripts/seed-emulator.mjs` (production READ → emulator 재구성)
- 용도: write까지 포함한 풀 라운드트립 검증, save → reload → 캐시 무효화 같은 시나리오.

### 둘 다 끄면
- production DB 직격. 일선에 영향. 가급적 사용 금지.

## 하네스: 코드 품질

**목표:** 코드 리뷰, 리팩토링 분석, 보안 감사를 병렬 실행하며, functions/ 변경 시 Cloud Functions 전문 리뷰까지 포함하여 통합 품질 보고서를 생성

**트리거:** 코드 품질/점검/감사/리뷰/보안 점검/Functions 리뷰 요청 시 `code-quality` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-11 | 초기 구성 | 전체 | - |
| 2026-04-22 | functions-reviewer 에이전트 추가 | agents/functions-reviewer.md, skills/code-quality/SKILL.md | Cloud Functions 도입으로 Node 런타임·Transaction·v2 트리거 특화 리뷰가 필요해짐. functions/ 변경 포함 시 병렬 스폰하여 클라이언트 리뷰와 독립 보고 |

## 하네스: 배포 전 점검

**목표:** push = 자동 배포이므로, 빌드 검증 + Functions 검증(변경 시) + Rules 동기화 + 코드 품질을 한 번에 점검하여 안전한 배포를 보장

**트리거:** 푸시 전/배포 전/푸시해도 돼?/배포 점검 요청 시 `pre-deploy` 스킬을 사용하라. code-quality 및 functions-check 하네스를 내부적으로 연동한다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | - |
| 2026-04-22 | Functions 검증 Phase 추가 | skills/pre-deploy/SKILL.md | Cloud Functions 도입으로 functions/ 변경 감지 시 lint + vitest unit + emulator integration test가 자동 수행되어야 함 (functions-check 스킬 위임) |

## 하네스: Functions 검증

**목표:** Cloud Functions(`impact7DB/functions/`)의 lint + unit + emulator integration test를 순차 실행하여 배포 가능성 판정

**트리거:** Functions 점검/Function 테스트/emulator 테스트/Function lint 요청 시 `functions-check` 스킬을 사용하라. `pre-deploy` 하네스가 자동 연동.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-22 | 초기 구성 | skills/functions-check/SKILL.md | 재등원·복귀 Cloud Function(`onLeaveRequestApproved`) 도입으로 배포 전 Functions 전용 검증이 별도 필요해짐 |

## 하네스: 스키마 영향 분석

**목표:** Firestore 컬렉션/필드 변경 시 영향받는 모든 코드를 추적하여 빠짐없는 수정 가이드 생성

**트리거:** 필드 추가/스키마 변경/컬렉션 수정/영향 분석/어디어디 고쳐야 요청 시 `schema-impact` 스킬을 사용하라. 구체적 Firestore 경로(enrollments, status 등) 변경 시에도 사용.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | - |

## 하네스: 모듈 분리

**목표:** 대규모 JS 파일(daily-ops.js 등)을 비즈니스 기능 단위로 안전하게 분리

**트리거:** 모듈 분리/파일 쪼개기/파일 분할/daily-ops 분리/파일이 너무 크다 요청 시 `module-splitter` 스킬을 사용하라.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | - |
| 2026-04-14 | 심볼 해결 검증 단계 추가 | dependency-analyzer.md, module-executor.md, module-splitter/SKILL.md | daily-ops.js 분리(3c70765) 후 bare identifier 누락으로 3연속 회귀(makeDailyRecordId/auditSet 누락 610192d, DAY_ORDER 고아화 174fc2e). build는 통과하고 runtime ReferenceError로만 드러나는 버그 클래스를 분리 전/중 단계에서 static하게 잡도록 강화 |

## 하네스: Firestore 데이터 복구

**목표:** 프로덕션 Firestore의 단일 문서 수동 조사·복구를 안전하게 수행 (check → dry-run → execute, batch atomic + history_logs)

**트리거:** 특정 학생 데이터 복구/Firestore 수동 수정/one-off 스크립트/scripts/oneoff 요청 시 `firestore-data-fix` 스킬을 사용하라. 대량 마이그레이션은 범위 밖.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-22 | 초기 구성 | skills/firestore-data-fix/SKILL.md | 유시우 복구(check-yoosiwoo.mjs + restore-yoosiwoo.mjs) 패턴을 체계화. 1인 개발자가 프로덕션 데이터를 수정할 때 실수 없이 진행하도록 dry-run + history_logs + batch atomic 규율을 스킬로 명문화 |

## 하네스: Firestore Rules 동기화

**목표:** firestore.rules를 4개 프로젝트(impact7DB·impact7newDSC·impact7HR·impact7exam)에 동기화. diff 확인 → 기준 파일 결정 → 사용자 승인 → 복사 → 검증 순으로 실행

**트리거:** rules 동기화/firestore.rules 수정/4개 프로젝트 동기화/rules 맞춰줘/배포 전 rules 확인 요청 시 `firestore-rules-sync` 스킬을 사용하라. `pre-deploy` 하네스도 자동으로 호출한다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-09 | 포인터 등록 + description pushy화 | skills/firestore-rules-sync/SKILL.md | AGENTS.md 포인터 누락(drift) 수정. description에 트리거·후속 키워드 추가 |

## 하네스: Enrollment 정합성 감사

**목표:** 학생 enrollments[] 배열의 class_type×코드 정합성을 두 가지 축으로 검증. (1) 4개 필수 가드 위치 정적 감사, (2) 실제 Firestore 데이터 위반 탐지 스크립트 생성

**트리거:** enrollment 검증/enrollment 정합성/등록 데이터 확인/수강 데이터 검증/class_type 오류/enrollment 감사/263건 같은 사고 방지/enrollment 일괄 점검/가드 코드 확인 요청 시 `enrollment-integrity` 스킬을 사용하라.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-09 | 초기 구성 | agents/enrollment-validator.md, skills/enrollment-integrity/SKILL.md | 2026-05 263건 사고(CSV class_type 누락으로 잘못된 enrollment 대량 생성) 재발 방지. 정적 가드 감사 + 데이터 감사 스크립트 생성을 에이전트화 |

## 하네스: 성능·Firestore 비용 감사

**목표:** onSnapshot 리스너 현황, 고비용 쿼리 패턴(N+1·전체 스캔), unsubscribe 누락, 번들 크기를 정적 분석하여 Firestore 읽기 비용 위험 요소를 발굴

**트리거:** 성능 감사/Firestore 읽기 비용/onSnapshot 분석/읽기 스파이크/쿼리 비용/번들 크기/performance audit/읽기 패턴 분석/Firestore 비용 최적화/N+1 쿼리/unsubscribe 누락 요청 시 `performance-audit` 스킬을 사용하라.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-09 | 초기 구성 | agents/performance-auditor.md, skills/performance-audit/SKILL.md | 8개 컬렉션 onSnapshot 전환(2026-03-24) 후 읽기 스파이크 모니터링 중. 비용 위험 요소를 사전에 정적 분석하는 하네스 필요 |

## 크로스앱 조율

크로스앱·공유 컬렉션 변경은 impact7DB의 `impact7-orchestrator` 하네스에서 조율한다.
→ 크로스앱 작업은 impact7DB에서 시작 권장.

## codegraph 탐색 원칙

코드를 탐색할 때 Read·grep 전에 **`codegraph_explore`를 먼저** 실행한다.
`.memory/reference_codegraph_guide.md`에 도메인별 핵심 쿼리가 정리되어 있다.

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정을 번갈아 사용하지만 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장한다.
계정별 `~/.claude-*/projects/*/memory/`에 저장하지 말 것.

- 새 대화 시작 시: `.memory/MEMORY.md` 먼저 읽을 것
- 메모리 저장 시: `.memory/`에 파일 생성하고 `.memory/MEMORY.md` 인덱스 업데이트


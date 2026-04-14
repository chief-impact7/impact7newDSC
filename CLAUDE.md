# Claude Code - Project Configuration

> Claude Code 전용 설정. 공통 규칙은 `RULES.md` 참조.

## 필수 사전 읽기
- 작업 시작 전 반드시 `RULES.md`를 읽는다
- Firestore 스키마, SECTIONS 배열 구조를 숙지한 상태에서 작업한다

## 작업 스타일
- 한국어로 응답한다
- 코드 변경 시 변경된 파일과 라인을 명시한다
- 큰 변경은 사전에 계획(plan)을 세운 뒤 사용자 승인 후 진행한다

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
- 빌드 완성 후 커밋 전에 `/simplify`를 실행하여 코드를 정리한다
- 큰 변경(여러 파일, 인증/보안 관련) 시 푸시 전에 `/code-review` 실행을 권장한다
- 푸시하면 Actions로 자동 배포되므로, 푸시 전 점검이 마지막 안전장치다

## Git 관련
- 커밋은 사용자 요청 시에만 수행
- 커밋 메시지: 한국어 또는 영어, 간결하게
- `.env` 파일 절대 커밋하지 않음

## 자주 쓰는 명령
```bash
npm run dev          # 개발 서버 (port 5174)
npm run build        # 빌드
```

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

**목표:** 코드 리뷰, 리팩토링 분석, 보안 감사를 병렬 실행하여 통합 품질 보고서를 생성

**트리거:** 코드 품질/점검/감사/리뷰/보안 점검 요청 시 `code-quality` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-11 | 초기 구성 | 전체 | - |

## 하네스: 배포 전 점검

**목표:** push = 자동 배포이므로, 빌드 검증 + Rules 동기화 + 코드 품질을 한 번에 점검하여 안전한 배포를 보장

**트리거:** 푸시 전/배포 전/푸시해도 돼?/배포 점검 요청 시 `pre-deploy` 스킬을 사용하라. code-quality 하네스를 내부적으로 연동한다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | - |

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

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정을 번갈아 사용하지만 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장한다.
계정별 `~/.claude-*/projects/*/memory/`에 저장하지 말 것.

- 새 대화 시작 시: `.memory/MEMORY.md` 먼저 읽을 것
- 메모리 저장 시: `.memory/`에 파일 생성하고 `.memory/MEMORY.md` 인덱스 업데이트


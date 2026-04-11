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

## 하네스: 코드 품질

**목표:** 코드 리뷰, 리팩토링 분석, 보안 감사를 병렬 실행하여 통합 품질 보고서를 생성

**트리거:** 코드 품질/점검/감사/리뷰/보안 점검/푸시 전 검사 요청 시 `code-quality` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-11 | 초기 구성 | 전체 | - |

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정을 번갈아 사용하지만 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장한다.
계정별 `~/.claude-*/projects/*/memory/`에 저장하지 말 것.

- 새 대화 시작 시: `.memory/MEMORY.md` 먼저 읽을 것
- 메모리 저장 시: `.memory/`에 파일 생성하고 `.memory/MEMORY.md` 인덱스 업데이트


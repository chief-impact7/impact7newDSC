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

## Git 관련
- 커밋은 사용자 요청 시에만 수행
- 커밋 메시지: 한국어 또는 영어, 간결하게
- `.env` 파일 절대 커밋하지 않음

## 자주 쓰는 명령
```bash
npm run dev          # 개발 서버 (port 5174)
npm run build        # 빌드
```

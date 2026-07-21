# Orca 워크트리에는 .env가 없다 (blank 화면·vitest auth 실패 원인)

- `.env`(Firebase 키)는 gitignored라 Orca/git 워크트리에 복제되지 않는다.
- 증상 1: `npm run dev` 후 페이지가 **콘솔 에러 없이** 빈 화면 — apiKey undefined로 Firebase 초기화 실패, 모듈 그래프가 조용히 죽음. vite overlay도 안 뜬다.
- 증상 2: `npm run test:vitest`에서 `auth/invalid-api-key`로 bulk-select·enrollment-active 등 suite 실패 (베이스라인부터 실패 — 코드 문제 아님).
- 해결: 본 클론에서 복사 — `cp /Users/jongsooyi/IMPACT7/impact7newDSC/.env .env`
- READ-ONLY dev 검증 시 `.env.development.local`에 `VITE_READ_ONLY=true`도 함께 필요.
- 관련: AGENTS.md의 quality-guard 경로 `/Users/jongsooyi/projects/impact7DB/...`는 stale — 실제는 `/Users/jongsooyi/IMPACT7/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs`

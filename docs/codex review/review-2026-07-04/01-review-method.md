# Review Method

## 리뷰 축

- 정합성: shared SSoT, Firestore rules, entrypoint, 데이터 파생이 같은 의미를 유지하는가
- 안정성: race, stale response, 부분 실패, 동시 실행이 운영 화면을 깨지 않는가
- 신뢰성: 실패가 사용자와 호출자에게 전달되고 재시도/rollback이 가능한가
- 신속성: 초기 로드, 쿼리 수, 청크 크기, 대량 작업이 일선 속도를 해치지 않는가
- 보안: 인증/권한/rules/Storage/OAuth/의존성 경계가 실제 데이터 민감도와 맞는가
- 운영성: push=배포 구조에서 검증 게이트와 blast radius 제한이 충분한가

## 확인한 범위

- 필수 규칙: `RULES.md`, `AGENTS.md`, `.memory/MEMORY.md`, `.memory/reference_codegraph_guide.md`
- entrypoint: `vite.config.js`, `index.html`, `dashboard.html`, `messages.html`, `class-setup.html`, `excel.html`, `checkin.html`
- rules: `firestore.rules`, `storage.rules`
- 저장/감사: `data-layer.js`, `save-scheduler.js`, `audit.js`, `docu-data.js`, `docu-card.js`
- 메시지: `src/messages/*`, `src/dashboard/components/MessageDeliverySummary.jsx`, callable wrapper in `data-layer.js`
- 대시보드: `src/dashboard/hooks/useFirestore.js`, `src/shared/firestore-helpers.js`, dashboard lazy/chart import
- 배포/검증: `.github/workflows/deploy.yml`, `package.json`, build output, npm audit

## 이전 리뷰 대비 재점검

2026-06-20 리뷰의 주요 P0/P1 중 다음은 현재 코드에서 개선 확인:

- 날짜 지연 저장: `createDebouncedWriter()`가 예약 시점 `targetDate`를 캡처하고 `flushPendingDailyWrites()`가 존재함.
- branch drift: `student-core.js`가 `@impact7/shared/branch`를 재export하고 회귀 테스트가 있음.
- `saveImmediately`: 실패 시 throw함.
- 기록 첨부 부분 실패: 신규 업로드 파일 보상 삭제와 문서 선삭제 후 파일 삭제 구조가 있음.
- `auditDelete`: snapshot log와 delete를 batch로 묶음.
- `종강`: Firestore rules 허용 상태에 포함됨.
- 대시보드 main data: request id guard가 있음.

## 한계

- Cloud Functions 구현체는 이 repo에 없으므로 메시지 발송 callable의 서버 권한·쿼터·멱등성은 코드로 직접 검증하지 못했다.
- Firestore/Storage emulator rules 테스트는 이번 턴에서 새로 작성하지 않았고, 정적 rules 읽기와 기존 스크립트 검증에 근거했다.
- 실제 운영 계정으로 브라우저에서 대량 발송/대시보드 조작을 수행하지 않았다.


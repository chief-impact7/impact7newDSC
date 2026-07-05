# Remediation Plan

## P0

### 1. HR Storage 역할 제한

대상:

- `storage.rules`
- 4개 repo rules sync: impact7DB, impact7newDSC, impact7HR, impact7exam
- rules emulator tests가 있는 기준 repo

완료 조건:

- 일반 impact7 직원은 HR `contracts`, `expenses`, `signatures` read/write 거부.
- director/owner 또는 명시 허용 staff만 필요한 경로 접근 가능.
- Storage emulator test로 통과 증명.
- rules 동기화 후 기준 repo에서 배포.

## P1

### 2. 메시지 발송 blast radius 제한

대상:

- `src/messages/components/BulkSendCard.jsx`
- `src/messages/components/DirectSmsCard.jsx`
- `src/messages/message-import.js`
- 서버 callable 구현 repo

완료 조건:

- client/server 모두 recipient hard cap 보유.
- 파일 import는 byte cap + phone count cap + 오류 메시지 제공.
- 일정 건수 이상 발송은 확인 modal 필수.
- 예약 발송은 과거 시각/비정상 시각 차단.
- 홍보성/정보성 규제 문구를 서버 검증과 client 미리보기에서 같은 기준으로 유지.

### 3. 메시지 dashboard race와 일괄 재처리 동시성 제한

대상:

- `src/dashboard/hooks/useFirestore.js`
- `src/dashboard/components/MessageDeliverySummary.jsx`

완료 조건:

- `useMessageDelivery()`에 request id guard 추가.
- bulk retry/archive/delete는 concurrency limit 적용.
- 선택 일부 실패 시 항목별 결과가 남고 실패 항목만 재시도 가능.
- 빠른 기간 전환 회귀 테스트 추가.

### 4. GitHub Actions 검증 gate 추가

대상:

- `.github/workflows/deploy.yml`

완료 조건:

- dispatch 전 `npm ci`, `npm test`, `npm run build`, shared lock check, class settings field check 실행.
- 검증 실패 시 통합 호스팅 dispatch 미실행.

### 5. 취약 의존성 처리

대상:

- `package.json`
- `package-lock.json`
- `src/messages/message-import.js`
- xlsx 사용 경로

완료 조건:

- protobuf 계열 audit fix 적용 후 test/build 통과.
- `xlsx` 유지/교체 결정 기록.
- 교체 전 완화책으로 count cap, lazy import, parsing timeout 또는 worker 격리 적용.

## P2

### 6. Drive scope incremental auth 전환

완료 조건:

- 기본 로그인에서 Drive scope 제거.
- Sheets export 실행 시점에만 GIS token 요청.
- token 저장 범위 최소화.

### 7. bundle/read 비용 개선

완료 조건:

- 메시지 파일 import 전까지 `xlsx` chunk 미로드.
- dashboard 일별 첫 화면에서 chart chunk 미로드 재확인.
- `class_settings` 전체 read를 cache 또는 필요한 문서 read로 축소.

### 8. App Check enforcement runbook

완료 조건:

- enforcement 전환 체크리스트 문서화.
- enforced release에서는 boot-time App Check init과 첫 요청 토큰 보장 테스트 추가.


# Validation Evidence

## 실행 명령

```bash
npm test
npm run build
npm audit --omit=dev
node scripts/check-shared-lock-sync.mjs
node scripts/check-class-settings-fields.mjs
git diff --check
```

## 결과

| 명령 | 결과 | 핵심 출력 |
|---|---|---|
| `npm test` | PASS | node:test 81건, Vitest 33건 통과 |
| `npm run build` | PASS with warning | Vite build 성공, 500kB 초과 청크 경고 |
| `npm audit --omit=dev` | FAIL | 3 vulnerabilities: moderate 1, high 1, critical 1 |
| `node scripts/check-shared-lock-sync.mjs` | PASS | `@impact7/shared` spec/lock v1.40.0 일치 |
| `node scripts/check-class-settings-fields.mjs` | PASS | JS 14개 필드가 rules 20개 허용 목록 내 |
| `git diff --check` | PASS | whitespace error 없음 |

## 빌드 크기 신호

Vite 경고 대상:

- `auth-DlOXRvpu.js`: 672.05kB, gzip 200.87kB
- `echarts-Dodi1FcX.js`: 588.52kB, gzip 200.55kB
- `xlsx-BojT3SgY.js`: 424.38kB, gzip 140.41kB
- `main-C6lxC_WW.js`: 413.45kB, gzip 105.41kB

## npm audit 신호

`npm audit --omit=dev`:

- `protobufjs <=7.6.2`: critical
- `@protobufjs/utf8 <=1.1.0`: moderate
- `xlsx *`: high, no fix available

## 개선 확인된 6월 리뷰 항목

- `save-scheduler.test.js`: 날짜 전환 전 예약 컨텍스트 보존과 `flushAll()` 회귀 테스트 통과.
- `student-core.test.js`: `10단지...` 접두 branch 판정 테스트 통과.
- `data-layer.js`: `saveImmediately()`가 실패를 throw.
- `audit.js`: `auditDelete()`가 batch commit으로 삭제와 로그 기록을 원자화.
- `docu-data.js`/`docu-card.js`: 업로드 후 문서 실패 보상 삭제와 문서 선삭제 후 파일 삭제 구조 확인.
- `src/dashboard/hooks/useFirestore.js`: main dashboard data와 consultation fetch에는 request id guard 확인.

## 검증 한계

- Cloud Functions 서버 구현은 이 repo 밖에 있어 메시지 callable의 서버-side cap/rate-limit/권한 검증은 확인하지 못했다.
- rules emulator 테스트를 새로 실행하지 않았다.
- 실제 운영 브라우저로 대량 발송, Drive export, App Check token 흐름을 수행하지 않았다.


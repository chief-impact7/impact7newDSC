# Findings

## 요약

| ID | 등급 | 축 | 내용 |
|---|---|---|---|
| F-01 | P0 | 보안 | HR Storage 민감 경로가 HR 역할이 아니라 impact7 도메인 인증만 요구 |
| F-02 | P1 | 운영성·신뢰성 | 메시지 대량/직접 발송에 client-side hard cap·최종 확인·예약 검증이 약함 |
| F-03 | P1 | 안정성 | 메시지 발송 현황 reload에 stale response guard가 없음 |
| F-04 | P1 | 안정성·신속성 | 실패 메시지 일괄 재처리가 무제한 병렬 callable로 실행됨 |
| F-05 | P1 | 배포 신뢰성 | `master` push workflow가 build/test 없이 통합 호스팅 dispatch |
| F-06 | P1 | 보안 | `npm audit --omit=dev`가 critical/high 취약 의존성을 보고 |
| F-07 | P2 | 보안·편의성 | 모든 로그인에 Drive scope를 요청하고 OAuth token을 sessionStorage에 저장 |
| F-08 | P2 | 성능 | build가 500kB 초과 청크 3개 이상을 경고 |
| F-09 | P2 | 비용·신속성 | daily dashboard가 열릴 때마다 `class_settings` 전체를 읽음 |
| F-10 | P2 | 운영 안전 | App Check가 첫 read 이후 초기화되어 enforcement 전환 절차가 취약 |

---

## F-01. HR Storage 민감 경로 권한이 너무 넓음

**근거**

- `storage.rules:22-38`: `staff`, `contracts`, `expenses`, `signatures` read/write가 모두 `isAuthorized()`만 요구한다.
- `storage.rules:5-10`: `isAuthorized()`는 이메일 검증 + `@gw.impact7.kr`/`@impact7.kr` 도메인만 확인한다.
- `firestore.rules:991-1036`: HR 계약/서류/급여/비용 Firestore 문서는 `isDirector()` 또는 staff owner 조건을 두는데, Storage는 같은 역할 경계를 적용하지 않는다.

**영향**

Firestore 문서 접근은 막혀도 Storage object path를 아는 내부 직원 계정이면 계약서, 비용, 서명 파일을 읽거나 덮어쓸 수 있는 rules 구조다. 같은 Firebase 프로젝트를 4개 앱이 공유하므로 DSC rules 수정이 HR/exam 데이터까지 영향을 준다.

**수정 방향**

- Storage rules에 HR 역할 조회 helper를 두고 `contracts`, `expenses`, `signatures`는 최소 `isDirector()`급으로 제한한다.
- 직원 본인 파일이 필요하면 `{staffId}` 경로와 `request.auth.uid == staffId` 조건으로 분리한다.
- Storage emulator 테스트: 외부 도메인, 일반 impact7 직원, HR staff, director를 나눠 read/write를 검증한다.

## F-02. 메시지 대량/직접 발송 blast radius 제한 부족

**근거**

- `src/messages/components/BulkSendCard.jsx:102-115`: 선택된 모든 학생 ID와 수신 필드를 즉시 callable로 보낸다.
- `src/messages/components/BulkSendCard.jsx:244-245`: 버튼 문구는 건수 표시뿐이며 별도 최종 확인이 없다.
- `src/messages/components/DirectSmsCard.jsx:51-60`: 임의 번호 목록 전체를 `sendDirectMessage()`에 전달한다.
- `src/messages/message-import.js:15-22`: 파일 크기 5MB 제한은 있으나 번호 개수 상한은 없다.

**영향**

필터를 잘못 담거나 파일에 과도한 번호가 들어가면 비용 발생·오발송·규제 리스크가 한 번에 커진다. 서버 callable이 최종 검증을 한다는 주석은 있으나, 이 repo에서는 서버 hard cap을 검증할 수 없다.

**수정 방향**

- client와 server 양쪽에 `maxRecipients`, `maxRecipientFields`, `maxMessageBytes`, 예약 가능 시간 범위를 명시한다.
- 일정 건수 이상은 확인 modal에 대상 수, 수신 필드, 정보성/홍보성, 예약 시각, 예상 채널을 보여준다.
- 직접 번호 업로드는 파일 크기뿐 아니라 추출 번호 개수 상한을 둔다.

## F-03. 메시지 발송 현황 stale response

**근거**

- `src/dashboard/hooks/useFirestore.js:150-167`: `useMessageDelivery().reload()`는 request id 또는 cancelled guard 없이 `getDeliveryStatus()` 완료 순서대로 state를 갱신한다.
- `src/dashboard/components/MessageDeliverySummary.jsx:96-105`: 기간 chip/custom 적용이 같은 reload 함수로 빠르게 연속 호출될 수 있다.

**영향**

사용자가 기간을 빠르게 바꾸거나 새로고침을 반복하면 느린 이전 callable 응답이 최신 기간 결과를 덮을 수 있다. 발송 실패/성공 건수는 운영 판단에 쓰이므로 stale 표시가 실제 조치 오류로 이어질 수 있다.

**수정 방향**

- `useDashboardData()`처럼 `reqIdRef`를 `useMessageDelivery()`에도 적용한다.
- `loading`과 `error`도 최신 요청만 갱신하게 한다.
- 기간 파라미터를 state로 보존해 일괄 처리 후 reload가 항상 현재 선택 기간을 재조회하도록 테스트한다.

## F-04. 실패 메시지 일괄 재처리 동시성 무제한

**근거**

- `src/dashboard/components/MessageDeliverySummary.jsx:143-159`: `Promise.allSettled(rows.map(run))`으로 선택 항목 전체를 동시에 callable 호출한다.
- `src/dashboard/components/MessageDeliverySummary.jsx:164-174`: 일괄 재발송/보관/삭제가 선택 건수 기준 동시 실행된다.

**영향**

실패 항목이 누적된 상태에서 전체 선택 후 재발송하면 Functions 호출 폭주, rate limit, 일부 성공/일부 실패 후 상태 판단 혼란이 생길 수 있다.

**수정 방향**

- batch size와 concurrency limit을 둔다.
- 결과를 항목별로 남기고 실패한 항목만 재시도할 수 있게 한다.
- 서버 callable에도 per-user/per-action rate limit이 있는지 확인하고 문서화한다.

## F-05. 배포 workflow에 repo-local 검증 gate 없음

**근거**

- `.github/workflows/deploy.yml:1-16`: `master` push 시 `chief-impact7/impact7-hosting`에 `deploy-unified` dispatch만 보낸다.
- 같은 workflow 안에서 `npm ci`, `npm test`, `npm run build`, rules 검증을 실행하지 않는다.
- 현재 repo 규칙상 push가 자동 배포 경로의 시작점이다.

**영향**

로컬 hook을 우회하거나 다른 환경에서 push하면 기본 테스트/빌드 실패 상태도 통합 호스팅 배포 파이프라인으로 넘어갈 수 있다. downstream repo가 build를 실패시킬 수는 있어도, 이 repo의 변경이 왜 실패했는지 늦게 발견된다.

**수정 방향**

- dispatch 전에 `npm ci`, `npm test`, `npm run build`, `node scripts/check-shared-lock-sync.mjs`, `node scripts/check-class-settings-fields.mjs`를 실행한다.
- workflow 실패 시 dispatch하지 않는다.

## F-06. 취약 의존성 잔존

**근거**

`npm audit --omit=dev` 결과:

- `protobufjs <=7.6.2`: critical
- `@protobufjs/utf8 <=1.1.0`: moderate
- `xlsx *`: high, no fix available

`xlsx`는 `src/messages/message-import.js:1-29`에서 사용자 업로드 파일 파싱에 사용된다.

**영향**

protobuf 계열은 lockfile update로 해소 가능성이 있고, `xlsx`는 npm audit 기준 수정 버전이 없어 파일 파서 공격면이 남는다. 5MB 제한은 완화책이지만 라이브러리 취약점 자체를 제거하지는 않는다.

**수정 방향**

- protobuf 계열은 별도 lockfile-only PR로 `npm audit fix` 후 build/test를 실행한다.
- `xlsx`는 유지보수되는 배포 채널 또는 대체 파서를 평가한다.
- 교체 전까지 Web Worker 격리, 번호 개수 상한, parsing timeout을 추가한다.

## F-07. Drive OAuth scope와 token 보관 범위가 넓음

**근거**

- `auth.js:4-10`: 모든 Google 로그인에 Drive readonly와 drive.file scope를 추가한다.
- `auth.js:19-47`: OAuth access token을 `sessionStorage`에 저장한다.
- 실제 Drive/Sheets 사용은 `export-report.js:215-246`의 일일현황표 생성 경로다.

**영향**

일반 DSC 기록만 하는 직원도 로그인 시 Drive 권한 동의를 요구받는다. XSS가 발생하면 세션 범위의 Drive token 탈취면이 생긴다.

**수정 방향**

- 기본 로그인은 Firebase Auth scope만 사용하고, Sheets export 시점에만 GIS incremental auth로 Drive scope를 요청한다.
- token은 sessionStorage 저장 없이 메모리 보관을 우선하고, 실패 시 재동의 UX를 둔다.

## F-08. 대형 청크가 아직 남아 있음

**근거**

`npm run build` 경고:

- `auth-DlOXRvpu.js`: 672.05kB
- `echarts-Dodi1FcX.js`: 588.52kB
- `xlsx-BojT3SgY.js`: 424.38kB
- `main-C6lxC_WW.js`: 413.45kB

`src/dashboard/echarts.jsx`가 core import로 개선되어 있지만, ECharts chunk 자체는 여전히 500kB를 넘는다.

**영향**

대시보드/메시지/메인 앱의 첫 로드와 cold cache 성능이 직원 PC 상태와 네트워크에 민감하다.

**수정 방향**

- `xlsx`는 메시지 파일 업로드 버튼 클릭 시점 dynamic import로 늦춘다.
- auth bundle에서 App Check/Drive/GIS 관련 코드를 더 분리할 수 있는지 확인한다.
- dashboard chart는 화면 섹션 단위 lazy loading과 실제 chart type tree-shaking을 재측정한다.

## F-09. daily dashboard가 `class_settings` 전체를 매번 읽음

**근거**

- `src/shared/firestore-helpers.js:155-161`: `fetchClassSettingsMap()`은 `class_settings` 전체를 읽는다.
- `src/shared/firestore-helpers.js:292-313`: `fetchDashboardDailyLogData(date)`가 일별 로그 로드마다 `fetchClassSettingsMap()`을 포함한다.

**영향**

반 설정 수가 늘수록 일별 로그 조회 비용과 latency가 누적된다. daily board가 자주 새로고침되는 운영 화면이라는 점에서 비용 위험이 있다.

**수정 방향**

- 학생/기록에 등장한 class code만 추려 필요한 문서만 읽거나, session-level cache with invalidation을 둔다.
- 읽기 수 회귀 기준을 정해 대시보드 로드당 예상 read count를 문서화한다.

## F-10. App Check enforcement 전환 절차가 약함

**근거**

- `firebase-config.js:42-63`: App Check는 동적 import 후 `ensureAppCheck()` 호출 시 초기화된다.
- `src/dashboard/App.jsx:149-152`: dashboard는 첫 데이터 로드 이후 `ensureAppCheck()`를 호출한다.
- 주석도 “강제 전환 시 앱 부팅 즉시 init으로 되돌릴 것”이라고 명시한다.

**영향**

현재 미강제 단계에서는 맞는 설계지만, 콘솔에서 enforcement를 먼저 켜면 첫 Firestore/Functions 요청이 토큰 없이 나갈 수 있다. 4앱 공유 Firebase라 전환 순서 실수의 blast radius가 크다.

**수정 방향**

- enforcement 전환 checklist를 `pre-deploy`/운영 문서에 고정한다.
- enforcement를 켤 release에서는 boot-time init과 첫 요청 토큰 보장을 별도 테스트한다.


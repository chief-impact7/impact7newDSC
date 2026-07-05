# Findings

## 요약

| ID | 등급 | 축 | 내용 |
|---|---|---|---|
| F-01 | P0 | 정합성·신뢰성 | 지연 저장이 날짜 전환 후 다른 날짜 문서에 기록될 수 있음 |
| F-02 | P0 | 보안 | 시험·HR Storage가 모든 로그인 사용자에게 허용됨 |
| F-03 | P1 | 정합성 | 로컬 지점 파생이 shared의 csKey 접두 규칙과 다름 |
| F-04 | P1 | 신뢰성·편의성 | `saveImmediately` 실패가 호출자에게 전달되지 않음 |
| F-05 | P1 | 안정성·복구 | 기록 첨부의 문서·파일 작업이 부분 실패 시 불일치함 |
| F-06 | P1 | 감사·복구 | 감사 로그 실패 후에도 삭제가 진행됨 |
| F-07 | P1 | 정합성 | shared가 지원하는 `종강`을 Firestore Rules가 거부함 |
| F-08 | P1 | 보안 | 취약 의존성 4건, `xlsx`는 현재 npm 경로에 수정 버전 없음 |
| F-09 | P2 | 안정성 | 대시보드의 이전 요청이 최신 기간 결과를 덮을 수 있음 |
| F-10 | P2 | 효율성 | 일일 로그가 승인 휴퇴원 전체를 매번 읽음 |
| F-11 | P2 | 효율성 | 학생 성적 탭이 시험·이벤트 수에 비례해 N+1 조회 |
| F-12 | P2 | 효율성 | 대시보드 공통 청크가 1.35MB로 초기 로드 비용이 큼 |
| F-13 | P2 | 테스트 | 기본 테스트 명령이 Vitest 4건을 누락함 |
| F-14 | P2 | 유지보수성 | `RULES.md`의 entry와 차트 기술이 현재 코드와 다름 |
| F-15 | P2 | 보안·편의성 | 모든 로그인에 Drive scope를 요청하고 access token을 sessionStorage에 보관 |
| F-16 | P3 | 계약 | 메시지 필터의 `classCode` 조건이 현대 enrollment 구조를 처리하지 못함 |

---

## F-01. 날짜 전환 중 지연 저장 오기록

**근거**

- `data-layer.js:816-843`: 2초 후 실행되는 콜백이 예약 시점 날짜가 아니라 실행 시점 `state.selectedDate`로 문서 ID와 `date`를 계산한다.
- `data-layer.js:925-942`: 날짜 이동 시 pending `state.saveTimers`를 flush/cancel하지 않는다.
- `data-layer.js:106-136`: 다음 숙제 저장도 같은 방식으로 실행 시점 날짜와 현재 `state.classNextHw`를 참조한다.

**재현 조건**

1. 날짜 A에서 기록 또는 다음 숙제를 수정한다.
2. 2초 안에 날짜 B로 이동한다.
3. 예약 콜백이 B 기준 문서에 A의 입력을 쓰거나, B 로드로 교체된 상태를 참조한다.

**영향**

- 날짜별 기록 오염
- 원래 날짜의 저장 누락
- UI 로컬 캐시와 Firestore 불일치

**수정 방향**

- 예약 시 `targetDate`, `docId`, immutable payload를 캡처한다.
- 날짜 전환 전에 pending 저장을 flush하거나 명시적으로 취소하고 사용자에게 알린다.
- `studentId + date`와 `classCode + domain + date`를 timer key로 사용한다.
- 가짜 타이머로 A→B 전환 회귀 테스트를 추가한다.

## F-02. 민감 Storage 경로의 인증 경계 불일치

**근거**

- `storage.rules:13-38`: `exam-papers`, `scans`, `staff`, `contracts`, `expenses`, `signatures`가 `request.auth != null`만 요구한다.
- `storage.rules:4-10,42-47`: DSC `student-records`는 검증된 impact7 도메인을 요구한다.
- `firestore.rules:13-18`: DB/DSC Firestore도 검증된 impact7 도메인을 요구한다.

**영향**

Rules만 놓고 보면 impact7 도메인이 아닌 Firebase 로그인 사용자도 시험지·스캔·계약·비용·서명 파일을 읽고 쓸 수 있다. 실제 악용 가능성은 Firebase Auth 공급자 설정에 영향을 받지만, 클라이언트의 도메인 체크는 보안 경계가 될 수 없다.

**수정 방향**

- 시험 경로는 최소 `isAuthorized()`로 통일한다.
- HR 경로는 `isAuthorized()`보다 강한 HR 역할 기반 Rules를 적용한다.
- Storage Rules emulator 테스트로 외부 도메인, 일반 직원, HR 권한 사용자를 분리 검증한다.
- 공유 규칙이므로 impact7DB에서 기준을 정하고 모든 앱에 동기화·배포한다.

## F-03. 지점 파생 shared drift

**근거**

- `student-core.js:17-23`: 첫 글자 `1/2`만 처리한다.
- `node_modules/@impact7/shared/branch.js:3-15`: `10단지`, `2단지` 접두를 먼저 처리한다.
- 실제 비교: `10단지목동중1A` 입력에서 로컬은 `2단지`, shared는 `10단지`.
- 로컬 함수는 필터, 대시보드, 메시지, 일일 기록의 `branch` 저장 등 다수 경로에서 사용된다.

**영향**

`branch` 필드가 없고 첫 enrollment가 내신 csKey인 학생은 지점 필터·표시·일일 기록이 반대로 분류될 수 있다.

**수정 방향**

- `student-core.js`의 로컬 구현을 제거하고 `@impact7/shared/branch`를 재노출한다.
- `2단지…`, `10단지…`, `101`, `201`, 명시적 `branch` 우선 테스트를 추가한다.

## F-04. 저장 실패를 성공으로 처리

**근거**

- `data-layer.js:865-886`: `saveImmediately()`가 오류를 로그에만 남기고 throw/실패 값을 반환하지 않는다.
- `scheduled-visits.js:60-78,104-120`: 호출자는 `await saveImmediately()` 후 성공 표시를 한다.
- `attendance.js:283-315`, `hw-management.js:773-845`: Firestore 성공 전에 로컬 캐시와 UI를 성공 상태로 갱신한다.

**영향**

권한·네트워크·Rules 오류가 발생해도 UI는 완료/출석/숙제 상태가 저장된 것처럼 보일 수 있다. 새로고침 후 되돌아가며 사용자는 실패를 인지하기 어렵다.

**수정 방향**

- `saveImmediately()`는 실패 시 throw한다.
- optimistic UI를 유지한다면 이전 상태를 보관해 rollback한다.
- 사용자 액션은 실패 toast와 재시도 경로를 제공한다.

## F-05. 기록 첨부의 Firestore↔Storage 부분 실패

**근거**

- `docu-card.js:282-305`: 파일 업로드 후 `createRecord()`가 실패하면 이미 업로드한 `metas`를 정리하지 않는다.
- `docu-card.js:225-253`: 편집에서 신규 파일 업로드 후 `updateRecord()`가 실패해도 신규 파일을 정리하지 않는다.
- `docu-data.js:62-74`: 삭제는 파일을 먼저 지운 뒤 Firestore 문서를 삭제한다. 문서 삭제 실패 시 문서는 삭제된 파일을 계속 참조한다.
- 오류 toast도 문서 쓰기 실패를 항상 “첨부 업로드 오류”로 표시한다.

**영향**

- 참조되지 않는 Storage 객체 누적
- 파일이 없는 Firestore 기록
- 원인과 다른 오류 메시지

**수정 방향**

- 생성·편집 catch에서 이번 요청으로 업로드한 파일을 보상 삭제한다.
- 삭제는 상태 전이(`deleting`) 또는 서버 함수로 오케스트레이션하고 재시도 가능한 정리 큐를 둔다.
- 문서 실패와 업로드 실패 메시지를 구분한다.

## F-06. 감사 로그 fail-open 삭제

**근거**

- `audit.js:68-85`: 삭제 전 snapshot/audit log 기록 오류를 catch한 뒤 `deleteDoc()`를 계속 실행한다.

**영향**

삭제 자체는 성공하지만 복구·추적에 필요한 감사 로그가 없을 수 있다. 기록, 반 설정, 결석 등 `auditDelete` 소비 경로 전반에 영향을 준다.

**수정 방향**

- Firestore 문서 삭제와 audit log 생성을 하나의 batch/transaction으로 묶는다.
- 감사 실패 시 삭제를 중단하거나 명시적 비상 우회만 허용한다.

## F-07. `종강` 상태 계약 불일치

**근거**

- `@impact7/shared/enrollment-status.js:5-6,38-40,68-73`: `종강`은 공식 비재원 상태다.
- `firestore.rules:66-69`: 학생의 허용 status에서 `종강`이 빠져 있다.
- UI와 조회 로직은 `종강`을 사용한다.

**영향**

`status='종강'` 문서는 다른 필드만 수정해도 `hasRequiredStudentFields()`에서 거부될 수 있고, shared의 선택 가능한 상태를 저장할 수 없다.

**수정 방향**

- Rules의 상태 목록을 shared 계약과 맞춘다.
- `종강`은 `enrollments=[]`일 때만 허용하는 emulator 테스트를 추가한다.

## F-08. 취약 의존성

**근거**

`npm audit --omit=dev` 결과:

- `protobufjs`: critical
- `@grpc/grpc-js`: high
- `xlsx`: high, npm audit 기준 수정 버전 없음
- `@protobufjs/utf8`: moderate

`xlsx`는 `class-setup-planner.js`와 `src/messages/message-import.js`에서 실제 사용자 파일을 파싱하며, 파일 크기 제한이 없다.

**수정 방향**

- protobuf 계열은 lockfile만 변경하는 별도 PR에서 `npm audit fix` 결과를 검증한다.
- `xlsx`는 유지보수되는 배포 채널/대체 라이브러리를 평가한다.
- 교체 전에는 업로드 크기 제한, Web Worker 격리, 처리 시간 제한을 둔다.

## F-09. 대시보드 stale response

**근거**

- `src/dashboard/hooks/useFirestore.js:55-89`: 날짜 범위 변경마다 Promise를 시작하지만 request id/abort/cleanup이 없다.

**영향**

빠르게 날짜를 바꾸면 오래 걸린 이전 요청이 최신 요청 뒤에 완료되어 화면을 이전 기간 데이터로 덮을 수 있다.

**수정 방향**

- effect별 sequence id 또는 cancelled flag를 두고 최신 요청만 state를 갱신한다.
- loading도 최신 요청만 종료하게 한다.

## F-10. 승인 휴퇴원 전체 스캔

**근거**

- `src/shared/firestore-helpers.js:247-261`: 날짜와 무관하게 `status == approved` 전체를 읽은 뒤 클라이언트에서 하루를 필터링한다.
- `src/shared/firestore-helpers.js:264-281`: 일일 로그를 열 때마다 실행된다.

**영향**

승인 이력이 누적될수록 일일 대시보드의 읽기 수·지연·비용이 선형 증가한다.

**수정 방향**

- 최종 승인일의 조회용 정규화 필드를 저장하거나, 두 승인 timestamp의 하루 범위 쿼리를 합쳐 최종일을 검증한다.
- 읽기 수를 측정하는 비용 회귀 테스트를 둔다.

## F-11. 성적 탭 N+1

**근거**

- `student-detail.js:867-894`: 모든 시험을 읽고 시험마다 결과 문서를 조회한다.
- `student-detail.js:841-864`: 직접 문서 실패 시 시험마다 최대 4개의 추가 쿼리를 순차 실행한다.
- `student-detail.js:897-963`: 외부 시험 이벤트마다 학생 하위 문서를 한 건씩 읽는다.

**영향**

시험 이력이 늘수록 학생 상세 열기 지연과 Firestore read 비용이 크게 증가한다.

**수정 방향**

- 학생 기준 결과 인덱스/요약 컬렉션을 만들거나 collection group 조회가 가능하도록 스키마를 조정한다.
- 최근 N건 우선 로드와 추가 보기 pagination을 적용한다.

## F-12. 대형 대시보드 청크

**근거**

- 프로덕션 빌드: `dashboard-jYkQDTtS.js` 1,346.37kB, gzip 447.39kB.
- 여러 대시보드 컴포넌트가 `echarts-for-react` 전체 entry를 정적으로 import한다.

**영향**

대시보드와 메시지 페이지의 초기 다운로드·파싱 비용이 크다.

**수정 방향**

- `echarts/core` 기반 필요한 차트·컴포넌트만 등록한다.
- 대시보드 섹션을 lazy import하고 메시지 페이지와 차트 청크 공유를 재검토한다.

## F-13. 기본 테스트 명령의 누락

**근거**

- `package.json:10`: node:test 5개 파일만 열거한다.
- `src/messages/bulk-select.test.js`는 Vitest 4건이며 기본 명령에 포함되지 않는다.
- `npx vitest run src/messages/bulk-select.test.js`는 4건 모두 통과했다.

**영향**

개발자와 CI가 `npm test`만 실행하면 메시지 대상 필터 회귀를 놓친다.

**수정 방향**

- `test:node`, `test:vitest`, `test`를 분리하고 `test`가 둘을 순차 실행하게 한다.

## F-14. 필수 문서 drift

**근거**

- `RULES.md:21-23,34-36,61-63`: 메인 entry를 `daily-ops.js`, 엑셀 entry를 `app.js`, 차트를 Recharts로 설명한다.
- 현재는 메인 `app.js`, 엑셀 `excel.js`, 차트 ECharts다.

**영향**

작업자가 잘못된 entry를 수정하거나 존재하지 않는 차트 스택을 전제로 판단할 수 있다.

**수정 방향**

- 현재 AGENTS.md의 entry 표를 `RULES.md`에도 반영하고 중복 설명의 정본을 하나로 정한다.

## F-15. OAuth scope와 토큰 보관

**근거**

- `auth.js:4-10`: 모든 Google 로그인에 Drive readonly와 drive.file scope를 추가한다.
- `auth.js:19-47`: access token을 sessionStorage에 저장한다.

**영향**

Drive 기능을 쓰지 않는 사용자도 넓은 동의를 요구받고, XSS가 발생하면 일반 Firebase 세션보다 가치가 큰 Drive token이 노출될 수 있다.

**수정 방향**

- 기본 로그인은 Firebase 인증 scope만 사용한다.
- Drive/Sheets 기능 진입 시 incremental authorization으로 별도 요청한다.
- 토큰 저장을 메모리 중심으로 줄이고 CSP·XSS 회귀 검증을 추가한다.

## F-16. 메시지 `classCode` 필터 계약 오류

**근거**

- `src/messages/bulk-select.js:12`: `enrollmentCode(s)`로 학생 객체를 enrollment처럼 처리한다.
- 현대 학생 데이터는 `enrollments[]`에 반 코드가 있다.
- 현재 UI는 이 옵션을 직접 넘기지 않아 즉시 노출되는 사용자 버그는 아니다.

**수정 방향**

- `allClassCodes(s).includes(classCode)`로 변경하고 다중 enrollment 테스트를 추가한다.

---

## 양호한 항목

- Firestore는 impact7 검증 도메인을 요구하고 기본 거부가 존재한다.
- `students` 클라이언트 삭제가 차단되어 있다.
- `message_queue`와 체크인 이벤트가 서버 전용이다.
- DSC 기록 첨부는 이미지·15MB 제한을 Rules와 클라이언트 양쪽에서 적용한다.
- 개발 환경에 READ-ONLY와 Firestore/Auth/Storage emulator 모드가 있다.
- 날짜가 오늘이 아닐 때 입력 화면에 경고를 표시한다.
- 실시간 리스너는 동일 key 재구독 전 기존 unsubscribe를 실행한다.
- Firestore/Storage 규칙 파일은 확인한 4개 저장소에서 동일하다.

## 검증 공백

- 프로덕션 Firestore 문서 수·실제 read 비용·field count 분포
- 실제 Firebase Auth 공급자 제한과 HR 역할별 Storage 접근
- emulator 기반 Rules 허용/거부 테스트
- 브라우저에서 날짜 전환·오프라인·다중 탭·느린 네트워크 시나리오
- 키보드·스크린리더·색 대비 자동 접근성 테스트
- 독립 리뷰어/전문 에이전트 교차 검토

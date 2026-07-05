# 개선 계획

## Phase 0 — 배포 차단 항목

### 0-1. 날짜 컨텍스트 고정

대상:

- `data-layer.js`
- `state.js`
- 관련 테스트

완료 조건:

- 저장 예약 후 날짜를 바꿔도 원래 날짜 문서만 수정됨
- 다음 숙제도 예약 당시 날짜·payload를 사용함
- 날짜 이동 시 pending 저장 정책이 테스트로 고정됨

### 0-2. Storage 권한 재설계

대상:

- `storage.rules`
- Rules emulator 테스트
- 4개 앱 규칙 동기화

완료 조건:

- 비 impact7 계정은 모든 업무 파일 경로 접근 거부
- 일반 직원과 HR 권한자의 경로별 허용 범위가 테스트됨
- impact7DB 기준으로 동기화·배포됨

## Phase 1 — 데이터 정합성·복구

### 1-1. shared 지점 함수 일원화

- 로컬 구현 제거
- `@impact7/shared/branch` import
- csKey 접두 회귀 테스트

### 1-2. 저장 실패 전파

- `saveImmediately` 실패 throw
- optimistic update rollback
- scheduled visit/attendance/homework 호출자 실패 UX 정리

### 1-3. 기록 첨부 보상 처리

- 생성/편집의 Firestore 실패 시 신규 업로드 파일 제거
- 삭제 작업을 재시도 가능한 상태 전이로 변경
- 오류 메시지 원인별 분리

### 1-4. 감사 삭제 원자화

- audit log와 Firestore delete를 batch/transaction으로 결합
- audit 실패 시 삭제 금지 테스트

### 1-5. `종강` 계약 동기화

- Rules 상태 목록 수정
- enrollment 비움 조건 emulator 테스트
- 4개 저장소 동기화

## Phase 2 — 안정성·비용

### 2-1. React 요청 역전 방지

- dashboard hooks에 request sequence/cleanup
- 빠른 날짜 변경 테스트

### 2-2. Firestore 조회 축소

- 승인 요청의 조회용 날짜 필드 또는 timestamp 범위 쿼리
- 성적 결과의 학생 중심 조회 모델
- 최근 N건과 pagination

### 2-3. 번들 분리

- ECharts core import
- 대시보드 섹션 lazy loading
- 목표: 초기 dashboard JS gzip 250kB 이하

## Phase 3 — 공급망·개발 경험

### 3-1. 취약 의존성

- protobuf 계열 안전 업데이트 후 build/test
- `xlsx` 교체 후보 비교
- 교체 전 파일 크기 제한과 worker 격리

### 3-2. 테스트 명령 통합

권장 형태:

```json
{
  "scripts": {
    "test:node": "node --test consultation-filter.test.js consultation-payload.test.js class-setup-enrollment.test.js student-core.test.js docu-records.test.js",
    "test:vitest": "vitest run",
    "test": "npm run test:node && npm run test:vitest"
  }
}
```

추가 필수 테스트:

- 날짜 A 저장 예약 후 B 이동
- shared/local branch 일치
- 저장 실패 rollback과 사용자 오류 표시
- 첨부 생성·편집·삭제 부분 실패
- Dashboard stale response
- Firestore/Storage Rules 허용·거부

### 3-3. 문서와 운영 가드

- `RULES.md` entry와 ECharts 반영
- 테스트/빌드/audit/Rules emulator를 CI에 연결
- 접근성 smoke 검사와 오류 수집 도입

## 권장 실행 순서

1. F-01
2. F-02
3. F-03, F-04, F-05, F-06, F-07
4. F-08, F-09, F-10, F-11
5. F-12~F-16

각 Phase는 source 변경이 있으므로 commit 전에 프로젝트 규칙에 따라 `simplify`와 코드 리뷰를 다시 실행하고, 최종적으로 build·전체 test·Rules emulator 검증을 수행한다.

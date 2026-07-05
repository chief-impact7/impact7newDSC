# 리뷰 방법

## 목표와 판정 원칙

리뷰는 정합성, 신뢰성, 안정성, 효율성, 편의성을 중심으로 보안, 데이터 보호, 유지보수성, 테스트 가능성, 접근성, 관측성까지 포함했다.

근거 우선순위는 다음과 같다.

1. 실행 결과와 재현
2. 실제 호출 경로와 쓰기 경계
3. shared 공개 계약과 Security Rules
4. 정적 패턴과 문서

확정할 수 없는 가능성은 결함으로 단정하지 않고 검증 공백 또는 개선 권고로 분리했다.

## 수행 순서

### 1. 실행 표면 확정

- Vite 멀티페이지 entry를 `vite.config.js`와 각 HTML의 module script로 대조
- 실제 entry:
  - 메인: `index.html` → `app.js`, `naesin.js`
  - 엑셀: `excel.html` → `excel.js`
  - 대시보드: `dashboard.html` → `src/dashboard/main.jsx`
  - 메시지: `messages.html` → `src/messages/main.jsx`
  - 반 편성: `class-setup.html` → `class-setup.js`
  - 체크인: `checkin.html` → `checkin.js`

### 2. shared-first 계약 대조

- `@impact7/shared` v1.30.0의 15개 export를 확인
- 지점, enrollment 상태, 학생 라벨, 날짜, 출결 액션의 로컬 재구현 여부를 조사
- 동일 이름이더라도 로컬과 shared의 입력 처리 결과가 다르면 drift로 판정

### 3. 데이터 쓰기 경로 추적

- Firestore 쓰기 래퍼와 직접 쓰기를 조사
- 지연 저장, 날짜 전환, 로컬 캐시 갱신 순서를 함께 추적
- 삭제 시 감사 로그, Firestore 문서, Storage 객체의 부분 실패를 확인

### 4. 비동기·상태 안정성 검토

- React effect와 reload의 stale response 가능성
- onSnapshot 해제·교체 여부
- 사용자 입력 중 재렌더 방지와 날짜 전환 중 pending 작업 처리

### 5. 보안·데이터 보호 검토

- Firestore/Storage 기본 거부, 인증 도메인, 민감 컬렉션 접근
- 클라이언트 입력 검증과 Rules 검증의 일치
- tracked secret 패턴과 npm 취약점
- OAuth scope와 브라우저 토큰 보관

### 6. 비용·성능 검토

- 전체 컬렉션 스캔, N+1, 무제한 쿼리, 실시간 리스너 범위
- 프로덕션 빌드 청크 크기
- 캐시와 lazy loading 사용 여부

### 7. 사용성·운영성 검토

- 저장 실패 피드백, 과거 날짜 경고, READ-ONLY/Emulator 안전장치
- 테스트 명령 하나로 전체 검증이 가능한지
- 문서가 실제 entry와 기술 스택을 반영하는지
- 접근성 속성과 자동 검증 존재 여부

## 심각도

| 등급 | 의미 |
|---|---|
| P0 | 데이터 오기록·민감 데이터 노출처럼 배포를 막아야 하는 문제 |
| P1 | 실제 기능 오류, 감사·복구 실패, 높은 보안 위험 |
| P2 | 일정 조건에서 오표시·비용 증가·운영 혼란을 만드는 문제 |
| P3 | 유지보수성과 편의성을 낮추는 개선 항목 |

## 종료 조건

- 코드와 shared 계약의 주요 경로를 대조
- 쓰기·삭제·인증·대량 조회 경로를 확인
- 프로젝트와 shared 테스트, 빌드, 구문 검사, 규칙 동기화, 의존성 감사를 실행
- 모든 finding에 파일·라인·영향·조치 방향을 기록

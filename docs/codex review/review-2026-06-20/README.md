# impact7newDSC 종합 리뷰

- 기준일: 2026-06-20
- 대상: `impact7newDSC` 전체와 `@impact7/shared` 공개 계약
- 판정: **조건부 실패 — P0 2건을 해소하기 전 배포 비권장**

## 결론

빌드와 현재 기본 테스트는 통과하고 Firestore/Storage 규칙 파일도 저장소 간 동일하다. 그러나 날짜 전환 직전의 지연 저장이 다른 날짜 문서로 기록될 수 있고, 공유 Storage 규칙이 일부 민감 경로를 모든 로그인 사용자에게 허용한다.

| 축 | 판정 | 핵심 근거 |
|---|---|---|
| 정합성 | 위험 | 로컬 지점 파생이 shared 계약과 다르고 `종강` 상태가 Rules에서 거부됨 |
| 신뢰성 | 위험 | 지연 저장의 날짜 컨텍스트 유실, 저장 실패를 성공처럼 처리하는 호출 경로 |
| 안정성 | 주의 | 대시보드 비동기 응답 역전, 기록 첨부의 Firestore↔Storage 부분 실패 |
| 효율성 | 주의 | 승인 휴퇴원 전체 스캔, 성적 탭 N+1, 대시보드 1.35MB 청크 |
| 편의성 | 보통 | 과거 날짜 경고·READ-ONLY 모드는 양호하나 실패 피드백과 테스트 진입점이 불완전 |
| 보안 | 위험 | HR/시험 Storage 경로의 도메인 검증 누락, 취약 의존성 4건 |
| 유지보수성 | 주의 | 실제 entry/차트와 `RULES.md`가 불일치하고 테스트 러너가 분산됨 |

## 우선 조치

1. `saveDailyRecord()`와 `saveClassNextHw()`가 예약 시점의 날짜·데이터를 캡처하도록 변경하고 날짜 이동 전 flush 또는 cancel한다.
2. `storage.rules`의 시험/HR 경로를 `isAuthorized()` 또는 HR 역할 기반 권한으로 제한한다.
3. 로컬 `branchFromStudent`를 제거하고 `@impact7/shared/branch`를 직접 사용한다.
4. `saveImmediately()`가 실패를 호출자에게 전달하게 하고, 첨부 업로드·문서 생성·삭제의 보상 처리를 완성한다.
5. `종강` 계약, 의존성 취약점, 쿼리 비용, 테스트 스크립트를 순서대로 정리한다.

## 문서 구성

- [01-review-method.md](./01-review-method.md): 반복 가능한 리뷰 절차와 범위
- [02-findings.md](./02-findings.md): 심각도별 확정 이슈
- [03-validation.md](./03-validation.md): 실행한 검증과 한계
- [04-remediation-plan.md](./04-remediation-plan.md): 수정 순서와 완료 조건

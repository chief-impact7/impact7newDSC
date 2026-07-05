# impact7newDSC 적대적 종합 리뷰

- 기준일: 2026-07-04
- 대상: `impact7newDSC` 현재 checkout, Firestore/Storage rules, 메시지/대시보드/기록/저장 경계
- 판정: **조건부 실패 - Storage 권한과 대량 메시지 운영 가드 정리 전 배포 확대 비권장**

## 결론

6월 P0였던 날짜 지연 저장, Storage 도메인 검증, 감사 삭제 fail-open, 대시보드 stale response 일부는 현재 코드에서 보강되어 있고 테스트도 통과한다. 그러나 공유 Storage rules가 HR 민감 파일을 모든 impact7 검증 계정에 열어두고, 최근 메시지 기능은 대량 발송/재처리의 client-side 상한과 확인·스로틀이 약하다.

| 축 | 판정 | 핵심 근거 |
|---|---|---|
| 정합성 | 보통 | shared branch drift와 `종강` rules mismatch는 현재 해소됨 |
| 안정성 | 주의 | 메시지 발송 현황 reload stale 응답, 일괄 재처리 무제한 병렬 callable |
| 신뢰성 | 주의 | 기본 테스트/빌드는 통과하지만 배포 workflow 자체에는 build/test gate 없음 |
| 신속성 | 주의 | `auth`/`echarts`/`xlsx` 대형 청크 경고, daily dashboard 전체 설정 read |
| 보안 | 위험 | HR Storage 경로가 역할이 아니라 도메인 인증만 요구, 취약 의존성 잔존 |
| 운영성 | 위험 | 메시지 대량 발송은 서버 방어선 검증 없이는 비용·오발송 blast radius가 큼 |

## 우선 조치

1. `storage.rules`의 HR 경로(`staff`, `contracts`, `expenses`, `signatures`)를 HR 역할 기반으로 제한하고 emulator 테스트를 추가한다.
2. 메시지 대량/직접 발송에 hard cap, 최종 확인, 예약 시각 검증, 재처리 concurrency limit을 둔다.
3. `useMessageDelivery()`에 request id/stale guard를 추가하고 발송현황 새로고침 race를 막는다.
4. `master` push workflow가 dispatch 전에 최소 `npm test && npm run build`를 실행하게 한다.
5. `xlsx` 대체/격리와 protobuf 계열 audit fix를 별도 작업으로 처리한다.

## 문서 구성

- [01-review-method.md](./01-review-method.md): 리뷰 기준과 확인 범위
- [02-findings.md](./02-findings.md): 심각도별 발견사항
- [03-validation.md](./03-validation.md): 실행 검증과 한계
- [04-remediation-plan.md](./04-remediation-plan.md): 수정 순서와 완료 조건


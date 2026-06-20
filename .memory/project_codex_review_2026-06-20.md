# codex 종합 리뷰(2026-06-20) 후속 진행

codex가 `docs/codex review/review-2026-06-20/`에 남긴 16건 finding을 배치로 처리 중.
핵심 5건(P0 2 + F-03/04/07)은 실제 코드와 직접 대조해 모두 사실 확인함.

## 완료 (푸시·배포 완료 2026-06-20 — DSC 코드는 Actions 호스팅, rules는 firebase deploy)
- 배치 A `3b75df7`: F-01(지연저장 날짜고정 — `save-scheduler.js` 순수 debounce, 예약 시점 targetDate 캡처 + reloadForDate flush), F-03(branch 로컬재구현 제거→`@impact7/shared/branch` 재노출, '10단지' 접두 오분류 교정), F-04(saveImmediately throw + 호출처 optimistic rollback), F-06(auditDelete를 getDoc+writeBatch로 fail-closed), F-13(test:node/test:vitest 분리), F-14(RULES.md entry/차트 현행화)
- 배치 B `dd4772b`: F-05(docu 첨부 부분실패 보상 — 생성/편집 문서쓰기 실패 시 업로드 파일 보상삭제, 삭제는 문서→파일 순서로 dangling 방지)
- 배치 D 일부 `81bd019`: F-09(useDashboardData useRef stale 가드), F-12(echarts-for-react 전체→echarts/core, dashboard 청크 1346→787kB)
- 배치 E `b1e585b`: F-16(filterStudents classCode를 enrollmentCode→allClassCodes로 교정), F-08 xlsx 5MB 상한
- 배치 C(rules, 4-repo 동기화): F-02(storage.rules exam/HR 6경로 request.auth!=null→isAuthorized()), F-07(firestore.rules 학생 status에 종강 추가). 커밋: DB `3df0c7b`·DSC `0c2df77`·HR `6d3ce81`·exam `c94167d` (md5 4개 동일)
  - 배포 완료: `firebase deploy --only firestore:rules,storage`(impact7db) 성공, 4-repo push 완료
  - 후속: F-02 HR 역할 세분화(staff 본인만 등)는 HR 앱 구조 의존
- F-10(배포 완료): `fetchApprovedLeaveRequestsForDate`를 status==approved 전체스캔 → approved_at/teacher_approved_at 각각 하루범위 쿼리 합집합 + finalApprovalDate(max) 재검증. leave_requests 복합인덱스 2개(status+approved_at, status+teacher_approved_at) impact7db 배포·빌드 READY. 커밋 DSC `7292812`·DB indexes `9b2dd9c` push 완료. **주의**: 과거 approved_at이 비-Timestamp면 누락(serverTimestamp 일관이면 무관). DSC firestore.indexes.json은 DB와 drift 상태(배포는 DB 기준)

## 남은 작업
- **F-11(진행 중 — Cloud Function 요약 방식, 사용자 선택)**: 성적 N+1을 student_scores/{studentId} 요약으로 해결.
  - 조사: academy 4시험(학생당 max1), external 47(school45·mock2). N+1 주범=external 45 getDoc(대부분 빈 결과). results docId=auto-id(식별 registrationNo·studentName), external docId=studentId. students에 studentNumber 필드 저장(역조회 가능).
  - 스키마: `student_scores/{studentId} = { academy:{[examId]:{...}}, external:{[eventId]:{...}}, updated_at }` (map, raw 비정규화 — 점수계산은 DSC 유지=drift회피).
  - **완료**: Cloud Function 2개 작성 `impact7DB/functions/src/syncStudentScores.js`(onExternalScoreWritten·onResultScoreWritten) + index.js export. 구문·eslint OK. **미커밋·미배포**.
  - **남은 단계**(각 프로덕션/고영향): ① emulator/unit 검증(로직 순수분리 필요) ② Function 배포(firebase deploy --only functions) ③ student_scores rules(read=isAuthorized, write=false) 4-repo 동기화·배포 ④ 백필 마이그레이션 scripts/oneoff(dry-run→execute, 전체 results/external→student_scores) ⑤ DSC loadScoreCard 대수술(load*Scores 4개 제거→student_scores 1회+departments 1회).
  - 조사 스크립트: `scripts/oneoff/investigate-student-scores.mjs`(read-only, 미커밋).
- **F-08 firebase(후속)**: protobufjs/grpc-js(critical/high)는 firebase@12.9 transitive지만 **dist 번들에 미포함**(firestore 브라우저빌드는 WebChannel) → 클라 런타임 무해. firebase 12.9→12.15 업뎃은 Firestore 런타임 검증 부담으로 별도 세션

## 후속 메모
- `save-scheduler.js`는 순수 모듈 — shared-first상 `@impact7/shared` 이관 검토 ([[feedback_reexport_local_binding]] 주의: re-export 로컬바인딩)
- F-04 rollback이 호출처마다 3종(attendance=reloadForDate, hw=로컬, docu=try-catch) — 헬퍼 일반화 후속
- rules 변경(C)은 [[feedback_firestore_rules_4projects]]·[[feedback_rules_sync_commit]] 규율 따를 것

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

- F-11(배포 완료 — Cloud Function 요약 방식): 성적 N+1을 student_scores/{studentId} 요약으로 해결.
  - 스키마: `student_scores/{studentId} = { academy:{[examId]:{examId,title,date,deptId,result}}, external:{[eventId]:{eventId,type,event,score}}, updated_at }` (map, raw 비정규화 — 점수계산은 DSC가 유지=drift회피).
  - Function 2개 `impact7DB/functions/src/syncStudentScores.js`: onExternalScoreWritten(docId=studentId 직접), onResultScoreWritten(resolveStudentId: studentNumber 타입정규화→parent_phone_1 하이픈유무→name). emulator 12 tests. 배포·재배포 완료. 커밋 DB `a1fa76f`·`059abb2`·`3e184d6`.
  - student_scores rules(read=isAuthorized, write=false) firebase 배포 + 4-repo git 커밋(DSC `0a64abb`·DB `3e184d6`·HR `a44d09b`·exam `63b3ca0`).
  - 백필 `functions/backfill-student-scores.mjs`: external 465 완전, academy 27/36(미매핑 9 = reg 전화번호불일치·이름'미확인'·studentNumber 부재 = 원천 데이터부실, DSC 기존도 동일 한계).
  - DSC `student-detail.js` loadScoreCard: load*Scores 4개 제거 → student_scores 1회 + departments 1회. 커밋 `0877512` push 완료(Actions 배포).
  - **남은 확인**: 브라우저 성적탭 실제 렌더(emulator 불가) — 배포 후 production 확인 필요.

- F-08 firebase(완료): firebase 12.9.0→12.15.0 업데이트. audit prod 4→3건(grpc-js 1.9.16으로 high 일부 해소). protobufjs 7.5.4(critical)는 @firebase/firestore가 핀한 transitive — **dist 번들 미포함(WebChannel)이라 클라 런타임 무해**. overrides 강제는 Firestore 호환 리스크>이득(0)이라 미적용. 검증: build·test·번들 미포함 재확인·브라우저(로그인/Firestore 로드/콘솔에러0). xlsx 크기제한은 배치E에서 적용.

## 남은 작업
- (없음 — codex 16건 전건 완료·배포·검증)

## 후속 메모
- `save-scheduler.js`는 순수 모듈 — shared-first상 `@impact7/shared` 이관 검토 ([[feedback_reexport_local_binding]] 주의: re-export 로컬바인딩)
- F-04 rollback이 호출처마다 3종(attendance=reloadForDate, hw=로컬, docu=try-catch) — 헬퍼 일반화 후속
- rules 변경(C)은 [[feedback_firestore_rules_4projects]]·[[feedback_rules_sync_commit]] 규율 따를 것

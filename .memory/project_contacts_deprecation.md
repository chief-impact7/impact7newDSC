---
name: contacts 컬렉션 폐기 — Phase 5 잔여 작업
description: contacts/students 병합 완료, 코드 정리 및 특강반 학생 추가 UI 미구현 — 2026-04-09 진행상황
type: project
---

## 완료된 작업 (2026-04-09)

1. **데이터 병합**: contacts → students 통합 완료. 모든 contacts 문서는 1:1 대응 students 보유 (drift 0건).
2. **'상담' status 도입**: students.status에 '상담' 추가. firestore.rules 4개 프로젝트 동기 + 배포 완료.
3. **DSC 로드 쿼리**: `daily-ops.js:444`, `app.js:249`, `src/shared/firestore-helpers.js:50` — `status in [...]`에 '상담' 포함.
4. **필수필드 검증**: 이름/학교/학년/학부/소속 공란 차단 — DSC `saveTempAttendance`, impact7DB `submitNewStudent` (신규·수정 공통), firestore.rules `temp_attendance`.
5. **drift 정리**: 정지우2 중복 삭제, 서윤하 first_registered 보강, 상담 학생 9건 backfill (김도영2 포함 특수 병합), orphan `김도영_2_1043638213` contacts 삭제.

**Why**: DSC 첫데이터입력 학생이 contacts에만 존재하고 students에는 누락되던 문제 해결.
**How to apply**: 현재 DSC에서 첫데이터입력해도 `_syncContactsForTemp`를 거쳐 contacts에 쓰이고 있음 — 이는 Phase 5에서 제거 예정.

## Phase 5 — DSC contacts 코드 제거 (완료 2026-04-09)

### DSC (`impact7newDSC`) — 완료
- `_searchContactsDSC` — contacts prefix 쿼리 → students에서 status in ['퇴원','종강'] 검색.
- `_tryTempContactAutofill` — `contacts/{docId}` → `students/{docId}` getDoc.
- `openContactAsTemp` — `contacts/{contactId}` → `students/{contactId}`.
- `_syncContactsForTemp` 제거 → `_upsertStudentFromTemp`로 대체. 신규 시 `students/{name_phone}`에 status='상담', 빈 enrollments, first_registered로 setDoc. 기존 시 status/enrollments 보존하고 기본 필드만 merge. 로컬 캐시(`allStudents`)도 즉시 업데이트.
- `help-guide.js`: contacts 언급을 students로 수정.
- 코드베이스 내 'contacts' 문자열 잔존: 0건 (검색 확인).

### impact7DB (`impact7DB`) — 별도 프로젝트, 미진행
다음 세션에서 impact7DB로 이동 후 진행:
- `app.js:617, 632` contacts 검색 → students 기반
- `app.js:1580` 자동채움 → students
- `app.js:2106` 신규 등록 시 contacts setDoc 제거
- `app.js:5821` batch contacts write 제거
- `_syncStudentsToContacts` 및 1회용 스크립트 정리

### 배포 후 모니터링
- DSC 첫데이터입력이 정상적으로 students에 '상담' 학생을 만드는지 확인
- 며칠 모니터링하여 contacts에 새 write가 없는지 (DSC쪽은 0이어야 함)
- impact7DB Phase 5 완료 후 `contacts` 컬렉션 백업 → drop

### 빌드
- `npm run build` 통과 (2026-04-09 Phase 5 DSC 부분).

## Phase 6 — 특강반 학생 추가 UI (완료 2026-04-09)

### 변경 내역
1. **class-setup.js**: `addNewExternalStudent` 제거, `_doSearchStudents` 비원생 fallback 제거, `ACTIVE_STATUSES`에 '상담' 추가, `submitWizard`에서 `isNew` 분기/`auditAdd` 제거. 마법사는 이제 students에 직접 쓰지 않음 (status2 update + arrayUnion enrollment만).
2. **daily-ops.js**: `renderClassDetail` 특강 분기에 `renderTeukangAddStudentCard` 추가. 인라인 검색 입력 + 결과 리스트, 클릭 시 `addStudentToTeukang` → `auditUpdate`로 enrollments arrayUnion + status2='특강'. 새 enrollment day는 `classSettings.schedule` 키에서, start/end_date는 같은 반 기존 학생에서 복사 (없으면 today).
3. 검색 필터: `재원/등원예정/실휴원/가휴원/상담` (퇴원 제외), 이미 등록된 학생 자동 제외.
4. 카드 안내문: 검색 결과 없으면 "첫데이터입력으로 먼저 등록" 가이드.

### 빌드
- `npm run build` 통과 (2026-04-09).
- DSC에서 students를 새로 만드는 경로는 이제 **첫데이터입력**(`saveTempAttendance` — 현재는 contacts 동기 포함, Phase 5에서 정리 예정) 외에는 없음.

### 다음 단계
- 사용자 테스트 후 Phase 5 진행.

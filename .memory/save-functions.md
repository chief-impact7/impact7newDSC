# Daily-ops.js 저장 함수 분석

## 핵심 저장 함수 맵

### 1. 기본 저장 인터페이스
- **saveDailyRecord(studentId, updates)**: 2초 debounce, Firestore setDoc with merge
- **saveImmediately(studentId, updates)**: 즉시 저장, debounce 없음
- 모두 `daily_records` 컬렉션 사용, Doc ID = `makeDailyRecordId(studentId, selectedDate)`

### 2. 출결(Attendance)
- **toggleAttendance() → applyAttendance()**: saveImmediately 호출
- 저장 필드: `attendance: { status }`, `arrival_time` (상태에 따라 추가/제거)

### 3. 숙제(Homework)
- **toggleHomework()**: saveImmediately 호출, homework 배열 업데이트
- **toggleHwDomainOX() → applyHwDomainOX()**: saveImmediately 호출, hw_domains_1st/2nd 업데이트
- **saveHomeworkFromModal()**: saveDailyRecord 호출, homework 배열에 항목 추가
- **saveClassNextHw()**: 별도 컬렉션 `class_next_hw`, Doc ID = `${classCode}_${selectedDate}`, 2초 debounce

### 4. 테스트(Test)
- **saveTestFromModal()**: saveDailyRecord 호출, tests 배열에 항목 추가
- **saveTestFailAction()**: setDoc to daily_records + writeBatch to test_fail_tasks
  - Doc ID: `test_${studentId}_${item}_${selectedDate}`.replace(/[^\w\s가-힣-]/g, '_')
  - 필드: domain(item), type, source, source_date, scheduled_date, alt_hw, handler, status:pending
- **completeTestFailTask() / cancelTestFailTask()**: updateDoc to test_fail_tasks

### 5. 숙제 미통과(HW Fail Action)
- **saveHwFailAction()**: setDoc to daily_records + writeBatch to hw_fail_tasks
  - Doc ID: `${studentId}_${domain}_${selectedDate}`.replace(/[^\w\s가-힣-]/g, '_')
  - pending task 취소 로직 포함
- **completeHwFailTask() / cancelHwFailTask()**: updateDoc to hw_fail_tasks

### 6. 반 관리(Class Management)
- **saveClassSettings()**: setDoc to class_settings, Doc ID = classCode
- **saveClassScheduledTimes()**: writeBatch update to students.enrollments (daily_records 아님!)
- **saveStudentScheduledTime()**: updateDoc to students.enrollments
- **saveEnrollment()**: updateDoc to students.enrollments

### 7. 일정 및 기타
- **saveRetakeSchedule()**: addDoc to retake_schedule (자동 ID 생성)
- **saveExtraVisit()**: saveDailyRecord() + 타겟 날짜 다르면 setDoc
- **saveTempAttendance()**: addDoc to temp_attendance
- **saveScheduleFromModal()**: Promise.all(saveRetakeSchedule())

### 8. 일괄 처리
- **handleBatchAction()**: writeBatch로 최대 200개씩 분할 저장
  - attendance, homework_status, homework_notify, test_result 액션 지원

## 주요 특징

1. **Doc ID 생성**
   - daily_records: makeDailyRecordId(studentId, selectedDate) 필수
   - hw_fail_tasks, test_fail_tasks: replace(/[^\w\s가-힣-]/g, '_') 정규식 사용
   - class_next_hw: ${classCode}_${selectedDate} 형식

2. **필수 필드**
   - daily_records: student_id, date, branch, updated_by, updated_at
   - fail_tasks: source_date, status

3. **에러 처리**
   - try-catch로 모든 저장 함수 감싸짐
   - console.error + showSaveIndicator('error') 호출

4. **로컬 캐시 동기화**
   - 저장 후 dailyRecords[studentId] 또는 해당 배열 업데이트
   - 렌더링 함수 호출

## 저장 실패 가능 원인

1. makeDailyRecordId() 오류
2. 필수 필드 누락
3. 잘못된 컬렉션명
4. WriteBatch commit 실패
5. Firestore 보안 규칙 거부
6. 타임아웃

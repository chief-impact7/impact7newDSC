// ─── Data Layer Module ──────────────────────────────────────────────────────
// daily-ops.js에서 추출한 Firebase 데이터 로드/저장 함수
// Phase 4-1

import {
    collection, getDocs, getDocsFromCache, doc, getDoc,
    query, where, orderBy, limit, startAfter, documentId, serverTimestamp, writeBatch, Timestamp,
    onSnapshot, deleteField
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase-config.js';
import { auditUpdate, auditSet, auditAdd, auditDelete, batchUpdate, batchSet, READ_ONLY } from './audit.js';
import { parseDateKST, toDateStrKST, todayStr, getDayName } from './src/shared/firestore-helpers.js';
import { state, DEFAULT_DOMAINS, LEAVE_STATUSES, DEFAULT_TEST_SECTIONS } from './state.js';
import { showSaveIndicator, showToast } from './ui-utils.js';
import { openKoreanDatePicker } from './date-picker.js';
import { normalizeDays, enrollmentCode, branchFromStudent, makeDailyRecordId, getActiveEnrollments } from './student-helpers.js';
import { DEFAULT_HISTORY_LIMIT } from './consultation-filter.js';
import { createDebouncedWriter } from './save-scheduler.js';
import { createPromoteEnrollPending } from '@impact7/shared/promote-enroll';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { deriveStudentNumber, studentNumberIdentityKey } from '@impact7/shared/student-number';
import { staffLabel } from '@impact7/shared/staff-label';

const _promoteEnrollPending = createPromoteEnrollPending(
    { db, writeBatch, doc, collection, serverTimestamp },
    { idField: 'docId', batchUpdate }
);

// ─── 지연 저장 스케줄러 (날짜 컨텍스트 고정) ──────────────────────────────────
// 예약 시점의 targetDate·payload를 캡처해, 발동 전에 날짜를 바꿔도 원래 날짜 문서에만
// 저장한다. 로컬 캐시는 발동 시점에 같은 날짜를 보고 있을 때만 갱신한다. F-01.
// daily_records 저장 + 로컬 캐시 갱신 헬퍼 (debounce/immediate 공통)
async function _persistDailyRecord(studentId, targetDate, updates) {
    const student = state.allStudents.find(s => s.docId === studentId);
    await auditSet(doc(db, 'daily_records', makeDailyRecordId(studentId, targetDate)), {
        student_id: studentId,
        date: targetDate,
        branch: branchFromStudent(student || {}),
        ...updates
    }, { merge: true });
}
function _applyDailyCache(studentId, targetDate, updates) {
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { docId: makeDailyRecordId(studentId, targetDate), student_id: studentId, date: targetDate };
    }
    Object.assign(state.dailyRecords[studentId], updates);
}

async function _writeDailyRecord({ studentId, targetDate, updates }) {
    try {
        await _persistDailyRecord(studentId, targetDate, updates);
        // 발동 시점에 같은 날짜를 보고 있을 때만 캐시 갱신
        if (state.selectedDate === targetDate) _applyDailyCache(studentId, targetDate, updates);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('저장 실패:', err);
        showSaveIndicator('error');
        alert('저장 실패: ' + (err.code || '') + ' ' + (err.message || err));
    }
}
const _dailyWriter = createDebouncedWriter(_writeDailyRecord);

async function _writeClassNextHw({ classCode, targetDate, domains }) {
    try {
        await auditSet(doc(db, 'class_next_hw', `${classCode}_${targetDate}`), {
            class_code: classCode,
            date: targetDate,
            domains
        }, { merge: true });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('다음숙제 저장 실패:', err);
        showSaveIndicator('error');
    }
}
const _nextHwWriter = createDebouncedWriter(_writeClassNextHw);

// 날짜 전환 전 예약된 저장을 원래 날짜에 즉시 확정한다.
async function flushPendingDailyWrites() {
    await _dailyWriter.flushAll();
    await _nextHwWriter.flushAll();
}

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, renderClassDetail,
    getClassTestSections;

export function initDataLayerDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    renderClassDetail = deps.renderClassDetail;
    getClassTestSections = deps.getClassTestSections;
}

// ─── Class Settings (영역 관리) ─────────────────────────────────────────────

export async function loadClassSettings(force = false) {
    if (state._classSettingsLoaded && !force) return;
    try {
        const snap = await getDocs(collection(db, 'class_settings'));
        state.classSettings = {};
        snap.forEach(d => { state.classSettings[d.id] = d.data(); });
        state._classSettingsLoaded = true;
    } catch (err) {
        console.error('[loadClassSettings]', err);
    }
}

export function getClassDomains(classCode) {
    return state.classSettings[classCode]?.domains || [...DEFAULT_DOMAINS];
}

// ─── Teachers (선생님 목록) ─────────────────────────────────────────────────

export async function loadTeachers() {
    try {
        const cutoff = Timestamp.fromDate(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));
        const q = query(collection(db, 'teachers'), where('last_login', '>=', cutoff));
        const snap = await getDocs(q);
        state.teachersList = [];
        snap.forEach(d => state.teachersList.push({ email: d.id, ...d.data() }));
        state.teachersList.sort((a, b) => getTeacherName(a.email).localeCompare(getTeacherName(b.email), 'ko'));
        console.log(`[loadTeachers] ${state.teachersList.length}명 (15일 내)`);
    } catch (err) {
        console.error('[loadTeachers] 실패:', err);
    }
}

export async function trackTeacherLogin(user) {
    if (!user?.email) return;
    try {
        await auditSet(doc(db, 'teachers', user.email), {
            email: user.email,
            display_name: user.displayName || staffLabel(user.email),
            photo_url: user.photoURL || '',
            last_login: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('Teacher login tracking failed:', err);
    }
}

export function getTeacherName(email) {
    return staffLabel(email);
}

// ─── Class Next Homework (반별 다음숙제) ────────────────────────────────────

export async function loadClassNextHw(date) {
    const q2 = query(collection(db, 'class_next_hw'), where('date', '==', date));
    const snap = await getDocs(q2);
    state.classNextHw = {};
    snap.forEach(d => {
        const data = d.data();
        state.classNextHw[data.class_code] = data;
    });
}

export function saveClassNextHw(classCode, domain, text, immediate = false) {
    const targetDate = state.selectedDate;
    // 로컬 상태 즉시 업데이트
    if (!state.classNextHw[classCode]) {
        state.classNextHw[classCode] = { class_code: classCode, date: targetDate, domains: {} };
    }
    state.classNextHw[classCode].domains[domain] = text;
    // 예약 시점 domains 스냅샷 — 발동 시 날짜가 바뀌어 교체된 state를 참조하지 않도록 고정
    const domains = { ...state.classNextHw[classCode].domains };
    const key = `${classCode}_${domain}_${targetDate}`;

    showSaveIndicator('saving');
    if (immediate) {
        _nextHwWriter.cancel(key);
        _writeClassNextHw({ classCode, targetDate, domains });
    } else {
        _nextHwWriter.request(key, { classCode, targetDate, domains });
    }
}

export function getNextHwStatus(classCode) {
    const domains = getClassDomains(classCode);
    const data = state.classNextHw[classCode]?.domains || {};
    const filled = domains.filter(d => {
        const v = (data[d] || '').trim();
        return v === '없음' || v.length > 0;
    }).length;
    return { filled, total: domains.length };
}

export function getStudentDomains(studentId) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return [...DEFAULT_DOMAINS];
    const domains = new Set();
    student.enrollments.forEach(e => {
        getClassDomains(enrollmentCode(e)).forEach(d => domains.add(d));
    });
    return domains.size > 0 ? [...domains] : [...DEFAULT_DOMAINS];
}

export function getStudentTestItems(studentId) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return { sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)), flat: [] };
    const merged = {};
    student.enrollments.forEach(e => {
        const sections = getClassTestSections(enrollmentCode(e));
        for (const [secName, items] of Object.entries(sections)) {
            if (!merged[secName]) merged[secName] = new Set();
            items.forEach(t => merged[secName].add(t));
        }
    });
    const sections = {};
    for (const [secName, itemSet] of Object.entries(merged)) {
        sections[secName] = [...itemSet];
    }
    if (Object.keys(sections).length === 0) {
        return { sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)), flat: [] };
    }
    const flat = Object.values(sections).flat();
    return { sections, flat };
}

// replace:true면 updateDoc으로 필드를 통째 교체 — schedule 같은 map은 setDoc merge의 deep-merge로 키 삭제가 안 되기 때문.
export async function saveClassSettings(classCode, data, { replace = false } = {}) {
    if (replace) {
        await auditUpdate(doc(db, 'class_settings', classCode), data);
    } else {
        await auditSet(doc(db, 'class_settings', classCode), data, { merge: true });
    }
    state.classSettings[classCode] = { ...state.classSettings[classCode], ...data };
}

// ─── Firebase CRUD ──────────────────────────────────────────────────────────

function _mergeSnapshots(...snaps) {
    const seenIds = new Set();
    const docs = [];
    for (const snap of snaps) {
        snap.docs.forEach(d => { if (!seenIds.has(d.id)) { seenIds.add(d.id); docs.push(d); } });
    }
    return docs;
}

function _applyStudentDocs(docs) {
    state.allStudents = [];
    docs.forEach(d => {
        const data = d.data();
        if (!data.enrollments?.length) {
            let levelSymbol = data.level_symbol || data.level_code || '';
            let classNumber = data.class_number || '';
            // Auto-correction: level_symbol에 숫자만 있으면 class_number로 이동
            if (/^\d+$/.test(levelSymbol) && !classNumber) {
                classNumber = levelSymbol;
                levelSymbol = '';
            }
            const day = normalizeDays(data.day);
            // 레거시 반배정 정보가 전혀 없으면(상담생 등) 합성하지 않는다 — class_type '정규' 둔갑 방지
            data.enrollments = (!levelSymbol && !classNumber && !data.class_type && !day.length) ? [] : [{
                class_type: data.class_type || '정규',
                level_symbol: levelSymbol,
                class_number: classNumber,
                day,
                start_date: data.start_date || ''
            }];
        } else {
            data.enrollments = data.enrollments.map(e => ({
                ...e,
                day: normalizeDays(e.day)
            }));
            // 중복 enrollment 제거 (같은 반코드+학기+수업종류+요일)
            const seen = new Set();
            data.enrollments = data.enrollments.filter(e => {
                const dayStr = (e.day || []).sort().join(',');
                const key = `${enrollmentCode(e)}_${e.semester || ''}_${e.class_type || '정규'}_${dayStr}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }
        state.allStudents.push({ docId: d.id, ...data });
    });
    state.allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
}

export async function loadStudents() {
    const q1 = query(collection(db, 'students'), where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원', '상담']));
    const q2 = query(collection(db, 'students'), where('status2', '==', '특강'));

    // 캐시 우선: 캐시 결과가 있으면 즉시 반영 후 서버에서 갱신
    try {
        const [c1, c2] = await Promise.all([getDocsFromCache(q1), getDocsFromCache(q2)]);
        if (c1.size + c2.size > 0) _applyStudentDocs(_mergeSnapshots(c1, c2));
    } catch { /* 캐시 없음 — 서버 로드로 계속 */ }

    try {
        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
        const allDocs = _mergeSnapshots(snap1, snap2);
        console.log('[loadStudents] 문서 수:', allDocs.length);
        _applyStudentDocs(allDocs);
    } catch (err) {
        console.error('[loadStudents] 로드 실패:', err.message, err);
        if (!state.allStudents.length) state.allStudents = [];
    }
}

export async function promoteEnrollPending() {
    if (READ_ONLY) return;
    const today = todayStr();
    try {
        const promoted = await _promoteEnrollPending(state.allStudents, today);
        promoted.forEach(s => { s.status = '재원'; });
        if (promoted.length > 0)
            console.log(`[promoteEnrollPending] ${promoted.length}명 등원예정→재원 전환:`, promoted.map(s => s.name));
    } catch (err) {
        console.error('[promoteEnrollPending] 전환 실패:', err);
    }
}

export async function backfillStudentNumbers() {
    if (READ_ONLY) return;
    const targets = state.allStudents.filter(s => ENROLLABLE_STATUSES.has(s.status) && !s.studentNumber);
    if (targets.length === 0) return;
    const assigned = new Set(state.allStudents.filter(s => s.studentNumber).map(s => studentNumberIdentityKey(s.name, s.studentNumber)));
    const batch = writeBatch(db);
    const pending = [];
    const duplicates = [];
    for (const s of targets) {
        const { studentNumber, source } = deriveStudentNumber(s);
        if (!studentNumber) continue;
        const key = studentNumberIdentityKey(s.name, studentNumber);
        if (!key) continue;
        if (assigned.has(key)) { duplicates.push(`${s.name} (#${studentNumber})`); continue; }
        assigned.add(key);
        batchUpdate(batch, doc(db, 'students', s.docId), { studentNumber, studentNumberSource: source, studentNumberIssuedAt: serverTimestamp() });
        pending.push({ s, studentNumber, source });
    }
    if (pending.length > 0) {
        try {
            await batch.commit();
            for (const { s, studentNumber, source } of pending) {
                s.studentNumber = studentNumber;
                s.studentNumberSource = source;
            }
            console.log(`[backfillStudentNumbers] ${pending.length}명 학생번호 발급`);
        } catch (err) {
            console.error('[backfillStudentNumbers] 실패:', err);
        }
    }
    if (duplicates.length > 0) {
        const msg = `이름+학생번호 중복 발생 — 수동 확인 필요: ${duplicates.join(', ')}`;
        console.warn('[backfillStudentNumbers]', msg);
        showToast(msg);
    }
}

// 미래 퇴원 예약 학생 중 퇴원일이 오늘 이하인 경우 Firestore status를 '퇴원'으로 업데이트.
// 단 status가 '재원' 또는 '등원예정'인 학생만 대상 — 가휴원/실휴원/상담으로 명시적 전환된
// 학생을 잔존 withdrawal_date 때문에 다시 퇴원으로 되돌리는 silent override 차단
// (전은민 케이스: 퇴원→휴원 후 다음 로그인 시 자동 되돌림 사고).
export async function cancelStudentPendingTasks(studentId) {
    const pendingHw   = state.hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const pendingTest = state.testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const openAbsence = state.absenceRecords.filter(r =>
        r.student_id === studentId && (r.status === 'open' || r.status === 'done') && (!r.resolution || r.resolution === 'pending')
    );
    if (!pendingHw.length && !pendingTest.length && !openAbsence.length) return;
    const cancelBatch = writeBatch(db);
    for (const t of pendingHw)   batchUpdate(cancelBatch, doc(db, 'hw_fail_tasks',   t.docId), { status: '취소' });
    for (const t of pendingTest) batchUpdate(cancelBatch, doc(db, 'test_fail_tasks',  t.docId), { status: '취소' });
    for (const r of openAbsence) batchUpdate(cancelBatch, doc(db, 'absence_records',  r.docId), { status: 'closed' });
    await cancelBatch.commit();
    pendingHw.forEach(t => { t.status = '취소'; });
    pendingTest.forEach(t => { t.status = '취소'; });
    openAbsence.forEach(r => { r.status = 'closed'; });
    console.log(`[cancelStudentPendingTasks] ${studentId}: hw=${pendingHw.length}, test=${pendingTest.length}, absence=${openAbsence.length}건 취소/종결`);
}

export async function promoteWithdrawalDate() {
    const today = todayStr();
    const ACTIVE_FOR_PROMOTE = new Set(['재원', '등원예정']);
    const toWithdraw = state.allStudents.filter(s =>
        ACTIVE_FOR_PROMOTE.has(s.status) && s.withdrawal_date && s.withdrawal_date <= today
    );
    if (toWithdraw.length === 0) return;
    const batch = writeBatch(db);
    for (const s of toWithdraw) {
        batchUpdate(batch, doc(db, 'students', s.docId), {
            status: '퇴원',
            enrollments: [],
            pre_withdrawal_status: deleteField()
        });
    }
    try {
        await batch.commit();
        if (READ_ONLY) return;
        toWithdraw.forEach(s => {
            s.status = '퇴원';
            s.enrollments = [];
            delete s.pre_withdrawal_status;
        });
        const toWithdrawSet = new Set(toWithdraw);
        state.allStudents = state.allStudents.filter(s => !toWithdrawSet.has(s));
        state.withdrawnStudents.push(...toWithdraw);
        console.log(`[promoteWithdrawalDate] ${toWithdraw.length}명 재원→퇴원 전환:`, toWithdraw.map(s => s.name));
        await Promise.all(toWithdraw.map(s => cancelStudentPendingTasks(s.docId)));
    } catch (err) {
        console.error('[promoteWithdrawalDate] 전환 실패:', err);
    }
}

// 미래 휴원 예약(scheduled_leave_status)의 시작일이 도래하면 status로 발효.
// promoteWithdrawalDate(미래 퇴원)와 대칭 — 서버 buildUpdate는 미래 휴원을 status 재원 유지 +
// scheduled_leave_status로 저장만 하고, 발효는 클라 promote가 담당한다. 발효 후 예약 필드는 제거.
export async function promoteScheduledLeave() {
    const today = todayStr();
    const ACTIVE_FOR_PROMOTE = new Set(['재원', '등원예정']);
    const toLeave = state.allStudents.filter(s =>
        ACTIVE_FOR_PROMOTE.has(s.status)
        && LEAVE_STATUSES.includes(s.scheduled_leave_status)
        && s.pause_start_date && s.pause_start_date <= today
    );
    if (toLeave.length === 0) return;
    const batch = writeBatch(db);
    for (const s of toLeave) {
        batchUpdate(batch, doc(db, 'students', s.docId), {
            status: s.scheduled_leave_status,
            scheduled_leave_status: deleteField(),
        });
    }
    try {
        await batch.commit();
        if (READ_ONLY) return;
        toLeave.forEach(s => { s.status = s.scheduled_leave_status; delete s.scheduled_leave_status; });
        console.log(`[promoteScheduledLeave] ${toLeave.length}명 예약 휴원 발효:`, toLeave.map(s => s.name));
    } catch (err) {
        console.error('[promoteScheduledLeave] 발효 실패:', err);
    }
}

export function loadDailyRecords(date) {
    const q = query(collection(db, 'daily_records'), where('date', '==', date));
    return _listenCollection('daily_records', q, null, (data) => {
        state.dailyRecords = {};
        data.forEach(d => { state.dailyRecords[d.student_id] = d; });
    });
}

export function loadRetakeSchedules() {
    const q = query(collection(db, 'retake_schedule'), where('status', '==', '예정'));
    const past = new Date();
    past.setDate(past.getDate() - 30);
    const pastStr = past.toISOString().slice(0, 10);
    return _listenCollection('retake_schedule', q, (d) => {
        const data = { docId: d.id, ...d.data() };
        return data.scheduled_date < pastStr ? null : data;
    }, (data) => { state.retakeSchedules = data; });
}

export function loadHwFailTasks() {
    // '취소'도 포함: 후속대책 카드가 closed read-only로 표시해 자동 reopen을 차단(45b93b9)하려면
    // state에 task가 남아 있어야 한다. 빠지면 빈 입력 필드로 다시 그려져 saveHwFailAction의
    // existing 가드가 안 걸리고 같은 docId로 pending이 덮어써짐.
    const q = query(collection(db, 'hw_fail_tasks'), where('status', 'in', ['pending', '완료', '취소', '기타']));
    return _listenCollection('hw_fail_tasks', q, null, (data) => { state.hwFailTasks = data; });
}

export function loadTestFailTasks() {
    const q = query(collection(db, 'test_fail_tasks'), where('status', 'in', ['pending', '완료', '취소', '기타']));
    return _listenCollection('test_fail_tasks', q, null, (data) => { state.testFailTasks = data; });
}

export function loadTempAttendances(date) {
    const q = query(collection(db, 'temp_attendance'), where('temp_date', '==', date));
    return _listenCollection('temp_attendance', q, null, (data) => { state.tempAttendances = data; });
}

export function loadTempClassOverrides(date) {
    const q = query(collection(db, 'temp_class_overrides'),
        where('override_date', '==', date),
        where('status', '==', 'active'));
    return _listenCollection('temp_class_overrides', q, null, (data) => { state.tempClassOverrides = data; });
}

// ─── Temp Class Override 헬퍼 ────────────────────────────────────────────────

export function getStudentOverrides(studentId, date) {
    return state.tempClassOverrides.filter(o => o.student_id === studentId && o.override_date === (date || state.selectedDate));
}

export function getOverrideStudentsForClass(classCode, date) {
    return state.tempClassOverrides.filter(o => o.target_class_code === classCode && o.override_date === (date || state.selectedDate));
}

export function getOverridingOutFromClass(classCode, date) {
    return state.tempClassOverrides.filter(o => o.original_class_code === classCode && o.override_date === (date || state.selectedDate));
}

export function addOverrideInStudents(students, classCodeFilter = null) {
    const studentIds = new Set(students.map(s => s.docId));
    state.tempClassOverrides.forEach(o => {
        if (classCodeFilter && o.target_class_code !== classCodeFilter) return;
        if (!studentIds.has(o.student_id)) {
            const s = state.allStudents.find(st => st.docId === o.student_id);
            if (s && s.status !== '퇴원') {
                students.push(s);
                studentIds.add(s.docId);
            }
        }
    });
}

export async function createTempClassOverride(studentId, targetClassCode, dates, reason) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;

    // 원래 반 코드 찾기
    const enrollments = getActiveEnrollments(student, state.selectedDate);
    const originalCode = enrollments.length > 0 ? enrollmentCode(enrollments[0]) : '';

    // 임시 반의 기본 시간 찾기
    const targetTime = state.classSettings[targetClassCode]?.default_time || '';

    showSaveIndicator('saving');
    try {
        const batch = writeBatch(db);
        for (const date of dates) {
            const docRef = doc(collection(db, 'temp_class_overrides'));
            batchSet(batch, docRef, {
                student_id: studentId,
                student_name: student.name || '',
                original_class_code: originalCode,
                target_class_code: targetClassCode,
                target_start_time: targetTime,
                override_date: date,
                reason: reason || '',
                status: 'active',
                created_by: state.currentUser?.email || '',
                created_at: serverTimestamp()
            });
        }
        await batch.commit();
        await loadTempClassOverrides(state.selectedDate);
        renderSubFilters();
        renderListPanel();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        if (state.currentCategory === 'class_mgmt' && state.selectedClassCode) renderClassDetail(state.selectedClassCode);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('타반수업 생성 실패:', err);
        showSaveIndicator('error');
    }
}

export async function cancelTempClassOverride(docId, studentId) {
    if (!confirm('이 타반수업을 취소하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'temp_class_overrides', docId), { status: 'cancelled' });
        await loadTempClassOverrides(state.selectedDate);
        renderSubFilters();
        renderListPanel();
        if (studentId && state.selectedStudentId === studentId) renderStudentDetail(studentId);
        if (state.currentCategory === 'class_mgmt' && state.selectedClassCode) renderClassDetail(state.selectedClassCode);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('타반수업 취소 실패:', err);
        showSaveIndicator('error');
    }
}

export function loadAbsenceRecords() {
    const q = query(collection(db, 'absence_records'), where('status', 'in', ['open', 'done']));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return _listenCollection('absence_records', q, (d) => {
        const data = { docId: d.id, ...d.data() };
        if (data.absence_date < cutoffStr) return null;
        // 비재원(퇴원·종강) 제외 — allStudents 부재 기준.
        // withdrawnStudents가 아니라 allStudents를 보는 이유: 퇴원생 로드는 idle 지연이라
        // 타이밍에 의존하면 안 되고, live 조회라 학생 증감도 즉시 반영된다.
        if (!state.allStudents.some(s => s.docId === data.student_id)) return null;
        return data;
    }, (data) => { state.absenceRecords = data; });
}

// ─── 실시간 리스너 공통 인프라 ────────────────────────────────────────────────
const _unsubs = {};   // 컬렉션별 unsubscribe 함수
let _rtDebounce = null;

function _isDetailInputFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    // detail-content 우선 — 기록(docu) 탭(#docu-tab)은 #detail-cards의 형제라
    // detail-cards 기준이면 docu 입력 중에도 가드가 작동하지 않아 재렌더로 입력이 유실된다.
    const detailPanel = document.getElementById('detail-content') || document.getElementById('detail-cards');
    return !!detailPanel && detailPanel.contains(el);
}

function _realtimeRefreshUI() {
    if (_rtDebounce) return;
    _rtDebounce = setTimeout(() => {
        _rtDebounce = null;
        renderSubFilters();
        renderListPanel();
        // 상세패널을 incremental로 재렌더한다. 카드 HTML이 직전과 같으면(다른 사람의 무관한
        // 쓰기) 교체를 건너뛰어 깜빡임을 막고, 비-daily 탭 콘텐츠(기록/상담/성적/메시지)는
        // studentChanged·!incremental 가드로 재생성되지 않아 그대로 보존된다. 동시에 daily
        // 카드와 프로필 헤더는 매번 최신화되어 탭 복귀 시 stale이 없다.
        // (입력 포커스 중이면 건너뜀 — 입력 내용 유실 방지)
        if (state.selectedStudentId && !_isDetailInputFocused()) {
            renderStudentDetail(state.selectedStudentId, { incremental: true });
        }
    }, 200);
}

function _listenCollection(key, q, parser, onData) {
    return new Promise((resolve) => {
        if (_unsubs[key]) { _unsubs[key](); delete _unsubs[key]; }
        let initialLoad = true;

        _unsubs[key] = onSnapshot(q, (snap) => {
            const results = [];
            snap.forEach(d => {
                const parsed = parser ? parser(d) : { docId: d.id, ...d.data() };
                if (parsed) results.push(parsed);
            });
            onData(results);

            if (initialLoad) {
                initialLoad = false;
                resolve();
            } else {
                _realtimeRefreshUI();
            }
        }, (err) => {
            console.error(`[${key}] 실시간 리스너 실패:`, err.message);
            resolve();
        });
    });
}

export function loadLeaveRequests() {
    const q = query(collection(db, 'leave_requests'), where('status', 'in', ['requested', 'approved', 'cancelled']));
    return _listenCollection('leave_requests', q, null, (data) => { state.leaveRequests = data; });
}

// ─── 1개월 경과 자동 처리 ────────────────────────────────────────────────────

export function _toDate(timestamp) {
    if (!timestamp) return null;
    if (timestamp.toDate) return timestamp.toDate();
    // "YYYY-MM-DD" 문자열은 UTC로 파싱되므로 KST 변환
    if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
        return parseDateKST(timestamp);
    }
    return new Date(timestamp);
}

export function _isOlderThan(timestamp, { days, months } = {}) {
    const d = _toDate(timestamp);
    if (!d) return false;
    const cutoff = new Date();
    if (months) cutoff.setMonth(cutoff.getMonth() - months);
    if (days) cutoff.setDate(cutoff.getDate() - days);
    return d < cutoff;
}

export async function syncTaskStudentNames() {
    const nameMap = new Map(state.allStudents.map(s => [s.docId, s.name]));
    const updates = [];
    for (const t of state.hwFailTasks) {
        const realName = nameMap.get(t.student_id);
        if (realName && realName !== t.student_name) {
            updates.push({ col: 'hw_fail_tasks', docId: t.docId, name: realName, task: t });
        }
    }
    for (const t of state.testFailTasks) {
        const realName = nameMap.get(t.student_id);
        if (realName && realName !== t.student_name) {
            updates.push({ col: 'test_fail_tasks', docId: t.docId, name: realName, task: t });
        }
    }
    for (const r of state.absenceRecords) {
        const realName = nameMap.get(r.student_id);
        if (realName && realName !== r.student_name) {
            updates.push({ col: 'absence_records', docId: r.docId, name: realName, task: r });
        }
    }
    if (updates.length === 0) return;
    console.log(`[syncTaskStudentNames] ${updates.length}건 이름 동기화`);
    for (const u of updates) {
        try {
            await auditUpdate(doc(db, u.col, u.docId), { student_name: u.name });
            u.task.student_name = u.name;
        } catch (err) {
            console.error('이름 동기화 실패:', u.col, u.docId, err);
        }
    }
}

export async function autoCloseOldRecords() {
    // 결석대장: 1개월 경과 → 행정완료
    const oldAbsences = state.absenceRecords.filter(r => r.status === 'open' && _isOlderThan(r.created_at, { months: 1 }));
    for (const r of oldAbsences) {
        try {
            await auditUpdate(doc(db, 'absence_records', r.docId), {
                status: 'closed'
            });
        } catch (err) {
            console.error('결석대장 자동종료 실패:', r.docId, err);
        }
    }
    if (oldAbsences.length > 0) {
        if (!READ_ONLY) {
            state.absenceRecords = state.absenceRecords.filter(r => !oldAbsences.includes(r));
        }
        console.log(`결석대장 자동 행정완료${READ_ONLY ? ' 시뮬레이션' : ''}: ${oldAbsences.length}건`);
    }

    // 휴퇴원요청은 자동승인하지 않는다(이전: 1개월 경과 시 system_auto 승인).
    // 장기 미처리 요청은 승인 대신 목록에서 경고 뱃지로 노출해 수동 처리를 유도한다(_leaveRequestStatusBadge).

    // 숙제미통과/테스트미통과 등원: 1개월 경과 pending → 자동 기타 처리
    const oldHwTasks = state.hwFailTasks.filter(t => t.status === 'pending' && t.scheduled_date && _isOlderThan(t.scheduled_date, { months: 1 }));
    for (const t of oldHwTasks) {
        try {
            await auditUpdate(doc(db, 'hw_fail_tasks', t.docId), {
                status: '기타',
                completed_by: 'system_auto',
                completed_at: new Date().toISOString()
            });
            if (!READ_ONLY) t.status = '기타';
        } catch (err) {
            console.error('숙제미통과 자동종료 실패:', t.docId, err);
        }
    }
    if (oldHwTasks.length > 0) console.log(`숙제미통과 등원 자동 기타처리: ${oldHwTasks.length}건`);

    const oldTestTasks = state.testFailTasks.filter(t => t.status === 'pending' && t.scheduled_date && _isOlderThan(t.scheduled_date, { months: 1 }));
    for (const t of oldTestTasks) {
        try {
            await auditUpdate(doc(db, 'test_fail_tasks', t.docId), {
                status: '기타',
                completed_by: 'system_auto',
                completed_at: new Date().toISOString()
            });
            if (!READ_ONLY) t.status = '기타';
        } catch (err) {
            console.error('테스트미통과 자동종료 실패:', t.docId, err);
        }
    }
    if (oldTestTasks.length > 0) console.log(`테스트미통과 등원 자동 기타처리: ${oldTestTasks.length}건`);

    // 결석대장 중복 제거: 같은 학생+같은 날짜에 open 건이 여러 개인 경우 입력된 건 유지, 나머지 삭제
    const absenceMap = new Map();
    for (const r of state.absenceRecords) {
        const key = `${r.student_id}_${r.absence_date}`;
        if (!absenceMap.has(key)) absenceMap.set(key, []);
        absenceMap.get(key).push(r);
    }
    const dupsToRemove = [];
    for (const [, group] of absenceMap) {
        if (group.length <= 1) continue;
        // 입력된 건(상담내용/사유/정당부당 중 하나라도 있는 건) 우선 유지
        group.sort((a, b) => {
            const aFilled = (a.consultation_note || a.reason || a.reason_valid || a.consultation_done) ? 1 : 0;
            const bFilled = (b.consultation_note || b.reason || b.reason_valid || b.consultation_done) ? 1 : 0;
            return bFilled - aFilled; // 입력된 건이 앞으로
        });
        // 첫 번째(가장 많이 입력된 건)만 유지, 나머지 삭제
        for (let i = 1; i < group.length; i++) {
            dupsToRemove.push(group[i]);
        }
    }
    for (const r of dupsToRemove) {
        try {
            await auditUpdate(doc(db, 'absence_records', r.docId), {
                status: 'closed'
            });
        } catch (err) {
            console.error('중복 결석대장 정리 실패:', r.docId, err);
        }
    }
    if (dupsToRemove.length > 0) {
        if (!READ_ONLY) {
            state.absenceRecords = state.absenceRecords.filter(r => !dupsToRemove.includes(r));
        }
        console.log(`결석대장 중복 정리: ${dupsToRemove.length}건 제거`);
    }

    // class_code 중복 정리: "HS201, HS201" → "HS201"
    const dedupClassCodeRecords = state.absenceRecords.filter(r => {
        if (!r.class_code) return false;
        const parts = r.class_code.split(',').map(s => s.trim()).filter(Boolean);
        return parts.length !== new Set(parts).size;
    });
    for (const r of dedupClassCodeRecords) {
        const fixed = [...new Set(r.class_code.split(',').map(s => s.trim()).filter(Boolean))].join(', ');
        try {
            await auditUpdate(doc(db, 'absence_records', r.docId), { class_code: fixed });
            if (!READ_ONLY) r.class_code = fixed;
        } catch (err) {
            console.error('class_code 중복 정리 실패:', r.docId, err);
        }
    }
    if (dedupClassCodeRecords.length > 0) {
        console.log(`class_code 중복 정리: ${dedupClassCodeRecords.length}건`);
    }
}

// 퇴원생 전체 로드 (1.5만+건 — 시스템 전반이 비원생 포함 전제라 전체 적재 필요).
// 첫 조작(학생 클릭) 응답성을 지키기 위해:
//  1) IndexedDB 캐시를 먼저 통째로 적용 — 재방문 시 네트워크 전에 기능 가용
//  2) 서버 갱신은 청크 분할(2,500건 + 사이마다 yield)로 메인스레드 블로킹 분산
// 동시 호출 가드: 진행 중 로드를 공유해 배열 리셋·interleave 방지.
const WITHDRAWN_CHUNK = 2500;
let _withdrawnLoading = null;
export function loadWithdrawnStudents() {
    if (_withdrawnLoading) return _withdrawnLoading;
    _withdrawnLoading = (async () => {
        const baseQ = query(collection(db, 'students'), where('status', '==', '퇴원'));
        try {
            try {
                const cached = await getDocsFromCache(baseQ);
                if (cached.size > 0) {
                    // 1.5만 건 d.data() 역직렬화도 한 방이면 메인스레드를 수백 ms 막는다 — 분할
                    const arr = [];
                    for (let i = 0; i < cached.docs.length; i += WITHDRAWN_CHUNK) {
                        cached.docs.slice(i, i + WITHDRAWN_CHUNK).forEach(d => arr.push({ docId: d.id, ...d.data() }));
                        if (i + WITHDRAWN_CHUNK < cached.docs.length) await new Promise(r => setTimeout(r, 50));
                    }
                    state.withdrawnStudents = arr;
                    state._withdrawnFullyLoaded = true;
                }
            } catch { /* 캐시 없음 — 서버 로드로 계속 */ }

            const fresh = [];
            let cursor = null;
            for (;;) {
                const parts = [where('status', '==', '퇴원'), orderBy(documentId()), limit(WITHDRAWN_CHUNK)];
                if (cursor) parts.push(startAfter(cursor));
                const snap = await getDocs(query(collection(db, 'students'), ...parts));
                snap.forEach(d => fresh.push({ docId: d.id, ...d.data() }));
                if (snap.size < WITHDRAWN_CHUNK) break;
                cursor = snap.docs[snap.docs.length - 1];
                await new Promise(r => setTimeout(r, 50));
            }
            state.withdrawnStudents = fresh;
            state._withdrawnFullyLoaded = true;
        } catch (err) {
            console.error('퇴원 학생 로드 실패:', err.message);
        } finally {
            _withdrawnLoading = null;
        }
    })();
    return _withdrawnLoading;
}

export function saveDailyRecord(studentId, updates) {
    const targetDate = state.selectedDate;
    showSaveIndicator('saving');
    _dailyWriter.request(`${studentId}_${targetDate}`, { studentId, targetDate, updates });
}

export async function saveRetakeSchedule(data) {
    showSaveIndicator('saving');
    try {
        const docRef = await auditAdd(collection(db, 'retake_schedule'), {
            ...data,
            created_by: state.currentUser.email,
            created_at: serverTimestamp()
        });
        state.retakeSchedules.push({ docId: docRef.id, ...data });
        showSaveIndicator('saved');
        return docRef.id;
    } catch (err) {
        console.error('일정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// silent: 사용자가 명시적으로 저장한 게 아닌 백그라운드 캐시 동기화(예: 체크리스트 캐시
// backfill)는 인디케이터를 띄우지 않는다. 단순 조회에 "저장 완료"가 떠 오해를 주는 것 방지.
export async function saveImmediately(studentId, updates, { silent = false } = {}) {
    if (!silent) showSaveIndicator('saving');
    const targetDate = state.selectedDate;
    try {
        await _persistDailyRecord(studentId, targetDate, updates);
        _applyDailyCache(studentId, targetDate, updates);
        if (!silent) showSaveIndicator('saved');
    } catch (err) {
        console.error('저장 실패:', err);
        if (!silent) showSaveIndicator('error');
        throw err;   // F-04: 실패를 호출자에게 전파 (optimistic rollback/재시도는 호출자 책임)
    }
}

// ─── Date navigation ──────────────────────────────────────────────────────��─

export function updateDateDisplay() {
    const dayName = getDayName(state.selectedDate);
    document.getElementById('date-text').textContent = `${state.selectedDate} (${dayName})`;

    // 오늘이 아닌 날짜는 출결 오입력 방지를 위해 날짜 칩 강조 + 배너 표시
    // 배너는 날짜 민감 카테고리에서만 — 행정·소속 등에서는 경고 피로만 유발
    const DATE_SENSITIVE_CATEGORIES = ['attendance', 'homework', 'test', 'automation'];
    const today = todayStr();
    const isToday = state.selectedDate === today;
    document.getElementById('date-display')?.classList.toggle('not-today', !isToday);
    const banner = document.getElementById('not-today-banner');
    if (banner) {
        const showBanner = !isToday && DATE_SENSITIVE_CATEGORIES.includes(state.currentCategory);
        banner.style.display = showBanner ? '' : 'none';
        if (showBanner) {
            const rel = state.selectedDate < today ? '과거' : '미래';
            document.getElementById('not-today-banner-text').textContent =
                `${rel} 날짜 ${state.selectedDate} (${dayName}) 기록을 보고 있습니다`;
        }
    }
}

export async function reloadForDate() {
    await flushPendingDailyWrites();   // 예약된 저장을 원래(이전) 날짜에 확정한 뒤 새 날짜 로드
    updateDateDisplay();   // 데이터 로드를 기다리지 않고 날짜 칩/배너 즉시 갱신
    state._visitStatusPending = {};

    await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadRoleMemos(), loadClassNextHw(state.selectedDate), loadClassSettings(), loadTeachers()]);
    await syncAbsenceRecords();
    state.selectedNextHwClass = null;
    renderSubFilters();
    renderListPanel();
    if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
}

export function changeDate(delta) {
    const d = parseDateKST(state.selectedDate);
    d.setDate(d.getDate() + delta);
    state.selectedDate = toDateStrKST(d);
    reloadForDate();
}

export function openDatePicker() {
    openKoreanDatePicker(document.getElementById('date-display'), state.selectedDate, (dateStr) => {
        state.selectedDate = dateStr;
        reloadForDate();
    });
}

export function goToday() {
    state.selectedDate = todayStr();
    reloadForDate();
}

// ─── deps for reloadForDate ──────────────────��──────────────────────────────
let loadRoleMemos, syncAbsenceRecords;

export function initDataLayerDeps2(deps) {
    loadRoleMemos = deps.loadRoleMemos;
    syncAbsenceRecords = deps.syncAbsenceRecords;
}

// =========================================================================
// 상담 데이터 헬퍼 (consultation-card.js 가 사용)
// =========================================================================
export async function addConsultation(data) {
  // data: { student_id, student_name, teacher_id, teacher_name, date, consultation_type, text }
  const payload = {
    ...data,
    ai_processed: false,
    ai_processed_at: null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  };
  // consultation_id 필드는 저장하지 않음 — doc.id가 곧 consultation_id (spec 4.1)
  const ref = await auditAdd(collection(db, 'consultations'), payload);
  return ref?.id;
}

// 제목만 갱신 (백그라운드 AI 제목용). update rule: 본인 + 24h 이내 + title은 허용 키.
export async function updateConsultationTitle(cid, title) {
  await auditUpdate(doc(db, 'consultations', cid), { title });
}

export async function getStudentSummary(studentId) {
  const snap = await getDoc(doc(db, 'consultation_summaries', studentId));
  return snap.exists() ? snap.data() : null;
}

export async function getStudentBriefing(studentId) {
  const snap = await getDoc(doc(db, 'consultation_briefings', studentId));
  return snap.exists() ? snap.data() : null;
}

export async function getStudentStatusSummary(studentId) {
  const snap = await getDoc(doc(db, 'student_status_summaries', studentId));
  return snap.exists() ? snap.data() : null;
}

// 종합상태·상담요약·브리핑을 단일 호출로 생성 → 3개 컬렉션 갱신.
export async function generateStudentReportAi(studentId) {
  const callable = httpsCallable(functions, 'generateStudentReportAi');
  const res = await callable({ studentId });
  return res.data;
}

// ─── 학생 상세 '메시지' 탭: 개별 발송 ─────────────────────────────────────────
// 정보성 안내(알림톡 템플릿). 동의·야간 제한 없음. 서버에서 직원 권한 검증.
export async function sendParentNotice(payload) {
  const callable = httpsCallable(functions, 'sendParentNotice');
  const res = await callable(payload);
  return res.data;
}

// 개별 홍보(브랜드 메시지). studentIds 1명으로 캠페인 재사용. 서버에서 원장 권한·광고 규제 검증.
export async function createPromoCampaign(payload) {
  const callable = httpsCallable(functions, 'createPromoCampaign');
  const res = await callable(payload);
  return res.data;
}

// 임의 번호 정보성 SMS 즉석 발송(메시지 센터 ③블록).
export async function sendDirectMessage(payload) {
  const callable = httpsCallable(functions, 'sendDirectMessage');
  const res = await callable(payload);
  return res.data;
}

// 정보성 대용량 발송(메시지 센터 ②블록, 직원 권한).
export async function createBulkMessage(payload) {
  const callable = httpsCallable(functions, 'createBulkMessage');
  const res = await callable(payload);
  return res.data;
}

// 일일 학습 리포트 발송(직원 권한). 친구→정보형 BMS, 비친구→가입안내 SMS.
export async function sendDailyReport(payload) {
  const callable = httpsCallable(functions, 'sendDailyReport');
  const res = await callable(payload);
  return res.data;
}

// 카카오 채널 친구목록 업로드 동기화 / 조회(직원 권한).
export async function syncChannelFriends(payload) {
  const callable = httpsCallable(functions, 'syncChannelFriends');
  const res = await callable(payload);
  return res.data;
}
export async function getChannelFriends() {
  const callable = httpsCallable(functions, 'getChannelFriends');
  const res = await callable({});
  return res.data;
}

// 학생별 발송 내역(message_logs 최신순).
export async function getStudentMessages(studentId) {
  const callable = httpsCallable(functions, 'getStudentMessages');
  const res = await callable({ studentId });
  return res.data;
}

// ─── AI 자동화 설정 (automation_settings/student_report) ──────────────────────
// director 등급 이상만 read/write 가능 (rules: canRunAiBatch). 문서 없으면 null → UI 기본값.
// 문서 경로/필드/콜러블명은 배포된 functions-shared 백엔드 계약에 맞춘다.
const AI_AUTO_DOC = ['automation_settings', 'student_report'];

export async function getAiAutomationSettings() {
  const snap = await getDoc(doc(db, ...AI_AUTO_DOC));
  return snap.exists() ? snap.data() : null;
}

// 진행상태/마지막 실행 결과 실시간 구독. cb(data|null) 형태로 호출. unsubscribe 함수를 반환한다.
// batch_active/progress_*/last_run_*은 서버가 갱신하는 읽기 전용 필드.
export function subscribeAiAutomationSettings(cb) {
  return onSnapshot(
    doc(db, ...AI_AUTO_DOC),
    (snap) => cb(snap.exists() ? snap.data() : null),
    (err) => { console.warn('[ai-automation] 구독 오류:', err?.code || err?.message); cb(null); }
  );
}

// 클라가 patch하는 필드는 enabled/interval/run_day/run_hour/skip_within_days 뿐.
// updated_by/updated_at은 auditSet이 자동 추가. batch_active/progress_*/last_run_*는 서버 갱신이라 보내지 않는다.
export async function saveAiAutomationSettings(patch) {
  await auditSet(doc(db, ...AI_AUTO_DOC), patch, { merge: true });
}

// 수동 '지금 실행' — 배포된 콜러블 runStudentReportBatchManual(asia-northeast3) 호출.
// 응답: {ok:true, status:'in_progress'|'complete', done, total, generated, skipped, total_tokens}
//   | {ok:false, reason:'locked'}. 권한 없음/미인증은 HttpsError로 throw → 호출측 catch.
// status:'in_progress'면 첫 청크만 끝났고 scheduled 틱이 이어받는다. timeout은 청크 1회 기준으로 충분(10분 여유).
export async function runStudentReportBatchManual(opts = {}) {
  const callable = httpsCallable(functions, 'runStudentReportBatchManual', { timeout: 600000 });
  const res = await callable(opts);
  return res.data;
}

export async function listStudentConsultations(studentId, limitCount = 10) {
  const q = query(
    collection(db, 'consultations'),
    where('student_id', '==', studentId),
    orderBy('date', 'desc'),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// 하이브리드: 기간 지정 시 Firestore date 범위 쿼리, 미지정 시 최근 N건(listStudentConsultations 재사용).
// 키워드 필터는 호출측(consultation-card)에서 filterConsultationsByKeyword로 처리.
export async function searchStudentConsultations(studentId, { startDate, endDate, limitCount = DEFAULT_HISTORY_LIMIT } = {}) {
  const hasRange = Boolean(startDate || endDate);
  if (!hasRange) {
    return listStudentConsultations(studentId, limitCount);
  }
  const clauses = [where('student_id', '==', studentId)];
  if (startDate) clauses.push(where('date', '>=', startDate));
  if (endDate)   clauses.push(where('date', '<=', endDate));
  const q = query(collection(db, 'consultations'), ...clauses, orderBy('date', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── 상담 고정(pin): consultation_pins/{cid} (doc id = consultation id) ───
export async function listStudentPins(studentId) {
  const q = query(collection(db, 'consultation_pins'), where('student_id', '==', studentId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.id);
}

export async function pinConsultation(cid, studentId, teacherId) {
  await auditSet(doc(db, 'consultation_pins', cid), {
    consultation_id: cid,
    student_id: studentId,
    teacher_id: teacherId,
    pinned_at: serverTimestamp(),
  });
}

export async function unpinConsultation(cid) {
  await auditDelete(doc(db, 'consultation_pins', cid));
}

// ─── Data Layer Module ──────────────────────────────────────────────────────
// daily-ops.js에서 추출한 Firebase 데이터 로드/저장 함수
// Phase 4-1

import {
    collection, getDocs, doc, getDoc,
    query, where, serverTimestamp, writeBatch, Timestamp,
    onSnapshot
} from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet, auditAdd, batchUpdate, batchSet } from './audit.js';
import { parseDateKST, toDateStrKST, todayStr, getDayName } from './src/shared/firestore-helpers.js';
import { state, DEFAULT_DOMAINS } from './state.js';
import { showSaveIndicator } from './ui-utils.js';
import { normalizeDays, enrollmentCode, branchFromStudent, makeDailyRecordId, getActiveEnrollments } from './student-helpers.js';

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

// state._classSettingsLoaded → state._classSettingsLoaded
export async function loadClassSettings(force = false) {
    if (state._classSettingsLoaded && !force) return;
    const snap = await getDocs(collection(db, 'class_settings'));
    state.classSettings = {};
    snap.forEach(d => { state.classSettings[d.id] = d.data(); });
    state._classSettingsLoaded = true;
}

export function getClassDomains(classCode) {
    return state.classSettings[classCode]?.domains || [...DEFAULT_DOMAINS];
}

// ─── Teachers (선생님 목록) ─────────────────────────────────────────────────

export async function loadTeachers() {
    const oneWeekAgo = Timestamp.fromDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const q = query(collection(db, 'teachers'), where('last_login', '>=', oneWeekAgo));
    const snap = await getDocs(q);
    state.teachersList = [];
    snap.forEach(d => state.teachersList.push({ email: d.id, ...d.data() }));
    state.teachersList.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email, 'ko'));
}

export async function trackTeacherLogin(user) {
    if (!user?.email) return;
    try {
        await auditSet(doc(db, 'teachers', user.email), {
            email: user.email,
            display_name: user.displayName || user.email.split('@')[0],
            photo_url: user.photoURL || '',
            last_login: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('Teacher login tracking failed:', err);
    }
}

export function getTeacherName(email) {
    if (!email) return '';
    return email.split('@')[0];
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
    const timerKey = `${classCode}_${domain}`;
    if (state.nextHwSaveTimers[timerKey]) clearTimeout(state.nextHwSaveTimers[timerKey]);

    // 로컬 상태 즉시 업데이트
    if (!state.classNextHw[classCode]) {
        state.classNextHw[classCode] = { class_code: classCode, date: state.selectedDate, domains: {} };
    }
    state.classNextHw[classCode].domains[domain] = text;

    const doSave = async () => {
        showSaveIndicator('saving');
        try {
            const docId = `${classCode}_${state.selectedDate}`;
            await auditSet(doc(db, 'class_next_hw', docId), {
                class_code: classCode,
                date: state.selectedDate,
                domains: state.classNextHw[classCode].domains
            }, { merge: true });
            showSaveIndicator('saved');
        } catch (err) {
            console.error('다음숙제 저장 실패:', err);
            showSaveIndicator('error');
        }
    };

    if (immediate) {
        doSave();
    } else {
        state.nextHwSaveTimers[timerKey] = setTimeout(doSave, 2000);
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
    const DEFAULT_TEST_SECTIONS = {
        '기반학습테스트': ['Vo', 'Id', 'ISC'],
        '리뷰테스트': []
    };
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

export async function saveClassSettings(classCode, data) {
    await auditSet(doc(db, 'class_settings', classCode), data, { merge: true });
    state.classSettings[classCode] = { ...state.classSettings[classCode], ...data };
}

// ─── Firebase CRUD ──────────────────────────────────────────────────────────

export async function loadStudents() {
    let snap;
    try {
        const [snap1, snap2] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원', '상담']))),
            getDocs(query(collection(db, 'students'), where('status2', '==', '특강')))
        ]);
        const seenIds = new Set();
        const allDocs = [];
        const dedup = d => { if (!seenIds.has(d.id)) { seenIds.add(d.id); allDocs.push(d); } };
        snap1.docs.forEach(dedup);
        snap2.docs.forEach(dedup);
        snap = allDocs;
        console.log('[loadStudents] 문서 수:', allDocs.length);
    } catch (err) {
        console.error('[loadStudents] 로드 실패:', err.message, err);
        state.allStudents = [];
        return;
    }
    state.allStudents = [];
    snap.forEach(d => {
        const data = d.data();
        if (!data.enrollments?.length) {
            let levelSymbol = data.level_symbol || data.level_code || '';
            let classNumber = data.class_number || '';
            // Auto-correction: level_symbol에 숫자만 있으면 class_number로 이동
            if (/^\d+$/.test(levelSymbol) && !classNumber) {
                classNumber = levelSymbol;
                levelSymbol = '';
            }
            data.enrollments = [{
                class_type: data.class_type || '정규',
                level_symbol: levelSymbol,
                class_number: classNumber,
                day: normalizeDays(data.day),
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

export async function promoteEnrollPending() {
    const today = todayStr();
    const pending = state.allStudents.filter(s =>
        s.status === '등원예정' &&
        (s.enrollments || []).some(e => e.start_date && e.start_date <= today)
    );
    if (pending.length === 0) return;
    const batch = writeBatch(db);
    for (const s of pending) {
        batchUpdate(batch, doc(db, 'students', s.docId), { status: '재원' });
        s.status = '재원';
    }
    try {
        await batch.commit();
        console.log(`[promoteEnrollPending] ${pending.length}명 등원예정→재원 전환:`, pending.map(s => s.name));
    } catch (err) {
        console.error('[promoteEnrollPending] 전환 실패:', err);
    }
}

// 미래 퇴원 예약 학생 중 퇴원일이 오늘 이하인 경우 Firestore status를 '퇴원'으로 업데이트
export async function promoteWithdrawalDate() {
    const today = todayStr();
    const toWithdraw = state.allStudents.filter(s =>
        s.status !== '퇴원' && s.withdrawal_date && s.withdrawal_date <= today
    );
    if (toWithdraw.length === 0) return;
    const batch = writeBatch(db);
    for (const s of toWithdraw) {
        batchUpdate(batch, doc(db, 'students', s.docId), { status: '퇴원' });
        s.status = '퇴원';
    }
    try {
        await batch.commit();
        const toWithdrawSet = new Set(toWithdraw);
        state.allStudents = state.allStudents.filter(s => !toWithdrawSet.has(s));
        state.withdrawnStudents.push(...toWithdraw);
        console.log(`[promoteWithdrawalDate] ${toWithdraw.length}명 재원→퇴원 전환:`, toWithdraw.map(s => s.name));
    } catch (err) {
        console.error('[promoteWithdrawalDate] 전환 실패:', err);
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
    const q = query(collection(db, 'hw_fail_tasks'), where('status', 'in', ['pending', '완료', '기타']));
    return _listenCollection('hw_fail_tasks', q, null, (data) => { state.hwFailTasks = data; });
}

export function loadTestFailTasks() {
    const q = query(collection(db, 'test_fail_tasks'), where('status', 'in', ['pending', '완료', '기타']));
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
    const q = query(collection(db, 'absence_records'), where('status', '==', 'open'));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return _listenCollection('absence_records', q, (d) => {
        const data = { docId: d.id, ...d.data() };
        if (data.absence_date < cutoffStr) return null;
        const withdrawnIds = new Set(state.withdrawnStudents.map(s => s.docId));
        if (withdrawnIds.has(data.student_id)) return null;
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
    const detailPanel = document.getElementById('detail-cards') || document.getElementById('detail-content');
    return detailPanel && detailPanel.contains(el);
}

function _realtimeRefreshUI() {
    if (_rtDebounce) return;
    _rtDebounce = setTimeout(() => {
        _rtDebounce = null;
        renderSubFilters();
        renderListPanel();
        // 상세패널 입력 중이면 리렌더 건너뜀 (입력 내용 유실 방지)
        if (state.selectedStudentId && !_isDetailInputFocused()) {
            renderStudentDetail(state.selectedStudentId);
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
                console.log(`[${key}] 실시간 업데이트 수신`);
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
    const oldAbsences = state.absenceRecords.filter(r => _isOlderThan(r.created_at, { months: 1 }));
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
        state.absenceRecords = state.absenceRecords.filter(r => !oldAbsences.includes(r));
        console.log(`결석대장 자동 행정완료: ${oldAbsences.length}건`);
    }

    // 휴퇴원요청: 1개월 경과 requested → 자동승인
    const oldRequests = state.leaveRequests.filter(r =>
        r.status === 'requested' && _isOlderThan(r.requested_at, { months: 1 })
    );
    for (const r of oldRequests) {
        try {
            const updates = {
                status: 'approved',
                approved_by: 'system_auto',
                approved_at: serverTimestamp()
            };
            if (!r.teacher_approved_by) {
                updates.teacher_approved_by = 'system_auto';
                updates.teacher_approved_at = serverTimestamp();
            }
            await auditUpdate(doc(db, 'leave_requests', r.docId), updates);
            r.status = 'approved';
            if (!r.teacher_approved_by) r.teacher_approved_by = 'system_auto';
            if (!r.approved_by) r.approved_by = 'system_auto';
            // 학생 status 실제 변경은 Cloud Function(onLeaveRequestApproved)이 처리
        } catch (err) {
            console.error('휴퇴원요청 자동승인 실패:', r.docId, err);
        }
    }
    if (oldRequests.length > 0) {
        console.log(`휴퇴원요청 자동 승인 + 학생 상태 변경: ${oldRequests.length}건`);
    }

    // 숙제미통과/테스트미통과 등원: 1개월 경과 pending → 자동 기타 처리
    const oldHwTasks = state.hwFailTasks.filter(t => t.status === 'pending' && t.scheduled_date && _isOlderThan(t.scheduled_date, { months: 1 }));
    for (const t of oldHwTasks) {
        try {
            await auditUpdate(doc(db, 'hw_fail_tasks', t.docId), {
                status: '기타',
                completed_by: 'system_auto',
                completed_at: new Date().toISOString()
            });
            t.status = '기타';
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
            t.status = '기타';
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
        state.absenceRecords = state.absenceRecords.filter(r => !dupsToRemove.includes(r));
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
            r.class_code = fixed;
        } catch (err) {
            console.error('class_code 중복 정리 실패:', r.docId, err);
        }
    }
    if (dedupClassCodeRecords.length > 0) {
        console.log(`class_code 중복 정리: ${dedupClassCodeRecords.length}건`);
    }
}

export async function loadWithdrawnStudents() {
    state.withdrawnStudents = [];
    try {
        const q = query(collection(db, 'students'), where('status', '==', '퇴원'));
        const snap = await getDocs(q);
        snap.forEach(d => state.withdrawnStudents.push({ docId: d.id, ...d.data() }));
    } catch (err) {
        console.error('퇴원 학생 로드 실패:', err.message);
    }
}

export function saveDailyRecord(studentId, updates) {
    if (state.saveTimers[studentId]) clearTimeout(state.saveTimers[studentId]);
    showSaveIndicator('saving');

    state.saveTimers[studentId] = setTimeout(async () => {
        try {
            const docId = makeDailyRecordId(studentId, state.selectedDate);
            const student = state.allStudents.find(s => s.docId === studentId);
            await auditSet(doc(db, 'daily_records', docId), {
                student_id: studentId,
                date: state.selectedDate,
                branch: branchFromStudent(student || {}),
                ...updates
            }, { merge: true });

            // 로컬 캐시 업데이트
            if (!state.dailyRecords[studentId]) {
                state.dailyRecords[studentId] = { docId, student_id: studentId, date: state.selectedDate };
            }
            Object.assign(state.dailyRecords[studentId], updates);

            showSaveIndicator('saved');
        } catch (err) {
            console.error('저장 실패:', err);
            showSaveIndicator('error');
            alert('저장 실패: ' + (err.code || '') + ' ' + (err.message || err));
        }
    }, 2000);
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

export async function saveImmediately(studentId, updates) {
    showSaveIndicator('saving');
    try {
        const docId = makeDailyRecordId(studentId, state.selectedDate);
        const student = state.allStudents.find(s => s.docId === studentId);
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            ...updates
        }, { merge: true });

        if (!state.dailyRecords[studentId]) {
            state.dailyRecords[studentId] = { docId, student_id: studentId, date: state.selectedDate };
        }
        Object.assign(state.dailyRecords[studentId], updates);

        showSaveIndicator('saved');
    } catch (err) {
        console.error('저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Date navigation ──────────────────────────────────────────────────────��─

export function updateDateDisplay() {
    const dayName = getDayName(state.selectedDate);
    document.getElementById('date-text').textContent = `${state.selectedDate} (${dayName})`;
    const picker = document.getElementById('date-picker');
    if (picker) picker.value = state.selectedDate;
}

export async function reloadForDate() {
    state._visitStatusPending = {};

    await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadRoleMemos(), loadClassNextHw(state.selectedDate), loadClassSettings(), loadTeachers()]);
    await syncAbsenceRecords();
    state.selectedNextHwClass = null;
    updateDateDisplay();
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
    const picker = document.getElementById('date-picker');
    picker.showPicker?.() || picker.click();
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

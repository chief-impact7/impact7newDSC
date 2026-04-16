// ─── Attendance Module ──────────────────────────────────────────────────────
// daily-ops.js에서 추출한 출결 관리 관련 함수
// Phase 4-5

import { collection, getDocs, doc, getDoc, query, where, serverTimestamp, deleteField } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet, auditDelete } from './audit.js';
import { getDayName } from './src/shared/firestore-helpers.js';
import { state, NEW_STUDENT_DAYS } from './state.js';
import { showSaveIndicator, nowTimeStr } from './ui-utils.js';
import { enrollmentCode, branchFromStudent } from './student-helpers.js';
import { saveImmediately, saveDailyRecord } from './data-layer.js';

// 토글 UI의 "기본" 라벨 집합 — 이 라벨들을 클릭하면 attendance.status는 '미확인'으로 리셋.
// 오늘 수업 유형/비정규 여부에 따라 첫 버튼 라벨이 동적으로 바뀌지만, 의미는 모두 동일("아직 미확인").
export const DEFAULT_ATTENDANCE_LABELS = new Set(['정규', '특강', '내신', '자유', '비정규']);

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, openBulkModal;

export function initAttendanceDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    openBulkModal = deps.openBulkModal;
}

// ─── Toggle handlers (immediate save) ──────────────────────────────────────

export async function cycleTempArrival(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;
    const cycle = ['', '등원', '미등원'];
    const current = ta.temp_arrival || '';
    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
    const next = cycle[nextIdx];
    showSaveIndicator('saving');
    try {
        const update = next ? { temp_arrival: next } : { temp_arrival: deleteField() };
        await auditUpdate(doc(db, 'temp_attendance', docId), update);
        ta.temp_arrival = next || undefined;
        state._scheduledVisitsCache = null;
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 등원 상태 변경 실패:', err);
        showSaveIndicator('error');
    }
}

export function cycleVisitAttendance(studentId) {
    const cycle = ['등원전', '출석', '지각', '결석'];
    const rec = state.dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const currentDisplay = attStatus === '미확인' ? '등원전' : attStatus;
    const nextIdx = (cycle.indexOf(currentDisplay) + 1) % cycle.length;
    const nextDisplay = cycle[nextIdx];
    const nextVal = nextDisplay === '등원전' ? '정규' : nextDisplay;
    applyAttendance(studentId, nextVal, true);
    renderListPanel();
}

export function toggleAttendance(studentId, displayStatus) {
    if (state.bulkMode && state.selectedStudentIds.size >= 2 && state.selectedStudentIds.has(studentId)) {
        openBulkModal('attendance');
        return;
    }
    applyAttendance(studentId, displayStatus);
}

export async function autoCreateAbsenceRecord(studentId, overrides) {
    // 결정적 문서 ID — 동일 학생+날짜 조합은 항상 같은 ID → race condition 방지
    const absDocId = `${studentId}_${state.selectedDate}`;

    // 행정완료 마커 체크 — 이미 종료된 건은 재생성하지 않음
    if (state.dailyRecords[studentId]?.absence_closed) return;

    // 메모리 중복 체크
    const exists = state.absenceRecords.some(r => r.student_id === studentId && r.absence_date === state.selectedDate);
    if (exists) return;

    // Firestore 서버 측 중복 체크
    try {
        // 1) 결정적 ID 문서 확인 (빠름)
        const existDoc = await getDoc(doc(db, 'absence_records', absDocId));
        if (existDoc.exists()) {
            const data = existDoc.data();
            if (data.status === 'open' && !state.absenceRecords.some(r => r.docId === absDocId)) {
                state.absenceRecords.push({ docId: absDocId, ...data });
            }
            return;
        }
        // 2) 기존 auto-ID 레코드 호환: 필드 기반 쿼리 폴백 (2026-03 배포, 2026-05 이후 제거 가능)
        const existQ = query(collection(db, 'absence_records'),
            where('student_id', '==', studentId),
            where('absence_date', '==', state.selectedDate),
            where('status', 'in', ['open', 'closed']));
        const existSnap = await getDocs(existQ);
        if (!existSnap.empty) {
            existSnap.forEach(d => {
                if (d.data().status === 'open' && !state.absenceRecords.some(r => r.docId === d.id)) {
                    state.absenceRecords.push({ docId: d.id, ...d.data() });
                }
            });
            return;
        }
    } catch (err) {
        console.warn('결석대장 중복 체크 실패:', err);
        // 체크 실패 시에도 setDoc은 멱등성이 보장되므로 진행
    }

    const student = state.allStudents.find(s => s.docId === studentId);

    let name, branch, classCode, reason;
    if (student) {
        const dayName = getDayName(state.selectedDate);
        const classCodes = (student.enrollments || [])
            .filter(e => e.day && e.day.includes(dayName))
            .map(e => enrollmentCode(e))
            .filter(Boolean);
        name = student.name || '';
        branch = branchFromStudent(student);
        classCode = [...new Set(classCodes)].join(', ');
        reason = '';
    } else if (overrides) {
        name = overrides.student_name || studentId.replace(/_\d+$/, '');
        branch = overrides.branch || '';
        classCode = overrides.class_code || '';
        reason = overrides.reason || '';
    } else {
        return;
    }

    try {
        const record = {
            student_id: studentId,
            student_name: name,
            branch,
            class_code: classCode,
            absence_date: state.selectedDate,
            consultation_done: false,
            consultation_note: '',
            reason,
            reason_valid: '',
            resolution: 'pending',
            settlement_memo: '',
            makeup_date: '',
            makeup_time: '',
            makeup_status: 'pending',
            makeup_completed_by: '',
            makeup_completed_at: '',
            reschedule_history: [],
            status: 'open',
            // 결석을 체크한 사람/시간 (daily_records 기준, syncAbsenceRecords 실행자가 아닌 실제 체크자)
            marked_absent_by: state.dailyRecords[studentId]?.updated_by || state.currentUser?.email || '',
            marked_absent_at: state.dailyRecords[studentId]?.updated_at || '',
            created_by: state.currentUser?.email || ''
        };
        await auditSet(doc(db, 'absence_records', absDocId), {
            ...record,
            created_at: serverTimestamp()
        });
        if (!state.absenceRecords.some(r => r.docId === absDocId)) {
            state.absenceRecords.push({
                ...record,
                docId: absDocId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error('결석대장 자동 생성 실패:', err);
    }
}

export async function autoRemoveAbsenceRecord(studentId) {
    const idx = state.absenceRecords.findIndex(r => r.student_id === studentId && r.absence_date === state.selectedDate);
    if (idx === -1) return;
    const record = state.absenceRecords[idx];
    // 보충/정산 처리가 진행된 결석대장은 출석 토글로 삭제하지 않음
    if (record.resolution && record.resolution !== 'pending') {
        console.warn(`결석대장 삭제 차단: ${record.student_name} — resolution=${record.resolution}, makeup_date=${record.makeup_date}`);
        return;
    }
    try {
        await auditDelete(doc(db, 'absence_records', record.docId));
        state.absenceRecords.splice(idx, 1);
        renderSubFilters();
    } catch (err) {
        console.error('결석대장 자동 삭제 실패:', err);
    }
}

// Self-healing: dailyRecords에서 결석인데 absence_records에 없는 건 자동 보충
export async function syncAbsenceRecords() {
    const absentEntries = Object.entries(state.dailyRecords)
        .filter(([, v]) => v?.attendance?.status === '결석' && v?.date === state.selectedDate && !v?.absence_closed);

    const tasks = absentEntries
        .filter(([studentId]) =>
            state.allStudents.some(s => s.docId === studentId) &&
            !state.absenceRecords.some(r => r.student_id === studentId && r.absence_date === state.selectedDate)
        )
        .map(([studentId]) => autoCreateAbsenceRecord(studentId));

    await Promise.all(tasks);
}

export function applyAttendance(studentId, displayStatus, force = false, silent = false) {
    // 기본 라벨(정규/특강/내신/자유/비정규) → 미확인으로 매핑
    const firestoreStatus = DEFAULT_ATTENDANCE_LABELS.has(displayStatus) ? '미확인' : displayStatus;

    const rec = state.dailyRecords[studentId] || {};
    const currentStatus = rec?.attendance?.status || '미확인';

    // force=true 시 강제 설정, 아니면 같은 상태 클릭 → 미확인으로 토글
    const newStatus = force ? firestoreStatus : (currentStatus === firestoreStatus ? '미확인' : firestoreStatus);

    const attendance = { ...(rec.attendance || {}), status: newStatus };

    const updates = { attendance };
    if (newStatus === '출석' || newStatus === '지각') {
        if (!rec?.arrival_time) {
            updates.arrival_time = nowTimeStr();
        }
    } else if (newStatus === '미확인') {
        updates.arrival_time = '';
    }

    saveImmediately(studentId, updates);

    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    Object.assign(state.dailyRecords[studentId], updates);

    // 결석 시 결석대장 자동 생성, 결석 아닌 상태로 변경 시 자동 삭제
    if (newStatus === '결석') {
        autoCreateAbsenceRecord(studentId);
    } else if (currentStatus === '결석' && newStatus !== '결석') {
        autoRemoveAbsenceRecord(studentId);
    }

    if (silent) return;

    const row = document.querySelector(`.list-item[data-id="${CSS.escape(studentId)}"]`);
    if (row) {
        const newDisplay = newStatus === '미확인' ? '정규' : newStatus;
        row.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.remove('active-present', 'active-late', 'active-absent', 'active-other');
            if (btn.textContent.trim() === newDisplay) {
                if (newDisplay === '출석') btn.classList.add('active-present');
                else if (newDisplay === '지각') btn.classList.add('active-late');
                else if (newDisplay === '결석') btn.classList.add('active-absent');
                else btn.classList.add('active-other');
            }
        });
    }

    renderSubFilters();

    if (state.currentCategory === 'attendance' && state.currentSubFilter.size > 0 && row) {
        const matchesFilter = doesStatusMatchFilter(newStatus, state.currentSubFilter);
        if (!matchesFilter) {
            row.classList.add('fade-out');
            row.addEventListener('transitionend', () => {
                renderListPanel();
            }, { once: true });
            setTimeout(() => {
                if (row.classList.contains('fade-out')) renderListPanel();
            }, 500);
        } else {
            renderListPanel();
        }
    } else {
        renderListPanel();
    }

    if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
}


// 학생의 출결 상태가 현재 L2 필터에 매칭되는지 판별
export function doesStatusMatchFilter(firestoreStatus, filterSet) {
    for (const f of filterSet) {
        if (f === 'pre_arrival' && (!firestoreStatus || firestoreStatus === '미확인')) return true;
        if (f === 'present' && firestoreStatus === '출석') return true;
        if (f === 'late' && firestoreStatus === '지각') return true;
        if (f === 'absent' && firestoreStatus === '결석') return true;
        if (f === 'other' && firestoreStatus && !['미확인', '출석', '지각', '결석'].includes(firestoreStatus)) return true;
    }
    return false;
}

export function isNewStudent(student, todayDate) {
    return (student.enrollments || []).some(e => {
        if (!e.start_date) return false;
        const diff = (todayDate - new Date(e.start_date)) / (1000 * 60 * 60 * 24);
        return diff >= 0 && diff <= NEW_STUDENT_DAYS;
    });
}

export function isAttendedStatus(status) {
    return status === '출석' || status === '지각' || status === '조퇴';
}

export function checkCanEditGrading(studentId) {
    const rec = state.dailyRecords[studentId] || {};
    if (isAttendedStatus(rec?.attendance?.status)) return true;
    alert('등원(출석, 지각, 조퇴) 상태인 학생만 입력할 수 있습니다.');
    return false;
}

export function _isVisitAttended(source, docId, studentId) {
    if (source === 'temp') {
        const ta = state.tempAttendances.find(t => t.docId === docId);
        return isAttendedStatus(ta?.temp_arrival);
    }
    if (studentId) {
        return isAttendedStatus(state.dailyRecords[studentId]?.attendance?.status);
    }
    return false;
}

export function handleAttendanceChange(studentId, field, value) {
    const rec = state.dailyRecords[studentId] || {};
    const attendance = { ...(rec.attendance || {}), [field]: value };
    saveDailyRecord(studentId, { attendance });

    // 로컬 캐시 즉시 업데이트 (UI 반영)
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    state.dailyRecords[studentId].attendance = attendance;

    // 목록 태그 즉시 업데이트
    if (field === 'status') {
        renderListPanel();
    }
}

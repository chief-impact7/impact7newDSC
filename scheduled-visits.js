// ─── Scheduled Visits Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 비정규 완료 처리 관련 함수
// Phase 4-3

import { doc, deleteField } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate } from './audit.js';
import { state, VISIT_STATUS_CYCLE } from './state.js';
import { showSaveIndicator, _visitLabel, _visitBtnStyles } from './ui-utils.js';
import { saveImmediately } from './data-layer.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail,
    _isVisitAttended, getScheduledVisits, openRescheduleModal, _subFilterBaseRef;

export function initScheduledVisitsDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    _isVisitAttended = deps._isVisitAttended;
    getScheduledVisits = deps.getScheduledVisits;
    openRescheduleModal = deps.openRescheduleModal;
    _subFilterBaseRef = deps._subFilterBaseRef; // { clear: () => {} }
}

// ─── 비정규 완료 처리 ─────────────────────────────────────────────────────

export async function completeScheduledVisit(source, docId, studentId) {
    if (!_isVisitAttended(source, docId, studentId)) {
        alert('등원(출석, 지각, 조퇴) 상태에서만 완료/시행 처리할 수 있습니다.');
        return;
    }
    showSaveIndicator('saving');
    try {
        const completedBy = (state.currentUser?.email || '').split('@')[0];

        const completedAt = new Date().toISOString();

        if (source === 'temp') {
            await auditUpdate(doc(db, 'temp_attendance', docId), { visit_status: '완료', completed_by: completedBy, completed_at: completedAt });
            const ta = state.tempAttendances.find(t => t.docId === docId);
            if (ta) { ta.visit_status = '완료'; ta.completed_by = completedBy; ta.completed_at = completedAt; }
        } else if (source === 'hw_fail') {
            await auditUpdate(doc(db, 'hw_fail_tasks', docId), {
                status: '완료',
                completed_by: completedBy,
                completed_at: completedAt
            });
            const t = state.hwFailTasks.find(t => t.docId === docId);
            if (t) { t.status = '완료'; t.completed_by = completedBy; t.completed_at = completedAt; }
        } else if (source === 'test_fail') {
            await auditUpdate(doc(db, 'test_fail_tasks', docId), {
                status: '완료',
                completed_by: completedBy,
                completed_at: completedAt
            });
            const t = state.testFailTasks.find(t => t.docId === docId);
            if (t) { t.status = '완료'; t.completed_by = completedBy; t.completed_at = completedAt; }
        } else if (source === 'extra') {
            // docId is studentId for extra_visit
            const rec = state.dailyRecords[docId] || {};
            const ev = rec.extra_visit || {};
            ev.visit_status = '완료';
            ev.completed_by = completedBy;
            ev.completed_at = completedAt;
            await saveImmediately(docId, { extra_visit: ev });
            if (state.dailyRecords[docId]) state.dailyRecords[docId].extra_visit = ev;
        }

        renderSubFilters();
        renderListPanel();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('비정규 완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

export async function resetScheduledVisit(source, docId, studentId) {
    showSaveIndicator('saving');
    try {
        if (source === 'temp') {
            await auditUpdate(doc(db, 'temp_attendance', docId), { visit_status: 'pending', completed_by: deleteField(), completed_at: deleteField() });
            const ta = state.tempAttendances.find(t => t.docId === docId);
            if (ta) { ta.visit_status = 'pending'; delete ta.completed_by; delete ta.completed_at; }
        } else if (source === 'hw_fail') {
            await auditUpdate(doc(db, 'hw_fail_tasks', docId), {
                status: 'pending',
                completed_by: deleteField(),
                completed_at: deleteField()
            });
            const t = state.hwFailTasks.find(t => t.docId === docId);
            if (t) { t.status = 'pending'; delete t.completed_by; delete t.completed_at; }
        } else if (source === 'test_fail') {
            await auditUpdate(doc(db, 'test_fail_tasks', docId), {
                status: 'pending',
                completed_by: deleteField(),
                completed_at: deleteField()
            });
            const t = state.testFailTasks.find(t => t.docId === docId);
            if (t) { t.status = 'pending'; delete t.completed_by; delete t.completed_at; }
        } else if (source === 'extra') {
            const rec = state.dailyRecords[docId] || {};
            const ev = rec.extra_visit || {};
            ev.visit_status = 'pending';
            delete ev.completed_by;
            delete ev.completed_at;
            await saveImmediately(docId, { extra_visit: ev });
            if (state.dailyRecords[docId]) state.dailyRecords[docId].extra_visit = ev;
        }

        renderSubFilters();
        renderListPanel();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('비정규 초기화 실패:', err);
        showSaveIndicator('error');
    }
}

export function cycleVisitStatus(source, docId, studentId) {
    // 현재 상태
    let currentStatus;
    if (state._visitStatusPending[docId]) {
        currentStatus = state._visitStatusPending[docId].nextStatus;
    } else if (source === 'temp') {
        currentStatus = state.tempAttendances.find(t => t.docId === docId)?.visit_status || 'pending';
    } else if (source === 'hw_fail') {
        currentStatus = state.hwFailTasks.find(t => t.docId === docId)?.status || 'pending';
    } else if (source === 'test_fail') {
        currentStatus = state.testFailTasks.find(t => t.docId === docId)?.status || 'pending';
    } else if (source === 'extra') {
        currentStatus = state.dailyRecords[docId]?.extra_visit?.visit_status || 'pending';
    }

    // 다음 상태로 토글 (미등원 시 '완료' 건너뜀)
    const attended = _isVisitAttended(source, docId, studentId);
    let nextIdx = (VISIT_STATUS_CYCLE.indexOf(currentStatus) + 1) % VISIT_STATUS_CYCLE.length;
    let nextStatus = VISIT_STATUS_CYCLE[nextIdx];
    if (!attended && nextStatus === '완료') {
        nextIdx = (nextIdx + 1) % VISIT_STATUS_CYCLE.length;
        nextStatus = VISIT_STATUS_CYCLE[nextIdx];
    }
    // 각 항목 독립적으로 pending 상태 유지
    state._visitStatusPending[docId] = { source, nextStatus, studentId };

    // 버튼 텍스트+스타일 즉시 변경
    const btn = document.querySelector(`[data-visit-id="${docId}"]`);
    if (btn) {
        const label = _visitLabel(nextStatus, source);
        const { cls, sty } = _visitBtnStyles(label);
        btn.textContent = label;
        btn.className = `toggle-btn ${cls}`.trim();
        btn.style.cssText = sty;
    }
}

export async function confirmVisitStatus(docId) {
    let pending = state._visitStatusPending[docId];
    if (!pending) {
        // 토글 안 했으면: 등원 시 '완료', 미등원 시 '미완료'
        const visits = getScheduledVisits();
        const v = visits.find(vi => vi.docId === docId);
        if (!v) return;
        const attended = _isVisitAttended(v.source, docId, v.studentId);
        pending = { source: v.source, nextStatus: attended ? '완료' : '미완료', studentId: v.studentId };
    }
    delete state._visitStatusPending[docId];

    const { source, nextStatus, studentId } = pending;

    // 미등원 상태에서 완료 시도 차단
    if (nextStatus === '완료' && !_isVisitAttended(source, docId, studentId)) {
        alert('등원(출석, 지각, 조퇴) 상태에서만 완료/시행 처리할 수 있습니다.');
        return;
    }

    if (nextStatus === 'pending') {
        await resetScheduledVisit(source, docId, studentId);
    } else if (nextStatus === '미완료' && (source === 'hw_fail' || source === 'test_fail')) {
        // 미완료 확인 → 재지정 모달 열기
        rescheduleVisit(source, docId);
    } else if (nextStatus === '미완료' && source === 'temp') {
        // 진단평가 미시행 확인 → 재지정/시험취소 선택
        _showDiagnosticActionModal(docId);
    } else if (nextStatus === '완료') {
        await completeScheduledVisit(source, docId, studentId);
    } else {
        // '기타'
        showSaveIndicator('saving');
        try {
            const completedBy = (state.currentUser?.email || '').split('@')[0];
            const completedAt = new Date().toISOString();
            const statusPayload = { completed_by: completedBy, completed_at: completedAt };

            if (source === 'temp') {
                await auditUpdate(doc(db, 'temp_attendance', docId), { visit_status: '기타', ...statusPayload });
                const ta = state.tempAttendances.find(t => t.docId === docId);
                if (ta) Object.assign(ta, { visit_status: '기타', ...statusPayload });
            } else if (source === 'hw_fail') {
                await auditUpdate(doc(db, 'hw_fail_tasks', docId), { status: '기타', ...statusPayload });
                const t = state.hwFailTasks.find(t => t.docId === docId);
                if (t) Object.assign(t, { status: '기타', ...statusPayload });
            } else if (source === 'test_fail') {
                await auditUpdate(doc(db, 'test_fail_tasks', docId), { status: '기타', ...statusPayload });
                const t = state.testFailTasks.find(t => t.docId === docId);
                if (t) Object.assign(t, { status: '기타', ...statusPayload });
            } else if (source === 'extra') {
                const ev = state.dailyRecords[docId]?.extra_visit || {};
                Object.assign(ev, { visit_status: '기타', ...statusPayload });
                await saveImmediately(docId, { extra_visit: ev });
                if (state.dailyRecords[docId]) state.dailyRecords[docId].extra_visit = ev;
            }

            renderSubFilters();
            renderListPanel();
            if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
            showSaveIndicator('saved');
        } catch (err) {
            console.error('비정규 기타 처리 실패:', err);
            showSaveIndicator('error');
        }
    }
}

export function rescheduleVisit(source, docId) {
    const collectionMap = { hw_fail: 'hw_fail_tasks', test_fail: 'test_fail_tasks' };
    const col = collectionMap[source];
    if (!col) return;
    const arr = source === 'hw_fail' ? state.hwFailTasks : state.testFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;
    openRescheduleModal(col, docId, t.student_id);
}

let _diagnosticActionDocId = null;

function _closeDiagnosticModal() {
    document.getElementById('diagnostic-action-modal').style.display = 'none';
    _diagnosticActionDocId = null;
    state._scheduledVisitsCache = null;
    if (_subFilterBaseRef) _subFilterBaseRef.clear();
    renderSubFilters();
    renderListPanel();
}

export function _showDiagnosticActionModal(docId) {
    _diagnosticActionDocId = docId;
    document.getElementById('diagnostic-reschedule-fields').style.display = 'none';
    const ta = state.tempAttendances.find(t => t.docId === docId);
    document.getElementById('diagnostic-reschedule-time').value = ta?.temp_time || '10:00';
    document.getElementById('diagnostic-reschedule-date').value = '';
    const btn = document.getElementById('diagnostic-reschedule-btn');
    btn.textContent = '재지정';
    btn.onclick = toggleDiagnosticReschedule;
    document.getElementById('diagnostic-action-modal').style.display = 'flex';
}

export function toggleDiagnosticReschedule() {
    const fields = document.getElementById('diagnostic-reschedule-fields');
    const btn = document.getElementById('diagnostic-reschedule-btn');
    if (fields.style.display === 'none') {
        fields.style.display = 'block';
        btn.textContent = '저장';
        btn.onclick = saveDiagnosticReschedule;
    } else {
        fields.style.display = 'none';
        btn.textContent = '재지정';
        btn.onclick = toggleDiagnosticReschedule;
    }
}

export async function saveDiagnosticReschedule() {
    if (!_diagnosticActionDocId) return;
    const newDate = document.getElementById('diagnostic-reschedule-date').value;
    if (!newDate) { alert('날짜를 선택하세요.'); return; }
    const newTime = document.getElementById('diagnostic-reschedule-time').value;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'temp_attendance', _diagnosticActionDocId), {
            temp_date: newDate,
            temp_time: newTime || '',
            visit_status: 'pending',
            arrival_status: ''
        });
        const ta = state.tempAttendances.find(t => t.docId === _diagnosticActionDocId);
        if (ta) Object.assign(ta, { temp_date: newDate, temp_time: newTime || '', visit_status: 'pending', arrival_status: '' });
        _closeDiagnosticModal();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 재지정 실패:', err);
        showSaveIndicator('error');
    }
}

export async function confirmDiagnosticCancel() {
    if (!_diagnosticActionDocId) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (state.currentUser?.email || '').split('@')[0];
        const completedAt = new Date().toISOString();
        await auditUpdate(doc(db, 'temp_attendance', _diagnosticActionDocId), {
            visit_status: '기타',
            completed_by: completedBy,
            completed_at: completedAt,
            cancel_reason: '시험취소'
        });
        const ta = state.tempAttendances.find(t => t.docId === _diagnosticActionDocId);
        if (ta) Object.assign(ta, { visit_status: '기타', completed_by: completedBy, completed_at: completedAt, cancel_reason: '시험취소' });
        _closeDiagnosticModal();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 시험취소 실패:', err);
        showSaveIndicator('error');
    }
}

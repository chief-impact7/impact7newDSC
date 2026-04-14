// ─── Reschedule Modal Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 재예약 모달 (밀린 Task 재지정) 로직
// Step 2

import { arrayUnion, doc } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state } from './state.js';
import {
    esc, formatTime12h, showSaveIndicator, _stripYear
} from './ui-utils.js';
import { auditUpdate } from './audit.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, _subFilterBaseRef;

export function initRescheduleModalDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    _subFilterBaseRef = deps._subFilterBaseRef;
}

// ─── 밀린 Task 재지정 ─────────────────────────────────────────────────────────

let _rescheduleTarget = null;

export function openRescheduleModal(collection, docId, studentId) {
    const dateLabel = document.getElementById('reschedule-date-label');
    const timeField = document.getElementById('reschedule-time-field');

    // 결석대장 재예약 (항상 등원 형식)
    if (collection === 'absence_records') {
        const r = state.absenceRecords.find(x => x.docId === docId);
        if (!r) return;
        _rescheduleTarget = { collection, docId, studentId, taskType: '등원' };
        dateLabel.textContent = '새 날짜';
        timeField.style.display = '';
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 보충 예정:</strong> ${r.makeup_date ? esc(_stripYear(r.makeup_date)) : '미정'}${r.makeup_time ? ' ' + esc(formatTime12h(r.makeup_time)) : ''}`;
        document.getElementById('reschedule-date').value = '';
        document.getElementById('reschedule-time').value = r.makeup_time || '16:00';
        document.getElementById('reschedule-reason').value = '';
        document.getElementById('reschedule-modal').style.display = 'flex';
        return;
    }

    const arr = collection === 'test_fail_tasks' ? state.testFailTasks : state.hwFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;
    _rescheduleTarget = { collection, docId, studentId, taskType: t.type };

    if (t.type === '대체숙제') {
        dateLabel.textContent = '새 제출기한';
        timeField.style.display = 'none';
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 기한:</strong> ${t.scheduled_date ? esc(_stripYear(t.scheduled_date)) : '미정'}`;
        document.getElementById('reschedule-time').value = '';
    } else {
        dateLabel.textContent = '새 날짜';
        timeField.style.display = '';
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 예정:</strong> ${t.scheduled_date ? esc(_stripYear(t.scheduled_date)) : '미정'}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`;
        document.getElementById('reschedule-time').value = t.scheduled_time || '16:00';
    }
    document.getElementById('reschedule-date').value = '';
    document.getElementById('reschedule-reason').value = '';
    document.getElementById('reschedule-modal').style.display = 'flex';
}

export async function saveReschedule() {
    if (!_rescheduleTarget) return;
    const { collection: col, docId, studentId } = _rescheduleTarget;
    const newDate = document.getElementById('reschedule-date').value;
    const newTime = document.getElementById('reschedule-time').value;
    const reason = document.getElementById('reschedule-reason').value.trim();
    if (!newDate) { alert('새 날짜를 입력하세요.'); return; }

    // 결석대장 재예약 분기
    if (col === 'absence_records') {
        const r = state.absenceRecords.find(x => x.docId === docId);
        if (!r) return;
        const entry = {
            prev_date: r.makeup_date || '',
            prev_time: r.makeup_time || '',
            new_date: newDate,
            new_time: newTime || '',
            rescheduled_by: (state.currentUser?.email || '').split('@')[0],
            rescheduled_at: new Date().toISOString()
        };
        if (reason) entry.reason = reason;

        showSaveIndicator('saving');
        try {
            await auditUpdate(doc(db, 'absence_records', docId), {
                makeup_date: newDate,
                makeup_time: newTime || '',
                makeup_status: 'pending',
                reschedule_history: arrayUnion(entry)
            });
            r.makeup_date = newDate;
            r.makeup_time = newTime || '';
            r.makeup_status = 'pending';
            if (!r.reschedule_history) r.reschedule_history = [];
            r.reschedule_history.push(entry);

            document.getElementById('reschedule-modal').style.display = 'none';
            _rescheduleTarget = null;
            renderStudentDetail(studentId);
            renderListPanel();
            showSaveIndicator('saved');
        } catch (err) {
            console.error('결석 재예약 저장 실패:', err);
            showSaveIndicator('error');
        }
        return;
    }

    const arr = col === 'test_fail_tasks' ? state.testFailTasks : state.hwFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;

    const entry = {
        prev_date: t.scheduled_date || '',
        prev_time: t.scheduled_time || '',
        new_date: newDate,
        new_time: newTime || '',
        rescheduled_by: (state.currentUser?.email || '').split('@')[0],
        rescheduled_at: new Date().toISOString()
    };
    if (reason) entry.reason = reason;

    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, col, docId), {
            scheduled_date: newDate,
            scheduled_time: newTime || '',
            reschedule_history: arrayUnion(entry)
        });
        // 로컬 캐시 업데이트
        t.scheduled_date = newDate;
        t.scheduled_time = newTime || '';
        if (!t.reschedule_history) t.reschedule_history = [];
        t.reschedule_history.push(entry);

        document.getElementById('reschedule-modal').style.display = 'none';
        _rescheduleTarget = null;
        state._scheduledVisitsCache = null;
        _subFilterBaseRef.clear();
        renderSubFilters();
        renderListPanel();
        if (studentId) renderStudentDetail(studentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('재지정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

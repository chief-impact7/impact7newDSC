// ─── Reschedule Modal Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 재예약 모달 (밀린 Task 재지정) 로직
// Step 2

import { arrayUnion, doc, writeBatch } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state } from './state.js';
import {
    esc, formatTime12h, renderTime12hOptions, showSaveIndicator, _stripYear
} from './ui-utils.js';
import { auditUpdate, batchUpdate, batchSet } from './audit.js';
import { makeDailyRecordId } from './student-helpers.js';
import { staffLabel } from '@impact7/shared/staff-label';

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

function setRescheduleTime(value) {
    const el = document.getElementById('reschedule-time');
    if (!el) return;
    el.innerHTML = renderTime12hOptions(value || '16:00');
    el.value = value || '16:00';
}

// 같은 학생·같은 날짜의 pending task 수집 (hw/test 공통) — 묶음 재지정 대상
function _pendingTasksOn(studentId, date) {
    if (!date) return [];
    const pick = (arr, col) => arr
        .filter(t => t.student_id === studentId && t.status === 'pending' && t.scheduled_date === date)
        .map(t => ({ collection: col, task: t }));
    return [...pick(state.hwFailTasks, 'hw_fail_tasks'), ...pick(state.testFailTasks, 'test_fail_tasks')];
}

// 단건 모달의 "같은 날 함께 재지정" 체크박스 — 같은 날 task가 2건 이상일 때만 노출
function _setBulkRow(count, date) {
    const row = document.getElementById('reschedule-bulk-row');
    const check = document.getElementById('reschedule-bulk-check');
    if (!row || !check) return;
    check.checked = false;
    if (count > 1) {
        document.getElementById('reschedule-bulk-label').textContent =
            `같은 날(${_stripYear(date)}) 밀린 task ${count}건 모두 재지정`;
        row.style.display = '';
    } else {
        row.style.display = 'none';
    }
}

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
        setRescheduleTime(r.makeup_time || '16:00');
        document.getElementById('reschedule-reason').value = '';
        _setBulkRow(0);
        document.getElementById('reschedule-modal').style.display = 'flex';
        return;
    }

    const arr = collection === 'test_fail_tasks' ? state.testFailTasks : state.hwFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;
    _rescheduleTarget = { collection, docId, studentId, taskType: t.type, date: t.scheduled_date };
    _setBulkRow(_pendingTasksOn(studentId, t.scheduled_date).length, t.scheduled_date);

    if (t.type === '대체숙제') {
        dateLabel.textContent = '새 제출기한';
        timeField.style.display = 'none';
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 기한:</strong> ${t.scheduled_date ? esc(_stripYear(t.scheduled_date)) : '미정'}`;
        setRescheduleTime('16:00');
    } else {
        dateLabel.textContent = '새 날짜';
        timeField.style.display = '';
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 예정:</strong> ${t.scheduled_date ? esc(_stripYear(t.scheduled_date)) : '미정'}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`;
        setRescheduleTime(t.scheduled_time || '16:00');
    }
    document.getElementById('reschedule-date').value = '';
    document.getElementById('reschedule-reason').value = '';
    document.getElementById('reschedule-modal').style.display = 'flex';
}

// 묶음 재지정 진입 (밀린 Task 카드의 날짜 그룹 헤더 버튼)
export function openBulkRescheduleModal(studentId, date) {
    const items = _pendingTasksOn(studentId, date);
    if (items.length === 0) return;
    _rescheduleTarget = { bulk: true, studentId, items };

    document.getElementById('reschedule-date-label').textContent = '새 날짜';
    // 등원 task가 하나라도 있으면 시간 필드 노출, 대체숙제만이면 날짜만
    const firstVisit = items.find(({ task }) => task.type !== '대체숙제');
    document.getElementById('reschedule-time-field').style.display = firstVisit ? '' : 'none';
    setRescheduleTime(firstVisit?.task.scheduled_time || '16:00');
    document.getElementById('reschedule-prev-info').innerHTML =
        `<strong>묶음 재지정:</strong> ${esc(_stripYear(date))} 밀린 task ${items.length}건`;
    _setBulkRow(0); // 이미 묶음 진입 — 체크박스 불필요
    document.getElementById('reschedule-date').value = '';
    document.getElementById('reschedule-reason').value = '';
    document.getElementById('reschedule-modal').style.display = 'flex';
}

// 묶음 저장 — batch 원자 처리, reschedule_history는 task별 개별 기록.
// 대체숙제는 의미가 "제출기한"이라 날짜만 변경하고 시간은 건드리지 않는다.
async function _saveBulkReschedule(items, newDate, newTime, reason, studentId) {
    const by = staffLabel(state.currentUser?.email);
    const at = new Date().toISOString();
    showSaveIndicator('saving');
    try {
        const batch = writeBatch(db);
        const applyLocal = [];
        const drDocs = new Map(); // daily_records docId -> { [actionField]: { [domain]: fieldUpdate } }
        for (const { collection: col, task: t } of items) {
            const isAlt = t.type === '대체숙제';
            const entry = {
                prev_date: t.scheduled_date || '',
                prev_time: t.scheduled_time || '',
                new_date: newDate,
                new_time: isAlt ? (t.scheduled_time || '') : (newTime || ''),
                rescheduled_by: by,
                rescheduled_at: at,
            };
            if (reason) entry.reason = reason;
            const update = { scheduled_date: newDate, reschedule_history: arrayUnion(entry) };
            if (!isAlt) update.scheduled_time = newTime || '';
            batchUpdate(batch, doc(db, col, t.docId), update);

            // daily_records 후속대책 영속화(#3) — task의 source_date 문서에 도메인 단위로 모은다.
            if (t.source_date) {
                const af = col === 'test_fail_tasks' ? 'test_fail_action' : 'hw_fail_action';
                const drId = makeDailyRecordId(t.student_id, t.source_date);
                if (!drDocs.has(drId)) drDocs.set(drId, { student_id: t.student_id, date: t.source_date });
                const data = drDocs.get(drId);
                if (!data[af]) data[af] = {};
                data[af][t.domain] = isAlt ? { scheduled_date: newDate } : { scheduled_date: newDate, scheduled_time: newTime || '' };
            }

            applyLocal.push(() => {
                t.scheduled_date = newDate;
                if (!isAlt) t.scheduled_time = newTime || '';
                if (!t.reschedule_history) t.reschedule_history = [];
                t.reschedule_history.push(entry);
                const rec = state.dailyRecords[t.student_id];
                const action = col === 'hw_fail_tasks' ? rec?.hw_fail_action?.[t.domain] : rec?.test_fail_action?.[t.domain];
                if (action) {
                    action.scheduled_date = newDate;
                    if (!isAlt) action.scheduled_time = newTime || '';
                }
            });
        }
        for (const [drId, data] of drDocs) batchSet(batch, doc(db, 'daily_records', drId), data, { merge: true });
        await batch.commit();
        applyLocal.forEach(fn => fn());

        document.getElementById('reschedule-modal').style.display = 'none';
        _rescheduleTarget = null;
        state._scheduledVisitsCache = null;
        _subFilterBaseRef.clear();
        renderSubFilters();
        renderListPanel();
        if (studentId && state.selectedStudentId === studentId) renderStudentDetail(studentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('묶음 재지정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

export async function saveReschedule() {
    if (!_rescheduleTarget) return;
    const newDate = document.getElementById('reschedule-date').value;
    const newTime = document.getElementById('reschedule-time').value;
    const reason = document.getElementById('reschedule-reason').value.trim();
    if (!newDate) { alert('새 날짜를 입력하세요.'); return; }

    // 묶음 경로: 그룹 헤더 진입(bulk) 또는 단건 모달의 "같은 날 함께" 체크
    const bulkChecked = document.getElementById('reschedule-bulk-check')?.checked;
    if (_rescheduleTarget.bulk || bulkChecked) {
        const { studentId } = _rescheduleTarget;
        const items = _rescheduleTarget.bulk
            ? _rescheduleTarget.items
            : _pendingTasksOn(studentId, _rescheduleTarget.date);
        if (items.length > 0) {
            await _saveBulkReschedule(items, newDate, newTime, reason, studentId);
            return;
        }
    }

    const { collection: col, docId, studentId } = _rescheduleTarget;

    // 결석대장 재예약 분기
    if (col === 'absence_records') {
        const r = state.absenceRecords.find(x => x.docId === docId);
        if (!r) return;
        const entry = {
            prev_date: r.makeup_date || '',
            prev_time: r.makeup_time || '',
            new_date: newDate,
            new_time: newTime || '',
            rescheduled_by: staffLabel(state.currentUser?.email),
            rescheduled_at: new Date().toISOString()
        };
        if (reason) entry.reason = reason;

        showSaveIndicator('saving');
        try {
            await auditUpdate(doc(db, 'absence_records', docId), {
                status: 'open',
                makeup_date: newDate,
                makeup_time: newTime || '',
                makeup_status: 'pending',
                reschedule_history: arrayUnion(entry)
            });
            r.status = 'open';
            r.makeup_date = newDate;
            r.makeup_time = newTime || '';
            r.makeup_status = 'pending';
            if (!r.reschedule_history) r.reschedule_history = [];
            r.reschedule_history.push(entry);

            document.getElementById('reschedule-modal').style.display = 'none';
            _rescheduleTarget = null;
            state._scheduledVisitsCache = null;
            if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
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
        rescheduled_by: staffLabel(state.currentUser?.email),
        rescheduled_at: new Date().toISOString()
    };
    if (reason) entry.reason = reason;

    showSaveIndicator('saving');
    try {
        // task 업데이트와 daily_records 후속대책 영속화를 한 batch로 원자 처리한다.
        // 분리 write 시 두 번째가 실패하면 task=새날짜·daily_records=옛날짜로 갈려 #3가 재발한다.
        const batch = writeBatch(db);
        batchUpdate(batch, doc(db, col, docId), {
            scheduled_date: newDate,
            scheduled_time: newTime || '',
            reschedule_history: arrayUnion(entry)
        });
        // daily_records 후속대책에도 새 날짜를 영속화(#3) — 리로드 후 옛 날짜로 되돌아가
        // 카드 재저장 시 reschedule가 덮어써지던 문제 방지. 액션은 task의 source_date 문서에 산다.
        // merge:true는 도메인 단위 deep-merge라 같은 액션의 type/alt_hw·타 도메인을 보존한다.
        if (t.source_date) {
            const actionField = col === 'test_fail_tasks' ? 'test_fail_action' : 'hw_fail_action';
            const drFieldUpdate = { scheduled_date: newDate };
            if (t.type !== '대체숙제') drFieldUpdate.scheduled_time = newTime || '';
            batchSet(batch, doc(db, 'daily_records', makeDailyRecordId(t.student_id, t.source_date)),
                { student_id: t.student_id, date: t.source_date, [actionField]: { [t.domain]: drFieldUpdate } }, { merge: true });
        }
        await batch.commit();

        // 로컬 캐시 업데이트: hw_fail_tasks
        t.scheduled_date = newDate;
        t.scheduled_time = newTime || '';
        if (!t.reschedule_history) t.reschedule_history = [];
        t.reschedule_history.push(entry);
        // 로컬 캐시 동기화: 후속대책 카드/학부모알림 pre-fill 일치
        const rec = state.dailyRecords[t.student_id];
        if (rec?.hw_fail_action?.[t.domain]) {
            rec.hw_fail_action[t.domain].scheduled_date = newDate;
            if (t.type !== '대체숙제') rec.hw_fail_action[t.domain].scheduled_time = newTime || '';
        }
        if (rec?.test_fail_action?.[t.domain]) {
            rec.test_fail_action[t.domain].scheduled_date = newDate;
            if (t.type !== '대체숙제') rec.test_fail_action[t.domain].scheduled_time = newTime || '';
        }

        document.getElementById('reschedule-modal').style.display = 'none';
        _rescheduleTarget = null;
        state._scheduledVisitsCache = null;
        _subFilterBaseRef.clear();
        renderSubFilters();
        renderListPanel();
        if (studentId && state.selectedStudentId === studentId) renderStudentDetail(studentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('재지정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

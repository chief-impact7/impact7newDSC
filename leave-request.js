// ─── Leave Request Module ──────────────────────────────────────────────────
// daily-ops.js에서 추출한 휴퇴원 요청 & 복귀 관련 함수
// Phase 3-1

import { collection, doc, serverTimestamp, deleteField } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { parseDateKST, todayStr } from './src/shared/firestore-helpers.js';
import { auditUpdate, auditAdd } from './audit.js';
import { state, LEAVE_STATUSES } from './state.js';
import { esc, escAttr, showSaveIndicator, _fmtTs } from './ui-utils.js';
import { branchFromStudent, allClassCodes, activeClassCodes, enrollmentCode, findStudent } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, getTeacherName, _isOlderThan, loadWithdrawnStudents, renderFilterChips;

export function initLeaveRequestDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    getTeacherName = deps.getTeacherName;
    _isOlderThan = deps._isOlderThan;
    loadWithdrawnStudents = deps.loadWithdrawnStudents;
    renderFilterChips = deps.renderFilterChips;
}

// ─── 휴퇴원 유형 헬퍼 ──────────────────────────────────────────────────────
const _isWithdrawalType = (t) => t === '퇴원요청' || t === '휴원→퇴원';
const _isLeaveSubType = (t) => t === '휴원요청' || t === '퇴원→휴원';
const _isLeaveExtension = (t) => t === '휴원연장';
const _isReturnType = (t) => t === '복귀요청' || t === '재등원요청';
const _isReEnrollType = (t) => t === '재등원요청';

// ─── 배지 렌더링 ──────────────────────────────────────────────────────────
function _leaveRequestTypeBadge(r) {
    const typeMap = {
        '휴원요청': { label: '휴원', color: '#2563eb' },
        '휴원연장': { label: '연장', color: '#0891b2' },
        '퇴원요청': { label: '퇴원', color: '#dc2626' },
        '휴원→퇴원': { label: '휴→퇴', color: '#dc2626' },
        '퇴원→휴원': { label: '퇴→휴', color: '#7c3aed' },
        '복귀요청': { label: '복귀', color: '#16a34a' },
        '재등원요청': { label: '재등원', color: '#16a34a' }
    };
    const t = typeMap[r.request_type] || { label: r.request_type, color: '#666' };
    let badge = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${t.color};">${esc(t.label)}</span>`;
    if (r.leave_sub_type) {
        badge += `<span style="font-size:11px;color:var(--text-sec);margin-left:2px;">${esc(r.leave_sub_type)}</span>`;
    }
    return badge;
}

function _leaveTypeBadgeOrFallback(lr, statusText) {
    return lr ? _leaveRequestTypeBadge(lr) : `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:#6b7280;">${esc(statusText)}</span>`;
}

function _leaveRequestStatusBadge(r) {
    if (typeof r === 'string') r = { status: r }; // 하위 호환
    if (r.status === 'approved') return `<span class="absence-status-badge completed">승인완료</span>`;
    if (r.status === 'cancelled') return `<span class="absence-status-badge undecided">취소</span>`;
    if (r.status === 'rejected') return `<span class="absence-status-badge noshow">반려</span>`;
    const pending = [];
    if (!r.teacher_approved_by) pending.push('교수부');
    if (!r.approved_by) pending.push('행정부');
    const label = pending.length > 0 ? `${pending.join('·')}대기` : '승인대기';
    return `<span class="absence-status-badge unconsulted">${esc(label)}</span>`;
}

// ─── 휴퇴원요청서 리스트 ─────────────────────────────────────────────────────

let _selectedLeaveRequestId = null;

export function renderLeaveRequestList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    let records = [...state.leaveRequests];
    if (state.selectedBranch) records = records.filter(r => r.branch === state.selectedBranch);
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        records = records.filter(r => r.student_name?.toLowerCase().includes(q));
    }
    // 그룹: 승인 대기 → 승인 완료 (7일 이내만)
    const pending = records.filter(r => r.status === 'requested');
    const approved = records.filter(r =>
        r.status === 'approved' && !_isOlderThan(r.approved_at, { days: 7 })
    );
    const visibleCount = pending.length + approved.length;
    countEl.textContent = `${visibleCount}건`;

    // 새 요청 버튼
    let html = `<div style="padding:8px 12px;">
        <button class="lr-btn lr-btn-tonal" style="width:100%;" onclick="openLeaveRequestModal()">
            <span class="material-symbols-outlined">add</span> 새 요청
        </button>
    </div>`;

    if (visibleCount === 0) {
        html += '<div class="empty-state">휴퇴원 요청이 없습니다.</div>';
        container.innerHTML = html;
        return;
    }

    const groups = [
        { label: '승인 대기', items: pending },
        { label: '승인 완료', items: approved }
    ];

    for (const g of groups) {
        if (g.items.length === 0) continue;
        html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(g.label)} (${g.items.length})</div>`;
        for (const r of g.items) {
            const isActive = r.student_id === state.selectedStudentId && r.docId === _selectedLeaveRequestId;
            const classCodes = (r.class_codes || []).join(', ');
            const _by = getTeacherName(r.requested_by);
            const tsStr = _fmtTs(r.requested_at);

            html += `<div class="list-item ${isActive ? 'active' : ''}${state.bulkMode ? ' bulk-mode' : ''}${state.selectedStudentIds.has(r.student_id) ? ' bulk-selected' : ''}" data-id="${escAttr(r.student_id)}" data-leave-id="${escAttr(r.docId)}"
                onclick="handleListItemClick(event,'${escAttr(r.student_id)}',()=>selectLeaveRequest('${escAttr(r.docId)}'))">
                <input type="checkbox" class="list-item-checkbox" ${state.selectedStudentIds.has(r.student_id) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(r.student_id)}', this.checked)">
                <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <span style="font-weight:600;font-size:13px;">${esc(r.student_name)}</span>
                            ${_leaveRequestTypeBadge(r)}
                            ${_leaveRequestStatusBadge(r)}
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                            ${esc(classCodes)}${_by ? ' · ' + esc(_by) : ''} · ${esc(tsStr)}
                        </div>
                    </div>
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
}

export function selectLeaveRequest(docId) {
    _selectedLeaveRequestId = docId;
    const r = state.leaveRequests.find(lr => lr.docId === docId);
    if (r) {
        state.selectedStudentId = r.student_id;
        renderLeaveRequestList();
        renderStudentDetail(r.student_id);
    }
}

// ─── 복귀예정 리스트 ──────────────────────────────────────────────────────

let _returnUpcomingCache = null;
export function _getReturnUpcomingStudents() {
    if (_returnUpcomingCache) return _returnUpcomingCache;
    const now = parseDateKST(todayStr());
    const approvedByStudent = new Map();
    for (const r of state.leaveRequests) {
        if (r.status === 'approved') approvedByStudent.set(r.student_id, r);
    }
    const results = [];
    for (const s of state.allStudents) {
        if (!LEAVE_STATUSES.includes(s.status) || !s.pause_end_date) continue;
        if (state.selectedBranch && s.branch !== state.selectedBranch) continue;
        const end = parseDateKST(s.pause_end_date);
        const daysLeft = Math.ceil((end - now) / 86400000);
        if (daysLeft < 0 || daysLeft > 14) continue;
        results.push({ student: s, daysLeft, leaveRequest: approvedByStudent.get(s.docId) || null });
    }
    results.sort((a, b) => a.daysLeft - b.daysLeft);
    _returnUpcomingCache = results;
    return results;
}

export function renderReturnUpcomingList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    let items = _getReturnUpcomingStudents();
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        items = items.filter(x => x.student.name?.toLowerCase().includes(q));
    }
    countEl.textContent = `${items.length}건`;

    if (items.length === 0) {
        container.innerHTML = '<div class="empty-state">2주 이내 복귀예정 학생이 없습니다.</div>';
        return;
    }

    const urgent = items.filter(x => x.daysLeft <= 7);
    const soon = items.filter(x => x.daysLeft > 7);

    const groups = [
        { label: '1주일 이내 복귀예정', items: urgent, ddayCls: 'urgent' },
        { label: '2주일 이내 복귀예정', items: soon, ddayCls: 'soon' }
    ];

    let html = '';
    for (const g of groups) {
        if (g.items.length === 0) continue;
        html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(g.label)} (${g.items.length})</div>`;
        for (const { student: s, daysLeft, leaveRequest: lr } of g.items) {
            const isActive = s.docId === state.selectedStudentId;
            const codes = allClassCodes(s).join(', ');
            const ddayLabel = daysLeft === 0 ? 'D-Day' : `D-${daysLeft}`;
            const typeBadge = _leaveTypeBadgeOrFallback(lr, s.status);
            const consultDone = s.return_consult_done;
            const consultIcon = `<span class="return-consult-icon material-symbols-outlined" title="복귀상담" style="color:${consultDone ? '#22c55e' : '#f59e0b'};" onclick="event.stopPropagation();toggleReturnConsult('${escAttr(s.docId)}')">${consultDone ? 'check_circle' : 'phone_in_talk'}</span>`;

            html += `<div class="list-item ${isActive ? 'active' : ''}${state.bulkMode ? ' bulk-mode' : ''}${state.selectedStudentIds.has(s.docId) ? ' bulk-selected' : ''}" data-id="${escAttr(s.docId)}"
                onclick="handleListItemClick(event,'${escAttr(s.docId)}',()=>selectReturnUpcomingStudent('${escAttr(s.docId)}'))">
                <input type="checkbox" class="list-item-checkbox" ${state.selectedStudentIds.has(s.docId) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(s.docId)}', this.checked)">
                <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <span style="font-weight:600;font-size:13px;">${esc(s.name)}</span>
                            ${typeBadge}
                            <span class="return-dday ${g.ddayCls}">${ddayLabel}</span>
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                            ${esc(codes)}${s.pause_end_date ? ' · 복귀 ' + esc(s.pause_end_date) : ''}
                        </div>
                    </div>
                    ${consultIcon}
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
}

export function selectReturnUpcomingStudent(studentId) {
    state.selectedStudentId = studentId;
    renderReturnUpcomingList();
    renderStudentDetail(studentId);
}

// ─── 복귀상담 토글/메모 ──────────────────────────────────────────────────────

export async function toggleReturnConsult(studentId) {
    const s = state.allStudents.find(x => x.docId === studentId);
    if (!s) return;
    const newVal = !s.return_consult_done;
    showSaveIndicator('saving');
    try {
        const updateData = { return_consult_done: newVal };
        if (newVal) {
            updateData.return_consult_done_by = state.currentUser?.email || '';
            updateData.return_consult_done_at = serverTimestamp();
        } else {
            updateData.return_consult_done_by = deleteField();
            updateData.return_consult_done_at = deleteField();
        }
        await auditUpdate(doc(db, 'students', studentId), updateData);
        s.return_consult_done = newVal;
        if (newVal) {
            s.return_consult_done_by = state.currentUser?.email || '';
            s.return_consult_done_at = new Date();
        } else {
            delete s.return_consult_done_by;
            delete s.return_consult_done_at;
        }
        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('복귀상담 토글 실패:', err);
        showSaveIndicator('error');
    }
}

let _returnConsultNoteTimer = null;
export function updateReturnConsultNote(studentId, value) {
    const s = state.allStudents.find(x => x.docId === studentId);
    if (!s) return;
    s.return_consult_note = value;
    if (_returnConsultNoteTimer) clearTimeout(_returnConsultNoteTimer);
    _returnConsultNoteTimer = setTimeout(async () => {
        showSaveIndicator('saving');
        try {
            await auditUpdate(doc(db, 'students', studentId), {
                return_consult_note: value
            });
            showSaveIndicator('saved');
        } catch (err) {
            console.error('복귀상담 메모 저장 실패:', err);
            showSaveIndicator('error');
        }
    }, 600);
}

// ─── 복귀상담 전용 카드 (복귀예정 뷰에서만 표시) ─────────────────────────

export function renderReturnConsultCard(studentId) {
    if (!state.currentSubFilter.has('return_upcoming')) return '';
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student || !LEAVE_STATUSES.includes(student.status) || !student.pause_end_date) return '';

    // D-day 계산
    const now = parseDateKST(todayStr());
    const end = parseDateKST(student.pause_end_date);
    const daysLeft = Math.ceil((end - now) / 86400000);
    const ddayLabel = daysLeft === 0 ? 'D-Day' : daysLeft > 0 ? `D-${daysLeft}` : `D+${Math.abs(daysLeft)}`;
    const ddayCls = daysLeft <= 7 ? 'urgent' : 'soon';

    // 휴원 정보
    const pauseInfo = `${student.pause_start_date || '?'} ~ ${student.pause_end_date || '?'}`;
    const statusBadge = _leaveTypeBadgeOrFallback(null, student.status);

    // 상담 상태 (학생 문서 기반)
    const consultDone = student.return_consult_done || false;
    const consultNote = student.return_consult_note || '';
    const consultBy = student.return_consult_done_by ? getTeacherName(student.return_consult_done_by) : '';
    const consultAt = student.return_consult_done_at ? _fmtTs(student.return_consult_done_at, true) : '';

    const checkboxHtml = `<div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="toggleReturnConsult('${escAttr(studentId)}')">
        <span class="material-symbols-outlined" style="font-size:22px;color:${consultDone ? '#22c55e' : '#9ca3af'};">${consultDone ? 'check_circle' : 'radio_button_unchecked'}</span>
        <span style="font-size:13px;font-weight:600;color:${consultDone ? '#22c55e' : 'var(--text-pri)'};">${consultDone ? '상담 완료' : '상담 미완료'}</span>
    </div>`;

    const metaHtml = consultDone && (consultBy || consultAt)
        ? `<div style="font-size:11px;color:var(--text-sec);margin-top:4px;margin-left:30px;">${consultBy ? esc(consultBy) : ''} ${consultAt ? esc(consultAt) : ''}</div>`
        : '';

    const noteHtml = `<textarea style="width:100%;min-height:60px;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:13px;resize:vertical;box-sizing:border-box;margin-top:8px;"
        placeholder="복귀상담 내용을 입력하세요..."
        onchange="updateReturnConsultNote('${escAttr(studentId)}',this.value)">${esc(consultNote)}</textarea>`;

    return `
        <div class="detail-card" style="border-left:3px solid ${daysLeft <= 7 ? '#dc2626' : '#f59e0b'};">
            <div class="detail-card-title" style="display:flex;align-items:center;gap:8px;">
                <span class="material-symbols-outlined" style="color:#2563eb;font-size:18px;">phone_callback</span>
                복귀상담
                <span class="return-dday ${ddayCls}" style="margin-left:auto;">${ddayLabel}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
                ${statusBadge}
                <span style="font-size:12px;color:var(--text-sec);">${esc(pauseInfo)}</span>
            </div>
            ${checkboxHtml}
            ${metaHtml}
            ${noteHtml}
        </div>`;
}

// ─── 휴퇴원요청서 카드 (학생 상세) ──────────────────────────────────────────

function _renderLRRow(r, idx, studentId) {
    const typeBadge = _leaveRequestTypeBadge(r);

    let dateStr = '';
    if (r.return_date) dateStr = `복귀일: ${r.return_date}`;
    else if (r.withdrawal_date) dateStr = `퇴원일: ${r.withdrawal_date}`;
    else if (_isLeaveExtension(r.request_type)) dateStr = `연장 종료일: ${r.leave_end_date || '—'}`;
    else if (r.leave_start_date) dateStr = `${r.leave_start_date} ~ ${r.leave_end_date || ''}`;

    const reqBy = getTeacherName(r.requested_by);
    const tAppBy = getTeacherName(r.teacher_approved_by);
    const appBy = getTeacherName(r.approved_by);
    let metaHtml = `<div style="font-size:10px;color:var(--text-sec);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
        ${reqBy ? `<span>요청: ${esc(reqBy)} ${_fmtTs(r.requested_at, true)}</span>` : ''}
        ${tAppBy ? `<span>교수부: ${esc(tAppBy)} ${_fmtTs(r.teacher_approved_at, true)}</span>` : ''}
        ${appBy ? `<span>행정부: ${esc(appBy)} ${_fmtTs(r.approved_at, true)}</span>` : ''}
    </div>`;

    const noteHtml = r.consultation_note
        ? `<div style="font-size:12px;margin-top:4px;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;">${esc(r.consultation_note)}</div>`
        : '';

    // 서버 finalize 실패 배지 (Cloud Function이 학생 전이를 완료하지 못한 경우)
    const errorHtml = r.finalize_error
        ? `<div style="margin-top:6px;padding:6px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:11px;">
            <strong>서버 처리 실패</strong> (${r.finalize_attempts || 0}회 시도): ${esc(r.finalize_error)}
            <button class="lr-btn lr-btn-outlined" style="margin-left:8px;font-size:10px;padding:2px 6px;"
                onclick="window._retryFinalize?.('${escAttr(r.docId)}')">재시도</button>
           </div>`
        : '';

    // 3버튼 토글 UI
    let actionsHtml = '';
    if (r.status !== 'approved' && r.status !== 'rejected') {
        const cDone = r.status === 'cancelled';
        const tDone = !!r.teacher_approved_by;
        const aDone = !!r.approved_by;
        actionsHtml = `
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;">
                <button class="lr-btn ${cDone ? 'lr-btn-filled' : 'lr-btn-outlined'}" style="${cDone ? '' : 'opacity:0.5;'}"
                    onclick="toggleCancelLeaveRequest('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                    <span class="material-symbols-outlined">${cDone ? 'cancel' : 'radio_button_unchecked'}</span>취소
                </button>
                <button class="lr-btn ${tDone ? 'lr-btn-filled' : 'lr-btn-outlined'}" style="${tDone ? '' : 'opacity:0.5;'}"
                    onclick="teacherApproveLeaveRequest('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                    <span class="material-symbols-outlined">${tDone ? 'check_circle' : 'radio_button_unchecked'}</span>교수부
                </button>
                <button class="lr-btn ${aDone ? 'lr-btn-filled' : 'lr-btn-outlined'}" style="${aDone ? '' : 'opacity:0.5;'}"
                    onclick="approveLeaveRequest('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                    <span class="material-symbols-outlined">${aDone ? 'check_circle' : 'radio_button_unchecked'}</span>행정부
                </button>
            </div>`;
    }

    // 복귀상담 메모 (최종 승인 완료 건)
    let returnConsultHtml = '';
    if (r.status === 'approved') {
        const stu = state.allStudents.find(x => x.docId === studentId);
        const consultDone = stu?.return_consult_done;
        const consultChecked = consultDone ? 'check_circle' : 'phone_in_talk';
        const consultColor = consultDone ? '#22c55e' : '#f59e0b';
        returnConsultHtml = `
            <div style="margin-top:8px;padding:8px;background:var(--bg-secondary);border-radius:6px;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <span class="return-consult-icon material-symbols-outlined" style="color:${consultColor};font-size:18px;cursor:pointer;"
                        onclick="toggleReturnConsult('${escAttr(studentId)}')">${consultChecked}</span>
                    <span style="font-size:12px;font-weight:600;color:var(--text-sec);">복귀유도 상담</span>
                </div>
                <textarea style="width:100%;min-height:48px;border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:12px;resize:vertical;box-sizing:border-box;"
                    placeholder="복귀상담 메모..."
                    onchange="updateReturnConsultNote('${escAttr(studentId)}',this.value)">${esc(stu?.return_consult_note || '')}</textarea>
            </div>`;
    }

    return `
        <div class="pending-task-row" data-lr-idx="${idx}" style="background:#f0f5ff;">
            <div class="pending-task-summary" onclick="this.parentElement.classList.toggle('expanded')">
                <span>${typeBadge} ${_leaveRequestStatusBadge(r)} <span style="font-size:12px;color:var(--text-sec);margin-left:4px;">${esc(dateStr)}</span></span>
                <span class="pending-task-arrow material-symbols-outlined" style="font-size:16px;color:var(--text-sec);">expand_more</span>
            </div>
            <div class="pending-task-expand">
                ${errorHtml}
                ${noteHtml}
                ${metaHtml}
                ${actionsHtml}
                ${returnConsultHtml}
            </div>
        </div>`;
}

// finalize_error 수동 재시도: status를 'requested' → 'approved' 토글로 onUpdate 재발동.
// finalize_* 필드는 admin SDK만 쓸 수 있어 클라이언트에서 삭제 불가 → status 토글 방식 사용.
// 두 write 사이 지연은 Firestore가 빠른 연속 write를 하나의 onUpdate로 coalesce하는 것을 방지 (before가 'approved'면 Function 가드에서 return).
export async function retryFinalize(docId) {
    const r = state.leaveRequests.find(lr => lr.docId === docId);
    if (!r) return;
    if (!confirm(`${r.student_name} — 서버 처리 재시도할까요?`)) return;
    try {
        await auditUpdate(doc(db, 'leave_requests', docId), { status: 'requested' });
        await new Promise(resolve => setTimeout(resolve, 500));
        await auditUpdate(doc(db, 'leave_requests', docId), { status: 'approved' });
        showSaveIndicator('saved');
    } catch (err) {
        alert('재시도 실패: ' + err.message);
        console.error(err);
    }
}

export function renderLeaveRequestCard(studentId) {
    const records = state.leaveRequests.filter(r => r.student_id === studentId);
    const student = findStudent(studentId);
    const stuStatus = student?.status || '';
    const isWithdrawnStu = stuStatus === '퇴원';
    const isLeaveStu = LEAVE_STATUSES.includes(stuStatus);

    // 복귀요청은 "휴원 → 재원" 이므로 휴원 라이프사이클(휴원요청서 카드)에 소속.
    // 재등원요청(퇴원 → 재원)만 퇴원요청서 카드에 남김.
    const leaveRecords = records.filter(r => !_isWithdrawalType(r.request_type) && !_isReEnrollType(r.request_type));
    const withdrawRecords = records.filter(r => _isWithdrawalType(r.request_type) || _isReEnrollType(r.request_type));

    const btnStyle = 'font-size:11px;padding:2px 8px;margin-left:auto;display:inline-flex;align-items:center;gap:4px;';
    let cards = '';

    // 휴원요청서 카드
    const leaveBtn = isLeaveStu
        ? `<button class="lr-btn lr-btn-tonal" style="${btnStyle}" onclick="openReturnFromLeaveModal('${escAttr(studentId)}')">
            <span class="material-symbols-outlined" style="font-size:14px;">undo</span>복귀</button>`
        : '';
    if (leaveRecords.length > 0 || leaveBtn) {
        cards += `<div class="detail-card">
            <div class="detail-card-title" style="display:flex;align-items:center;gap:6px;">
                <span class="material-symbols-outlined" style="color:#2563eb;font-size:18px;">description</span>
                휴원요청서 <span style="font-size:12px;color:var(--text-sec);">(${leaveRecords.length}건)</span>
                ${leaveBtn}
            </div>
            ${leaveRecords.map((r, i) => _renderLRRow(r, i, studentId)).join('')}
        </div>`;
    }

    // 퇴원요청서 카드
    const withdrawBtn = isWithdrawnStu
        ? `<button class="lr-btn lr-btn-tonal" style="${btnStyle}" onclick="openReEnrollModal('${escAttr(studentId)}')">
            <span class="material-symbols-outlined" style="font-size:14px;">person_add</span>재등원</button>`
        : '';
    if (withdrawRecords.length > 0 || withdrawBtn) {
        cards += `<div class="detail-card">
            <div class="detail-card-title" style="display:flex;align-items:center;gap:6px;">
                <span class="material-symbols-outlined" style="color:#dc2626;font-size:18px;">description</span>
                퇴원요청서 <span style="font-size:12px;color:var(--text-sec);">(${withdrawRecords.length}건)</span>
                ${withdrawBtn}
            </div>
            ${withdrawRecords.map((r, i) => _renderLRRow(r, i, studentId)).join('')}
        </div>`;
    }

    return cards;
}

// ─── 휴퇴원요청서 모달 로직 ─────────────────────────────────────────────────

let _leaveRequestStudentId = null;
let _leaveRequestStudentData = null;

export function openLeaveRequestModal() {
    document.getElementById('lr-request-type').value = '휴원요청';
    document.getElementById('lr-sub-type').value = '실휴원';
    document.getElementById('lr-consultation-note').value = '';
    onLeaveRequestTypeChange(); // resets student state + date fields
    document.getElementById('leave-request-modal').style.display = 'flex';
}

export function onLeaveRequestTypeChange() {
    const type = document.getElementById('lr-request-type').value;
    const subWrap = document.getElementById('lr-sub-type-wrap');
    subWrap.style.display = _isLeaveSubType(type) ? '' : 'none';
    _renderLeaveRequestDateFields(type);
    // 퇴원→휴원 선택 시 퇴원 학생 lazy-load
    if (type === '퇴원→휴원' && state.withdrawnStudents.length === 0) {
        loadWithdrawnStudents();
    }
    // 검색 초기화
    _leaveRequestStudentId = null;
    _leaveRequestStudentData = null;
    document.getElementById('lr-student-search').value = '';
    document.getElementById('lr-student-results').innerHTML = '';
    document.getElementById('lr-student-info').style.display = 'none';
}

function _renderLeaveRequestDateFields(type) {
    const container = document.getElementById('lr-date-fields');
    if (_isWithdrawalType(type)) {
        container.innerHTML = `
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">퇴원시작일</label>
            <input type="date" id="lr-withdrawal-date" class="field-input" style="width:100%;">`;
    } else if (_isLeaveExtension(type)) {
        container.innerHTML = `
            <div>
                <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">연장 종료일</label>
                <input type="date" id="lr-leave-end" class="field-input" style="width:100%;">
            </div>`;
    } else {
        container.innerHTML = `
            <div style="display:flex;gap:8px;">
                <div style="flex:1;">
                    <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">휴원시작일</label>
                    <input type="date" id="lr-leave-start" class="field-input" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">휴원종료일</label>
                    <input type="date" id="lr-leave-end" class="field-input" style="width:100%;">
                </div>
            </div>`;
    }
}

export function searchLeaveRequestStudent(term) {
    const results = document.getElementById('lr-student-results');
    if (!term || term.length < 1) { results.innerHTML = ''; return; }

    const type = document.getElementById('lr-request-type').value;
    let pool;
    if (type === '퇴원→휴원') {
        pool = state.withdrawnStudents;
    } else if (type === '휴원→퇴원' || type === '휴원연장') {
        // 휴원연장은 이미 휴원 중인 학생 대상
        pool = state.allStudents.filter(s => LEAVE_STATUSES.includes(s.status));
    } else {
        // 휴원요청/퇴원요청 — 재원·등원예정 학생 대상
        pool = state.allStudents.filter(s => s.status === '재원' || s.status === '등원예정');
    }

    const matched = pool.filter(s => s.name.includes(term)).slice(0, 10);

    if (matched.length === 0) {
        results.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-sec);">결과 없음</div>';
        return;
    }

    results.innerHTML = matched.map(s => {
        const codes = allClassCodes(s).join(', ');
        return `<div class="list-item" style="padding:6px 10px;cursor:pointer;" onclick="selectLeaveRequestStudentById('${escAttr(s.docId)}')">
            <span style="font-weight:600;font-size:13px;">${esc(s.name)}</span>
            <span style="font-size:11px;color:var(--text-sec);margin-left:6px;">${esc(codes)} · ${esc(s.status || '')}</span>
        </div>`;
    }).join('');
}

export function selectLeaveRequestStudentById(id) {
    const type = document.getElementById('lr-request-type').value;
    const pool = type === '퇴원→휴원' ? state.withdrawnStudents : state.allStudents;
    const s = pool.find(st => st.docId === id);
    if (!s) return;

    _leaveRequestStudentId = id;
    _leaveRequestStudentData = s;

    document.getElementById('lr-student-search').value = s.name;
    document.getElementById('lr-student-results').innerHTML = '';
    document.getElementById('lr-student-info').style.display = '';
    document.getElementById('lr-student-name').textContent = s.name;
    document.getElementById('lr-student-class').textContent = allClassCodes(s).join(', ');
    document.getElementById('lr-student-status').textContent = s.status || '';
    document.getElementById('lr-student-phone').textContent = s.student_phone || '—';
    document.getElementById('lr-parent-phone').textContent = s.parent_phone_1 || '—';
}

export async function submitLeaveRequest() {
    if (!_leaveRequestStudentId || !_leaveRequestStudentData) {
        alert('학생을 선택해주세요.');
        return;
    }

    const type = document.getElementById('lr-request-type').value;
    const s = _leaveRequestStudentData;
    const isWithdrawal = _isWithdrawalType(type);
    const showSub = _isLeaveSubType(type);

    const data = {
        student_id: _leaveRequestStudentId,
        student_name: s.name,
        branch: branchFromStudent(s),
        class_codes: activeClassCodes(s, state.selectedDate),
        request_type: type,
        student_phone: s.student_phone || '',
        parent_phone_1: s.parent_phone_1 || '',
        consultation_note: document.getElementById('lr-consultation-note').value.trim(),
        status: 'requested',
        previous_status: s.status || '',
        requested_by: state.currentUser?.email || '',
        requested_at: serverTimestamp(),
        created_at: serverTimestamp()
    };

    if (showSub) {
        data.leave_sub_type = document.getElementById('lr-sub-type').value;
    }

    if (isWithdrawal) {
        const wd = document.getElementById('lr-withdrawal-date')?.value;
        if (!wd) { alert('퇴원시작일을 입력해주세요.'); return; }
        data.withdrawal_date = wd;
    } else if (_isLeaveExtension(type)) {
        const le = document.getElementById('lr-leave-end')?.value;
        if (!le) { alert('연장 종료일을 입력해주세요.'); return; }
        data.leave_end_date = le;
    } else {
        const ls = document.getElementById('lr-leave-start')?.value;
        const le = document.getElementById('lr-leave-end')?.value;
        if (!ls || !le) { alert('휴원 시작일과 종료일을 입력해주세요.'); return; }
        if (le < ls) { alert('종료일이 시작일보다 앞섭니다.'); return; }
        data.leave_start_date = ls;
        data.leave_end_date = le;
    }

    try {
        const docRef = await auditAdd(collection(db, 'leave_requests'), data);
        state.leaveRequests.push({ docId: docRef.id, ...data, requested_at: new Date(), created_at: new Date() });
        document.getElementById('leave-request-modal').style.display = 'none';
        showSaveIndicator('saved');
        renderSubFilters();
        renderLeaveRequestList();
    } catch (err) {
        alert('요청 저장 실패: ' + err.message);
        console.error(err);
    }
}

// ─── 휴퇴원 승인/취소 (3단계: 요청 → 교수부승인 → 행정부승인) ─────────────────

// 요청취소 토글
export async function toggleCancelLeaveRequest(docId, studentId) {
    const r = state.leaveRequests.find(lr => lr.docId === docId);
    if (!r) return;
    const isCancelled = r.status === 'cancelled';
    try {
        await auditUpdate(doc(db, 'leave_requests', docId), { status: isCancelled ? 'requested' : 'cancelled' });
        const lrIdx = state.leaveRequests.findIndex(lr => lr.docId === docId);
        if (lrIdx >= 0) state.leaveRequests[lrIdx].status = isCancelled ? 'requested' : 'cancelled';
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) renderLeaveRequestList();
        renderStudentDetail(studentId);
    } catch (err) { alert('처리 실패: ' + err.message); }
}

// 방어 가드: 최종 승인 시 RETURN 유형(복귀/재등원)은 반드시 target_class_code 필요
// 정상 UI 경로에서는 세팅되지만, 데이터 마이그레이션/수동 생성 등 비정상 경로 방어용.
function _checkLegacyReturnTarget(r, willFinalize) {
    if (!willFinalize) return true;
    const isReturn = _isReturnType(r.request_type);
    if (isReturn && !r.target_class_code) {
        alert('이 요청에 "복귀할 반" 정보가 없습니다.\n요청을 취소하고 새로 작성해주세요.');
        return false;
    }
    return true;
}

// 교수부 승인 토글
export async function teacherApproveLeaveRequest(docId, studentId) {
    const r = state.leaveRequests.find(lr => lr.docId === docId);
    if (!r) return;
    // 토글: 이미 승인 → 취소
    if (r.teacher_approved_by) {
        if (!confirm(`${r.student_name} — 교수부 승인을 취소하시겠습니까?`)) return;
        try {
            await auditUpdate(doc(db, 'leave_requests', docId), { teacher_approved_by: deleteField(), teacher_approved_at: deleteField() });
            const lrIdx = state.leaveRequests.findIndex(lr => lr.docId === docId);
            if (lrIdx >= 0) { delete state.leaveRequests[lrIdx].teacher_approved_by; delete state.leaveRequests[lrIdx].teacher_approved_at; }
            showSaveIndicator('saved');
            renderSubFilters();
            if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) renderLeaveRequestList();
            renderStudentDetail(studentId);
        } catch (err) { alert('교수부 승인 취소 실패: ' + err.message); }
        return;
    }
    const typeLabel = `${r.request_type}${r.leave_sub_type ? ' (' + r.leave_sub_type + ')' : ''}`;
    const isFinal = !!r.approved_by;
    // 레거시 가드 (최종 승인 시점에만 체크)
    if (!_checkLegacyReturnTarget(r, isFinal)) return;
    const confirmMsg = isFinal
        ? `⚠️ ${r.student_name} — ${typeLabel}\n\n행정부 승인이 이미 완료되어, 교수부 승인 시 최종 승인 처리됩니다.\n학생 상태가 변경됩니다. 진행하시겠습니까?`
        : `${r.student_name} — ${typeLabel}\n교수부 승인하시겠습니까?`;
    if (!confirm(confirmMsg)) return;

    try {
        const updates = { teacher_approved_by: state.currentUser?.email || '', teacher_approved_at: serverTimestamp() };
        if (r.approved_by) updates.status = 'approved';
        await auditUpdate(doc(db, 'leave_requests', docId), updates);

        const lrIdx = state.leaveRequests.findIndex(lr => lr.docId === docId);
        if (lrIdx >= 0) {
            state.leaveRequests[lrIdx].teacher_approved_by = state.currentUser?.email || '';
            state.leaveRequests[lrIdx].teacher_approved_at = new Date();
            if (r.approved_by) state.leaveRequests[lrIdx].status = 'approved';
        }

        // 최종 승인된 경우 학생 상태 전이는 Cloud Function(onLeaveRequestApproved)이 처리
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) renderLeaveRequestList();
        renderStudentDetail(studentId);
    } catch (err) {
        alert('교수부 승인 실패: ' + err.message);
        console.error(err);
    }
}

// 행정부 승인 토글
export async function approveLeaveRequest(docId, studentId) {
    const r = state.leaveRequests.find(lr => lr.docId === docId);
    if (!r) return;
    // 토글: 이미 승인 → 취소
    if (r.approved_by) {
        if (!confirm(`${r.student_name} — 행정부 승인을 취소하시겠습니까?`)) return;
        try {
            await auditUpdate(doc(db, 'leave_requests', docId), { approved_by: deleteField(), approved_at: deleteField() });
            const lrIdx = state.leaveRequests.findIndex(lr => lr.docId === docId);
            if (lrIdx >= 0) { delete state.leaveRequests[lrIdx].approved_by; delete state.leaveRequests[lrIdx].approved_at; }
            showSaveIndicator('saved');
            renderSubFilters();
            if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) renderLeaveRequestList();
            renderStudentDetail(studentId);
        } catch (err) { alert('행정부 승인 취소 실패: ' + err.message); }
        return;
    }

    const typeLabel = `${r.request_type}${r.leave_sub_type ? ' (' + r.leave_sub_type + ')' : ''}`;
    const isFinal = !!r.teacher_approved_by;
    // 레거시 가드 (최종 승인 시점에만 체크)
    if (!_checkLegacyReturnTarget(r, isFinal)) return;
    const confirmMsg = isFinal
        ? `⚠️ ${r.student_name} — ${typeLabel}\n\n교수부 승인이 이미 완료되어, 행정부 승인 시 최종 승인 처리됩니다.\n학생 상태가 변경됩니다. 진행하시겠습니까?`
        : `${r.student_name} — ${typeLabel}\n행정부 승인하시겠습니까?`;
    if (!confirmMsg || !confirm(confirmMsg)) return;

    try {
        const updates = { approved_by: state.currentUser?.email || '', approved_at: serverTimestamp() };
        if (r.teacher_approved_by) updates.status = 'approved';
        await auditUpdate(doc(db, 'leave_requests', docId), updates);

        const lrIdx = state.leaveRequests.findIndex(lr => lr.docId === docId);
        if (lrIdx >= 0) {
            state.leaveRequests[lrIdx].approved_by = state.currentUser?.email || '';
            state.leaveRequests[lrIdx].approved_at = new Date();
            if (r.teacher_approved_by) state.leaveRequests[lrIdx].status = 'approved';
        }

        // 최종 승인된 경우 학생 상태 전이는 Cloud Function(onLeaveRequestApproved)이 처리
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) renderLeaveRequestList();
        renderStudentDetail(studentId);
    } catch (err) {
        alert('행정부 승인 실패: ' + err.message);
        console.error(err);
    }
}

export async function cancelLeaveRequest(docId, studentId) {
    if (!confirm('요청을 취소하시겠습니까?')) return;
    try {
        await auditUpdate(doc(db, 'leave_requests', docId), {
            status: 'cancelled'
        });
        state.leaveRequests = state.leaveRequests.filter(lr => lr.docId !== docId);
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) {
            renderLeaveRequestList();
        }
        renderStudentDetail(studentId);
    } catch (err) {
        alert('취소 실패: ' + err.message);
        console.error(err);
    }
}

// ─── 재등원 / 휴원복귀 모달 (공용) ──────────────────────────────────────────

let _returnModalStudentId = null;
let _returnModalType = null; // '재등원요청' | '복귀요청'

function _openReturnModal(studentId, type) {
    const student = findStudent(studentId);
    if (!student) { alert('학생 정보를 찾을 수 없습니다.'); return; }

    _returnModalStudentId = studentId;
    _returnModalType = type;

    // 모달 제목
    const titleEl = document.querySelector('#return-from-leave-modal .modal-header h3');
    titleEl.textContent = _isReEnrollType(type) ? '재등원 요청' : '복귀 요청';

    // 날짜 라벨
    document.getElementById('rfl-date-label').textContent = _isReEnrollType(type) ? '재등원일' : '복귀일';

    document.getElementById('rfl-student-name').textContent = student.name;
    document.getElementById('rfl-student-class').textContent = allClassCodes(student).join(', ');
    document.getElementById('rfl-student-status').textContent = student.status || '';

    let periodText = '';
    if (student.status === '퇴원') {
        // 퇴원 학생: 퇴원일 표시
        const wdLr = state.leaveRequests.find(lr => lr.student_id === studentId && lr.status === 'approved' &&
            (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원'));
        if (wdLr?.withdrawal_date) periodText = `퇴원일: ${wdLr.withdrawal_date}`;
    } else if (student.pause_start_date) {
        periodText = `휴원기간: ${student.pause_start_date} ~ ${student.pause_end_date || ''}`;
    }
    document.getElementById('rfl-leave-period').textContent = periodText;

    const today = state.selectedDate || todayStr();
    document.getElementById('rfl-return-date').value = today;
    document.getElementById('rfl-consultation-note').value = '';

    // class_settings에 level(초/중/고) 메타가 없어 branch만으로 필터.
    // 학부 이동은 재등원 후 학생 상세에서 수동 처리.
    const branch = branchFromStudent(student);
    const select = document.getElementById('rfl-target-class');
    select.innerHTML = '<option value="">-- 반 선택 --</option>';
    const candidates = Object.entries(state.classSettings || {})
        .filter(([code, cs]) => {
            // 정규반만 (class_type 없음=레거시 정규 포함, '내신'/'특강' 제외).
            // 자유학기는 정규 코드 공유하되 free_schedule이 있음 — 정규로 취급.
            if (cs.class_type && cs.class_type !== '정규') return false;
            // code의 첫 숫자로 branch 추론 (A101 → '1' → 2단지, A201 → '2' → 10단지)
            const firstDigit = (code.match(/\d/) || [''])[0];
            const codeBranch = firstDigit === '1' ? '2단지' : firstDigit === '2' ? '10단지' : '';
            if (branch && codeBranch && codeBranch !== branch) return false;
            return true;
        })
        .sort(([a], [b]) => a.localeCompare(b));
    for (const [code, cs] of candidates) {
        const days = (cs.default_days || Object.keys(cs.schedule || {})).join('·');
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = days ? `${code} (${days})` : code;
        select.appendChild(opt);
    }
    const existingReg = (student.enrollments || []).find(e =>
        (!e.class_type || e.class_type === '정규') && e.class_number
    );
    if (existingReg) {
        const existingCode = enrollmentCode(existingReg);
        if (candidates.some(([c]) => c === existingCode)) {
            select.value = existingCode;
        }
    }
    const hintEl = document.getElementById('rfl-target-class-hint');
    hintEl.textContent = select.value
        ? `현재 선택: ${select.value}`
        : '복귀할 반을 선택하세요';
    window._onRflTargetClassChange = () => {
        const code = select.value;
        hintEl.textContent = code ? `선택: ${code}` : '복귀할 반을 선택하세요';
    };

    document.getElementById('return-from-leave-modal').style.display = 'flex';
}

export function openReEnrollModal(studentId) {
    _openReturnModal(studentId, '재등원요청');
}

export function openReturnFromLeaveModal(studentId) {
    _openReturnModal(studentId, '복귀요청');
}

export async function submitReturnFromLeave() {
    if (!_returnModalStudentId || !_returnModalType) return;

    const student = findStudent(_returnModalStudentId);
    if (!student) { alert('학생 정보를 찾을 수 없습니다.'); return; }

    const returnDate = document.getElementById('rfl-return-date').value;
    if (!returnDate) { alert(_isReEnrollType(_returnModalType) ? '재등원일을 입력해주세요.' : '복귀일을 입력해주세요.'); return; }

    const targetClassCode = document.getElementById('rfl-target-class').value || '';
    if (!targetClassCode) {
        alert('복귀할 반을 선택해주세요.');
        return;
    }

    const note = document.getElementById('rfl-consultation-note').value.trim();

    try {
        const data = {
            student_id: _returnModalStudentId,
            student_name: student.name,
            branch: branchFromStudent(student),
            class_codes: activeClassCodes(student, state.selectedDate),
            request_type: _returnModalType,
            return_date: returnDate,
            target_class_code: targetClassCode,
            student_phone: student.student_phone || '',
            parent_phone_1: student.parent_phone_1 || '',
            consultation_note: note,
            status: 'requested',
            previous_status: student.status || '',
            requested_by: state.currentUser?.email || '',
            requested_at: serverTimestamp(),
            created_at: serverTimestamp()
        };

        const docRef = await auditAdd(collection(db, 'leave_requests'), data);
        state.leaveRequests.push({ docId: docRef.id, ...data, requested_at: new Date(), created_at: new Date() });

        document.getElementById('return-from-leave-modal').style.display = 'none';
        const savedStudentId = _returnModalStudentId;
        _returnModalStudentId = null;
        _returnModalType = null;
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) {
            renderLeaveRequestList();
        }
        renderStudentDetail(savedStudentId);
    } catch (err) {
        alert('요청 실패: ' + err.message);
        console.error(err);
    }
}

// resetReturnUpcomingCache — daily-ops에서 호출하여 캐시 초기화
export function resetReturnUpcomingCache() {
    _returnUpcomingCache = null;
}

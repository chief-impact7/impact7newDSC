// ─── Absence Records Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 결석대장 관련 함수
// Phase 3-2

import { doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet } from './audit.js';
import { state } from './state.js';
import { esc, escAttr, showSaveIndicator, _fmtTs, _stripYear, _renderRescheduleHistory } from './ui-utils.js';
import { makeDailyRecordId } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, getTeacherName, renderFilterChips;

export function initAbsenceRecordsDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    getTeacherName = deps.getTeacherName;
    renderFilterChips = deps.renderFilterChips;
}

// ─── 결석대장 리스트 뷰 ─────────────────────────────────────────────────────

function _renderValidityBadge(reasonValid) {
    if (!reasonValid) return '';
    const cls = reasonValid === '정당' ? 'valid' : 'invalid';
    return `<span class="absence-validity-badge ${cls}">${esc(reasonValid)}</span>`;
}

function _getAbsenceStatusGroup(r) {
    // 퇴원요청 학생 체크
    if (r._hasLeaveRequest) return { order: 7, label: '퇴원요청', badgeClass: 'noshow' };
    if (!r.consultation_done) return { order: 0, label: '미상담', badgeClass: 'unconsulted' };
    if (r.resolution === 'pending') return { order: 1, label: '처리 미결정', badgeClass: 'undecided' };
    if (r.resolution === '보충') {
        if (r.makeup_status === '미등원') return { order: 3, label: '보충 미등원', badgeClass: 'noshow' };
        if (r.makeup_status === '완료') return { order: 4, label: '보충 완료', badgeClass: 'completed' };
        if (r.makeup_date === 'undecided' || !r.makeup_date) return { order: 2, label: '보충입력대기', badgeClass: 'makeup' };
        return { order: 2, label: '보충 예정', badgeClass: 'makeup' };
    }
    if (r.resolution === '정산') return { order: 5, label: '정산 대기', badgeClass: 'settlement' };
    return { order: 6, label: '기타', badgeClass: 'undecided' };
}

export function renderAbsenceLedgerList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    // 퇴원승인 학생 제외, 퇴원요청 학생 플래그
    const approvedLeaveStudentIds = new Set(
        state.leaveRequests.filter(lr => lr.status === 'approved' && (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원'))
            .map(lr => lr.student_id)
    );
    const requestedLeaveStudentIds = new Set(
        state.leaveRequests.filter(lr => lr.status === 'requested' && (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원'))
            .map(lr => lr.student_id)
    );

    let records = state.absenceRecords.filter(r => !approvedLeaveStudentIds.has(r.student_id));
    if (state.selectedBranch) records = records.filter(r => r.branch === state.selectedBranch);
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        records = records.filter(r => r.student_name?.toLowerCase().includes(q) || r.class_code?.toLowerCase().includes(q));
    }

    // 퇴원요청 플래그 부여
    records.forEach(r => { r._hasLeaveRequest = requestedLeaveStudentIds.has(r.student_id); });

    countEl.textContent = `${records.length}건`;

    if (records.length === 0) {
        container.innerHTML = '<div class="empty-state">열린 결석 기록이 없습니다.</div>';
        return;
    }

    // 상태별 그룹 정렬
    records.sort((a, b) => {
        const ga = _getAbsenceStatusGroup(a);
        const gb = _getAbsenceStatusGroup(b);
        if (ga.order !== gb.order) return ga.order - gb.order;
        return (b.absence_date || '').localeCompare(a.absence_date || '');
    });

    let currentGroup = -1;
    let html = '';
    for (const r of records) {
        const group = _getAbsenceStatusGroup(r);
        if (group.order !== currentGroup) {
            currentGroup = group.order;
            html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(group.label)}</div>`;
        }
        const isActive = r.student_id === state.selectedStudentId;
        const validityBadge = _renderValidityBadge(r.reason_valid);
        const consultBtn = r.consultation_done
            ? '<span class="material-symbols-outlined" style="font-size:14px;color:var(--success);">check_circle</span>'
            : `<button class="btn-icon" style="padding:2px;" onclick="event.stopPropagation(); toggleConsultation('${escAttr(r.docId)}', '${escAttr(r.student_id)}')" title="상담 완료 처리"><span class="material-symbols-outlined" style="font-size:14px;color:var(--text-sec);">phone_callback</span></button>`;

        const _primaryCode = (r.class_code || '').split(',')[0].trim();
        const _teacherEmail = state.classSettings[_primaryCode]?.teacher;
        const _teacher = _teacherEmail ? getTeacherName(_teacherEmail) : '';
        const metaStr = _teacher ? ` · ${_teacher}` : '';

        html += `<div class="list-item ${isActive ? 'active' : ''}${state.bulkMode ? ' bulk-mode' : ''}${state.selectedStudentIds.has(r.student_id) ? ' bulk-selected' : ''}" data-id="${escAttr(r.student_id)}"
            onclick="handleListItemClick(event, '${escAttr(r.student_id)}')">
            <input type="checkbox" class="list-item-checkbox" ${state.selectedStudentIds.has(r.student_id) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(r.student_id)}', this.checked)">
            <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                ${consultBtn}
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:center;gap:4px;">
                        <span style="font-weight:600;font-size:13px;">${esc(r.student_name)}</span>
                        <span class="absence-status-badge ${group.badgeClass}">${esc(group.label)}</span>
                        ${validityBadge}
                    </div>
                    <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                        ${esc(r.class_code || '')} · ${esc(_stripYear(r.absence_date))}${r.reason ? ' · ' + esc(r.reason) : ''}${metaStr}
                    </div>
                </div>
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

// ─── 결석대장 CRUD ───────────────────────────────────────────────────────────

export async function updateAbsenceField(docId, field, value, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            [field]: value
        });
        r[field] = value;
        state._scheduledVisitsCache = null;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('결석대장 필드 업데이트 실패:', err);
        showSaveIndicator('error');
    }
}

export async function toggleConsultation(docId, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    const sid = studentId || r.student_id;
    const newVal = !r.consultation_done;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            consultation_done: newVal
        });
        r.consultation_done = newVal;
        if (sid) renderStudentDetail(sid);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('상담 토글 실패:', err);
        showSaveIndicator('error');
    }
}

// 1단계 유효성: 상담내용 + 사유 입력 후 정당/부당 설정 가능
export async function validateAndSetReasonValid(docId, value, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    // 버튼 클릭 시점의 실시간 입력값을 DOM에서 읽기
    const idx = state.absenceRecords.filter(x => x.student_id === studentId).indexOf(r);
    const cardEl = document.querySelector(`[data-absence-idx="${idx}"]`);
    let noteVal = r.consultation_note || '';
    let reasonVal = r.reason || '';
    if (cardEl) {
        const ta = cardEl.querySelector('[data-field="consultation-note"]');
        const inp = cardEl.querySelector('[data-field="reason"]');
        if (ta) noteVal = ta.value;
        if (inp) reasonVal = inp.value;
    }
    const missing = [];
    if (!noteVal.trim()) missing.push('상담 내용');
    if (!reasonVal.trim()) missing.push('결석 사유');
    if (missing.length > 0) {
        alert(`${missing.join(', ')}을(를) 먼저 입력해주세요.`);
        return;
    }
    // 배치 업데이트: 한 번의 Firestore 호출 + 한 번의 렌더링
    const newVal = r.reason_valid === value ? '' : value;
    const updates = {};
    if (noteVal.trim() !== (r.consultation_note || '')) updates.consultation_note = noteVal.trim();
    if (reasonVal.trim() !== (r.reason || '')) updates.reason = reasonVal.trim();
    updates.reason_valid = newVal;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            ...updates
        });
        Object.assign(r, updates);
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('결석대장 1단계 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// 2단계 유효성: 상담완료 + 보충/정산 둘 다 필요
export function validateAndSetResolution(docId, resolution, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    if (!r.consultation_done) {
        alert('상담완료를 먼저 체크해주세요.');
        return;
    }
    setAbsenceResolution(docId, resolution, studentId);
}

export async function setAbsenceResolution(docId, resolution, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    const newRes = r.resolution === resolution ? 'pending' : resolution;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            resolution: newRes
        });
        r.resolution = newRes;
        state._scheduledVisitsCache = null;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('처리방법 설정 실패:', err);
        showSaveIndicator('error');
    }
}

export async function completeAbsenceMakeup(docId, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            makeup_status: '완료',
            makeup_completed_by: state.currentUser?.email || '',
            makeup_completed_at: serverTimestamp()
        });
        r.makeup_status = '완료';
        r.makeup_completed_by = state.currentUser?.email || '';
        r.makeup_completed_at = new Date();
        state._scheduledVisitsCache = null;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('보충완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

export async function markAbsenceNoShow(docId, studentId) {
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            makeup_status: '미등원'
        });
        r.makeup_status = '미등원';
        state._scheduledVisitsCache = null;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('미등원 처리 실패:', err);
        showSaveIndicator('error');
    }
}

export async function switchToSettlement(docId, studentId) {
    if (!confirm('정산으로 전환하시겠습니까?')) return;
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            resolution: '정산',
            makeup_status: 'pending'
        });
        r.resolution = '정산';
        r.makeup_status = 'pending';
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('정산전환 실패:', err);
        showSaveIndicator('error');
    }
}

export async function closeAbsenceRecord(docId, studentId) {
    if (!confirm('이 결석 건의 행정절차를 종료하시겠습니까?\n(목록에서 사라지며 되돌릴 수 없습니다)')) return;
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        const absenceDate = r.absence_date || state.selectedDate;
        await auditUpdate(doc(db, 'absence_records', docId), {
            status: 'closed'
        });
        // daily_records에 absence_closed 마커 저장 → syncAbsenceRecords가 재생성하지 않도록
        const dailyDocId = makeDailyRecordId(studentId, absenceDate);
        await auditSet(doc(db, 'daily_records', dailyDocId), {
            student_id: studentId,
            date: absenceDate,
            absence_closed: true
        }, { merge: true });
        if (state.dailyRecords[studentId]) state.dailyRecords[studentId].absence_closed = true;
        state.absenceRecords = state.absenceRecords.filter(x => x.docId !== docId);
        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('결석대장 종료 실패:', err);
        showSaveIndicator('error');
    }
}

export function openAbsenceRescheduleModal(docId, studentId) {
    window.openRescheduleModal('absence_records', docId, studentId);
}

export async function reopenAbsenceMakeup(docId, studentId) {
    if (!confirm('보충 완료를 취소하고 재예약하시겠습니까?')) return;
    const r = state.absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'absence_records', docId), {
            makeup_status: 'pending',
            makeup_date: '',
            makeup_time: '',
            makeup_completed_by: '',
            makeup_completed_at: ''
        });
        r.makeup_status = 'pending';
        r.makeup_date = '';
        r.makeup_time = '';
        r.makeup_completed_by = '';
        r.makeup_completed_at = '';
        state._scheduledVisitsCache = null;
        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('보충 재예약 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 결석대장 단계 뱃지 헬퍼 ─────────────────────────────────────────────────

function _renderStepBadge(number, isDone, primaryColor = 'var(--primary)') {
    const bg = isDone ? 'var(--success)' : primaryColor;
    const check = isDone ? '<span class="material-symbols-outlined" style="font-size:14px;color:var(--success);">check</span>' : '';
    return `<span style="background:${bg};color:#fff;border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;">${number}</span> ${check}`;
}

// ─── 결석대장 카드 expanded 상태 보존 헬퍼 ──────────────────────────────────

export function _getExpandedAbsenceIndices() {
    const indices = [];
    document.querySelectorAll('[data-absence-idx]').forEach(el => {
        if (el.classList.contains('expanded')) {
            indices.push(el.getAttribute('data-absence-idx'));
        }
    });
    return indices;
}

export function _restoreExpandedAbsenceIndices(indices) {
    if (!indices || indices.length === 0) return;
    indices.forEach(idx => {
        const el = document.querySelector(`[data-absence-idx="${idx}"]`);
        if (el) el.classList.add('expanded');
    });
}

// ─── 결석대장 카드 (학생 상세) ───────────────────────────────────────────────

export function renderAbsenceRecordCard(studentId) {
    const records = state.absenceRecords.filter(r => r.student_id === studentId);
    if (records.length === 0) return '';

    const rows = records.map((r, idx) => {
        const group = _getAbsenceStatusGroup(r);
        const validityBadge = _renderValidityBadge(r.reason_valid);
        const consultChecked = r.consultation_done ? 'checked' : '';

        // ── 1단계: 상담내용, 결석사유, 정당/부당 (항상 표시) ──
        const stage1Done = !!(r.consultation_note && r.reason && r.reason_valid);
        const stage1Html = `
            <div style="margin-bottom:8px;">
                <div style="font-size:10px;color:var(--text-sec);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                    ${_renderStepBadge(1, stage1Done)}
                    상담 · 사유
                </div>
                <textarea class="field-input" data-field="consultation-note" style="width:100%;min-height:40px;resize:vertical;font-size:12px;margin-bottom:6px;"
                    placeholder="상담 내용..."
                    onchange="updateAbsenceField('${escAttr(r.docId)}', 'consultation_note', this.value, '${escAttr(studentId)}')">${esc(r.consultation_note || '')}</textarea>
                <div style="display:flex;align-items:center;gap:4px;">
                    <input type="text" class="field-input" data-field="reason" style="flex:1;font-size:12px;" placeholder="결석 사유"
                        value="${escAttr(r.reason || '')}"
                        onchange="updateAbsenceField('${escAttr(r.docId)}', 'reason', this.value, '${escAttr(studentId)}')" />
                    <button class="hw-fail-type-btn ${r.reason_valid === '정당' ? 'active' : ''}" style="font-size:11px;${r.reason_valid === '정당' ? 'background:#16a34a;border-color:#16a34a;color:#fff;' : ''}"
                        onclick="validateAndSetReasonValid('${escAttr(r.docId)}', '정당', '${escAttr(studentId)}')">정당</button>
                    <button class="hw-fail-type-btn ${r.reason_valid === '부당' ? 'active' : ''}" style="font-size:11px;${r.reason_valid === '부당' ? 'background:#dc2626;border-color:#dc2626;color:#fff;' : ''}"
                        onclick="validateAndSetReasonValid('${escAttr(r.docId)}', '부당', '${escAttr(studentId)}')">부당</button>
                </div>
            </div>`;

        // ── 이미 입력된 카드인지 판별 (resolution이 설정됨 → 보기 모드: 모든 단계 표시) ──
        const hasExistingData = !!(r.resolution && r.resolution !== 'pending');

        // ── 2단계 조건: 1단계 모두 입력 시 표시 (보기 모드면 항상 표시) ──
        const stage2Done = !!(stage1Done && r.consultation_done && r.resolution && r.resolution !== 'pending');
        const stage2Html = !(stage1Done || hasExistingData) ? '' : `
            <div style="margin-bottom:8px;padding-top:8px;border-top:1px dashed var(--border);">
                <div style="font-size:10px;color:var(--text-sec);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                    ${_renderStepBadge(2, stage2Done)}
                    상담완료 · 처리방법
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap;">
                        <input type="checkbox" ${consultChecked} onchange="toggleConsultation('${escAttr(r.docId)}', '${escAttr(studentId)}')" />
                        상담완료
                    </label>
                    <span style="width:1px;height:16px;background:var(--border);margin:0 2px;"></span>
                    <span style="font-size:11px;color:var(--text-sec);white-space:nowrap;">처리방법:</span>
                    <button class="hw-fail-type-btn ${r.resolution === '보충' ? 'active' : ''}" style="font-size:11px;${r.resolution === '보충' ? 'background:#2563eb;border-color:#2563eb;color:#fff;' : ''}"
                        onclick="validateAndSetResolution('${escAttr(r.docId)}', '보충', '${escAttr(studentId)}')">보충</button>
                    <button class="hw-fail-type-btn ${r.resolution === '정산' ? 'active' : ''}" style="font-size:11px;${r.resolution === '정산' ? 'background:#7c3aed;border-color:#7c3aed;color:#fff;' : ''}"
                        onclick="validateAndSetResolution('${escAttr(r.docId)}', '정산', '${escAttr(studentId)}')">정산</button>
                </div>
            </div>`;

        // ── 3단계: 2단계 완료 후 또는 보기 모드 시 표시 ──
        let stage3Html = '';
        if ((stage2Done || hasExistingData) && r.resolution === '보충') {
            const isUndecided = r.makeup_date === 'undecided';
            const makeupDateVal = isUndecided ? '' : (r.makeup_date || '');
            const makeupTimeVal = r.makeup_time || '16:00';
            const hasMakeupDate = !!r.makeup_date && !isUndecided;

            // 보충완료/미등원은 날짜 입력 후에만 표시
            let makeupActions = '';
            if (hasMakeupDate) {
                if (r.makeup_status === 'pending') {
                    makeupActions = `
                        <button class="hw-fail-type-btn active" style="background:var(--success);border-color:var(--success);font-size:11px;"
                            onclick="completeAbsenceMakeup('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">check_circle</span>보충완료
                        </button>
                        <button class="hw-fail-type-btn" style="font-size:11px;background:#dc2626;border-color:#dc2626;color:#fff;"
                            onclick="markAbsenceNoShow('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">person_off</span>미등원
                        </button>`;
                } else if (r.makeup_status === '미등원') {
                    makeupActions = `
                        <button class="hw-fail-type-btn" style="font-size:11px;background:#7c3aed;border-color:#7c3aed;color:#fff;"
                            onclick="openAbsenceRescheduleModal('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">event</span>재예약
                        </button>
                        <button class="hw-fail-type-btn" style="font-size:11px;"
                            onclick="switchToSettlement('${escAttr(r.docId)}', '${escAttr(studentId)}')">정산전환</button>`;
                } else if (r.makeup_status === '완료') {
                    makeupActions = `
                        <span style="font-size:11px;color:var(--success);font-weight:600;">보충 완료됨</span>
                        <button class="hw-fail-type-btn" style="font-size:11px;background:#7c3aed;border-color:#7c3aed;color:#fff;margin-left:4px;"
                            onclick="reopenAbsenceMakeup('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">event</span>재예약
                        </button>`;
                }
            }

            const makeupDone = hasMakeupDate || isUndecided;
            stage3Html = `
                <div style="margin-bottom:8px;padding-top:8px;border-top:1px dashed var(--border);">
                    <div style="font-size:10px;color:var(--text-sec);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                        ${_renderStepBadge(3, makeupDone, '#2563eb')}
                        보충 일시
                    </div>
                    <div style="background:#eff6ff;border-radius:6px;padding:8px;">
                        <div style="display:flex;align-items:center;gap:4px;${makeupActions ? 'margin-bottom:4px;' : ''}">
                            <input type="date" class="field-input" style="font-size:12px;width:130px;" value="${escAttr(makeupDateVal)}"
                                onchange="updateAbsenceField('${escAttr(r.docId)}', 'makeup_date', this.value, '${escAttr(studentId)}')" />
                            <input type="time" class="field-input" style="font-size:12px;width:100px;" value="${escAttr(makeupTimeVal)}"
                                onchange="updateAbsenceField('${escAttr(r.docId)}', 'makeup_time', this.value, '${escAttr(studentId)}')" />
                            ${isUndecided ? `<span style="font-size:11px;color:var(--warning);font-weight:600;">미정</span>` :
                              !hasMakeupDate ? `<button class="hw-fail-type-btn" style="font-size:11px;color:var(--text-sec);"
                                onclick="updateAbsenceField('${escAttr(r.docId)}', 'makeup_date', 'undecided', '${escAttr(studentId)}')">미정</button>` : ''}
                        </div>
                        ${makeupActions ? `<div style="display:flex;align-items:center;gap:4px;">${makeupActions}</div>` : ''}
                    </div>
                </div>`;
        } else if ((stage2Done || hasExistingData) && r.resolution === '정산') {
            stage3Html = `
                <div style="margin-bottom:8px;padding-top:8px;border-top:1px dashed var(--border);">
                    <div style="font-size:10px;color:var(--text-sec);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                        ${_renderStepBadge(3, true, '#7c3aed')}
                        정산
                    </div>
                    <div style="background:#f5f3ff;border-radius:6px;padding:8px;">
                        <textarea class="field-input" style="width:100%;min-height:36px;resize:vertical;font-size:12px;"
                            placeholder="정산 메모..."
                            onchange="updateAbsenceField('${escAttr(r.docId)}', 'settlement_memo', this.value, '${escAttr(studentId)}')">${esc(r.settlement_memo || '')}</textarea>
                    </div>
                </div>`;
        }

        // ── 4단계: 수정/행정완료 ──
        // 2단계 완료 + (보충: 일시 입력 또는 미정 / 정산: 바로)
        const stage3Done = stage2Done && (r.resolution === '정산' ||
            (r.resolution === '보충' && !!r.makeup_date));
        const historyHtml = _renderRescheduleHistory(r.reschedule_history);
        // 결석을 실제 체크한 사람 (marked_absent_by 우선, 없으면 created_by 폴백)
        const markedBy = getTeacherName(r.marked_absent_by || r.created_by);
        const markedAt = r.marked_absent_at || r.created_at;
        const updatedBy = getTeacherName(r.updated_by);

        // 입력 완료 여부: stage3Done이 이미 stage2Done(consultation_done 포함)을 내포
        const actionBtn = stage3Done
            ? `<button class="hw-fail-type-btn" style="font-size:11px;"
                    onclick="event.preventDefault(); showSaveIndicator('saved');">
                    <span class="material-symbols-outlined" style="font-size:13px;">edit</span>수정
                </button>`
            : `<button class="hw-fail-type-btn" style="font-size:11px;background:var(--primary);border-color:var(--primary);color:#fff;"
                    onclick="this.closest('.pending-task-row').classList.remove('expanded'); showSaveIndicator('saved');">
                    <span class="material-symbols-outlined" style="font-size:13px;">save</span>저장
                </button>`;

        const stage4Html = `
            <div style="padding-top:8px;border-top:1px dashed var(--border);">
                ${historyHtml}
                <div style="font-size:10px;color:var(--text-sec);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
                    ${markedBy ? `<span>결석체크: ${esc(markedBy)} ${_fmtTs(markedAt, true)}</span>` : ''}
                    ${updatedBy && updatedBy !== markedBy ? `<span>수정: ${esc(updatedBy)} ${_fmtTs(r.updated_at, true)}</span>` : ''}
                </div>
                <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">
                    ${actionBtn}
                    <button class="hw-fail-type-btn" style="font-size:11px;background:#6b7280;border-color:#6b7280;color:#fff;"
                        onclick="closeAbsenceRecord('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">archive</span>행정완료
                    </button>
                </div>
            </div>`;

        return `
            <div class="pending-task-row" data-absence-idx="${idx}" style="background:#fef2f2;">
                <div class="pending-task-summary" onclick="this.parentElement.classList.toggle('expanded')">
                    <span style="display:flex;align-items:center;gap:4px;">
                        <span class="absence-status-badge ${group.badgeClass}">${esc(group.label)}</span>
                        ${esc(r.class_code || '')} · ${esc(_stripYear(r.absence_date))}
                        ${validityBadge}
                    </span>
                    <span class="pending-task-arrow material-symbols-outlined" style="font-size:16px;color:var(--text-sec);">expand_more</span>
                </div>
                <div class="pending-task-expand">
                    ${stage1Html}
                    ${stage2Html}
                    ${stage3Html}
                    ${stage4Html}
                </div>
            </div>`;
    }).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:#dc2626;font-size:18px;">event_busy</span>
                결석대장 <span style="font-size:12px;color:var(--text-sec);">(${records.length}건)</span>
            </div>
            ${rows}
        </div>`;
}

// ─── 진단평가 모달 + CRUD ─────────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-3)

import { msIcon } from './ms-icon.js';
import { collection, doc, getDoc, getDocs, query, where, serverTimestamp, arrayUnion, deleteField } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state, TEMP_FIELD_LABELS } from './state.js';
import { esc, formatTime12h, showSaveIndicator, stripEmailDomain, _fmtTs } from './ui-utils.js';
import { auditDelete, auditUpdate, auditSet, auditAdd } from './audit.js';
import { todayStr } from './src/shared/firestore-helpers.js';
import { SCHOOL_FIELD, currentSchool, schoolLevelGradeLabel } from '@impact7/shared/student-label';
import { staffLabel } from '@impact7/shared/staff-label';
import { normalizeStudentMemos } from './role-memo.js';

const _normalizePhone = (phone) => (phone || '').replace(/\D/g, '').replace(/^0(?=\d{10}$)/, '');

// ─── 의존성 주입 (daily-ops.js에서 init 호출) ──────────────────────────────
let renderSubFilters, renderListPanel, loadTempAttendances;

export function initDiagnosticDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    loadTempAttendances = deps.loadTempAttendances;
}

// ─── Temp Attendance Detail Panel ────────────────────────────────────────────

export function renderTempAttendanceDetail(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    // 진단평가는 탭이 없다. 직전 학생 상세(renderStudentDetail)가 켜놓은 탭 바·탭
    // 콘텐츠가 남지 않도록 리셋하고 카드 영역만 노출한다.
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) tabsEl.style.display = 'none';
    document.getElementById('detail-cards').style.display = '';
    // message-tab·docu-tab 포함 — 소속반 메시지 탭(단체안내)이 채워진 뒤 진단평가로 넘어오면
    // 그 UI가 남아 진단평가 카드 아래 노출된다.
    ['report-tab', 'score-tab', 'consultation-tab', 'message-tab', 'docu-tab'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    // 프로필 헤더
    document.getElementById('profile-avatar').textContent = (ta.name || '?')[0];
    document.getElementById('detail-name').textContent = ta.name || '';
    document.getElementById('profile-academic-summary').innerHTML = '';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag" style="background:#7c3aed;color:#fff;">진단평가</span>
        <span class="tag tag-pending">비등록</span>
    `;

    // 카드들
    const cardsContainer = document.getElementById('detail-cards');
    if (!cardsContainer) return;

    // 입력일시 포맷
    let createdAtStr = '';
    if (ta.created_at) {
        const ts = ta.created_at.toDate ? ta.created_at.toDate() : new Date(ta.created_at);
        createdAtStr = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
    }

    const createdById = stripEmailDomain(ta.created_by);

    const schoolLabel = schoolLevelGradeLabel({ school: ta.school, level: ta.level, grade: ta.grade });
    const infoRows = [
        { icon: 'apartment', label: '소속', value: ta.branch },
        { icon: 'school', label: '학교', value: schoolLabel },
        { icon: 'phone_android', label: '학생 전화', value: ta.student_phone },
        { icon: 'contact_phone', label: '학부모 전화', value: ta.parent_phone_1 },
        { icon: 'calendar_today', label: '예정 날짜', value: ta.temp_date },
        { icon: 'schedule', label: '예정 시간', value: ta.temp_time ? formatTime12h(ta.temp_time) : '' },
        { icon: 'edit_calendar', label: '입력일시', value: createdAtStr },
        { icon: 'person', label: '입력', value: createdById },
    ].filter(r => r.value);

    const memoHtml = ta.memo ? `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('sticky_note_2', '', 'style="color:var(--primary);"')} 메모
            </div>
            <div style="padding:8px 0;color:var(--text-pri);white-space:pre-wrap;font-size:14px;">${esc(ta.memo)}</div>
        </div>
    ` : '';

    // 수정 이력 카드
    let editHistoryHtml = '';
    if (ta.edit_history && ta.edit_history.length) {
        const sorted = [...ta.edit_history].sort((a, b) => (b.edited_at || '').localeCompare(a.edited_at || ''));
        editHistoryHtml = `
            <div class="detail-card">
                <div class="detail-card-title">
                    ${msIcon('history', '', 'style="color:var(--warning);"')} 수정 이력 (${sorted.length}건)
                </div>
                ${sorted.map(h => {
                    const dt = h.edited_at ? new Date(h.edited_at) : null;
                    const dateStr = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}` : '';
                    const editor = stripEmailDomain(h.edited_by);
                    const changes = Object.keys(h.after || {}).map(key => {
                        const label = TEMP_FIELD_LABELS[key] || key;
                        const before = (h.before && h.before[key]) || '(없음)';
                        const after = h.after[key] || '(없음)';
                        return `<div style="font-size:13px;padding:2px 0;"><span style="font-weight:500;color:var(--primary);">${label}</span>: ${esc(before)} → ${esc(after)}</div>`;
                    }).join('');
                    return `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
                        <div style="font-size:12px;color:var(--text-sec);margin-bottom:2px;">${dateStr} · ${esc(editor)}</div>
                        ${changes}
                    </div>`;
                }).join('')}
            </div>
        `;
    }

    cardsContainer.innerHTML = `
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px;">
            <button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;color:#dc2626;border-color:#dc2626;" onclick="cancelTempAttendance('${docId}')">
                ${msIcon('cancel', '', 'style="font-size:16px;vertical-align:middle;"')} 취소
            </button>
            <button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="openTempAttendanceForEdit('${docId}')">
                ${msIcon('edit', '', 'style="font-size:16px;vertical-align:middle;"')} 수정
            </button>
        </div>
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('info', '', 'style="color:#7c3aed;"')} 진단평가 정보
            </div>
            ${infoRows.map(r => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
                    ${msIcon(r.icon, '', 'style="font-size:18px;color:var(--text-sec);"')}
                    <span style="font-size:13px;color:var(--text-sec);min-width:80px;">${esc(r.label)}</span>
                    <span style="font-size:14px;color:var(--text-pri);font-weight:500;">${esc(r.value)}</span>
                </div>
            `).join('')}
        </div>
        ${memoHtml}
        ${editHistoryHtml}
    `;
}

export async function cancelTempAttendance(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;
    if (!confirm(`"${ta.name}" 진단평가 예약을 취소하시겠습니까?\n취소 후에도 기록은 남습니다.`)) return;
    try {
        const cancelledBy = staffLabel(state.currentUser?.email);
        const cancelledAt = new Date().toISOString();
        await auditUpdate(doc(db, 'temp_attendance', docId), {
            visit_status: '기타',
            cancel_reason: '예약취소',
            completed_by: cancelledBy,
            completed_at: cancelledAt,
            temp_arrival: deleteField(),
        });
        delete state._visitStatusPending[docId];
        Object.assign(ta, { visit_status: '기타', cancel_reason: '예약취소', completed_by: cancelledBy, completed_at: cancelledAt });
        delete ta.temp_arrival;
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 취소 실패:', err);
        alert(`취소 실패: ${err.message || err}`);
    }
}

export async function deleteTempAttendance(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;
    if (!confirm(`"${ta.name}" 진단평가 기록을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
        await auditDelete(doc(db, 'temp_attendance', docId));
        state.tempAttendances = state.tempAttendances.filter(t => t.docId !== docId);
        document.getElementById('detail-content').style.display = 'none';
        document.getElementById('detail-empty').style.display = '';
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 삭제 실패:', err);
        alert(`삭제 실패: ${err.message || err}`);
    }
}

// ─── 진단평가 모달 CRUD ──────────────────────────────────────────────────

function _makeContactDocId(name, phone) {
    let p = (phone || '').replace(/\D/g, '');
    if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
    return `${name}_${p}`.replace(/\s+/g, '_');
}

let _lastTempAutofillId = null;

async function _tryTempContactAutofill() {
    const name = document.getElementById('temp-att-name')?.value.trim();
    const phone = document.getElementById('temp-att-parent-phone')?.value.trim();
    if (!name || !phone) return;

    const docId = _makeContactDocId(name, phone);
    if (docId === _lastTempAutofillId) return;

    try {
        const snap = await getDoc(doc(db, 'students', docId));
        if (!snap.exists()) return;
        const contact = snap.data();
        _lastTempAutofillId = docId;

    const setIfEmpty = (id, val) => {
        const el = document.getElementById(id);
        if (el && !el.value && val) el.value = val;
    };

    // level/branch는 빈 값이면 채움
    const levelEl = document.getElementById('temp-att-level');
    if (levelEl && !levelEl.value && contact.level) levelEl.value = contact.level;
    const branchEl = document.getElementById('temp-att-branch');
    if (branchEl && !branchEl.value && contact.branch) branchEl.value = contact.branch;

    setIfEmpty('temp-att-school', contact.school);
    setIfEmpty('temp-att-grade', contact.grade);
    setIfEmpty('temp-att-student-phone', contact.student_phone);

    // 자동채움 알림
    const hint = document.getElementById('temp-att-autofill-hint');
    if (hint) {
        hint.textContent = `이전 기록에서 "${contact.name}" 정보를 불러왔습니다`;
        hint.style.display = 'block';
        setTimeout(() => { hint.style.display = 'none'; }, 3000);
    }
    } catch (e) { /* getDoc 실패 시 무시 */ }
}

export function openTempAttendanceModal() {
    state._editingTempDocId = null;
    _lastTempAutofillId = null;
    document.getElementById('temp-att-modal-title').textContent = '첫데이터 입력';
    document.getElementById('temp-att-save-btn').textContent = '저장';
    document.getElementById('temp-att-edit-history').innerHTML = '';
    _hideDuplicatePrompt();
    document.getElementById('temp-att-name').value = '';
    document.getElementById('temp-att-branch').value = '';
    document.getElementById('temp-att-school').value = '';
    document.getElementById('temp-att-level').value = '';
    document.getElementById('temp-att-grade').value = '';
    document.getElementById('temp-att-student-phone').value = '';
    document.getElementById('temp-att-parent-phone').value = '';
    document.getElementById('temp-att-memo').value = '';
    // 진단평가일/시간은 newtest 자동등록 또는 상세패널 '진단평가 예약' 모달이 담당 — 첫데이터는 미예약이 기본
    document.getElementById('temp-att-date').value = '';
    document.getElementById('temp-att-time').value = '';
    document.getElementById('temp-attendance-modal').style.display = '';
}

// 첫데이터입력 → students 컬렉션 직접 upsert
// - 신규: status='상담' + 빈 enrollments로 생성
// - 기존: status/enrollments는 건드리지 않고 기본 정보만 merge
// 첫데이터 메모는 학생 문서의 고정 메모로 실어 나중에 등록해도 상세패널에 따라온다
const _tempMemoEntry = (text) => ({
    text, pinned: true, date: todayStr(), created_at: todayStr(),
    created_by: state.currentUser?.email || '',
});

// 날짜 없는 첫데이터에서는 이 upsert가 유일한 저장이므로 오류를 삼키지 않고
// 호출부(saveTempAttendance)의 alert로 올린다
// prevMemo: 수정 저장 시 이전 temp 메모 — 같은 텍스트의 고정 메모를 교체해 중복 축적을 막는다
async function _upsertStudentFromTemp(data, prevMemo) {
    if (!data.parent_phone_1 || !data.name) return;
    const studentDocId = _makeContactDocId(data.name, data.parent_phone_1);
    const ref = doc(db, 'students', studentDocId);

    const baseFields = {
        name: data.name,
        level: data.level || '',
        grade: data.grade || '',
        student_phone: data.student_phone || '',
        parent_phone_1: data.parent_phone_1,
    };
    const _sf = SCHOOL_FIELD[data.level];
    if (_sf && data.school) baseFields[_sf] = data.school;
    if (data.branch) baseFields.branch = data.branch;

    const snap = await getDoc(ref);
    if (snap.exists()) {
        // 기존 학생 — status/enrollments는 보존, 기본 필드만 merge
        // 메모는 같은 내용이 이미 있으면 중복 추가하지 않는다 (수정 저장이 upsert를 재호출)
        const memos = normalizeStudentMemos(snap.data());
        if (data.memo && !memos.some(m => m.text === data.memo)) {
            const prevIdx = prevMemo ? memos.findIndex(m => m.pinned && m.text === prevMemo) : -1;
            if (prevIdx >= 0) memos[prevIdx] = { ...memos[prevIdx], text: data.memo };
            else memos.push(_tempMemoEntry(data.memo));
            baseFields.memo = memos;
        }
        await auditSet(ref, baseFields, { merge: true });
        // 로컬 캐시 업데이트
        const cached = state.allStudents.find(s => s.docId === studentDocId);
        if (cached) Object.assign(cached, baseFields);
    } else {
        // 신규 — '상담' 상태로 생성
        const newDoc = {
            ...baseFields,
            status: '상담',
            enrollments: [],
            first_registered: data.temp_date || todayStr(),
        };
        if (data.memo) newDoc.memo = [_tempMemoEntry(data.memo)];
        await auditSet(ref, newDoc);
        // 로컬 캐시 추가 (loadStudents 재호출 없이 즉시 반영)
        state.allStudents.push({ docId: studentDocId, ...newDoc });
        state.allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    }
}

export async function saveTempAttendance() {
    const name = document.getElementById('temp-att-name').value.trim();
    const branch = document.getElementById('temp-att-branch').value;
    const school = document.getElementById('temp-att-school').value.trim();
    const level = document.getElementById('temp-att-level').value;
    const grade = document.getElementById('temp-att-grade').value.trim();

    if (!name) { alert('이름을 입력하세요.'); document.getElementById('temp-att-name').focus(); return; }
    if (!branch) { alert('소속을 선택하세요.'); document.getElementById('temp-att-branch').focus(); return; }
    if (!school) { alert('학교를 입력하세요.'); document.getElementById('temp-att-school').focus(); return; }
    if (!level) { alert('학부(초/중/고)를 선택하세요.'); document.getElementById('temp-att-level').focus(); return; }
    if (!grade) { alert('학년을 입력하세요.'); document.getElementById('temp-att-grade').focus(); return; }
    // 신규 생성 시 학생 문서 ID가 이름_학부모전화로 만들어지므로 전화 없인 아무것도 저장되지 않는다
    if (!state._editingTempDocId && !document.getElementById('temp-att-parent-phone').value.trim()) {
        alert('학부모연락처를 입력하세요.'); document.getElementById('temp-att-parent-phone').focus(); return;
    }

    const data = {
        name,
        branch,
        school,
        level,
        grade,
        student_phone: document.getElementById('temp-att-student-phone').value.trim(),
        parent_phone_1: document.getElementById('temp-att-parent-phone').value.trim(),
        memo: document.getElementById('temp-att-memo').value.trim(),
        temp_date: document.getElementById('temp-att-date').value,
        temp_time: document.getElementById('temp-att-time').value,
    };

    try {
        if (state._editingTempDocId) {
            const existing = state.tempAttendances.find(t => t.docId === state._editingTempDocId);
            if (!existing) { alert('원본 데이터를 찾을 수 없습니다.'); return; }
            await _doUpdateTempAttendance(state._editingTempDocId, existing, data);
            return;
        }

        // 날짜 없는 첫데이터는 학생 upsert만 하므로(문서 ID 고정 = 멱등) 중복 예약 검사가 무의미
        if (data.temp_date) {
            const duplicates = await _findUpcomingTempByContact(data.name, data.parent_phone_1);
            if (duplicates.length > 0) {
                duplicates.sort((a, b) => (a.temp_date || '').localeCompare(b.temp_date || ''));
                _showDuplicatePrompt(duplicates[0], data);
                return;
            }
        }

        await _doCreateTempAttendance(data);
    } catch (err) {
        console.error('진단평가 저장 실패:', err);
        alert(`저장에 실패했습니다.\n${err.message || err}`);
    }
}

async function _doCreateTempAttendance(data, { modalId = 'temp-attendance-modal', upsertStudent = true } = {}) {
    data.created_at = serverTimestamp();
    data.created_by = state.currentUser?.email || '';

    // 날짜 없는 첫데이터는 방문 예약이 아니다 — temp_attendance에 쓰면
    // 날짜 기반 쿼리(loadTempAttendances)에 영원히 안 잡히는 고아 문서가 된다
    const writes = upsertStudent ? [_upsertStudentFromTemp(data)] : [];
    if (data.temp_date) writes.push(auditAdd(collection(db, 'temp_attendance'), data));
    await Promise.all(writes);
    document.getElementById(modalId).style.display = 'none';

    if (data.temp_date === state.selectedDate) {
        await loadTempAttendances(state.selectedDate);
    }
    renderSubFilters();
    renderListPanel();
    showSaveIndicator('saved');
}

async function _doUpdateTempAttendance(docId, existing, data) {
    const editableFields = Object.keys(TEMP_FIELD_LABELS);
    const before = {};
    const after = {};
    for (const key of editableFields) {
        const oldVal = (existing[key] || '').toString();
        const newVal = (data[key] || '').toString();
        if (oldVal !== newVal) {
            before[key] = oldVal;
            after[key] = newVal;
        }
    }

    if (Object.keys(after).length === 0) {
        alert('변경된 내용이 없습니다.');
        return;
    }

    const historyEntry = {
        before,
        after,
        edited_by: state.currentUser?.email || '',
        edited_at: new Date().toISOString()
    };

    await Promise.all([
        auditUpdate(doc(db, 'temp_attendance', docId), {
            ...data,
            edit_history: arrayUnion(historyEntry)
        }),
        _upsertStudentFromTemp(data, existing.memo)
    ]);

    const cached = state.tempAttendances.find(t => t.docId === docId);
    if (cached) {
        Object.assign(cached, data);
        cached.updated_by = state.currentUser?.email || '';
        if (!cached.edit_history) cached.edit_history = [];
        cached.edit_history.push(historyEntry);
    }

    document.getElementById('temp-attendance-modal').style.display = 'none';

    if (data.temp_date === state.selectedDate || existing.temp_date === state.selectedDate) {
        await loadTempAttendances(state.selectedDate);
    }
    renderSubFilters();
    renderListPanel();
    if (cached) renderTempAttendanceDetail(docId);
    showSaveIndicator('saved');
}

// 전화번호는 raw 입력(010-1234-5678 vs 01012345678)이라 클라이언트 정규화 비교 필요
async function _findUpcomingTempByContact(name, phone) {
    if (!name || !phone) return [];
    const target = _normalizePhone(phone);
    if (!target) return [];
    const snap = await getDocs(query(collection(db, 'temp_attendance'), where('name', '==', name)));
    const today = todayStr();
    return snap.docs
        .map(d => ({ docId: d.id, ...d.data() }))
        .filter(t => [t.parent_phone_1, t.student_phone].some(value => _normalizePhone(value) === target)
            && (t.temp_date || '') >= today);
}

function _hideDuplicatePrompt() {
    const box = document.getElementById('temp-att-duplicate-prompt');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'none';
}

function _showDuplicatePrompt(existing, pendingData) {
    const box = document.getElementById('temp-att-duplicate-prompt');
    if (!box) return;

    const editor = stripEmailDomain(existing.created_by);
    const tsStr = _fmtTs(existing.created_at, true);
    const timeStr = existing.temp_time ? formatTime12h(existing.temp_time) : '시간 미정';

    box.innerHTML = `
        <div style="background:#fff7ed;border:1px solid #f59e0b;border-radius:8px;padding:12px;margin:8px 0;">
            <div style="display:flex;align-items:center;gap:6px;color:#b45309;font-weight:600;margin-bottom:6px;">
                ${msIcon('warning', '', 'style="font-size:18px;"')}
                동일 학생의 진단평가가 이미 예정되어 있습니다
            </div>
            <div style="color:#78350f;font-size:13px;line-height:1.6;">
                <strong>${esc(existing.name)}</strong> (${esc(existing.parent_phone_1 || '-')}) — ${esc(existing.temp_date)} ${esc(timeStr)}<br>
                등록: ${esc(editor || '-')}${tsStr ? ` (${tsStr})` : ''}
            </div>
            <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
                <button class="btn btn-primary" id="temp-att-dup-edit" style="font-size:13px;">기존 일정 변경</button>
                <button class="btn btn-secondary" id="temp-att-dup-add" style="font-size:13px;">중복 등록</button>
                <button class="btn btn-secondary" id="temp-att-dup-cancel" style="font-size:13px;">취소</button>
            </div>
        </div>
    `;
    box.style.display = '';

    const runDup = (label, fn) => async () => {
        _hideDuplicatePrompt();
        try { await fn(); }
        catch (err) {
            console.error(`${label} 실패:`, err);
            alert(`${label}에 실패했습니다.\n${err.message || err}`);
        }
    };
    // 모달에서 날짜/시간이 숨겨져 pendingData가 빈 값일 수 있다 — 기존 예약 일시를 지우면 안 된다
    document.getElementById('temp-att-dup-edit').onclick = runDup('일정 변경', () => _doUpdateTempAttendance(existing.docId, existing, {
        ...pendingData,
        temp_date: pendingData.temp_date || existing.temp_date || '',
        temp_time: pendingData.temp_time || existing.temp_time || '',
    }));
    document.getElementById('temp-att-dup-add').onclick = runDup('진단평가 저장', () => _doCreateTempAttendance(pendingData));
    document.getElementById('temp-att-dup-cancel').onclick = _hideDuplicatePrompt;
}

export function openTempAttendanceForEdit(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;

    state._editingTempDocId = docId;
    _lastTempAutofillId = null;

    document.getElementById('temp-att-modal-title').textContent = '첫데이터 수정';
    document.getElementById('temp-att-save-btn').textContent = '수정';
    _hideDuplicatePrompt();

    document.getElementById('temp-att-name').value = ta.name || '';
    document.getElementById('temp-att-branch').value = ta.branch || '';
    document.getElementById('temp-att-school').value = ta.school || '';
    document.getElementById('temp-att-level').value = ta.level || '';
    document.getElementById('temp-att-grade').value = ta.grade || '';
    document.getElementById('temp-att-student-phone').value = ta.student_phone || '';
    document.getElementById('temp-att-parent-phone').value = ta.parent_phone_1 || '';
    document.getElementById('temp-att-memo').value = ta.memo || '';
    document.getElementById('temp-att-date').value = ta.temp_date || '';
    document.getElementById('temp-att-time').value = ta.temp_time || '';

    renderTempEditHistory(ta.edit_history);

    document.getElementById('temp-attendance-modal').style.display = '';
}

export function renderTempEditHistory(history) {
    const container = document.getElementById('temp-att-edit-history');
    if (!container) return;
    if (!history || !history.length) { container.innerHTML = ''; return; }

    const sorted = [...history].sort((a, b) => (b.edited_at || '').localeCompare(a.edited_at || ''));
    container.innerHTML = `
        <div class="temp-edit-history">
            <div class="temp-edit-history-title">수정 이력 (${sorted.length}건)</div>
            ${sorted.map(h => {
                const dt = h.edited_at ? new Date(h.edited_at) : null;
                const dateStr = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}` : '';
                const editor = (h.edited_by || '').replace(/@(gw\.)?impact7\.kr$/, '');
                const changes = Object.keys(h.after || {}).map(key => {
                    const label = TEMP_FIELD_LABELS[key] || key;
                    const before = (h.before && h.before[key]) || '(없음)';
                    const after = h.after[key] || '(없음)';
                    return `<div class="temp-edit-history-change"><span class="field-name">${esc(label)}</span>: ${esc(before)} → ${esc(after)}</div>`;
                }).join('');
                return `<div class="temp-edit-history-item">
                    <div class="temp-edit-history-meta">${dateStr} · ${esc(editor)}</div>
                    ${changes}
                </div>`;
            }).join('')}
        </div>
    `;
}

let _diagnosticScheduleStudentId = null;

export async function openDiagnosticScheduleModal(studentId) {
    try {
        const snap = await getDoc(doc(db, 'students', studentId));
        if (!snap.exists()) return;
        _diagnosticScheduleStudentId = studentId;
        document.getElementById('diagnostic-schedule-student').textContent = snap.data().name || '';
        document.getElementById('diagnostic-schedule-date').value = '';
        document.getElementById('diagnostic-schedule-time').value = '';
        document.getElementById('diagnostic-schedule-modal').style.display = '';
        document.getElementById('diagnostic-schedule-date').focus();
    } catch (err) {
        console.error('진단평가 예약 열기 실패:', err);
        alert('학생 정보를 불러오지 못했습니다.');
    }
}

export async function saveDiagnosticSchedule() {
    const dateEl = document.getElementById('diagnostic-schedule-date');
    const tempDate = dateEl.value;
    if (!tempDate) { alert('날짜를 선택하세요.'); dateEl.focus(); return; }
    if (!_diagnosticScheduleStudentId) return;

    const saveBtn = document.getElementById('diagnostic-schedule-save-btn');
    saveBtn.disabled = true;
    try {
        const snap = await getDoc(doc(db, 'students', _diagnosticScheduleStudentId));
        if (!snap.exists()) { alert('학생 정보를 찾을 수 없습니다.'); return; }
        const student = snap.data();
        const data = {
            name: student.name || '',
            branch: student.branch || '',
            school: currentSchool(student),
            level: student.level || '',
            grade: String(student.grade || ''),
            student_phone: student.student_phone || '',
            parent_phone_1: student.parent_phone_1 || '',
            memo: '',
            temp_date: tempDate,
            temp_time: document.getElementById('diagnostic-schedule-time').value,
        };
        const missing = ['name', 'branch', 'school', 'level', 'grade'].filter(key => !data[key]);
        if (missing.length) {
            alert(`학생 정보가 부족해 예약할 수 없습니다: ${missing.join(', ')}`);
            return;
        }

        const duplicates = await _findUpcomingTempByContact(data.name, data.parent_phone_1 || data.student_phone);
        duplicates.sort((a, b) => (a.temp_date || '').localeCompare(b.temp_date || ''));
        if (duplicates.length) {
            const existing = duplicates[0];
            const time = existing.temp_time ? ` ${formatTime12h(existing.temp_time)}` : '';
            if (!confirm(`${existing.temp_date}${time}에 이미 예약되어 있습니다.\n중복 등록하시겠습니까?`)) return;
        }

        await _doCreateTempAttendance(data, { modalId: 'diagnostic-schedule-modal', upsertStudent: false });
    } catch (err) {
        console.error('진단평가 예약 저장 실패:', err);
        alert(`저장에 실패했습니다.\n${err.message || err}`);
    } finally {
        saveBtn.disabled = false;
    }
}

// 이름·학부모전화 입력 후 students 자동채움 이벤트
export function setupTempAutofillListeners() {
    document.getElementById('temp-att-parent-phone')?.addEventListener('change', _tryTempContactAutofill);
    document.getElementById('temp-att-parent-phone')?.addEventListener('blur', _tryTempContactAutofill);
    document.getElementById('temp-att-name')?.addEventListener('change', _tryTempContactAutofill);
}

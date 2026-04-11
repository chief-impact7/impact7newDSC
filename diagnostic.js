// ─── 진단평가 모달 + CRUD ─────────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-3)

import { collection, doc, getDoc, serverTimestamp, arrayUnion } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state, TEMP_FIELD_LABELS } from './state.js';
import { esc, formatTime12h, nowTimeStr, showSaveIndicator } from './ui-utils.js';
import { auditDelete, auditUpdate, auditSet, auditAdd } from './audit.js';

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

    // 프로필 헤더
    document.getElementById('profile-avatar').textContent = (ta.name || '?')[0];
    document.getElementById('detail-name').textContent = ta.name || '';
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

    // 이메일에서 아이디만 추출 (@gw.impact7.kr, @impact7.kr 제거)
    const createdById = (ta.created_by || '').replace(/@(gw\.)?impact7\.kr$/, '');

    const infoRows = [
        { icon: 'apartment', label: '소속', value: ta.branch },
        { icon: 'school', label: '학교', value: ta.school },
        { icon: 'bar_chart', label: '학부', value: ta.level },
        { icon: 'grade', label: '학년', value: ta.grade },
        { icon: 'phone_android', label: '학생 전화', value: ta.student_phone },
        { icon: 'phone', label: '학부모 전화', value: ta.parent_phone_1 },
        { icon: 'calendar_today', label: '예정 날짜', value: ta.temp_date },
        { icon: 'schedule', label: '예정 시간', value: ta.temp_time ? formatTime12h(ta.temp_time) : '' },
        { icon: 'edit_calendar', label: '입력일시', value: createdAtStr },
        { icon: 'person', label: '입력', value: createdById },
    ].filter(r => r.value);

    const memoHtml = ta.memo ? `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);">sticky_note_2</span> 메모
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
                    <span class="material-symbols-outlined" style="color:var(--warning);">history</span> 수정 이력 (${sorted.length}건)
                </div>
                ${sorted.map(h => {
                    const dt = h.edited_at ? new Date(h.edited_at) : null;
                    const dateStr = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}` : '';
                    const editor = (h.edited_by || '').replace(/@(gw\.)?impact7\.kr$/, '');
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
            <button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;color:#dc2626;border-color:#dc2626;" onclick="deleteTempAttendance('${docId}')">
                <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">delete</span> 삭제
            </button>
            <button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="openTempAttendanceForEdit('${docId}')">
                <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">edit</span> 수정
            </button>
        </div>
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:#7c3aed;">info</span> 진단평가 정보
            </div>
            ${infoRows.map(r => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
                    <span class="material-symbols-outlined" style="font-size:18px;color:var(--text-sec);">${r.icon}</span>
                    <span style="font-size:13px;color:var(--text-sec);min-width:80px;">${esc(r.label)}</span>
                    <span style="font-size:14px;color:var(--text-pri);font-weight:500;">${esc(r.value)}</span>
                </div>
            `).join('')}
        </div>
        ${memoHtml}
        ${editHistoryHtml}
    `;
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
    document.getElementById('temp-att-modal-title').textContent = '첫데이터 및 진단평가입력';
    document.getElementById('temp-att-save-btn').textContent = '저장';
    document.getElementById('temp-att-edit-history').innerHTML = '';
    document.getElementById('temp-att-name').value = '';
    document.getElementById('temp-att-branch').value = '';
    document.getElementById('temp-att-school').value = '';
    document.getElementById('temp-att-level').value = '';
    document.getElementById('temp-att-grade').value = '';
    document.getElementById('temp-att-student-phone').value = '';
    document.getElementById('temp-att-parent-phone').value = '';
    document.getElementById('temp-att-memo').value = '';
    document.getElementById('temp-att-date').value = state.selectedDate;
    document.getElementById('temp-att-time').value = nowTimeStr();
    document.getElementById('temp-attendance-modal').style.display = '';
}

// 첫데이터입력 → students 컬렉션 직접 upsert
// - 신규: status='상담' + 빈 enrollments로 생성
// - 기존: status/enrollments는 건드리지 않고 기본 정보만 merge
async function _upsertStudentFromTemp(data) {
    if (!data.parent_phone_1 || !data.name) return;
    try {
        const studentDocId = _makeContactDocId(data.name, data.parent_phone_1);
        const ref = doc(db, 'students', studentDocId);

        const baseFields = {
            name: data.name,
            level: data.level || '',
            school: data.school || '',
            grade: data.grade || '',
            student_phone: data.student_phone || '',
            parent_phone_1: data.parent_phone_1,
        };
        if (data.branch) baseFields.branch = data.branch;

        const snap = await getDoc(ref);
        if (snap.exists()) {
            // 기존 학생 — status/enrollments는 보존, 기본 필드만 merge
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
                first_registered: data.temp_date,
            };
            await auditSet(ref, newDoc);
            // 로컬 캐시 추가 (loadStudents 재호출 없이 즉시 반영)
            state.allStudents.push({ docId: studentDocId, ...newDoc });
            state.allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        }
    } catch (err) {
        console.warn('[STUDENT UPSERT FROM TEMP]', err);
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
            // ── 수정 모드 ──
            const existing = state.tempAttendances.find(t => t.docId === state._editingTempDocId);
            if (!existing) { alert('원본 데이터를 찾을 수 없습니다.'); return; }

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
                auditUpdate(doc(db, 'temp_attendance', state._editingTempDocId), {
                    ...data,
                    edit_history: arrayUnion(historyEntry)
                }),
                _upsertStudentFromTemp(data)
            ]);

            // 로컬 캐시 업데이트
            Object.assign(existing, data);
            existing.updated_by = state.currentUser?.email || '';
            if (!existing.edit_history) existing.edit_history = [];
            existing.edit_history.push(historyEntry);

            document.getElementById('temp-attendance-modal').style.display = 'none';

            renderSubFilters();
            renderListPanel();
            renderTempAttendanceDetail(state._editingTempDocId);
            showSaveIndicator('saved');
        } else {
            // ── 생성 모드 ──
            // 동일 이름+날짜 중복 체크
            const duplicate = state.tempAttendances.find(t => t.name === data.name && t.temp_date === data.temp_date);
            if (duplicate) {
                if (!confirm(`"${data.name}" 학생이 ${data.temp_date}에 이미 등록되어 있습니다.\n그래도 추가하시겠습니까?`)) return;
            }

            data.created_at = serverTimestamp();
            data.created_by = state.currentUser?.email || '';

            await Promise.all([
                auditAdd(collection(db, 'temp_attendance'), data),
                _upsertStudentFromTemp(data)
            ]);
            document.getElementById('temp-attendance-modal').style.display = 'none';

            const savedDate = data.temp_date;
            if (savedDate === state.selectedDate) {
                await loadTempAttendances(state.selectedDate);
                renderSubFilters();
                renderListPanel();
            }
            showSaveIndicator('saved');
        }
    } catch (err) {
        console.error('진단평가 저장 실패:', err);
        alert(`저장에 실패했습니다.\n${err.message || err}`);
    }
}

export function openTempAttendanceForEdit(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;

    state._editingTempDocId = docId;
    _lastTempAutofillId = null;

    document.getElementById('temp-att-modal-title').textContent = '첫데이터 및 진단평가 수정';
    document.getElementById('temp-att-save-btn').textContent = '수정';

    document.getElementById('temp-att-name').value = ta.name || '';
    document.getElementById('temp-att-branch').value = ta.branch || '';
    document.getElementById('temp-att-school').value = ta.school || '';
    document.getElementById('temp-att-level').value = ta.level || '';
    document.getElementById('temp-att-grade').value = ta.grade || '';
    document.getElementById('temp-att-student-phone').value = ta.student_phone || '';
    document.getElementById('temp-att-parent-phone').value = ta.parent_phone_1 || '';
    document.getElementById('temp-att-memo').value = ta.memo || '';
    document.getElementById('temp-att-date').value = ta.temp_date || state.selectedDate;
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

// 과거 학생 클릭 → 진단평가 모달 열기 + 자동채움
export async function openContactAsTemp(contactId) {
    try {
        const snap = await getDoc(doc(db, 'students', contactId));
        if (!snap.exists()) return;
        const c = snap.data();
        openTempAttendanceModal();
        document.getElementById('temp-att-name').value = c.name || '';
        document.getElementById('temp-att-branch').value = c.branch || '';
        document.getElementById('temp-att-school').value = c.school || '';
        document.getElementById('temp-att-level').value = c.level || '';
        document.getElementById('temp-att-grade').value = c.grade || '';
        document.getElementById('temp-att-student-phone').value = c.student_phone || '';
        document.getElementById('temp-att-parent-phone').value = c.parent_phone_1 || '';
    } catch (e) { /* 네트워크 오류 시 무시 */ }
}

// 이름·학부모전화 입력 후 students 자동채움 이벤트
export function setupTempAutofillListeners() {
    document.getElementById('temp-att-parent-phone')?.addEventListener('change', _tryTempContactAutofill);
    document.getElementById('temp-att-parent-phone')?.addEventListener('blur', _tryTempContactAutofill);
    document.getElementById('temp-att-name')?.addEventListener('change', _tryTempContactAutofill);
}

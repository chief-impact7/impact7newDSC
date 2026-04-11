// ─── Role & Memo Module ────────────────────────────────────────────────────
// daily-ops.js에서 추출한 롤/메모 관련 함수
// Phase 3-6

import { collection, doc, getDoc, getDocs, query, where, serverTimestamp, arrayUnion } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { todayStr } from './src/shared/firestore-helpers.js';
import { auditUpdate, auditSet, auditAdd } from './audit.js';
import { state } from './state.js';
import { esc, escAttr, showSaveIndicator } from './ui-utils.js';
import { findStudent, enrollmentCode } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderStudentDetail;

export function initRoleMemoDeps(deps) {
    renderStudentDetail = deps.renderStudentDetail;
}

// ─── 롤(역할) 관리 ──────────────────────────────────────────────────────────

export async function loadUserRole() {
    if (!state.currentUser) return;
    try {
        const docRef = doc(db, 'user_settings', state.currentUser.email);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            state.currentRole = snap.data().role || '행정';
        } else {
            state.currentRole = '행정';
            await auditSet(docRef, { role: '행정' });
        }
        renderRoleSelector();
        updateMemoUI();
    } catch (err) {
        console.error('롤 로드 실패:', err);
        state.currentRole = '행정';
        renderRoleSelector();
        updateMemoUI();
    }
}

export async function selectRole(role) {
    if (!state.currentUser) return;
    state.currentRole = role;
    renderRoleSelector();
    updateMemoUI();

    try {
        await auditSet(doc(db, 'user_settings', state.currentUser.email), {
            role
        }, { merge: true });
    } catch (err) {
        console.error('롤 저장 실패:', err);
    }

    await loadRoleMemos();
}

export function renderRoleSelector() {
    const container = document.getElementById('role-chips');
    if (!container) return;
    container.querySelectorAll('.role-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.role === state.currentRole);
    });
}

function updateMemoUI() {
    const bell = document.getElementById('memo-bell');
    const memoSection = document.getElementById('sidebar-memo-section');
    const roleSelector = document.getElementById('role-selector');

    if (state.currentUser) {
        roleSelector.style.display = '';
    }

    if (state.currentRole) {
        bell.style.display = '';
        memoSection.style.display = '';
    }
}

// ─── 롤 메모 CRUD ───────────────────────────────────────────────────────────

export async function loadRoleMemos() {
    if (!state.currentUser || !state.currentRole) return;
    state.roleMemos = [];

    try {
        const qDate = query(
            collection(db, 'role_memos'),
            where('date', '==', state.selectedDate)
        );
        const qPinned = query(
            collection(db, 'role_memos'),
            where('pinned', '==', true)
        );
        const [snapDate, snapPinned] = await Promise.all([getDocs(qDate), getDocs(qPinned)]);

        const seen = new Set();
        const addMemo = (d) => {
            if (seen.has(d.id)) return;
            seen.add(d.id);
            const data = d.data();
            const isSent = data.sender_email === state.currentUser.email;
            const isReceived = data.target_roles?.includes(state.currentRole);
            if (isSent || isReceived) {
                state.roleMemos.push({ docId: d.id, ...data, _isSent: isSent, _isReceived: isReceived });
            }
        };
        snapDate.forEach(addMemo);
        snapPinned.forEach(addMemo);
        sortRoleMemos();
    } catch (err) {
        console.error('메모 로드 실패:', err);
    }

    updateMemoBadge();
    renderMemoPanel();
}

function sortRoleMemos() {
    state.roleMemos.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const ta = a.created_at?.toMillis?.() || 0;
        const tb = b.created_at?.toMillis?.() || 0;
        return tb - ta;
    });
}

function updateMemoBadge() {
    const badge = document.getElementById('memo-badge');
    const sidebarBadge = document.getElementById('memo-unread-sidebar');
    if (!badge || !sidebarBadge) return;

    // 수신 메모 중 미읽음 (자기가 보낸 건 제외)
    const unreadCount = state.roleMemos.filter(m =>
        m._isReceived && m.sender_email !== state.currentUser?.email && !m.read_by?.includes(state.currentUser?.email)
    ).length;

    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = '';
        sidebarBadge.textContent = unreadCount;
        sidebarBadge.style.display = '';
    } else {
        badge.style.display = 'none';
        sidebarBadge.style.display = 'none';
    }
}

export function toggleMemoSection() {
    const panel = document.getElementById('memo-panel');
    const icon = document.getElementById('memo-expand-icon');
    if (panel.style.display === 'none') {
        panel.style.display = '';
        icon.textContent = 'expand_less';
        renderMemoPanel();
    } else {
        panel.style.display = 'none';
        icon.textContent = 'expand_more';
    }
}

export function toggleMemoPanel() {
    const panel = document.getElementById('memo-panel');
    const icon = document.getElementById('memo-expand-icon');

    // 이미 열려있으면 닫기
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        icon.textContent = 'expand_more';
        return;
    }

    // 사이드바가 모바일에서 닫혀있으면 열기
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.add('mobile-open');
        overlay.classList.add('visible');
    }

    // 패널 열기
    panel.style.display = '';
    icon.textContent = 'expand_less';
    renderMemoPanel();
}

export function setMemoTab(tab) {
    state.memoTab = tab;
    renderMemoPanel();
}

export function renderMemoPanel() {
    const tabsContainer = document.getElementById('memo-tabs');
    const contentContainer = document.getElementById('memo-content');
    if (!tabsContainer || !contentContainer) return;

    tabsContainer.innerHTML = `
        <button class="memo-tab ${state.memoTab === 'inbox' ? 'active' : ''}" onclick="setMemoTab('inbox')">수신함</button>
        <button class="memo-tab ${state.memoTab === 'outbox' ? 'active' : ''}" onclick="setMemoTab('outbox')">발신함</button>
    `;

    renderMemoList(contentContainer);
}

function renderMemoList(container) {
    if (!container) container = document.getElementById('memo-content');
    if (!container) return;

    // 탭에 따라 발신/수신 필터
    let memos;
    if (state.memoTab === 'outbox') {
        memos = state.roleMemos.filter(m => m.sender_email === state.currentUser?.email);
    } else {
        memos = state.roleMemos.filter(m => m._isReceived && m.sender_email !== state.currentUser?.email);
    }

    let html = '';

    if (memos.length === 0) {
        html = `<div style="padding:12px;color:var(--text-sec);font-size:13px;text-align:center;">${state.memoTab === 'outbox' ? '보낸 메모가 없습니다' : '받은 메모가 없습니다'}</div>`;
    } else {
        html = memos.map(m => {
            const isUnread = m._isReceived && m.sender_email !== state.currentUser?.email && !m.read_by?.includes(state.currentUser?.email);
            const studentLabel = m.type === 'student' && m.student_name ? `<div class="memo-item-student">${esc(m.student_name)}</div>` : '';
            const targets = m.target_roles?.join(', ') || '';
            const timeStr = m.created_at?.toDate?.()
                ? m.created_at.toDate().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                : '';

            const senderLabel = state.memoTab === 'outbox'
                ? '→ ' + esc(targets)
                : esc(m.sender_email?.split('@')[0] || '') + ' (' + esc(m.sender_role || '') + ')';

            const isPinned = !!m.pinned;
            const pinClass = isPinned ? ' pinned' : '';
            const pinIcon = isPinned ? 'keep' : 'keep_off';
            const pinTitle = isPinned ? '고정 해제' : '고정';
            const dateLabel = m.date !== state.selectedDate ? `<span class="memo-item-pin-date">${esc(m.date || '')}</span>` : '';

            return `<div class="memo-item${pinClass} ${isUnread ? 'unread' : ''}" onclick="expandMemo('${m.docId}', this)">
                <div class="memo-item-header">
                    <span class="memo-item-sender">${senderLabel}</span>
                    <span style="display:flex;align-items:center;gap:4px;">
                        ${dateLabel}
                        <span class="memo-item-date">${esc(timeStr)}</span>
                        <button class="memo-pin-btn${isPinned ? ' active' : ''}" onclick="event.stopPropagation();toggleMemoPin('${m.docId}',${!isPinned})" title="${pinTitle}">
                            <span class="material-symbols-outlined" style="font-size:16px;">${pinIcon}</span>
                        </button>
                    </span>
                </div>
                ${studentLabel}
                <div class="memo-item-content">${esc(m.content || '')}</div>
            </div>`;
        }).join('');
    }

    // 모든 롤에서 메모 보내기 버튼
    html += `<button class="memo-send-btn" onclick="openMemoModal()">
        <span class="material-symbols-outlined" style="font-size:18px;">add</span>
        메모 보내기
    </button>`;

    container.innerHTML = html;
}

export async function expandMemo(memoDocId, el) {
    const contentEl = el.querySelector('.memo-item-content');
    if (contentEl) {
        contentEl.classList.toggle('expanded');
    }

    // 수신 메모 읽음 처리 (자기가 보낸 건 제외)
    const memo = state.roleMemos.find(m => m.docId === memoDocId);
    if (memo && memo.sender_email !== state.currentUser?.email) {
        await markMemoRead(memoDocId);
    }
}

export async function toggleMemoPin(memoDocId, pinned) {
    try {
        await auditUpdate(doc(db, 'role_memos', memoDocId), {
            pinned: pinned
        });
        const memo = state.roleMemos.find(m => m.docId === memoDocId);
        if (memo) memo.pinned = pinned;
        sortRoleMemos();
        renderMemoPanel();
    } catch (err) {
        console.error('메모 고정 실패:', err);
    }
}

export async function markMemoRead(memoDocId) {
    if (!state.currentUser) return;
    const memo = state.roleMemos.find(m => m.docId === memoDocId);
    if (!memo || memo.read_by?.includes(state.currentUser.email)) return;

    try {
        await auditUpdate(doc(db, 'role_memos', memoDocId), {
            read_by: arrayUnion(state.currentUser.email)
        });
        if (!memo.read_by) memo.read_by = [];
        memo.read_by.push(state.currentUser.email);
        updateMemoBadge();
    } catch (err) {
        console.error('메모 읽음 처리 실패:', err);
    }
}

export function openMemoModal(studentId) {
    document.getElementById('memo-type').value = studentId ? 'student' : 'free';
    document.getElementById('memo-student-search').value = '';
    document.getElementById('memo-student-id').value = studentId || '';
    document.getElementById('memo-student-dropdown').style.display = 'none';
    document.getElementById('memo-content-input').value = '';
    const pinCheck = document.getElementById('memo-pin-check');
    if (pinCheck) pinCheck.checked = false;

    // 학생 지정 시 자동 선택
    const selectedEl = document.getElementById('memo-student-selected');
    if (studentId) {
        const student = state.allStudents.find(s => s.docId === studentId);
        selectedEl.textContent = student ? student.name : '';
    } else {
        selectedEl.textContent = '';
    }

    toggleMemoStudentField();

    // 수신 대상: 자기 롤 제외한 나머지 롤을 체크박스로 동적 생성
    const allRoles = ['행정', '교수', '관리'];
    const otherRoles = allRoles.filter(r => r !== state.currentRole);
    const checksContainer = document.getElementById('memo-target-checks');
    checksContainer.innerHTML = otherRoles.map((r, i) =>
        `<label><input type="checkbox" value="${r}" ${i === 0 ? 'checked' : ''}> ${r}</label>`
    ).join('');

    document.getElementById('memo-modal').style.display = 'flex';
}

export function toggleMemoStudentField() {
    const type = document.getElementById('memo-type').value;
    const field = document.getElementById('memo-student-field');
    field.style.display = type === 'student' ? '' : 'none';
}

export function searchMemoStudent(q) {
    const dropdown = document.getElementById('memo-student-dropdown');
    if (!q || q.length < 1) {
        dropdown.style.display = 'none';
        return;
    }

    const qLower = q.toLowerCase();
    const matches = state.allStudents.filter(s => s.name?.toLowerCase().includes(qLower)).slice(0, 8);

    if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    dropdown.innerHTML = matches.map(s => {
        const code = (s.enrollments || []).map(e => enrollmentCode(e)).join(', ');
        return `<div class="memo-student-dropdown-item" onclick="selectMemoStudent('${escAttr(s.docId)}', '${escAttr(s.name)}')">${esc(s.name)} <span style="color:var(--text-sec);font-size:11px;">${esc(code)}</span></div>`;
    }).join('');
    dropdown.style.display = '';
}

export function selectMemoStudent(studentId, studentName) {
    document.getElementById('memo-student-id').value = studentId;
    document.getElementById('memo-student-selected').textContent = studentName;
    document.getElementById('memo-student-search').value = '';
    document.getElementById('memo-student-dropdown').style.display = 'none';
}

export async function sendMemo() {
    if (!state.currentUser || !state.currentRole) {
        alert('로그인 후 역할을 선택하세요.');
        return;
    }

    const type = document.getElementById('memo-type').value;
    const studentId = document.getElementById('memo-student-id').value || null;
    const studentName = type === 'student' ? document.getElementById('memo-student-selected').textContent : null;
    const content = document.getElementById('memo-content-input').value.trim();

    if (!content) {
        alert('내용을 입력하세요.');
        return;
    }

    // 수신 대상 수집
    const targetRoles = [];
    document.querySelectorAll('#memo-target-checks input:checked').forEach(cb => {
        targetRoles.push(cb.value);
    });
    if (targetRoles.length === 0) {
        alert('수신 대상을 선택하세요.');
        return;
    }

    if (type === 'student' && !studentId) {
        alert('학생을 선택하세요.');
        return;
    }

    showSaveIndicator('saving');
    try {
        const pinChecked = document.getElementById('memo-pin-check')?.checked || false;
        await auditAdd(collection(db, 'role_memos'), {
            type,
            student_id: studentId,
            student_name: studentName,
            content,
            sender_email: state.currentUser.email,
            sender_role: state.currentRole,
            target_roles: targetRoles,
            date: state.selectedDate,
            pinned: pinChecked,
            read_by: [],
            created_at: serverTimestamp()
        });

        document.getElementById('memo-modal').style.display = 'none';
        await loadRoleMemos();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('메모 전송 실패:', err);
        showSaveIndicator('error');
    }
}

function getStudentRoleMemos(studentId) {
    return state.roleMemos.filter(m => m.type === 'student' && m.student_id === studentId);
}

export function renderStudentRoleMemoCard(studentId) {
    const memos = getStudentRoleMemos(studentId);
    const student = findStudent(studentId);

    let memosHtml = '';
    if (memos.length === 0) {
        memosHtml = '<div class="detail-card-empty">이 학생에 대한 롤 메모 없음</div>';
    } else {
        memosHtml = memos.map(m => {
            const timeStr = m.created_at?.toDate?.()
                ? m.created_at.toDate().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                : '';
            return `<div class="detail-role-memo">
                <div class="detail-role-memo-header">
                    <span class="detail-role-memo-sender">${esc(m.sender_email?.split('@')[0] || '')} (${esc(m.sender_role || '')})</span>
                    <span class="detail-role-memo-date">${esc(timeStr)}</span>
                </div>
                <div class="detail-role-memo-content">${esc(m.content || '')}</div>
            </div>`;
        }).join('');
    }

    const sendBtn = `<button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openMemoModal('${studentId}')">
        <span class="material-symbols-outlined" style="font-size:16px;">add</span> 메모 보내기
    </button>`;

    return `<div class="detail-card">
        <div class="detail-card-title">
            <span class="material-symbols-outlined" style="color:#7b61ff;font-size:18px;">mail</span>
            롤 메모 (${memos.length})
        </div>
        ${memosHtml}
        ${sendBtn}
    </div>`;
}

// ─── 메모 카드 (통합: 고정 + 오늘) ──────────────────────────────────────────
export function normalizeStudentMemos(student) {
    if (!student.memo) return [];
    if (typeof student.memo === 'string') {
        if (!student.memo.trim()) return [];
        return [{ text: student.memo.trim(), pinned: true, created_at: '', created_by: '' }];
    }
    if (Array.isArray(student.memo)) return student.memo;
    return [];
}

export function renderUnifiedMemoCard(studentId) {
    const student = findStudent(studentId);
    if (!student) return '';
    const rec = state.dailyRecords[studentId] || {};
    const memos = normalizeStudentMemos(student);

    // 고정 메모 + 오늘 메모를 합쳐서 표시
    const displayItems = [];

    // 1) 고정 메모 (pinned, 항상 표시)
    memos.forEach((m, idx) => {
        if (m.pinned) displayItems.push({ ...m, _idx: idx, _source: 'pin' });
    });

    // 2) 오늘 비고정 메모 (date === state.selectedDate)
    memos.forEach((m, idx) => {
        if (!m.pinned && m.date === state.selectedDate) displayItems.push({ ...m, _idx: idx, _source: 'today' });
    });

    // 3) 기존 daily_records.note (레거시, 있으면 표시)
    if (rec.note) {
        displayItems.push({ text: rec.note, pinned: false, _source: 'daily', created_by: '', created_at: state.selectedDate });
    }

    let listHtml = '';
    if (displayItems.length === 0) {
        listHtml = '<div class="detail-card-empty" style="font-size:12px;color:var(--text-sec);">메모 없음</div>';
    } else {
        listHtml = displayItems.map(m => {
            const pinnedCls = m.pinned ? ' pinned' : '';
            const pinIcon = m.pinned ? 'keep' : 'keep_off';
            const byStr = m.created_by ? m.created_by.split('@')[0] : '';
            const dateLabel = m._source === 'pin' && m.date && m.date !== state.selectedDate ? m.date : '';
            const meta = [byStr, dateLabel || m.created_at || ''].filter(Boolean).join(' · ');

            if (m._source === 'daily') {
                return `<div class="student-memo-item">
                    <div class="student-memo-content">${esc(m.text)}</div>
                    <div class="student-memo-bottom">
                        <span class="student-memo-meta" style="color:var(--text-sec);font-style:italic;">오늘 메모 (레거시)</span>
                    </div>
                </div>`;
            }

            return `<div class="student-memo-item${pinnedCls}">
                <div class="student-memo-content">${esc(m.text || '')}</div>
                <div class="student-memo-bottom">
                    <span class="student-memo-meta">${esc(meta)}</span>
                    <span class="student-memo-actions">
                        <span class="material-symbols-outlined student-memo-btn" title="${m.pinned ? '고정 해제' : '고정'}" onclick="toggleStudentMemoPin('${escAttr(studentId)}',${m._idx})">${pinIcon}</span>
                        <span class="material-symbols-outlined student-memo-btn delete" title="삭제" onclick="deleteStudentMemo('${escAttr(studentId)}',${m._idx})">close</span>
                    </span>
                </div>
            </div>`;
        }).join('');
    }

    return `<div class="detail-card">
        <div class="detail-card-title" style="display:flex;align-items:center;justify-content:space-between;">
            <span style="display:flex;align-items:center;gap:6px;">
                <span class="material-symbols-outlined" style="color:var(--text-sec);font-size:18px;">sticky_note_2</span>
                메모
            </span>
            <button class="icon-btn" style="width:28px;height:28px;" onclick="document.getElementById('memo-add-row-${escAttr(studentId)}').style.display=document.getElementById('memo-add-row-${escAttr(studentId)}').style.display==='none'?'':'none'" title="메모 추가">
                <span class="material-symbols-outlined" style="font-size:20px;">add</span>
            </button>
        </div>
        <div class="student-memo-add" id="memo-add-row-${escAttr(studentId)}" style="display:none;">
            <input type="text" class="field-input student-memo-input" id="detail-memo-input-${escAttr(studentId)}"
                placeholder="메모 입력 후 Enter..." onkeydown="if(event.key==='Enter'){event.preventDefault();addStudentMemo('${escAttr(studentId)}');}">
        </div>
        ${listHtml}
    </div>`;
}

// ─── 학생 메모 CRUD ────────────────────────────────────────────────────────

async function saveStudentMemoArray(studentId, memos) {
    try {
        await auditUpdate(doc(db, 'students', studentId), { memo: memos });
        const s = state.allStudents.find(s => s.docId === studentId);
        if (s) s.memo = memos;
        showSaveIndicator('saved');
        renderStudentDetail(studentId);
    } catch (err) {
        console.error('고정 메모 저장 실패:', err);
        showSaveIndicator('error');
    }
}

let _addMemoLock = false;

export async function addStudentMemo(studentId) {
    if (_addMemoLock) return;
    const input = document.getElementById(`detail-memo-input-${studentId}`);
    if (!input || !input.value.trim()) return;
    _addMemoLock = true;
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) { _addMemoLock = false; return; }
    const memos = normalizeStudentMemos(student);
    memos.push({ text: input.value.trim(), pinned: false, date: state.selectedDate, created_at: todayStr(), created_by: state.currentUser?.email || '' });
    await saveStudentMemoArray(studentId, memos);
    _addMemoLock = false;
}

export async function deleteStudentMemo(studentId, idx) {
    if (!confirm('이 메모를 삭제하시겠습니까?')) return;
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;
    const memos = normalizeStudentMemos(student);
    if (idx < 0 || idx >= memos.length) return;
    memos.splice(idx, 1);
    await saveStudentMemoArray(studentId, memos);
}

export async function toggleStudentMemoPin(studentId, idx) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;
    const memos = normalizeStudentMemos(student);
    if (idx < 0 || idx >= memos.length) return;
    memos[idx].pinned = !memos[idx].pinned;
    await saveStudentMemoArray(studentId, memos);
}

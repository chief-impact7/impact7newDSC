// ─── Bulk Mode Module ───────────────────────────────────────────────────────
// daily-ops.js에서 추출한 일괄 처리 관련 함수
// Phase 4-2

import { state } from './state.js';
import { esc, escAttr, showSaveIndicator, showToast, oxDisplayClass } from './ui-utils.js';
import { branchFromStudent } from './student-helpers.js';
import { getStudentDomains, getStudentTestItems, saveImmediately } from './data-layer.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail,
    applyAttendance, applyHwDomainOX, isAttendedStatus, oxFieldLabel, selectStudent;

export function initBulkModeDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    applyAttendance = deps.applyAttendance;
    applyHwDomainOX = deps.applyHwDomainOX;
    isAttendedStatus = deps.isAttendedStatus;
    oxFieldLabel = deps.oxFieldLabel;
    selectStudent = deps.selectStudent;
}

// ─── Bulk Mode (일괄 선택) ──────────────────────────────────────────────────

export function enterBulkMode() {
    state.bulkMode = true;
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) btn.classList.add('active');
    document.getElementById('bulk-action-bar').style.display = 'flex';
    document.querySelectorAll('.list-item').forEach(el => el.classList.add('bulk-mode'));
    updateBulkBar();
}

export function exitBulkMode() {
    state.bulkMode = false;
    state.selectedStudentIds.clear();
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) btn.classList.remove('active');
    document.getElementById('bulk-action-bar').style.display = 'none';
    document.querySelectorAll('.list-item').forEach(el => el.classList.remove('bulk-mode', 'bulk-selected'));
    document.querySelectorAll('.list-item-checkbox').forEach(cb => cb.checked = false);
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (selectAllCb) selectAllCb.checked = false;
    // 벌크 요약 패널 숨기고 기존 상세 패널 복원
    const summaryEl = document.getElementById('bulk-summary');
    if (summaryEl) summaryEl.style.display = 'none';
    if (state.selectedStudentId) {
        document.getElementById('detail-empty').style.display = 'none';
        document.getElementById('detail-content').style.display = '';
        renderStudentDetail(state.selectedStudentId);
    } else {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
    }
}

export function updateBulkBar() {
    const count = state.selectedStudentIds.size;
    const countEl = document.getElementById('bulk-selected-count');
    if (countEl) countEl.textContent = `${count}명 선택`;
    const visibleCbs = document.querySelectorAll('.list-item-checkbox');
    const allChecked = visibleCbs.length > 0 && [...visibleCbs].every(cb => cb.checked);
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (selectAllCb) selectAllCb.checked = allChecked;
    renderBulkSummary();
}

export function renderBulkSummary() {
    const summaryEl = document.getElementById('bulk-summary');
    if (!summaryEl) return;

    if (!state.bulkMode || state.selectedStudentIds.size < 2) {
        summaryEl.style.display = 'none';
        // 기존 상세 패널 복원
        if (state.selectedStudentId) {
            document.getElementById('detail-empty').style.display = 'none';
            document.getElementById('detail-content').style.display = '';
        } else {
            document.getElementById('detail-empty').style.display = '';
            document.getElementById('detail-content').style.display = 'none';
        }
        return;
    }

    // 벌크 요약 표시, 기존 패널 숨김
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'none';
    summaryEl.style.display = '';

    const ids = [...state.selectedStudentIds];
    const students = ids.map(id => state.allStudents.find(s => s.docId === id)).filter(Boolean);
    const count = students.length;

    // 이름 목록 (최대 10명)
    const nameList = count <= 10
        ? students.map(s => esc(s.name)).join(', ')
        : students.slice(0, 10).map(s => esc(s.name)).join(', ') + ` 외 ${count - 10}명`;

    // 공통 소속
    const branches = [...new Set(students.map(s => branchFromStudent(s)).filter(Boolean))];
    const commonBranch = branches.length === 1 ? branches[0] : null;

    summaryEl.innerHTML = `
        <div class="bulk-summary-header">
            <div class="bulk-summary-avatar">
                <span class="material-symbols-outlined">groups</span>
            </div>
            <div class="bulk-summary-info">
                <h2 class="bulk-summary-title">${count}명 선택됨</h2>
                ${commonBranch ? `<span class="tag">${esc(commonBranch)}</span>` : ''}
            </div>
            <button class="icon-btn detail-close-btn" onclick="exitBulkMode()" title="벌크 모드 종료" aria-label="벌크 모드 종료">
                <span class="material-symbols-outlined">close</span>
            </button>
        </div>
        <div class="bulk-summary-names">${nameList}</div>
        <div class="bulk-summary-actions">
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkAttendanceFromSummary()">
                <span class="material-symbols-outlined" style="font-size:18px;">event_available</span>
                일괄 출결
            </button>
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkOXFromSummary('hw')">
                <span class="material-symbols-outlined" style="font-size:18px;">menu_book</span>
                일괄 숙제OX
            </button>
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkOXFromSummary('test')">
                <span class="material-symbols-outlined" style="font-size:18px;">quiz</span>
                일괄 테스트OX
            </button>
        </div>`;
}

export function openBulkAttendanceFromSummary() {
    if (state.selectedStudentIds.size < 2) return;
    openBulkModal('attendance');
}

export function openBulkOXFromSummary(type) {
    if (state.selectedStudentIds.size < 2) return;
    const field = type === 'test'
        ? (state.currentSubFilter.has('test_2nd') ? 'test_domains_2nd' : 'test_domains_1st')
        : (state.currentSubFilter.has('hw_2nd') ? 'hw_domains_2nd' : 'hw_domains_1st');
    const firstId = [...state.selectedStudentIds][0];
    let domains = [];
    if (type === 'test') {
        const { sections } = getStudentTestItems(firstId);
        domains = Object.values(sections).flat();
    } else {
        domains = getStudentDomains(firstId);
    }
    if (domains.length === 0) {
        showToast('해당 항목이 없습니다.');
        return;
    }
    if (domains.length === 1) {
        openBulkModal('ox', field, domains[0]);
        return;
    }
    openBulkDomainPicker(type, field, domains);
}

export function openBulkDomainPicker(type, field, domains) {
    const modal = document.getElementById('bulk-confirm-modal');
    const titleEl = document.getElementById('bulk-confirm-title');
    const descEl = document.getElementById('bulk-confirm-desc');
    const namesEl = document.getElementById('bulk-confirm-names');
    const bodyEl = document.getElementById('bulk-modal-body');
    const saveBtn = document.getElementById('bulk-modal-save-btn');

    titleEl.textContent = type === 'test' ? '테스트 영역 선택' : '숙제 영역 선택';
    descEl.textContent = 'OX를 변경할 영역을 선택하세요.';
    namesEl.textContent = '';
    saveBtn.style.display = 'none';

    bodyEl.innerHTML = `<div class="bulk-domain-picker">${domains.map(d =>
        `<button class="btn btn-secondary bulk-domain-pick-btn" onclick="pickBulkDomain('${escAttr(field)}', '${escAttr(d)}')">${esc(d)}</button>`
    ).join('')}</div>`;

    _bulkModalType = 'domain-picker';
    modal.style.display = 'flex';
}

export function pickBulkDomain(field, domain) {
    document.getElementById('bulk-confirm-modal').style.display = 'none';
    document.getElementById('bulk-modal-save-btn').style.display = '';
    _bulkModalType = null;
    openBulkModal('ox', field, domain);
}

export function toggleSelectAll(checked) {
    if (!state.bulkMode) enterBulkMode();
    document.querySelectorAll('.list-item-checkbox').forEach(cb => {
        cb.checked = checked;
        const item = cb.closest('.list-item');
        const id = item?.dataset.id;
        if (id) {
            if (checked) { state.selectedStudentIds.add(id); item.classList.add('bulk-selected'); }
            else { state.selectedStudentIds.delete(id); item.classList.remove('bulk-selected'); }
        }
    });
    updateBulkBar();
}

export function toggleStudentCheckbox(docId, checked) {
    if (checked) state.selectedStudentIds.add(docId);
    else state.selectedStudentIds.delete(docId);
    const item = document.querySelector(`.list-item[data-id="${docId}"]`);
    if (item) item.classList.toggle('bulk-selected', checked);
    updateBulkBar();
}

// ─── Bulk Action Modal ───────────────────────────────────────────────────────
let _bulkModalType = null;   // 'attendance' | 'ox'
let _bulkModalField = null;  // hw_domains_1st etc.
let _bulkModalDomain = null; // 'Gr' etc.
let _bulkModalValue = null;  // 선택된 값

export function openBulkModal(type, field, domain) {
    _bulkModalType = type;
    _bulkModalField = field;
    _bulkModalDomain = domain;
    _bulkModalValue = null;

    const count = state.selectedStudentIds.size;
    const names = [...state.selectedStudentIds].map(id => state.allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;

    const modal = document.getElementById('bulk-confirm-modal');
    const titleEl = document.getElementById('bulk-confirm-title');
    const descEl = document.getElementById('bulk-confirm-desc');
    const namesEl = document.getElementById('bulk-confirm-names');
    const bodyEl = document.getElementById('bulk-modal-body');

    descEl.textContent = `선택된 ${count}명에게 동일하게 적용합니다.`;
    namesEl.textContent = nameList;

    if (type === 'attendance') {
        titleEl.textContent = '일괄 출결 변경';
        const statuses = ['정규', '출석', '지각', '결석', '조퇴', '기타'];
        bodyEl.innerHTML = `<div class="bulk-modal-toggle-group">${statuses.map(st =>
            `<button class="bulk-modal-toggle-btn" data-value="${esc(st)}" onclick="selectBulkValue(this, '${esc(st)}')">${esc(st)}</button>`
        ).join('')}</div>`;
    } else if (type === 'ox') {
        const label = oxFieldLabel(field);
        titleEl.textContent = `일괄 ${label} 변경`;
        const values = ['O', '△', 'X', ''];
        bodyEl.innerHTML = `<div class="bulk-modal-domain-label">${esc(domain)}</div>
            <div class="bulk-modal-toggle-group">${values.map(v =>
                `<button class="bulk-modal-toggle-btn ${oxDisplayClass(v)}" data-value="${v}" onclick="selectBulkValue(this, '${v}')">${v || '—'}</button>`
            ).join('')}</div>`;
    }

    document.getElementById('bulk-modal-save-btn').disabled = true;
    modal.style.display = 'flex';
}

export function selectBulkValue(btn, value) {
    _bulkModalValue = value;
    btn.closest('.bulk-modal-toggle-group').querySelectorAll('.bulk-modal-toggle-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('bulk-modal-save-btn').disabled = false;
}

function bulkApplyOxToAttended(value) {
    const attendedIds = [...state.selectedStudentIds].filter(id => isAttendedStatus(state.dailyRecords[id]?.attendance?.status));
    attendedIds.forEach(id => applyHwDomainOX(id, _bulkModalField, _bulkModalDomain, value));
    const skipped = state.selectedStudentIds.size - attendedIds.length;
    if (skipped > 0) showToast(`미출석 ${skipped}명 제외`);
}

export function resetBulkModal() {
    const modal = document.getElementById('bulk-confirm-modal');
    modal.style.display = 'none';

    if (_bulkModalType === 'attendance') {
        [...state.selectedStudentIds].forEach(id => applyAttendance(id, '정규', true, true));
    } else if (_bulkModalType === 'ox') {
        bulkApplyOxToAttended('');
    }
    renderSubFilters();
    renderListPanel();
    showToast(`${state.selectedStudentIds.size}명 초기화 완료`);
    _bulkModalType = null;
}

export function confirmBulkAction() {
    if (_bulkModalValue === null) return;
    const modal = document.getElementById('bulk-confirm-modal');
    modal.style.display = 'none';

    if (_bulkModalType === 'attendance') {
        [...state.selectedStudentIds].forEach(id => applyAttendance(id, _bulkModalValue, true, true));
        renderSubFilters();
        renderListPanel();
    } else if (_bulkModalType === 'ox') {
        bulkApplyOxToAttended(_bulkModalValue);
        renderSubFilters();
        renderListPanel();
    }
    showToast(`${state.selectedStudentIds.size}명 일괄 처리 완료`);
    _bulkModalType = null;
}

export function cancelBulkAction() {
    document.getElementById('bulk-confirm-modal').style.display = 'none';
    _bulkModalType = null;
}

export function handleListItemClick(e, docId, fallbackFn) {
    if (state.bulkMode) {
        const cb = e.currentTarget.querySelector('.list-item-checkbox');
        if (cb && e.target !== cb) {
            cb.checked = !cb.checked;
            toggleStudentCheckbox(docId, cb.checked);
        }
        return;
    }
    if (fallbackFn) fallbackFn(docId);
    else selectStudent(docId);
}

// ─── Group View ──────────────────────────────────────────────────────────────
export function toggleGroupView() {
    const modes = ['none', 'branch', 'class'];
    const labels = { none: 'view_agenda', branch: 'location_city', class: 'school' };
    const titles = { none: '그룹 뷰 (소속별)', branch: '그룹 뷰: 소속별 → 반별로 전환', class: '그룹 뷰: 반별 → 해제' };
    const idx = modes.indexOf(state.groupViewMode);
    state.groupViewMode = modes[(idx + 1) % modes.length];
    localStorage.setItem('dsc_groupViewMode', state.groupViewMode);
    const btn = document.getElementById('group-view-btn');
    if (btn) {
        btn.querySelector('.material-symbols-outlined').textContent = labels[state.groupViewMode];
        btn.title = titles[state.groupViewMode];
        btn.classList.toggle('active', state.groupViewMode !== 'none');
    }
    renderListPanel();
}

// ─── 일괄 메모 ──────────────────────────────────────────────────────────────

export function openBulkMemo() {
    if (state.selectedStudentIds.size === 0) { alert('학생을 선택하세요.'); return; }
    const count = state.selectedStudentIds.size;
    const names = [...state.selectedStudentIds].map(id => state.allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;
    document.getElementById('bulk-memo-desc').textContent = `${count}명 선택: ${nameList}`;
    document.getElementById('bulk-memo-text').value = '';
    document.getElementById('bulk-memo-modal').style.display = 'flex';
}

export async function saveBulkMemo() {
    const text = document.getElementById('bulk-memo-text').value.trim();
    if (!text) { alert('메모 내용을 입력하세요.'); return; }

    showSaveIndicator('saving');
    try {
        const ids = [...state.selectedStudentIds];
        for (const studentId of ids) {
            const rec = state.dailyRecords[studentId] || {};
            const existing = rec.note || '';
            const newNote = existing ? `${existing}\n${text}` : text;
            await saveImmediately(studentId, { note: newNote });
        }
        document.getElementById('bulk-memo-modal').style.display = 'none';
        showSaveIndicator('saved');
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
    } catch (err) {
        console.error('일괄 메모 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 일괄 학부모 알림 ───────────────────────────────────────────────────────

export function openBulkNotify() {
    if (state.selectedStudentIds.size === 0) { alert('학생을 선택하세요.'); return; }
    const count = state.selectedStudentIds.size;
    const names = [...state.selectedStudentIds].map(id => state.allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;
    document.getElementById('bulk-notify-desc').textContent = `${count}명 선택: ${nameList}`;
    document.getElementById('bulk-notify-text').value = '';
    document.getElementById('bulk-notify-modal').style.display = 'flex';
}

export async function saveBulkNotify() {
    const text = document.getElementById('bulk-notify-text').value.trim();
    if (!text) { alert('알림 메시지를 입력하세요.'); return; }

    const ids = [...state.selectedStudentIds];
    const lines = [];
    for (const studentId of ids) {
        const student = state.allStudents.find(s => s.docId === studentId);
        if (!student) continue;
        lines.push(`[${student.name}] ${text}`);
    }
    const fullMessage = lines.join('\n');

    try {
        await navigator.clipboard.writeText(fullMessage);
        document.getElementById('bulk-notify-modal').style.display = 'none';
        alert(`${ids.length}명의 알림 메시지가 클립보드에 복사되었습니다.`);
    } catch (err) {
        console.error('클립보드 복사 실패:', err);
        alert('클립보드 복사에 실패했습니다. 직접 복사해주세요.\n\n' + fullMessage);
    }
}

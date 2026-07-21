// ─── HW Management Module ──────────────────────────────────────────────────
// daily-ops.js에서 추출한 숙제 관리 관련 함수
// Phase 3-4

import { msIcon } from './ms-icon.js';
import { state } from './state.js';
import { esc, escAttr, formatTime12h, nextOXValue, oxDisplayClass, _stripYear, _isNoShow, _renderRescheduleHistory } from './ui-utils.js';
import { enrollmentCode, getActiveEnrollments, matchesBranchFilter } from './student-helpers.js';
import { getDayName, studentShortLabel } from './src/shared/firestore-helpers.js';
import {
    initFailActionShared, renderFailActionCard, selectFailType,
    clearFailType, saveFailFields, saveFailAction, completeFailTask, cancelFailTask,
} from './fail-action-shared.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderStudentDetail, renderSubFilters, renderListPanel, saveDailyRecord;
let getClassDomains, getNextHwStatus, saveClassNextHw;
let checkCanEditGrading, saveImmediately;
let getUniqueClassCodes, renderFilterChips, openBulkModal;

export function initHwManagementDeps(deps) {
    renderStudentDetail = deps.renderStudentDetail;
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    saveDailyRecord = deps.saveDailyRecord;
    getClassDomains = deps.getClassDomains;
    getNextHwStatus = deps.getNextHwStatus;
    saveClassNextHw = deps.saveClassNextHw;
    checkCanEditGrading = deps.checkCanEditGrading;
    saveImmediately = deps.saveImmediately;
    getUniqueClassCodes = deps.getUniqueClassCodes;
    renderFilterChips = deps.renderFilterChips;
    openBulkModal = deps.openBulkModal;
    initFailActionShared({ renderStudentDetail, renderListPanel, checkCanEditGrading });
}

// ─── 숙제 미통과 후속대책 (공유 fail-action 엔진의 hw 바인딩) ─────────────────
const HW_CONFIG = {
    collection: 'hw_fail_tasks',
    docIdPrefix: '',
    actionField: 'hw_fail_action',
    firstField: 'hw_domains_1st',
    fieldAttr: 'data-hw-field',
    datasetKey: 'hwField',
    stateTasksKey: 'hwFailTasks',
    titleNoun: '숙제',
    descUnit: '영역',
    cardIcon: 'assignment_late',
    countSuffix: '개 영역',
    extraTaskData: {},
    savedTagInline: true,       // hw는 행마다 저장됨 태그를 인라인 노출
    hidePendingFromForm: false, // hw는 pending도 폼에 인라인 표시(테스트와 달리 숨기지 않음)
    selectFn: 'selectHwFailType',
    clearFn: 'clearHwFailType',
    saveFieldsFn: 'saveHwFailFields',
};

export function renderHwFailActionCard(studentId, domains, d2nd, hwFailAction, mode = 'default') {
    return renderFailActionCard({ studentId, items: domains, d2nd, failAction: hwFailAction, mode, config: HW_CONFIG });
}
export const selectHwFailType = (studentId, domain, type, btnEl) => selectFailType(studentId, domain, type, HW_CONFIG);
export const clearHwFailType = (studentId, domain) => clearFailType(studentId, domain, HW_CONFIG);
export const saveHwFailFields = (studentId, domain, btnEl) => saveFailFields(studentId, domain, btnEl, HW_CONFIG);
export const saveHwFailAction = (studentId, hwFailAction, onlyDomain) => saveFailAction(studentId, hwFailAction, onlyDomain, HW_CONFIG);
export const completeHwFailTask = (taskDocId, studentId) => completeFailTask(taskDocId, studentId, HW_CONFIG);
export const cancelHwFailTask = (taskDocId, studentId) => cancelFailTask(taskDocId, studentId, HW_CONFIG);

export function renderPendingTasksCard(studentId, tasks) {
    if (tasks.length === 0) return '';

    // 날짜 그룹 우선 정렬 (같은 날 묶음 재지정 단위), 그룹 내에선 재지정된 task를 뒤로
    const sortedTasks = [...tasks].sort((a, b) => {
        const dateCmp = (a.scheduled_date || '9999').localeCompare(b.scheduled_date || '9999');
        if (dateCmp !== 0) return dateCmp;
        const aRescheduled = Array.isArray(a.reschedule_history) && a.reschedule_history.length > 0;
        const bRescheduled = Array.isArray(b.reschedule_history) && b.reschedule_history.length > 0;
        if (aRescheduled !== bRescheduled) return aRescheduled ? 1 : -1;
        return (a.scheduled_time || '').localeCompare(b.scheduled_time || '');
    });

    const groupCounts = {};
    sortedTasks.forEach(t => {
        const k = t.scheduled_date || '';
        groupCounts[k] = (groupCounts[k] || 0) + 1;
    });
    const groupHeader = (dateKey) => {
        const count = groupCounts[dateKey];
        const bulkBtn = dateKey && count >= 2
            ? `<button class="hw-fail-type-btn" style="background:#7c3aed;border-color:#7c3aed;color:#fff;font-size:11px;padding:2px 8px;"
                    onclick="openBulkRescheduleModal('${escAttr(studentId)}', '${escAttr(dateKey)}')">
                    ${msIcon('event', '', 'style="font-size:13px;"')}묶음 재지정
                </button>`
            : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 2px;font-size:12px;font-weight:600;color:var(--text-sec);">
            <span>${dateKey ? esc(_stripYear(dateKey)) : '날짜 미정'} · ${count}건</span>${bulkBtn}
        </div>`;
    };

    const taskRows = sortedTasks.map((t, idx) => {
        const isTest = t.source === 'test';
        const completeFunc = isTest ? 'completeTestFailTask' : 'completeHwFailTask';
        const cancelFunc = isTest ? 'cancelTestFailTask' : 'cancelHwFailTask';
        const collection = isTest ? 'test_fail_tasks' : 'hw_fail_tasks';
        const sourceLabel = isTest ? '테스트' : '숙제';
        const typeIcon = t.type === '등원'
            ? msIcon('person-simple-run', '', 'style="font-size:14px;"')
            : msIcon('note-pencil', '', 'style="font-size:14px;"');
        const noShow = _isNoShow(t);
        const isRescheduled = Array.isArray(t.reschedule_history) && t.reschedule_history.length > 0;
        const rowClass = [
            'pending-task-row',
            isRescheduled ? 'rescheduled' : '',
            noShow ? 'no-show' : '',
        ].filter(Boolean).join(' ');

        // 1줄 요약: 도메인 · 타입 · 출처날짜 + 미등원 뱃지
        const noShowBadge = noShow ? '<span class="no-show-badge">미등원</span>' : '';
        const rescheduledBadge = isRescheduled ? '<span class="rescheduled-badge">재지정됨</span>' : '';
        const summary = `${esc(t.domain)} ${typeIcon} ${esc(t.type)} · ${esc(sourceLabel)} ${esc(_stripYear(t.source_date))}${noShowBadge}${rescheduledBadge}`;

        // 상세 내용
        const detail = t.type === '등원'
            ? `${esc(_stripYear(t.scheduled_date))}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`
            : `${esc(t.alt_hw || '내용 미입력')}${t.scheduled_date ? ' (기한: ' + esc(_stripYear(t.scheduled_date)) + ')' : ''}`;

        // 재지정 버튼 — 모든 pending task에 노출 (대체숙제는 모달이 시간 필드 자동 숨김)
        const rescheduleBtn = `<button class="hw-fail-type-btn" style="background:#7c3aed;border-color:#7c3aed;color:#fff;font-size:11px;"
                    onclick="openRescheduleModal('${escAttr(collection)}', '${escAttr(t.docId)}', '${escAttr(studentId)}')">
                    ${msIcon('event', '', 'style="font-size:13px;"')}재지정
                </button>`;

        // 재지정 이력
        const historyHtml = _renderRescheduleHistory(t.reschedule_history);

        const dateKey = t.scheduled_date || '';
        const header = (idx === 0 || (sortedTasks[idx - 1].scheduled_date || '') !== dateKey) ? groupHeader(dateKey) : '';

        return `
            ${header}
            <div class="${rowClass}" data-task-idx="${idx}">
                <div class="pending-task-summary" role="button" tabindex="0" data-keyclick aria-expanded="false" onclick="this.parentElement.classList.toggle('expanded'); this.setAttribute('aria-expanded', String(this.parentElement.classList.contains('expanded')))">
                    <span>${summary}</span>
                    ${msIcon('expand_more', 'pending-task-arrow', 'style="font-size:16px;color:var(--text-sec);"')}
                </div>
                <div class="pending-task-expand">
                    <div class="pending-task-detail">${detail}</div>
                    <div class="pending-task-meta">담당: ${esc(t.handler || '')}</div>
                    <div class="pending-task-actions">
                        <button class="hw-fail-type-btn active" style="background:var(--success);border-color:var(--success);font-size:11px;"
                            onclick="${completeFunc}('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                            ${msIcon('check_circle', '', 'style="font-size:13px;"')}완료
                        </button>
                        <button class="hw-fail-type-btn hw-fail-clear-btn" style="font-size:11px;"
                            onclick="${cancelFunc}('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                            ${msIcon('cancel', '', 'style="font-size:13px;"')}취소
                        </button>
                        ${rescheduleBtn}
                    </div>
                    ${historyHtml}
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="detail-card" style="border-color:#fef3c7;">
            <div class="detail-card-title">
                ${msIcon('pending_actions', '', 'style="color:#d97706;font-size:18px;"')}
                밀린 Task (${tasks.length})
            </div>
            ${taskRows}
        </div>
    `;
}

export function renderNextHwClassList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    renderFilterChips();

    let classCodes = getUniqueClassCodes().regular;
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        classCodes = classCodes.filter(cc => cc.toLowerCase().includes(q));
    }
    countEl.textContent = `${classCodes.length}개 반`;

    if (classCodes.length === 0) {
        container.innerHTML = `<div class="empty-state">
            ${msIcon('school')}
            <p>오늘 수업이 있는 반이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = classCodes.map(cc => {
        const { filled, total } = getNextHwStatus(cc);
        const isActive = cc === state.selectedNextHwClass ? 'active' : '';
        const statusClass = filled === total ? 'next-hw-complete' : filled > 0 ? 'next-hw-partial' : '';
        const domains = getClassDomains(cc);
        const data = state.classNextHw[cc]?.domains || {};

        return `<div class="list-item next-hw-class-card ${isActive} ${statusClass}" data-class="${escAttr(cc)}" role="button" tabindex="0" data-keyclick onclick="selectNextHwClass('${escAttr(cc)}')">
            <div class="next-hw-class-header">
                <span class="next-hw-class-code">${esc(cc)}</span>
                <span class="next-hw-class-status">${filled}/${total}</span>
            </div>
            <div class="next-hw-domain-chips">
                ${domains.map(d => {
                    const val = (data[d] || '').trim();
                    const isNone = val === '없음';
                    const isFilled = val && !isNone;
                    const stateClass = isFilled ? 'filled' : isNone ? 'none' : '';
                    return `<button class="next-hw-chip ${stateClass}" onclick="event.stopPropagation(); openNextHwModal('${escAttr(cc)}', '${escAttr(d)}')" title="${escAttr(val || '미입력')}">${esc(d)}</button>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');
}

export function selectNextHwClass(classCode) {
    state.selectedNextHwClass = classCode;
    renderNextHwClassList();
    renderNextHwClassDetail(classCode);
    // 모바일: 디테일 패널 보이기
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

export function openNextHwModal(classCode, domain) {
    state.nextHwModalTarget = { classCode, domain };
    const data = state.classNextHw[classCode]?.domains || {};
    const currentVal = (data[domain] || '').trim();

    document.getElementById('next-hw-modal-title').textContent = `${classCode} · ${domain} 다음숙제`;
    document.getElementById('next-hw-modal-label').textContent = domain;

    const textarea = document.getElementById('next-hw-modal-text');
    const saveBtn = document.getElementById('next-hw-modal-save');

    if (currentVal && currentVal !== '없음') {
        textarea.value = currentVal;
        saveBtn.textContent = '수정';
    } else {
        textarea.value = '';
        saveBtn.textContent = '입력';
    }

    // 핸들러를 반별 용으로 설정
    saveBtn.onclick = saveNextHwFromModal;
    document.getElementById('next-hw-modal-none').onclick = saveNextHwNone;

    document.getElementById('next-hw-modal').style.display = '';
    setTimeout(() => textarea.focus(), 100);
}

export function saveNextHwFromModal() {
    const { classCode, domain } = state.nextHwModalTarget;
    if (!classCode || !domain) return;

    const text = document.getElementById('next-hw-modal-text').value.trim();
    if (!text) { alert('내용을 입력하세요'); return; }

    saveClassNextHw(classCode, domain, text, true);
    document.getElementById('next-hw-modal').style.display = 'none';
    refreshNextHwViews(classCode);
}

export function saveNextHwNone() {
    const { classCode, domain } = state.nextHwModalTarget;
    if (!classCode || !domain) return;

    saveClassNextHw(classCode, domain, '없음', true);
    document.getElementById('next-hw-modal').style.display = 'none';
    refreshNextHwViews(classCode);
}

// ─── 개인별 다음숙제 모달 (학생 상세 패널에서 사용) ─────────────────────────
let personalNextHwTarget = { studentId: null, classCode: null, domain: null };

export function openPersonalNextHwModal(studentId, classCode, domain) {
    personalNextHwTarget = { studentId, classCode, domain };
    const rec = state.dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    const personalVal = personalNextHw[pKey];
    const classVal = (state.classNextHw[classCode]?.domains?.[domain] || '').trim();

    // 개인값이 있으면 개인값, 없으면 반값 표시
    const hasPersonal = personalVal != null && personalVal !== '';
    const currentVal = hasPersonal ? personalVal : classVal;

    document.getElementById('next-hw-modal-title').textContent = `${classCode} · ${domain} 개인 다음숙제`;
    document.getElementById('next-hw-modal-label').textContent = domain;

    const textarea = document.getElementById('next-hw-modal-text');
    const saveBtn = document.getElementById('next-hw-modal-save');

    if (currentVal && currentVal !== '없음') {
        textarea.value = currentVal;
        saveBtn.textContent = '수정';
    } else {
        textarea.value = '';
        saveBtn.textContent = '입력';
    }

    // 모달 저장 버튼을 개인용으로 연결
    saveBtn.onclick = savePersonalNextHwFromModal;
    document.getElementById('next-hw-modal-none').onclick = savePersonalNextHwNone;

    document.getElementById('next-hw-modal').style.display = '';
    setTimeout(() => textarea.focus(), 100);
}

export function savePersonalNextHwFromModal() {
    const { studentId, classCode, domain } = personalNextHwTarget;
    if (!studentId || !classCode || !domain) return;

    const text = document.getElementById('next-hw-modal-text').value.trim();
    if (!text) { alert('내용을 입력하세요'); return; }

    const rec = state.dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    personalNextHw[pKey] = text;

    saveDailyRecord(studentId, { personal_next_hw: personalNextHw });
    document.getElementById('next-hw-modal').style.display = 'none';
    restoreModalHandlers();
    if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
}

export function savePersonalNextHwNone() {
    const { studentId, classCode, domain } = personalNextHwTarget;
    if (!studentId || !classCode || !domain) return;

    const rec = state.dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    personalNextHw[pKey] = '없음';

    saveDailyRecord(studentId, { personal_next_hw: personalNextHw });
    document.getElementById('next-hw-modal').style.display = 'none';
    restoreModalHandlers();
    if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
}

// 모달 핸들러를 반별 용으로 복원
export function restoreModalHandlers() {
    document.getElementById('next-hw-modal-save').onclick = saveNextHwFromModal;
    document.getElementById('next-hw-modal-none').onclick = saveNextHwNone;
}

export function refreshNextHwViews(classCode) {
    // 반별 다음숙제 뷰가 열려있으면 리렌더
    if (state.currentCategory === 'homework' && state.currentSubFilter.has('hw_next')) {
        renderNextHwClassList();
        if (state.selectedNextHwClass === classCode) renderNextHwClassDetail(classCode);
    }
    // 학생 상세가 열려있으면 리렌더
    if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
}

export function renderNextHwClassDetail(classCode) {
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const domains = getClassDomains(classCode);
    const data = state.classNextHw[classCode]?.domains || {};

    // 프로필 영역
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
    document.getElementById('profile-academic-summary').innerHTML = '';

    const { filled, total } = getNextHwStatus(classCode);
    const statusTag = filled === total ? 'tag-present' : filled > 0 ? 'tag-late' : 'tag-pending';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">다음숙제</span>
        <span class="tag tag-status ${statusTag}">${filled}/${total} 입력</span>
    `;

    // 반 소속 학생 목록
    const dayName = getDayName(state.selectedDate);
    const classStudents = state.allStudents.filter(s =>
        s.status !== '퇴원'
        && matchesBranchFilter(s)
        && getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName) && enrollmentCode(e) === classCode)
    );

    const cardsContainer = document.getElementById('detail-cards');
    cardsContainer.innerHTML = `
        <!-- 다음숙제 입력 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('edit_note', '', 'style="color:var(--primary);font-size:18px;"')}
                다음숙제 입력
            </div>
            <div class="next-hw-domain-chips" style="margin-bottom:12px;">
                ${domains.map(d => {
                    const val = (data[d] || '').trim();
                    const isNone = val === '없음';
                    const isFilled = val && !isNone;
                    const stateClass = isFilled ? 'filled' : isNone ? 'none' : '';
                    return `<button class="next-hw-chip ${stateClass}" onclick="openNextHwModal('${escAttr(classCode)}', '${escAttr(d)}')" title="${escAttr(val || '미입력')}">${esc(d)}</button>`;
                }).join('')}
            </div>
            ${domains.map(d => {
                const val = (data[d] || '').trim();
                if (!val) return '';
                const isNone = val === '없음';
                return `<div class="next-hw-detail-row">
                    <span class="next-hw-detail-label">${esc(d)}</span>
                    <span style="font-size:13px;color:${isNone ? 'var(--text-sec)' : 'var(--text-main)'};">${isNone ? '숙제 없음' : esc(val)}</span>
                </div>`;
            }).join('')}
        </div>

        <!-- 학생 목록 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('group', '', 'style="color:var(--text-sec);font-size:18px;"')}
                소속 학생 (${classStudents.length}명)
            </div>
            ${classStudents.length === 0
                ? '<div class="detail-card-empty">소속 학생 없음</div>'
                : classStudents.map(s => `<div class="detail-item" style="cursor:pointer;" role="button" tabindex="0" data-keyclick onclick="selectStudent('${escAttr(s.docId)}')">
                    <span>${esc(s.name)}</span>
                    <span class="tag" style="font-size:11px;">${esc(studentShortLabel(s))}</span>
                </div>`).join('')
            }
        </div>
    `;
}


export function toggleHomework(studentId, hwIndex, status) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const homework = [...(rec.homework || [])];
    if (homework[hwIndex]) {
        homework[hwIndex] = { ...homework[hwIndex], status };
        const prevHomework = rec.homework ? rec.homework.map(h => ({ ...h })) : undefined;
        saveImmediately(studentId, { homework }).catch((err) => {
            // 저장 실패 시 optimistic 캐시 rollback + 리렌더. F-04.
            // daily_records onSnapshot이 재구성하면 항목이 사라질 수 있어 존재 가드.
            console.error('숙제 저장 실패:', err);
            const cur = state.dailyRecords[studentId];
            if (cur) {
                if (prevHomework) cur.homework = prevHomework;
                else delete cur.homework;
            }
            renderSubFilters();
            renderListPanel();
            if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
        });

        if (!state.dailyRecords[studentId]) {
            state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        }
        state.dailyRecords[studentId].homework = homework;

        renderSubFilters();
        renderListPanel();
        if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
    }
}

export function oxFieldLabel(field) {
    const labels = { hw_domains_1st: '숙제1차', hw_domains_2nd: '숙제2차', test_domains_1st: '테스트1차', test_domains_2nd: '테스트2차' };
    return labels[field] || field;
}

export function toggleHwDomainOX(studentId, field, domain) {
    if (!checkCanEditGrading(studentId)) return;
    if (state.bulkMode && state.selectedStudentIds.size >= 2 && state.selectedStudentIds.has(studentId)) {
        openBulkModal('ox', field, domain);
        return;
    }
    applyHwDomainOX(studentId, field, domain);
    renderSubFilters();
    if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
}


export function applyHwDomainOX(studentId, field, domain, forceValue) {
    const rec = state.dailyRecords[studentId] || {};
    const domainData = { ...(rec[field] || {}) };
    const currentVal = domainData[domain] || '';
    const newVal = forceValue !== undefined ? forceValue : nextOXValue(currentVal);
    domainData[domain] = newVal;

    const updates = { [field]: domainData };

    // 1차에서 'O' 입력 시, 2차에 해당 항목이 있으면 자동 정리
    const secondField = field === 'hw_domains_1st' ? 'hw_domains_2nd'
        : field === 'test_domains_1st' ? 'test_domains_2nd' : null;
    if (secondField && newVal === 'O' && rec[secondField]?.[domain]) {
        const secondData = { ...(rec[secondField] || {}) };
        delete secondData[domain];
        updates[secondField] = secondData;
    }

    // 즉시 저장 (실패 시 optimistic 캐시 rollback + 리렌더). F-04.
    // 변경한 두 필드만 되돌린다 — 레코드 통째 교체는 그 사이 동시 변경된 다른 필드(출결 등)를
    // 유실시키고, onSnapshot 재구성으로 항목이 사라지면 undefined가 되므로 존재 가드.
    const prevField = rec[field];
    const prevSecond = secondField ? rec[secondField] : undefined;
    saveImmediately(studentId, updates).catch((err) => {
        console.error('OX 저장 실패:', err);
        const cur = state.dailyRecords[studentId];
        if (cur) {
            if (prevField === undefined) delete cur[field]; else cur[field] = prevField;
            if (secondField && updates[secondField] !== undefined) {
                if (prevSecond === undefined) delete cur[secondField]; else cur[secondField] = prevSecond;
            }
        }
        renderSubFilters();
        if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
    });

    // 로컬 캐시 업데이트
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    state.dailyRecords[studentId][field] = domainData;
    if (secondField && updates[secondField]) {
        state.dailyRecords[studentId][secondField] = updates[secondField];
    }

    // DOM 직접 업데이트 (버튼만 갱신)
    const btn = document.querySelector(`.hw-domain-ox[data-student="${CSS.escape(studentId)}"][data-field="${CSS.escape(field)}"][data-domain="${CSS.escape(domain)}"]`);
    if (btn) {
        btn.classList.remove('ox-green', 'ox-red', 'ox-yellow', 'ox-empty');
        btn.classList.add(oxDisplayClass(newVal));
        btn.textContent = newVal || '—';
    }
}

export function handleHomeworkStatusChange(studentId, hwIndex, value) {
    const rec = state.dailyRecords[studentId] || {};
    const homework = [...(rec.homework || [])];
    if (homework[hwIndex]) {
        homework[hwIndex] = { ...homework[hwIndex], status: value };
        saveDailyRecord(studentId, { homework });

        if (!state.dailyRecords[studentId]) {
            state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        }
        state.dailyRecords[studentId].homework = homework;
    }
}

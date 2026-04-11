// ─── HW Management Module ──────────────────────────────────────────────────
// daily-ops.js에서 추출한 숙제 관리 관련 함수
// Phase 3-4

import { doc } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate } from './audit.js';
import { state } from './state.js';
import { esc, escAttr, showSaveIndicator, formatTime12h, nextOXValue, oxDisplayClass } from './ui-utils.js';
import { enrollmentCode, getActiveEnrollments, matchesBranchFilter } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderStudentDetail, renderSubFilters, renderListPanel, saveDailyRecord;
let getClassDomains, getNextHwStatus, saveClassNextHw;
let _stripYear, _isNoShow, _renderRescheduleHistory, checkCanEditGrading, saveImmediately;

export function initHwManagementDeps(deps) {
    renderStudentDetail = deps.renderStudentDetail;
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    saveDailyRecord = deps.saveDailyRecord;
    getClassDomains = deps.getClassDomains;
    getNextHwStatus = deps.getNextHwStatus;
    saveClassNextHw = deps.saveClassNextHw;
    _stripYear = deps._stripYear;
    _isNoShow = deps._isNoShow;
    _renderRescheduleHistory = deps._renderRescheduleHistory;
    checkCanEditGrading = deps.checkCanEditGrading;
    saveImmediately = deps.saveImmediately;
}

export function renderHwFailActionCard(studentId, domains, d2nd, hwFailAction, mode = 'default') {
    const rec = state.dailyRecords[studentId] || {};
    const d1st = rec.hw_domains_1st || {};
    const is1stOnly = mode === '1st_only';

    // 미통과 대상
    const failDomains = is1stOnly
        ? domains.filter(d => { const v = d1st[d] || ''; return v && v !== 'O'; })
        : domains.filter(d => {
            const v2 = d2nd[d] || '';
            if (v2 === 'X' || v2 === '△') return true;
            const v1 = d1st[d] || '';
            if (v1 && v1 !== 'O' && !v2) return true;
            return false;
        });

    const titleLabel = is1stOnly ? '후속대책' : '2차 숙제 처리';
    const passLabel = is1stOnly ? '1차 모두 통과!' : '2차 모두 통과!';

    if (failDomains.length === 0) {
        return `
            <div class="detail-card hw-fail-card">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:var(--success);font-size:18px;">check_circle</span>
                    ${titleLabel}
                </div>
                <div class="detail-card-empty" style="color:var(--success);">✅ ${passLabel}</div>
            </div>
        `;
    }

    // pending 또는 완료된 task가 있는 영역은 후속대책 카드에서 제외 (취소만 재생성 허용)
    const filteredDomains = failDomains.filter(domain =>
        !state.hwFailTasks.find(t => t.student_id === studentId && t.domain === domain && t.source_date === state.selectedDate && (t.status === 'pending' || t.status === '완료'))
    );

    if (filteredDomains.length === 0) {
        return `
            <div class="detail-card hw-fail-card">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:var(--success);font-size:18px;">task_alt</span>
                    ${titleLabel}
                </div>
                <div class="detail-card-empty" style="color:var(--text-sec);">모두 처리됨</div>
            </div>
        `;
    }

    const descLabel = is1stOnly
        ? '1차 미통과 영역에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.'
        : '2차 미통과 영역에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.';

    const rows = filteredDomains.map(domain => {
        const action = hwFailAction[domain] || {};
        const type = action.type || '';
        const isVisit = type === '등원';
        const isAlt = type === '대체숙제';
        const escapedDomain = escAttr(domain);
        const badgeVal = is1stOnly ? (d1st[domain] || '') : (d2nd[domain] || '');

        return `
            <div class="hw-fail-domain-row" data-domain="${escapedDomain}">
                <div class="hw-fail-domain-header">
                    <span style="font-size:12px;font-weight:600;color:var(--text-main);">${esc(domain)}</span>
                    <span class="hw-fail-ox-badge ${oxDisplayClass(badgeVal)}">${esc(badgeVal || '—')}</span>
                    <div class="hw-fail-type-btns">
                        <button class="hw-fail-type-btn ${isVisit ? 'active' : ''}"
                            onclick="selectHwFailType('${escAttr(studentId)}', '${escapedDomain}', '등원', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">directions_walk</span>등원
                        </button>
                        <button class="hw-fail-type-btn ${isAlt ? 'active' : ''}"
                            onclick="selectHwFailType('${escAttr(studentId)}', '${escapedDomain}', '대체숙제', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">edit_note</span>대체숙제
                        </button>
                        ${type ? `<button class="hw-fail-type-btn hw-fail-clear-btn"
                            onclick="clearHwFailType('${escAttr(studentId)}', '${escapedDomain}')">취소</button>` : ''}
                    </div>
                </div>
                ${isVisit ? `
                    <div class="hw-fail-detail">
                        <div class="hw-fail-detail-row">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">등원일시</label>
                            <input type="date" class="field-input hw-fail-input" data-hw-field="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                            <input type="time" class="field-input hw-fail-input" data-hw-field="scheduled_time" style="width:90px;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_time || '')}" placeholder="시간">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || state.currentUser?.email || '').split('@')[0])}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="saveHwFailFields('${escAttr(studentId)}', '${escapedDomain}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : isAlt ? `
                    <div class="hw-fail-detail">
                        <input type="text" class="field-input hw-fail-input" data-hw-field="alt_hw" style="width:100%;padding:4px 8px;font-size:12px;"
                            placeholder="대체 숙제 내용 (예: 단어장 50개)"
                            value="${escAttr(action.alt_hw || '')}">
                        <div class="hw-fail-detail-row" style="margin-top:4px;">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">제출기한</label>
                            <input type="date" class="field-input hw-fail-input" data-hw-field="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || state.currentUser?.email || '').split('@')[0])}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="saveHwFailFields('${escAttr(studentId)}', '${escapedDomain}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : ''}
                <div class="hw-fail-saved-tag" id="hw-fail-saved-${escAttr(studentId)}-${escapedDomain}" style="display:none;font-size:11px;color:var(--success);margin-top:4px;">✓ 저장됨</div>
            </div>
        `;
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');

    return `
        <div class="detail-card hw-fail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--danger);font-size:18px;">assignment_late</span>
                ${is1stOnly ? '후속대책' : '숙제 미통과'} (${filteredDomains.length}개 영역)
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                ${descLabel}
            </div>
            ${rows}
        </div>
    `;
}

// 처리 유형 선택 (등원 / 대체숙제)
export async function selectHwFailType(studentId, domain, type, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const hwFailAction = { ...(rec.hw_fail_action || {}) };
    const current = hwFailAction[domain] || {};

    hwFailAction[domain] = {
        ...current,
        type,
        handler: current.handler || state.currentUser?.email || '',
        scheduled_date: current.scheduled_date || '',
        scheduled_time: current.scheduled_time || '',
        alt_hw: current.alt_hw || '',
        updated_at: new Date().toISOString(),
    };

    // 타입 선택 단계: daily_records에만 저장 (hw_fail_tasks는 "저장" 버튼 시 생성)
    await _saveHwFailActionOnly(studentId, hwFailAction);
    renderStudentDetail(studentId);
}

// 처리 유형 초기화
export async function clearHwFailType(studentId, domain) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const hwFailAction = { ...(rec.hw_fail_action || {}) };
    delete hwFailAction[domain];
    await saveHwFailAction(studentId, hwFailAction);
    renderStudentDetail(studentId);
}

export async function saveHwFailFields(studentId, domain, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const row = btnEl.closest('.hw-fail-domain-row');
    if (!row) return;
    if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = {};
    if (!state.dailyRecords[studentId].hw_fail_action) state.dailyRecords[studentId].hw_fail_action = {};
    if (!state.dailyRecords[studentId].hw_fail_action[domain]) state.dailyRecords[studentId].hw_fail_action[domain] = {};
    row.querySelectorAll('[data-hw-field]').forEach(el => {
        state.dailyRecords[studentId].hw_fail_action[domain][el.dataset.hwField] = el.value;
    });
    state.dailyRecords[studentId].hw_fail_action[domain].updated_at = new Date().toISOString();
    await saveHwFailAction(studentId, state.dailyRecords[studentId].hw_fail_action, domain);
    const tag = document.getElementById(`hw-fail-saved-${studentId}-${domain}`);
    if (tag) { tag.style.display = ''; setTimeout(() => tag.style.display = 'none', 2000); }
    renderStudentDetail(studentId);
}

// daily_records에만 hw_fail_action 저장 (타입 선택 단계용, task 생성 없음)
async function _saveHwFailActionOnly(studentId, hwFailAction) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            hw_fail_action: hwFailAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId].hw_fail_action = hwFailAction;
        showSaveIndicator('saved');
    } catch (err) {
        console.error('hw_fail_action 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// Firestore에 hw_fail_action 저장 + hw_fail_tasks 컬렉션에도 동기화
// onlyDomain: 지정 시 해당 영역만 task 생성/업데이트
export async function saveHwFailAction(studentId, hwFailAction, onlyDomain) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            hw_fail_action: hwFailAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId].hw_fail_action = hwFailAction;

        // hw_fail_tasks 컬렉션 동기화 (domain당 1개 doc: studentId_domain_sourceDate)
        // 1) 서버 확인이 필요한 항목들을 병렬로 읽기
        const hwTaskEntries = Object.entries(hwFailAction).filter(([domain, action]) => action.type && (!onlyDomain || domain === onlyDomain));

        const hwTaskChecks = hwTaskEntries.map(([domain, action]) => {
            const taskDocId = `${studentId}_${domain}_${state.selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = state.hwFailTasks.find(t => t.docId === taskDocId);

            return { domain, action, taskDocId, existing };
        });

        const hwWriteBatch = writeBatch(db);
        let hwWriteCount = 0;
        for (const check of hwTaskChecks) {
            if (!check) continue;
            const { domain, action, taskDocId, existing } = check;
            const taskData = {
                student_id: studentId,
                student_name: student?.name || '',
                domain,
                type: action.type,
                source_date: state.selectedDate,
                scheduled_date: action.scheduled_date || '',
                scheduled_time: action.scheduled_time || '',
                alt_hw: action.alt_hw || '',
                handler: (action.handler || state.currentUser?.email || '').split('@')[0],
                status: 'pending',
                created_by: (state.currentUser?.email || '').split('@')[0],
                created_at: existing?.created_at || new Date().toISOString(),
                branch: branchFromStudent(student || {}),
            };
            batchSet(hwWriteBatch, doc(db, 'hw_fail_tasks', taskDocId), taskData, { merge: true });
            hwWriteCount++;
            const idx = state.hwFailTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                state.hwFailTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                state.hwFailTasks.push({ docId: taskDocId, ...taskData });
            }
        }

        if (hwWriteCount > 0) {
            await hwWriteBatch.commit();

        }

        // 삭제된 domain의 pending tasks: 타입 제거 시 hw_fail_tasks에서도 상태 업데이트
        const hwCancelTargets = state.hwFailTasks.filter(t => t.student_id === studentId && t.source_date === state.selectedDate && t.status === 'pending' && (!hwFailAction[t.domain] || !hwFailAction[t.domain].type));
        if (hwCancelTargets.length > 0) {
            const cancelBatch = writeBatch(db);
            for (const t of hwCancelTargets) {
                batchUpdate(cancelBatch, doc(db, 'hw_fail_tasks', t.docId), {
                    status: '취소',
                    cancelled_by: (state.currentUser?.email || '').split('@')[0],
                    cancelled_at: new Date().toISOString()
                });
                t.status = '취소';
            }
            await cancelBatch.commit();
        }

        showSaveIndicator('saved');
    } catch (err) {
        console.error('hw_fail_action 저장 실패:', err);
        showSaveIndicator('error');
    }
}

export function renderPendingTasksCard(studentId, tasks) {
    if (tasks.length === 0) return '';

    const taskRows = tasks.map((t, idx) => {
        const isTest = t.source === 'test';
        const completeFunc = isTest ? 'completeTestFailTask' : 'completeHwFailTask';
        const cancelFunc = isTest ? 'cancelTestFailTask' : 'cancelHwFailTask';
        const collection = isTest ? 'test_fail_tasks' : 'hw_fail_tasks';
        const sourceLabel = isTest ? '테스트' : '숙제';
        const typeIcon = t.type === '등원' ? '🚶' : '📝';
        const noShow = _isNoShow(t);

        // 1줄 요약: 도메인 · 타입 · 출처날짜 + 미등원 뱃지
        const noShowBadge = noShow ? '<span class="no-show-badge">미등원</span>' : '';
        const summary = `${esc(t.domain)} ${typeIcon} ${esc(t.type)} · ${esc(sourceLabel)} ${esc(_stripYear(t.source_date))}${noShowBadge}`;

        // 상세 내용
        const detail = t.type === '등원'
            ? `${esc(_stripYear(t.scheduled_date))}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`
            : `${esc(t.alt_hw || '내용 미입력')}${t.scheduled_date ? ' (기한: ' + esc(_stripYear(t.scheduled_date)) + ')' : ''}`;

        // 재지정 버튼 (미등원 + 등원 타입만)
        const rescheduleBtn = (noShow && t.type === '등원')
            ? `<button class="hw-fail-type-btn" style="background:#7c3aed;border-color:#7c3aed;color:#fff;font-size:11px;"
                    onclick="openRescheduleModal('${escAttr(collection)}', '${escAttr(t.docId)}', '${escAttr(studentId)}')">
                    <span class="material-symbols-outlined" style="font-size:13px;">event</span>재지정
                </button>`
            : '';

        // 재지정 이력
        const historyHtml = _renderRescheduleHistory(t.reschedule_history);

        return `
            <div class="pending-task-row" data-task-idx="${idx}">
                <div class="pending-task-summary" onclick="this.parentElement.classList.toggle('expanded')">
                    <span>${summary}</span>
                    <span class="pending-task-arrow material-symbols-outlined" style="font-size:16px;color:var(--text-sec);">expand_more</span>
                </div>
                <div class="pending-task-expand">
                    <div class="pending-task-detail">${detail}</div>
                    <div class="pending-task-meta">담당: ${esc(t.handler || '')}</div>
                    <div class="pending-task-actions">
                        <button class="hw-fail-type-btn active" style="background:var(--success);border-color:var(--success);font-size:11px;"
                            onclick="${completeFunc}('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">check_circle</span>완료
                        </button>
                        <button class="hw-fail-type-btn hw-fail-clear-btn" style="font-size:11px;"
                            onclick="${cancelFunc}('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                            <span class="material-symbols-outlined" style="font-size:13px;">cancel</span>취소
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
                <span class="material-symbols-outlined" style="color:#d97706;font-size:18px;">pending_actions</span>
                밀린 Task (${tasks.length})
            </div>
            ${taskRows}
        </div>
    `;
}

// 밀린 Task 완료 처리
export async function completeHwFailTask(taskDocId, studentId) {
    if (!confirm('완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'hw_fail_tasks', taskDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const t = state.hwFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '완료'; t.completed_by = completedBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

// 밀린 Task 취소 처리
export async function cancelHwFailTask(taskDocId, studentId) {
    if (!confirm('취소 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'hw_fail_tasks', taskDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const t = state.hwFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '취소'; t.cancelled_by = cancelledBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
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
            <span class="material-symbols-outlined">school</span>
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

        return `<div class="list-item next-hw-class-card ${isActive} ${statusClass}" data-class="${escAttr(cc)}" onclick="selectNextHwClass('${escAttr(cc)}')">
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

    const { filled, total } = getNextHwStatus(classCode);
    const statusTag = filled === total ? 'tag-present' : filled > 0 ? 'tag-late' : 'tag-pending';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">다음숙제</span>
        <span class="tag tag-status ${statusTag}">${filled}/${total} 입력</span>
    `;

    // 반 소속 학생 목록
    const dayName = getDayName(state.selectedDate);
    let classStudents = state.allStudents.filter(s =>
        s.status !== '퇴원' && getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName) && enrollmentCode(e) === classCode)
    );
    classStudents = classStudents.filter(s => matchesBranchFilter(s));

    const cardsContainer = document.getElementById('detail-cards');
    cardsContainer.innerHTML = `
        <!-- 다음숙제 입력 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">edit_note</span>
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
                <span class="material-symbols-outlined" style="color:var(--text-sec);font-size:18px;">group</span>
                소속 학생 (${classStudents.length}명)
            </div>
            ${classStudents.length === 0
                ? '<div class="detail-card-empty">소속 학생 없음</div>'
                : classStudents.map(s => `<div class="detail-item" style="cursor:pointer;" onclick="selectStudent('${escAttr(s.docId)}')">
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
        saveImmediately(studentId, { homework });

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

    // 즉시 저장
    saveImmediately(studentId, updates);

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


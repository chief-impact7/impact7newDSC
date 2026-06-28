// ─── Fail Action 공유 엔진 ──────────────────────────────────────────────────
// 숙제(hw)·테스트(test) 미통과 후속대책은 동일한 기능을 두 "출처"에 적용한 것이다.
// 두 모듈(hw-management.js / test-management.js)이 복붙해 쓰던 렌더·저장·task 동기화
// 로직을 단일 엔진으로 통합한다. 출처별 차이는 전부 config 데이터 파라미터로 표현한다.
//
// config 필드:
//   collection        : 'hw_fail_tasks' | 'test_fail_tasks'
//   docIdPrefix       : '' | 'test_'                  (task docId 접두)
//   actionField       : 'hw_fail_action' | 'test_fail_action'  (daily_records 필드)
//   firstField        : 'hw_domains_1st' | 'test_domains_1st'  (1차 채점 필드)
//   fieldAttr         : 'data-hw-field' | 'data-test-field'    (입력 data attr)
//   datasetKey        : 'hwField' | 'testField'               (el.dataset 키)
//   stateTasksKey     : 'hwFailTasks' | 'testFailTasks'        (state[...] task 배열)
//   titleNoun         : '숙제' | '테스트'
//   descUnit          : '영역'(hw) | '항목'(test)              (안내문 단위)
//   cardIcon          : 'assignment_late' | 'quiz'
//   countSuffix       : '개 영역' | '개'                       (제목 카운트 단위)
//   extraTaskData     : {} | { source: 'test' }               (task 추가 필드)
//   savedTagInline    : true(hw) | false(test)   — 행마다 ✓저장됨 태그 + 저장 시 노출
//   hidePendingFromForm : false(hw) | true(test) — pending은 폼에서 숨기고 "모두 처리됨"
//   reopenedSet       : null(hw) | Set(test)     — 명시적 편집요청 추적 set
//   selectFn/clearFn/saveFieldsFn : onclick에 들어갈 window 전역 함수명
import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet, batchSet, batchUpdate } from './audit.js';
import { state } from './state.js';
import { esc, escAttr, showSaveIndicator, formatTime12h, renderTime12hSelect, oxDisplayClass, _stripYear } from './ui-utils.js';
import { makeDailyRecordId, branchFromStudent } from './student-helpers.js';
import { staffLabel } from '@impact7/shared/staff-label';

// ─── deps injection (hw/test 모듈의 initDeps에서 동일 인스턴스 주입) ──────────
let renderStudentDetail, renderListPanel, checkCanEditGrading;

export function initFailActionShared(deps) {
    renderStudentDetail = deps.renderStudentDetail;
    renderListPanel = deps.renderListPanel;
    checkCanEditGrading = deps.checkCanEditGrading;
}

// ─── 렌더 ───────────────────────────────────────────────────────────────────
export function renderFailActionCard({ studentId, items, d2nd, failAction, mode = 'default', config }) {
    const rec = state.dailyRecords[studentId] || {};
    const first = rec[config.firstField] || {};
    const is1stOnly = mode === '1st_only';

    // 미통과 대상
    const failKeys = is1stOnly
        ? items.filter(k => { const v = first[k] || ''; return v && v !== 'O'; })
        : items.filter(k => {
            const v2 = d2nd[k] || '';
            if (v2 === 'X' || v2 === '△') return true;
            const v1 = first[k] || '';
            if (v1 && v1 !== 'O' && !v2) return true;
            return false;
        });

    const ordinal = is1stOnly ? '1차' : '2차';
    const titleLabel = `${config.titleNoun} ${ordinal} 미통과`;
    const passLabel = `${config.titleNoun} ${ordinal} 모두 통과!`;

    if (failKeys.length === 0) {
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

    // test: pending task 항목은 밀린 Task로 이동됐으므로 숨김(명시적 편집요청은 예외).
    let renderKeys = failKeys;
    if (config.hidePendingFromForm) {
        renderKeys = failKeys.filter(key => {
            const isPending = !!state[config.stateTasksKey].find(t =>
                t.student_id === studentId && t.domain === key
                && t.source_date === state.selectedDate && t.status === 'pending'
            );
            return !isPending || (config.reopenedSet && config.reopenedSet.has(`${studentId}_${key}`));
        });
        if (renderKeys.length === 0) {
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
    }

    const descLabel = `${config.titleNoun} ${ordinal} 미통과 ${config.descUnit}에 '등원 약속' 또는 '대체 숙제'를 지정하세요.`;

    const rows = renderKeys.map(key => {
        const closedTask = state[config.stateTasksKey].find(t =>
            t.student_id === studentId && t.domain === key
            && t.source_date === state.selectedDate
            && t.status !== 'pending' && t.status
        );
        if (closedTask) return _renderClosedFailRow(key, closedTask);

        const hasPendingTask = !!state[config.stateTasksKey].find(t =>
            t.student_id === studentId && t.domain === key
            && t.source_date === state.selectedDate && t.status === 'pending'
        );

        const action = failAction[key] || {};
        const type = action.type || '';
        const isVisit = type === '등원';
        const isAlt = type === '대체숙제';
        const escapedKey = escAttr(key);
        const badgeVal = is1stOnly ? (first[key] || '') : (d2nd[key] || '');

        const savedTag = config.savedTagInline
            ? `<div class="hw-fail-saved-tag" id="hw-fail-saved-${escAttr(studentId)}-${escapedKey}" style="display:none;font-size:11px;color:var(--success);margin-top:4px;">✓ 저장됨</div>`
            : '';

        return `
            <div class="hw-fail-domain-row" data-domain="${escapedKey}">
                <div class="hw-fail-domain-header">
                    <span style="font-size:12px;font-weight:600;color:var(--text-main);">${esc(key)}</span>
                    <span class="hw-fail-ox-badge ${oxDisplayClass(badgeVal)}">${esc(badgeVal || '—')}</span>
                    ${hasPendingTask ? `<span style="font-size:10px;color:var(--primary);padding:1px 5px;border-radius:4px;border:1px solid var(--primary);margin-right:auto;">저장됨·수정가능</span>` : ''}
                    <div class="hw-fail-type-btns">
                        <button class="hw-fail-type-btn ${isVisit ? 'active' : ''}" aria-pressed="${isVisit}"
                            onclick="${config.selectFn}('${escAttr(studentId)}', '${escapedKey}', '등원', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">directions_walk</span>등원
                        </button>
                        <button class="hw-fail-type-btn ${isAlt ? 'active' : ''}" aria-pressed="${isAlt}"
                            onclick="${config.selectFn}('${escAttr(studentId)}', '${escapedKey}', '대체숙제', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">edit_note</span>대체숙제
                        </button>
                        ${type ? `<button class="hw-fail-type-btn hw-fail-clear-btn"
                            onclick="${config.clearFn}('${escAttr(studentId)}', '${escapedKey}')">${hasPendingTask ? '삭제' : '취소'}</button>` : ''}
                    </div>
                </div>
                ${isVisit ? `
                    <div class="hw-fail-detail">
                        <div class="hw-fail-detail-row">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">등원일시</label>
                            <input type="date" class="field-input hw-fail-input" ${config.fieldAttr}="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                            ${renderTime12hSelect({
                                value: action.scheduled_time || '16:00',
                                dataAttr: `${config.fieldAttr}="scheduled_time"`,
                                className: 'hw-fail-input',
                                style: 'width:105px;padding:4px 8px;font-size:12px;',
                            })}
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc(staffLabel(action.handler || state.currentUser?.email || ''))}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="${config.saveFieldsFn}('${escAttr(studentId)}', '${escapedKey}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : isAlt ? `
                    <div class="hw-fail-detail">
                        <input type="text" class="field-input hw-fail-input" ${config.fieldAttr}="alt_hw" aria-label="대체 숙제" style="width:100%;padding:4px 8px;font-size:12px;"
                            placeholder="대체 숙제 내용 (예: 단어장 50개)"
                            value="${escAttr(action.alt_hw || '')}">
                        <div class="hw-fail-detail-row" style="margin-top:4px;">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">제출기한</label>
                            <input type="date" class="field-input hw-fail-input" ${config.fieldAttr}="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc(staffLabel(action.handler || state.currentUser?.email || ''))}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="${config.saveFieldsFn}('${escAttr(studentId)}', '${escapedKey}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : ''}${savedTag ? `
                ${savedTag}` : ''}
            </div>
        `;
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');

    const count = renderKeys.length;
    return `
        <div class="detail-card hw-fail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--danger);font-size:18px;">${config.cardIcon}</span>
                ${titleLabel} (${count}${config.countSuffix})
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                ${descLabel}
            </div>
            ${rows}
        </div>
    `;
}

// 닫힌(완료/취소/기타) fail task 행.
function _renderClosedFailRow(key, task) {
    const detail = task.type === '등원'
        ? `${_stripYear(task.scheduled_date || '')}${task.scheduled_time ? ' ' + formatTime12h(task.scheduled_time) : ''}`
        : (task.alt_hw || '내용 없음');
    return `
        <div class="hw-fail-domain-row hw-fail-closed" data-domain="${escAttr(key)}" style="opacity:0.75;">
            <div class="hw-fail-domain-header">
                <span style="font-size:12px;font-weight:600;color:var(--text-main);">${esc(key)}</span>
                <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--surface-alt);color:var(--text-sec);">처리됨 (${esc(task.status)})</span>
            </div>
            <div style="font-size:11px;color:var(--text-sec);padding:4px 0 0 6px;">
                ${esc(task.type)} · ${esc(detail)}
            </div>
        </div>
    `;
}

// 닫힌 task 재활성화 — UI에서 제공하지 않고 기존 window API 호환용으로만 유지.
export async function reopenFailDomain(studentId, key, config) {
    const taskDocId = `${config.docIdPrefix}${studentId}_${key}_${state.selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
    const task = state[config.stateTasksKey].find(t => t.docId === taskDocId);
    if (!task || task.status === 'pending') return;
    if (!confirm(`'${key}' 후속대책을 다시 활성화하시겠습니까?`)) return;
    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, config.collection, taskDocId), {
            status: 'pending',
            completed_by: '',
            completed_at: '',
            cancelled_by: '',
            cancelled_at: '',
        });
        Object.assign(task, { status: 'pending', completed_by: '', completed_at: '', cancelled_by: '', cancelled_at: '' });
        if (config.reopenedSet) config.reopenedSet.add(`${studentId}_${key}`);
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('재입력 활성화 실패:', err);
        showSaveIndicator('error');
    }
}

// 처리 유형 선택 (등원 / 대체숙제) — daily_records에만 저장(task는 "저장" 버튼 시 생성)
export async function selectFailType(studentId, key, type, config) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const failAction = { ...(rec[config.actionField] || {}) };
    const current = failAction[key] || {};

    failAction[key] = {
        ...current,
        type,
        handler: current.handler || state.currentUser?.email || '',
        scheduled_date: current.scheduled_date || '',
        scheduled_time: current.scheduled_time || '',
        alt_hw: current.alt_hw || '',
        updated_at: new Date().toISOString(),
    };

    await _saveFailActionOnly(studentId, failAction, config);
    renderStudentDetail(studentId);
}

// 처리 유형 초기화
export async function clearFailType(studentId, key, config) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const failAction = { ...(rec[config.actionField] || {}) };
    delete failAction[key];
    if (config.reopenedSet) config.reopenedSet.delete(`${studentId}_${key}`);
    await saveFailAction(studentId, failAction, undefined, config);
    renderStudentDetail(studentId);
}

export async function saveFailFields(studentId, key, btnEl, config) {
    if (!checkCanEditGrading(studentId)) return;
    const row = btnEl.closest('.hw-fail-domain-row');
    if (!row) return;
    if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = {};
    if (!state.dailyRecords[studentId][config.actionField]) state.dailyRecords[studentId][config.actionField] = {};
    if (!state.dailyRecords[studentId][config.actionField][key]) state.dailyRecords[studentId][config.actionField][key] = {};
    row.querySelectorAll(`[${config.fieldAttr}]`).forEach(el => {
        state.dailyRecords[studentId][config.actionField][key][el.dataset[config.datasetKey]] = el.value;
    });
    state.dailyRecords[studentId][config.actionField][key].updated_at = new Date().toISOString();
    if (config.reopenedSet) config.reopenedSet.delete(`${studentId}_${key}`);
    await saveFailAction(studentId, state.dailyRecords[studentId][config.actionField], key, config);
    renderStudentDetail(studentId);
    // 저장 확인 태그는 재렌더 "후"의 새 요소에 노출한다 — 재렌더 전에 켜면 곧바로 지워진다.
    if (config.savedTagInline) {
        const tag = document.getElementById(`hw-fail-saved-${studentId}-${key}`);
        if (tag) { tag.style.display = ''; setTimeout(() => tag.style.display = 'none', 2000); }
    }
}

// daily_records에만 fail_action 저장 (타입 선택 단계용, task 생성 없음)
async function _saveFailActionOnly(studentId, failAction, config) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            [config.actionField]: failAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId][config.actionField] = failAction;
        showSaveIndicator('saved');
    } catch (err) {
        console.error(`${config.actionField} 저장 실패:`, err);
        showSaveIndicator('error');
    }
}

// Firestore에 fail_action 저장 + fail_tasks 컬렉션 동기화 (domain당 1 doc)
// onlyDomain: 지정 시 해당 영역만 task 생성/업데이트
export async function saveFailAction(studentId, failAction, onlyDomain, config) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    const stateTasks = state[config.stateTasksKey];
    // 저장 실패 시 낙관적 캐시 롤백용 스냅샷 (OX·homework 경로와 동일 방어).
    const prevAction = state.dailyRecords[studentId]?.[config.actionField];
    const prevTasks = stateTasks.map(t => ({ ...t }));
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            [config.actionField]: failAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId][config.actionField] = failAction;

        const taskEntries = Object.entries(failAction).filter(([key, action]) => action.type && (!onlyDomain || key === onlyDomain));
        const taskChecks = taskEntries.map(([key, action]) => {
            const taskDocId = `${config.docIdPrefix}${studentId}_${key}_${state.selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = stateTasks.find(t => t.docId === taskDocId);
            return { key, action, taskDocId, existing };
        });

        const taskWriteBatch = writeBatch(db);
        let writeCount = 0;
        for (const check of taskChecks) {
            if (!check) continue;
            const { key, action, taskDocId, existing } = check;
            // 닫힌(완료/취소/기타) task는 건드리지 않는다(방어적 가드 — UI에서도 입력 필드 미노출).
            if (existing && existing.status && existing.status !== 'pending') continue;

            const taskData = {
                student_id: studentId,
                student_name: student?.name || '',
                domain: key,
                type: action.type,
                ...config.extraTaskData,
                source_date: state.selectedDate,
                scheduled_date: action.scheduled_date || '',
                scheduled_time: action.scheduled_time || '',
                alt_hw: action.alt_hw || '',
                handler: staffLabel(action.handler || state.currentUser?.email || ''),
                status: 'pending',
                created_by: staffLabel(state.currentUser?.email),
                created_at: existing?.created_at || new Date().toISOString(),
                branch: branchFromStudent(student || {}),
            };
            batchSet(taskWriteBatch, doc(db, config.collection, taskDocId), taskData, { merge: true });
            writeCount++;
            const idx = stateTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                stateTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                stateTasks.push({ docId: taskDocId, ...taskData });
            }
        }

        if (writeCount > 0) await taskWriteBatch.commit();

        // 삭제된 domain의 pending tasks: 타입 제거 시 컬렉션에서도 '취소'로 업데이트
        const cancelTargets = stateTasks.filter(t => t.student_id === studentId && t.source_date === state.selectedDate && t.status === 'pending' && (!failAction[t.domain] || !failAction[t.domain].type));
        if (cancelTargets.length > 0) {
            const cancelBatch = writeBatch(db);
            for (const t of cancelTargets) {
                batchUpdate(cancelBatch, doc(db, config.collection, t.docId), {
                    status: '취소',
                    cancelled_by: staffLabel(state.currentUser?.email),
                    cancelled_at: new Date().toISOString()
                });
                t.status = '취소';
            }
            await cancelBatch.commit();
        }

        showSaveIndicator('saved');
    } catch (err) {
        // 낙관적 캐시 롤백: task 배열을 저장 전으로 복원해 유령 pending task를 막는다.
        // action 맵은 복사본을 넘기는 호출(clearFailType)에서 복원된다. saveFailFields는
        // 같은 객체를 in-place 편집 후 넘겨 self-assign이라 필드편집까지는 못 되돌리지만,
        // 에러 경로이고 전역 인디케이터로 실패가 표시된다(다중 배치도 onSnapshot이 자가 치유).
        stateTasks.length = 0;
        for (const t of prevTasks) stateTasks.push(t);
        if (state.dailyRecords[studentId]) {
            if (prevAction === undefined) delete state.dailyRecords[studentId][config.actionField];
            else state.dailyRecords[studentId][config.actionField] = prevAction;
        }
        console.error(`${config.actionField} 저장 실패:`, err);
        showSaveIndicator('error');
    }
}

// 밀린 Task 완료 처리
export async function completeFailTask(taskDocId, studentId, config) {
    if (!confirm('완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = staffLabel(state.currentUser?.email);
        await auditUpdate(doc(db, config.collection, taskDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const t = state[config.stateTasksKey].find(t => t.docId === taskDocId);
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
export async function cancelFailTask(taskDocId, studentId, config) {
    if (!confirm('취소 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = staffLabel(state.currentUser?.email);
        await auditUpdate(doc(db, config.collection, taskDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const t = state[config.stateTasksKey].find(t => t.docId === taskDocId);
        if (t) { t.status = '취소'; t.cancelled_by = cancelledBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
}

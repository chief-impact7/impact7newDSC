// ─── Test Management Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 테스트 관리 관련 함수
// Phase 3-5

import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet, batchUpdate, batchSet } from './audit.js';
import { state } from './state.js';
import { esc, escAttr, showSaveIndicator, oxDisplayClass } from './ui-utils.js';
import { makeDailyRecordId, branchFromStudent } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let renderStudentDetail, renderListPanel, checkCanEditGrading, getClassDomains;

export function initTestManagementDeps(deps) {
    renderStudentDetail = deps.renderStudentDetail;
    renderListPanel = deps.renderListPanel;
    checkCanEditGrading = deps.checkCanEditGrading;
    getClassDomains = deps.getClassDomains;
}

// ─── 상수 ──────────────────────────────────────────────────────────────────

const DEFAULT_TEST_SECTIONS = {
    '기반학습테스트': ['Vo', 'Id', 'ISC'],
    '리뷰테스트': []
};

// ─── getClassTestSections ──────────────────────────────────────────────────

export function getClassTestSections(classCode) {
    const saved = state.classSettings[classCode]?.test_sections;
    if (saved) return JSON.parse(JSON.stringify(saved));
    // 최초: 리뷰테스트를 영역숙제관리(domains) 기반으로 초기화
    const sections = JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS));
    sections['리뷰테스트'] = [...getClassDomains(classCode)];
    return sections;
}

// ─── Test Fail Action (테스트 2차 미통과 처리) ────────────────────────────────

export function renderTestFailActionCard(studentId, testSections, t2nd, testFailAction, mode = 'default') {
    const rec = state.dailyRecords[studentId] || {};
    const t1st = rec.test_domains_1st || {};
    const is1stOnly = mode === '1st_only';

    const allItems = Object.values(testSections).flat();
    // 미통과 대상
    const failItems = is1stOnly
        ? allItems.filter(t => { const v = t1st[t] || ''; return v && v !== 'O'; })
        : allItems.filter(t => {
            const v2 = t2nd[t] || '';
            if (v2 === 'X' || v2 === '△') return true;
            const v1 = t1st[t] || '';
            if (v1 && v1 !== 'O' && !v2) return true;
            return false;
        });

    const titleLabel = is1stOnly ? '후속대책' : '2차 테스트 처리';
    const passLabel = is1stOnly ? '1차 모두 통과!' : '2차 모두 통과!';

    if (failItems.length === 0) {
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

    // pending 또는 완료된 task가 있는 항목은 후속대책 카드에서 제외 (취소만 재생성 허용)
    const filteredItems = failItems.filter(item =>
        !state.testFailTasks.find(t => t.student_id === studentId && t.domain === item && t.source_date === state.selectedDate && (t.status === 'pending' || t.status === '완료'))
    );

    if (filteredItems.length === 0) {
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
        ? '1차 미통과 항목에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.'
        : '2차 미통과 항목에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.';

    const rows = filteredItems.map(item => {
        const action = testFailAction[item] || {};
        const type = action.type || '';
        const isVisit = type === '등원';
        const isAlt = type === '대체숙제';
        const escapedItem = escAttr(item);
        const badgeVal = is1stOnly ? (t1st[item] || '') : (t2nd[item] || '');

        return `
            <div class="hw-fail-domain-row" data-domain="${escapedItem}">
                <div class="hw-fail-domain-header">
                    <span style="font-size:12px;font-weight:600;color:var(--text-main);">${esc(item)}</span>
                    <span class="hw-fail-ox-badge ${oxDisplayClass(badgeVal)}">${esc(badgeVal || '—')}</span>
                    <div class="hw-fail-type-btns">
                        <button class="hw-fail-type-btn ${isVisit ? 'active' : ''}"
                            onclick="selectTestFailType('${escAttr(studentId)}', '${escapedItem}', '등원', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">directions_walk</span>등원
                        </button>
                        <button class="hw-fail-type-btn ${isAlt ? 'active' : ''}"
                            onclick="selectTestFailType('${escAttr(studentId)}', '${escapedItem}', '대체숙제', this)">
                            <span class="material-symbols-outlined" style="font-size:13px;">edit_note</span>대체숙제
                        </button>
                        ${type ? `<button class="hw-fail-type-btn hw-fail-clear-btn"
                            onclick="clearTestFailType('${escAttr(studentId)}', '${escapedItem}')">취소</button>` : ''}
                    </div>
                </div>
                ${isVisit ? `
                    <div class="hw-fail-detail">
                        <div class="hw-fail-detail-row">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">등원일시</label>
                            <input type="date" class="field-input hw-fail-input" data-test-field="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                            <input type="time" class="field-input hw-fail-input" data-test-field="scheduled_time" style="width:90px;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_time || '')}" placeholder="시간">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || state.currentUser?.email || '').split('@')[0])}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="saveTestFailFields('${escAttr(studentId)}', '${escapedItem}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : isAlt ? `
                    <div class="hw-fail-detail">
                        <input type="text" class="field-input hw-fail-input" data-test-field="alt_hw" style="width:100%;padding:4px 8px;font-size:12px;"
                            placeholder="대체 숙제 내용 (예: 단어장 50개)"
                            value="${escAttr(action.alt_hw || '')}">
                        <div class="hw-fail-detail-row" style="margin-top:4px;">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">제출기한</label>
                            <input type="date" class="field-input hw-fail-input" data-test-field="scheduled_date" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || state.currentUser?.email || '').split('@')[0])}</div>
                        <button class="btn btn-primary btn-sm detail-save-btn" style="margin-top:6px;" onclick="saveTestFailFields('${escAttr(studentId)}', '${escapedItem}', this)">
                            <span class="material-symbols-outlined" style="font-size:16px;">save</span> 저장
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');

    return `
        <div class="detail-card hw-fail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--danger);font-size:18px;">quiz</span>
                ${is1stOnly ? '후속대책' : '테스트 미통과'} (${filteredItems.length}개)
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                ${descLabel}
            </div>
            ${rows}
        </div>
    `;
}

export async function selectTestFailType(studentId, item, type, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const testFailAction = { ...(rec.test_fail_action || {}) };
    const current = testFailAction[item] || {};

    testFailAction[item] = {
        ...current,
        type,
        handler: current.handler || state.currentUser?.email || '',
        scheduled_date: current.scheduled_date || '',
        scheduled_time: current.scheduled_time || '',
        alt_hw: current.alt_hw || '',
        updated_at: new Date().toISOString(),
    };

    // 타입 선택 단계: daily_records에만 저장 (test_fail_tasks는 "저장" 버튼 시 생성)
    await _saveTestFailActionOnly(studentId, testFailAction);
    renderStudentDetail(studentId);
}

export async function clearTestFailType(studentId, item) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = state.dailyRecords[studentId] || {};
    const testFailAction = { ...(rec.test_fail_action || {}) };
    delete testFailAction[item];
    await saveTestFailAction(studentId, testFailAction);
    renderStudentDetail(studentId);
}

export async function saveTestFailFields(studentId, item, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const row = btnEl.closest('.hw-fail-domain-row');
    if (!row) return;
    if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = {};
    if (!state.dailyRecords[studentId].test_fail_action) state.dailyRecords[studentId].test_fail_action = {};
    if (!state.dailyRecords[studentId].test_fail_action[item]) state.dailyRecords[studentId].test_fail_action[item] = {};
    row.querySelectorAll('[data-test-field]').forEach(el => {
        state.dailyRecords[studentId].test_fail_action[item][el.dataset.testField] = el.value;
    });
    state.dailyRecords[studentId].test_fail_action[item].updated_at = new Date().toISOString();
    await saveTestFailAction(studentId, state.dailyRecords[studentId].test_fail_action, item);
    const tag = row.querySelector('.hw-fail-saved-tag');
    if (tag) { tag.style.display = ''; setTimeout(() => tag.style.display = 'none', 2000); }
    renderStudentDetail(studentId);
}

// daily_records에만 test_fail_action 저장 (타입 선택 단계용, task 생성 없음)
async function _saveTestFailActionOnly(studentId, testFailAction) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            test_fail_action: testFailAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId].test_fail_action = testFailAction;
        showSaveIndicator('saved');
    } catch (err) {
        console.error('test_fail_action 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// onlyDomain: 지정 시 해당 영역만 task 생성/업데이트
export async function saveTestFailAction(studentId, testFailAction, onlyDomain) {
    const docId = makeDailyRecordId(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    try {
        await auditSet(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: state.selectedDate,
            branch: branchFromStudent(student || {}),
            test_fail_action: testFailAction
        }, { merge: true });
        if (!state.dailyRecords[studentId]) state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        state.dailyRecords[studentId].test_fail_action = testFailAction;

        // test_fail_tasks 컬렉션 동기화
        // 1) 서버 확인이 필요한 항목들을 병렬로 읽기
        const testTaskEntries = Object.entries(testFailAction).filter(([item, action]) => action.type && (!onlyDomain || item === onlyDomain));
        const testTaskChecks = testTaskEntries.map(([item, action]) => {
            const taskDocId = `test_${studentId}_${item}_${state.selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = state.testFailTasks.find(t => t.docId === taskDocId);
            return { item, action, taskDocId, existing };
        });

        // 2) 쓰기를 배치로 모아서 커밋
        const testWriteBatch = writeBatch(db);
        let testWriteCount = 0;
        for (const check of testTaskChecks) {
            if (!check) continue;
            const { item, action, taskDocId, existing } = check;
            const taskData = {
                student_id: studentId,
                student_name: student?.name || '',
                domain: item,
                type: action.type,
                source: 'test',
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
            batchSet(testWriteBatch, doc(db, 'test_fail_tasks', taskDocId), taskData, { merge: true });
            testWriteCount++;
            const idx = state.testFailTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                state.testFailTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                state.testFailTasks.push({ docId: taskDocId, ...taskData });
            }
        }
        if (testWriteCount > 0) await testWriteBatch.commit();

        // 삭제된 item의 pending tasks 취소
        const testCancelTargets = state.testFailTasks.filter(t => t.student_id === studentId && t.source_date === state.selectedDate && t.status === 'pending' && (!testFailAction[t.domain] || !testFailAction[t.domain].type));
        if (testCancelTargets.length > 0) {
            const cancelBatch = writeBatch(db);
            for (const t of testCancelTargets) {
                batchUpdate(cancelBatch, doc(db, 'test_fail_tasks', t.docId), {
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
        console.error('test_fail_action 저장 실패:', err);
        showSaveIndicator('error');
    }
}

export async function completeTestFailTask(taskDocId, studentId) {
    if (!confirm('완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'test_fail_tasks', taskDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const t = state.testFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '완료'; t.completed_by = completedBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

export async function cancelTestFailTask(taskDocId, studentId) {
    if (!confirm('취소 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'test_fail_tasks', taskDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const t = state.testFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '취소'; t.cancelled_by = cancelledBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
}

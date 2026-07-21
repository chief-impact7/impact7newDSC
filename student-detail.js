// student-detail.js — 학생 상세 패널 렌더링 모듈
//
// 분리 출처: daily-ops.js (cluster C, Step 4)
// Injection: `renderSubFilters`, `renderListPanel`, `_isNaesinClassCode`는 daily-ops.js에서 주입.

import { msIcon } from './ms-icon.js';
import {
    collection, getDocs, doc, getDoc,
    query, where, deleteField
} from 'firebase/firestore';
import { db } from './firebase-config.js';
import { deriveLevelPeriod } from '@impact7/shared/enrollment-derivation';
import { ENROLLABLE_STATUSES, isEnrollableStatus, STATUS_TONE } from '@impact7/shared/enrollment-status';
import { formatDateKST, toDate } from '@impact7/shared/datetime';
import { imeInputAttrs } from '@impact7/shared/ime-input';
import { staffLabel } from '@impact7/shared/staff-label';
import { schoolLevelGradeLabel } from '@impact7/shared/student-label';
import { ATTENDANCE_ACTIONS, normalizeAttendanceLabel } from '@impact7/shared/attendance-action';
import { state, LEAVE_STATUSES } from './state.js';
import {
    esc, escAttr, formatTime12h, renderTime12hSelect, oxChip,
    nowTimeStr, showSaveIndicator, showToast, _stripYear
} from './ui-utils.js';
import {
    enrollmentCode, findStudent,
    branchFromStudent, makeDailyRecordId,
    getActiveEnrollments, getStudentStartTime,
    allClassCodes, summarizeEnrollmentClasses, isValidDateStr,
    isNaesinActiveToday, deriveClassLabelAt, siblingStatusSuffix, isOnLeaveAt
} from './student-helpers.js';
import {
    currentSchool, studentGrade, studentShortLabel, todayStr, getDayName
} from './src/shared/firestore-helpers.js';
import { auditSet, READ_ONLY } from './audit.js';
import {
    getStudentDomains, getStudentTestItems, getClassDomains,
    getTeacherName, getStudentOverrides,
    saveDailyRecord, saveImmediately, searchStudentConsultations,
    loadStudentTenure
} from './data-layer.js';
import { isAttendedStatus } from './attendance.js';
import { renderClassBulkMessageTab } from './class-bulk-message.js';
import {
    renderHwFailActionCard, renderPendingTasksCard, openPersonalNextHwModal
} from './hw-management.js';
import { renderTestFailActionCard } from './test-management.js';
import {
    renderAbsenceRecordCard, _getExpandedAbsenceIndices, _restoreExpandedAbsenceIndices
} from './absence-records.js';
import { renderReturnConsultCard } from './leave-request.js';
import { normalizeStudentMemos } from './role-memo.js';
import { hasRecentRecord, splitRecordsByType } from './docu-records.js';
import { loadClassHistoryCard } from './class-history.js';
// 비활성 학생(퇴원·종강·상담 등) 식별용 — 출결현황 탭 라벨을 "수업이력"으로 동적 전환.
const _isInactiveDetailStudent = (s) => !ENROLLABLE_STATUSES.has(s?.status || '');

// 마스터 status → tone 배지 HTML (@impact7/shared STATUS_TONE 기반, DB와 동일 tone SSoT).
// 헤더에 출결 배지와 나란히 병기. status 없으면 빈 문자열.
const statusToneClass = (status) => STATUS_TONE[status] ? 'tone-' + STATUS_TONE[status] : '';
const statusToneBadgeHtml = (status) =>
    status ? `<span class="tag tag-master-status ${statusToneClass(status)}">${esc(status)}</span>` : '';

// ─── Injection slots (daily-ops.js → initStudentDetailDeps) ─────────────────
let renderSubFilters, renderListPanel, _isNaesinClassCode;

export function initStudentDetailDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    _isNaesinClassCode = deps._isNaesinClassCode;
}

// ─── Module-local state ─────────────────────────────────────────────────────
let _lastRenderedStudentId = null;
// 증분 렌더링용 — 직전에 detail-cards에 그린 카드 HTML. realtime 갱신에서 동일하면
// (같은 학생 동일성은 studentChanged 가드가 담당) innerHTML 교체·비동기 마운트를 건너뛴다.
let _lastCardsHtml = null;
let _renderConsultationFn = null;
let _renderMessageFn = null;
let _renderDocuFn = null;

// ─── 재원기간 (tenure) ───────────────────────────────────────────────────────
// history_logs에서 공유 deriveTenure로 파생해 헤더에 표시 (DB app.js와 동일 SSoT 로직).
// renderStudentDetail은 동기 렌더라 여기서 비동기 조회 후, 그 학생이 아직 선택돼 있을 때만 반영(stale 방지).

// Date → 'YYYY-MM-DD' (로컬 시간 기준, DB formatDate와 동일). 비정상 값은 '—'.
function _fmtTenureDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
    return formatDateKST(d);   // shared datetime SSoT (비-KST 환경 drift 방지)
}

// 재원기간 표시 문자열. start 없으면 '—'. END 규칙: end 있으면 퇴원일,
// 없고 status='종강'이면 status_changed_at(없으면 updated_at), 그 외(재원계열)면 '현재'.
function formatTenure(start, end, startEvent, student) {
    if (!start) return startEvent ? '등원예정' : '—';
    const startStr = _fmtTenureDate(start);
    let endStr;
    if (end) {
        endStr = _fmtTenureDate(end);
    } else if (student?.status === '종강') {
        const ts = student.status_changed_at || student.updated_at;
        const d = toDate(ts);
        endStr = d && !isNaN(d.getTime()) ? _fmtTenureDate(d) : '종강';
    } else {
        endStr = '현재';
    }
    return `${startStr} ~ ${endStr}`;
}

async function fillTenure(studentId, student) {
    const el = document.getElementById('detail-header-tenure');
    if (!el) return;
    el.textContent = '…';
    try {
        const { start, end, startEvent } = await loadStudentTenure(studentId, student.status);
        if (state.selectedStudentId !== studentId) return; // 그 사이 다른 학생 선택됨
        el.textContent = formatTenure(start, end, startEvent, student);
    } catch (e) {
        if (state.selectedStudentId !== studentId) return;
        console.warn('[TENURE] 재원기간 조회 실패:', e.code, e.message);
        el.textContent = '—';
    }
}

// ─── Checklist & Departure ──────────────────────────────────────────────────

export function getStudentChecklistStatus(studentId) {
    const rec = state.dailyRecords[studentId] || {};
    const items = [];

    // 1. 출석
    const attStatus = rec?.attendance?.status || '미확인';
    const isAttended = isAttendedStatus(attStatus);
    items.push({
        key: 'attendance',
        label: '출석',
        done: attStatus !== '미확인'
    });

    // 2. 숙제 1차 (미출석이면 데이터가 있어도 미완료 처리)
    const domains = isAttended ? getStudentDomains(studentId) : [];
    const hw1st = rec.hw_domains_1st || {};
    const hw1stFilled = isAttended && domains.some(d => hw1st[d]);
    items.push({
        key: 'hw_1st',
        label: '숙제 1차',
        done: hw1stFilled
    });

    // 3. 숙제 2차 (1차에서 미통과 있을 때만, 미출석이면 미완료)
    const hw1stFails = domains.filter(d => hw1st[d] && hw1st[d] !== 'O');
    if (isAttended && hw1stFails.length > 0) {
        const hw2nd = rec.hw_domains_2nd || {};
        const hw2ndFilled = hw1stFails.every(d => hw2nd[d]);
        items.push({
            key: 'hw_2nd',
            label: '숙제 2차',
            done: hw2ndFilled
        });
    }

    // 4. 테스트 1차 (미출석이면 미완료)
    const { flat: testItems } = isAttended ? getStudentTestItems(studentId) : { flat: [] };
    const t1st = rec.test_domains_1st || {};
    const t1stFilled = isAttended && testItems.some(t => t1st[t]);
    if (testItems.length > 0) {
        items.push({
            key: 'test_1st',
            label: '테스트 1차',
            done: t1stFilled
        });
    }

    // 5. 테스트 2차 (1차에서 미통과 있을 때만, 미출석이면 미완료)
    const t1stFails = testItems.filter(t => t1st[t] && t1st[t] !== 'O');
    if (isAttended && t1stFails.length > 0) {
        const t2nd = rec.test_domains_2nd || {};
        const t2ndFilled = t1stFails.every(t => t2nd[t]);
        items.push({
            key: 'test_2nd',
            label: '테스트 2차',
            done: t2ndFilled
        });
    }

    // 6. 미통과 처리 (2차 X/△/S 또는 1차 미통과+2차 미입력, 출석 학생만)
    if (isAttended) {
        const hw2nd = rec.hw_domains_2nd || {};
        const hwFailDomains = domains.filter(d => {
            const v2 = hw2nd[d] || '';
            if (v2 && v2 !== 'O') return true;
            if (hw1st[d] && hw1st[d] !== 'O' && !v2) return true;
            return false;
        });
        const t2nd = rec.test_domains_2nd || {};
        const testFailItems = testItems.filter(t => {
            const v2 = t2nd[t] || '';
            if (v2 && v2 !== 'O') return true;
            if (t1st[t] && t1st[t] !== 'O' && !v2) return true;
            return false;
        });
        if (hwFailDomains.length > 0 || testFailItems.length > 0) {
            const hwAction = rec.hw_fail_action || {};
            const testAction = rec.test_fail_action || {};
            const allHandled = hwFailDomains.every(d => hwAction[d]?.type) && testFailItems.every(t => testAction[t]?.type);
            items.push({
                key: 'fail_action',
                label: '미통과 처리',
                done: allHandled
            });
        }
    }

    // 7. 하원
    items.push({
        key: 'departure',
        label: ATTENDANCE_ACTIONS.departure,
        done: normalizeAttendanceLabel(rec.departure?.status) === ATTENDANCE_ACTIONS.departure
    });

    return items;
}

// 체크리스트 완료 캐시를 daily_records에 동기화(태블릿 하원 게이트용).
// 하원 항목 제외한 미완료가 0건이면 complete. 값이 바뀐 경우에만 저장(쓰기 폭주 방지).
async function syncChecklistCache(studentId, items) {
    const pending = items.filter(i => !i.done && i.key !== 'departure').map(i => i.label);
    const complete = pending.length === 0;
    const rec = state.dailyRecords[studentId] || {};
    const prevComplete = !!rec.checklist_complete;
    const prevPending = Array.isArray(rec.checklist_pending) ? rec.checklist_pending : [];
    const samePending = prevPending.length === pending.length && prevPending.every((v, i) => v === pending[i]);
    if (prevComplete === complete && samePending) return; // 변경 없음 → 스킵
    // saveImmediately가 state.dailyRecords[studentId]까지 갱신·에러 처리한다.
    // silent: 단순 조회 시 백그라운드 캐시 backfill이라 "저장 완료" 인디케이터를 띄우지 않는다.
    await saveImmediately(studentId, { checklist_complete: complete, checklist_pending: pending }, { silent: true });
}

function renderChecklistCard(studentId) {
    // 순수 렌더 — 캐시 동기화(syncChecklistCache)는 렌더 side-effect로 매 틱 호출되면
    // "렌더→write→onSnapshot→렌더" 결합을 만들므로, 실제 카드 갱신 시에만 별도로 호출한다(M-15).
    const items = getStudentChecklistStatus(studentId);
    const doneCount = items.filter(i => i.done).length;
    const total = items.length;
    const allDone = doneCount === total;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    const rec = state.dailyRecords[studentId] || {};
    const departure = rec.departure || {};
    const isDeparted = normalizeAttendanceLabel(departure.status) === ATTENDANCE_ACTIONS.departure;

    // Non-departure items that are not done
    const pendingItems = items.filter(i => !i.done && i.key !== 'departure');
    const canDepart = pendingItems.length === 0;

    let departureSection = '';
    if (isDeparted) {
        departureSection = `
            <button class="departure-btn departed" disabled>
                ${msIcon('check_circle', '', 'style="font-size:16px;"')}
                하원 완료 (${formatTime12h(departure.time || '')})
            </button>`;
    } else if (canDepart) {
        departureSection = `
            <button class="departure-btn ready" onclick="confirmDeparture('${escAttr(studentId)}')">
                ${msIcon('logout', '', 'style="font-size:16px;"')}
                하원 확인
            </button>`;
    } else {
        departureSection = `
            <button class="departure-btn not-ready" onclick="confirmDeparture('${escAttr(studentId)}')">
                ${msIcon('logout', '', 'style="font-size:16px;"')}
                하원 확인 (미완료 ${pendingItems.length}건)
            </button>`;
    }

    const parentMsgBtn = `
        <button class="departure-btn not-ready" style="margin-top:6px;background:#f3e8ff;color:#7c3aed;border:1px solid #e9d5ff;"
            onclick="event.stopPropagation(); openParentMessageModal('${escAttr(studentId)}')">
            ${msIcon('sms', '', 'style="font-size:16px;"')}
            학부모 알림 작성
        </button>`;

    return `
        <div class="checklist-card">
            <div class="checklist-progress">
                <div class="checklist-progress-bar">
                    <div class="checklist-progress-fill ${allDone ? 'complete' : ''}" style="width:${pct}%"></div>
                </div>
                <span class="checklist-progress-text">${doneCount}/${total}</span>
            </div>
            <div class="checklist-items">
                ${items.filter(i => i.key !== 'departure').map(i => `
                    <span class="checklist-item ${i.done ? 'done' : ''}">
                        ${msIcon(i.done ? 'check_circle' : 'radio_button_unchecked', 'checklist-icon')}
                        ${esc(i.label)}
                    </span>
                `).join('')}
            </div>
            ${departureSection}
            ${parentMsgBtn}
        </div>`;
}

export async function confirmDeparture(studentId) {
    const rec = state.dailyRecords[studentId] || {};
    const items = getStudentChecklistStatus(studentId);
    const pendingItems = items.filter(i => !i.done && i.key !== 'departure');

    let reason = '';
    if (pendingItems.length > 0) {
        const pendingLabels = pendingItems.map(i => i.label).join(', ');
        reason = prompt(`미완료 항목: ${pendingLabels}\n\n미완료 사유를 입력하세요:`);
        if (reason === null) return; // 취소
        if (!reason.trim()) {
            alert('미완료 사유를 입력해주세요.');
            return;
        }
    }

    showSaveIndicator('saving');
    try {
        const departure = {
            status: ATTENDANCE_ACTIONS.departure,
            time: nowTimeStr(),
            confirmed_by: staffLabel(state.currentUser?.email),
            confirmed_at: new Date().toISOString()
        };
        if (reason) {
            departure.incomplete_reason = reason.trim();
            departure.incomplete_items = pendingItems.map(i => i.label);
        }

        await saveImmediately(studentId, { departure });
        if (!state.dailyRecords[studentId]) {
            state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
        }
        state.dailyRecords[studentId].departure = departure;

        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('하원 확인 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Student Detail Panel ───────────────────────────────────────────────────

function buildStayStatsHtml(student) {
    const enrollments = (student.enrollments || []).filter(e => e.level_symbol || e.start_date);
    if (!enrollments.length) return '';

    // 헤더 기간 = 재원기간(이력 기반 deriveTenure, fillTenure가 비동기로 채움). 레벨기간은 등원 일정 카드.
    return `
        <div class="stay-period">
            <span class="stay-period-label">재원기간</span>
            <span class="stay-period-value" id="detail-header-tenure">…</span>
        </div>
    `;
}

// ─── 출결현황 탭 ──────────────────────────────────────────────────────────────

function _ensureReportInputDefaults() {
    const startEl = document.getElementById('report-start');
    const endEl = document.getElementById('report-end');
    if (!startEl || !endEl) return;
    if (startEl.value && endEl.value) return;
    const today = new Date();
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    if (!startEl.value) startEl.value = formatDateKST(monthAgo);
    if (!endEl.value) endEl.value = formatDateKST(today);
}

// 탭 모듈은 동적 import로 로드한다. 청크 로드 실패(stale-chunk)는 app.js의 전역
// vite:preloadError 핸들러가 자동 새로고침으로 처리하므로 호출부에 .catch를 두지 않는다.
export function switchDetailTab(tab) {
    state.detailTab = tab;
    document.querySelectorAll('.detail-tab').forEach(t => {
        const isActive = t.dataset.tab === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', String(isActive)); // role="tab" 선택 상태 노출
    });
    document.getElementById('detail-cards').style.display = tab === 'daily' ? '' : 'none';
    document.getElementById('report-tab').style.display = tab === 'report' ? '' : 'none';
    document.getElementById('score-tab').style.display = tab === 'score' ? '' : 'none';
    document.getElementById('consultation-tab').style.display = tab === 'consultation' ? '' : 'none';
    document.getElementById('message-tab').style.display = tab === 'message' ? '' : 'none';
    const docuTabEl = document.getElementById('docu-tab');
    if (docuTabEl) docuTabEl.style.display = tab === 'docu' ? '' : 'none';
    if (tab === 'score') {
        if (state.selectedStudentId) _openedDetailTabs.add(`${state.selectedStudentId}:score`);
        loadScoreCard();
    }
    if (tab === 'report') {
        if (state.selectedStudentId) _loadReportOrHistoryCard(state.selectedStudentId);
    }
    if (tab === 'consultation') {
        if (state.selectedStudentId) _openedDetailTabs.add(`${state.selectedStudentId}:consultation`);
        if (_renderConsultationFn) {
            _renderConsultationFn(state.selectedStudentId);
            return;
        }
        import('./consultation-card.js').then(({ renderConsultationTab, initConsultationCardDeps }) => {
            initConsultationCardDeps({
                getStudent: (id) => findStudent(id),
                getCurrentTeacher: () => ({
                    id: state.currentUser?.uid ?? '',
                    name: getTeacherName(state.currentUser?.email ?? ''),
                }),
                getAssignedTeachers: (id) => {
                    const student = findStudent(id);
                    if (!student) return [];
                    const emails = new Set();
                    for (const code of allClassCodes(student)) {
                        const cs = state.classSettings?.[code];
                        if (cs?.teacher) emails.add(cs.teacher);
                        if (cs?.sub_teacher) emails.add(cs.sub_teacher);
                    }
                    return [...emails].map(e => getTeacherName(e)).filter(Boolean);
                },
                toast: (msg) => showToast(msg),
                readonly: READ_ONLY,
            });
            _renderConsultationFn = renderConsultationTab;
            renderConsultationTab(state.selectedStudentId);
        });
    }
    if (tab === 'message') {
        // 소속반 뷰(학생 미선택 + L4 반 선택): 개인 메시지 대신 반 단체 안내 탭
        if (!state.selectedStudentId && state.selectedClassCode && state.selectedBranchLevel) {
            renderClassBulkMessageTab(state.selectedClassCode);
            return;
        }
        if (_renderMessageFn) {
            _renderMessageFn(state.selectedStudentId);
            return;
        }
        import('./message-card.js').then(({ renderMessageTab, initMessageCardDeps }) => {
            initMessageCardDeps({
                getStudent: (id) => findStudent(id),
                toast: (msg, type) => showToast(msg, type),
                readonly: READ_ONLY,
            });
            _renderMessageFn = renderMessageTab;
            renderMessageTab(state.selectedStudentId);
        });
    }
    if (tab === 'docu') {
        if (_renderDocuFn) {
            _renderDocuFn(state.selectedStudentId);
            return;
        }
        import('./docu-card.js').then(({ renderDocuTab, initDocuCardDeps }) => {
            initDocuCardDeps({
                toast: (msg, type) => showToast(msg, type),
                readonly: READ_ONLY,
                refreshBadge: (id) => _refreshDocuBadge(id),
            });
            _renderDocuFn = renderDocuTab;
            renderDocuTab(state.selectedStudentId);
        });
    }
}

// 상세 탭 뱃지 — 학생 전환 시 기록·상담·성적 탭에 2주 이내 새 항목 알림(점)을 표시.
// 탭을 안 열어도 보이게 학생 전환마다 1회씩만 조회한다. 모든 비동기는 _badgeStudentId로 stale 가드.
let _badgeStudentId = null;
// 상담·성적 뱃지는 비용(쿼리·getDoc)이 커서 그 탭을 한 번이라도 연 학생만 계산한다.
// 세션 내 `${studentId}:${tab}` 기록 — switchDetailTab에서 등록.
const _openedDetailTabs = new Set();
function _setTabBadge(tab, show) {
    const btn = document.querySelector(`.detail-tab[data-tab="${tab}"]`);
    if (btn) btn.classList.toggle('has-badge', !!show);
}

// 기록 탭: 대기중 요청서 | 최근(14일) 요청서 | 최근 반성문·기타 | 최근 메모(student.memo created_at).
function _refreshDocuBadge(studentId) {
    _badgeStudentId = studentId;
    _setTabBadge('docu', false); // 학생 전환 시 일단 제거
    if (!studentId) return;
    const now = Date.now();
    const student = findStudent(studentId);
    // 대기중(승인 진행 중) 휴/퇴원 요청서는 기간과 무관하게 뱃지 대상
    const lrs = (state.leaveRequests || []).filter(lr => lr.student_id === studentId);
    const hasPendingLR = lrs.some(lr => lr.status === 'requested');
    // 메모는 동기 판정. 단 화면 메모 카드에 실제 표시되는 메모(고정 또는 선택일 메모)만 대상 —
    // 지난 비고정 메모는 카드에 안 보이므로 뱃지 오탐을 막는다.
    const visibleMemos = student
        ? normalizeStudentMemos(student).filter(m => m.pinned || m.date === state.selectedDate)
        : [];
    const memosRecent = hasRecentRecord(visibleMemos, now);
    import('./docu-data.js')
        .then(data => data.listStudentRecords(studentId))
        .then(records => {
            if (_badgeStudentId !== studentId) return; // stale 방지
            // 화면 기록 탭(splitRecordsByType)은 reflection/etc만 표시 → 뱃지도 그 둘만 본다.
            const { reflections, etc } = splitRecordsByType(records);
            const show = hasPendingLR || memosRecent
                || hasRecentRecord(lrs, now)
                || hasRecentRecord([...reflections, ...etc], now);
            _setTabBadge('docu', show);
        })
        .catch(err => console.warn('[badge] 기록 뱃지 갱신 실패:', err));
}

// 상담 탭: date(상담일)·created_at이 14일 이내인 상담이 있으면. date 범위 쿼리로 가볍게 1회 조회.
function _refreshConsultationBadge(studentId) {
    _badgeStudentId = studentId;
    _setTabBadge('consultation', false);
    if (!studentId) return;
    const now = Date.now();
    const startDate = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    searchStudentConsultations(studentId, { startDate, limitCount: 1 })
        .then(rows => {
            if (_badgeStudentId !== studentId) return;
            // consultations의 date/created_at을 isRecentRecord의 occurred_at/created_at에 매핑해 재사용.
            const mapped = rows.map(c => ({ occurred_at: c.date, created_at: c.created_at }));
            _setTabBadge('consultation', hasRecentRecord(mapped, now));
        })
        .catch(err => console.warn('[badge] 상담 뱃지 갱신 실패:', err));
}

// 성적 탭: academy/external 항목의 시험일(date) 또는 요약 updated_at이 14일 이내면. 요약 1회 조회.
function _refreshScoreBadge(studentId) {
    _badgeStudentId = studentId;
    _setTabBadge('score', false);
    if (!studentId) return;
    const now = Date.now();
    getDoc(doc(db, 'student_scores', studentId))
        .then(snap => {
            if (_badgeStudentId !== studentId) return;
            const sdata = snap.exists() ? snap.data() : {};
            const cands = [];
            // 화면에 실제 행이 그려지는 항목의 시험일(date)만 본다(요약 updated_at은 빈 요약도
            // 최근이라 오탐 → 제외). academy·수능인덱스는 화면이 필터 없이 다 표시한다.
            for (const a of Object.values(sdata.academy || {})) cands.push({ occurred_at: a?.date });
            for (const e of Object.values(sdata.external || {})) {
                // 학교내신·모의고사는 화면(buildExternalRows)이 무점수 placeholder를 제외하므로 뱃지도 동일 판정.
                if ((e?.type === 'school' || e?.type === 'mock') && !externalScoreIsMeaningful(e?.score, e?.type)) continue;
                cands.push({ occurred_at: e?.date || e?.event?.date });
            }
            _setTabBadge('score', hasRecentRecord(cands, now));
        })
        .catch(err => console.warn('[badge] 성적 뱃지 갱신 실패:', err));
}

// 학생 전환 시 기록·상담·성적 뱃지를 한 번에 갱신.
function _refreshDetailBadges(studentId) {
    _refreshDocuBadge(studentId);
    // 상담·성적은 그 탭을 한 번이라도 연 학생만 계산(읽기 비용 절감).
    // 안 연 학생은 계산을 건너뛰되, 이전 학생의 점이 남지 않도록 명시적으로 끈다.
    if (_openedDetailTabs.has(`${studentId}:consultation`)) _refreshConsultationBadge(studentId);
    else _setTabBadge('consultation', false);
    if (_openedDetailTabs.has(`${studentId}:score`)) _refreshScoreBadge(studentId);
    else _setTabBadge('score', false);
}

// role-memo.js가 메모 CRUD 후 기록 뱃지를 갱신할 수 있도록 공개.
export { _refreshDocuBadge as refreshDocuBadge };

// 비활성 학생: 출결현황 대신 수업이력(history_logs, DB와 동일한 7종 분류) 로드.
// 활성 학생: 기존 출결현황 로드 (날짜 범위 입력 유지).
function _loadReportOrHistoryCard(studentId) {
    const student = findStudent(studentId);
    const dateRangeEl = document.querySelector('#report-tab .report-date-range');
    if (student && _isInactiveDetailStudent(student)) {
        if (dateRangeEl) dateRangeEl.style.display = 'none';
        loadClassHistoryCard(studentId);
    } else {
        if (dateRangeEl) dateRangeEl.style.display = '';
        _ensureReportInputDefaults();
        loadReportCard(studentId);
    }
}

// studentId 인자 우선(생략 시 현재 선택 학생). 상단 프로필과 동일 학생의 출결을 그리고,
// getDocs 후 stale 가드로 빠른 학생 전환 시 구학생 데이터가 신학생 라벨로 그려지는 것 차단.
export async function loadReportCard(studentId = state.selectedStudentId) {
    if (!studentId) return;

    const startDate = document.getElementById('report-start').value;
    const endDate = document.getElementById('report-end').value;
    if (!startDate || !endDate) {
        alert('시작일과 종료일을 모두 입력해주세요.');
        return;
    }
    if (startDate > endDate) {
        alert('시작일이 종료일보다 늦습니다.');
        return;
    }

    const contentEl = document.getElementById('report-content');
    contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">조회 중...</div>';

    try {
        const q = query(
            collection(db, 'daily_records'),
            where('student_id', '==', studentId),
            where('date', '>=', startDate),
            where('date', '<=', endDate)
        );
        const snap = await getDocs(q);
        // 조회 중 다른 학생으로 전환됐으면 구학생 레코드를 신학생 라벨로 그리지 않도록 폐기.
        if (state.selectedStudentId !== studentId) return;
        const records = [];
        snap.forEach(d => records.push(d.data()));
        records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        renderReportCard(records);
    } catch (err) {
        console.error('출결현황 조회 실패:', err);
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">조회 실패: ' + esc(err.message) + '</div>';
    }
}

function aggregateOX(records, prefix) {
    const domains = new Set();
    records.forEach(rec => {
        Object.keys(rec[`${prefix}_domains_1st`] || {}).forEach(d => domains.add(d));
        Object.keys(rec[`${prefix}_domains_2nd`] || {}).forEach(d => domains.add(d));
    });

    const stats = {};
    domains.forEach(d => { stats[d] = { O: 0, '△': 0, X: 0 }; });
    records.forEach(rec => {
        domains.forEach(d => {
            const val = (rec[`${prefix}_domains_2nd`]?.[d]) || (rec[`${prefix}_domains_1st`]?.[d]) || '';
            if (val === 'O' || val === '△' || val === 'X') {
                stats[d][val]++;
            }
        });
    });
    return stats;
}

function renderReportCard(records) {
    const contentEl = document.getElementById('report-content');

    if (records.length === 0) {
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">해당 기간에 기록이 없습니다.</div>';
        return;
    }

    // ── 출석 집계 ──
    const student = state.allStudents.find(s => s.docId === state.selectedStudentId);
    const attendanceRows = records.flatMap(rec => {
        const date = rec.date || '';
        const dayName = date ? getDayName(date) : '';
        const status = rec.attendance?.status || '';
        const reason = rec.attendance?.reason || '';
        // 저장 시점 스냅샷(class_label) 우선 — 내신반 삭제·기간 변경 후에도 과거 표시가
        // 보존된다. 스냅샷 없는 옛 기록만 현재 설정으로 역산(fallback).
        const classLabel = rec.class_label || (student && date ? deriveClassLabelAt(student, date) : '');
        const classTypes = classLabel.split('/');
        const hasTeukang = rec.visit2
            || (classTypes.includes('특강') && classTypes.length > 1);
        if (!hasTeukang) return [{ date, dayName, status, reason, classLabel }];
        const mainClassLabel = classTypes.filter(label => label !== '특강').join('/') || classLabel;
        return [
            { date, dayName, status, reason, classLabel: mainClassLabel },
            { date, dayName, status: rec.visit2?.status || '', reason: rec.visit2?.reason || '', classLabel: '특강' },
        ];
    }).filter(r => r.date);
    const attendanceDayCount = new Set(attendanceRows.map(r => r.date)).size;

    const attendanceHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('event_available', '', 'style="color:var(--primary);font-size:18px;"')}
                출석 (${attendanceDayCount}일)
            </div>
            <table class="report-attendance-table">
                <thead><tr><th>날짜</th><th>유형</th><th>구분</th><th>비고</th></tr></thead>
                <tbody>
                    ${attendanceRows.map(r => {
                        const dateShort = r.date.slice(5).replace('-', '/');
                        const cls = r.status === '출석' ? 'att-present' :
                                    r.status === '결석' ? 'att-absent' :
                                    r.status === '지각' ? 'att-late' :
                                    r.status === '보충' ? 'att-makeup' : '';
                        // 출결 미입력이지만 휴원기간에 걸린 날은 '-' 대신 '휴원' 표기.
                        const division = r.status || (student && isOnLeaveAt(student, r.date) ? '휴원' : '-');
                        return `<tr>
                            <td>${esc(dateShort)}(${esc(r.dayName)})</td>
                            <td>${esc(r.classLabel || '-')}</td>
                            <td class="${cls}">${esc(division)}</td>
                            <td>${esc(r.reason)}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    // ── 숙제 O/△/X 집계 ──
    const hwStats = aggregateOX(records, 'hw');

    // ── 테스트 O/△/X 집계 ──
    const testStats = aggregateOX(records, 'test');

    const renderOxSection = (title, icon, stats) => {
        const domains = Object.keys(stats);
        if (domains.length === 0) return '';
        return `
            <div class="report-ox-section">
                <div class="report-ox-title">
                    ${msIcon(icon, '', 'style="font-size:16px;vertical-align:middle;"')}
                    ${esc(title)}
                </div>
                ${domains.map(d => {
                    const s = stats[d];
                    return `<div class="report-ox-row">
                        <span class="report-ox-label">${esc(d)}</span>
                        <span class="report-ox-val report-ox-o">O:${s.O}</span>
                        <span class="report-ox-val report-ox-t">△:${s['△']}</span>
                        <span class="report-ox-val report-ox-x">X:${s.X}</span>
                    </div>`;
                }).join('')}
            </div>
        `;
    };

    const oxGridHtml = (Object.keys(hwStats).length > 0 || Object.keys(testStats).length > 0) ? `
        <div class="report-ox-grid">
            ${renderOxSection('숙제', 'assignment', hwStats)}
            ${renderOxSection('테스트', 'quiz', testStats)}
        </div>
    ` : '';

    contentEl.innerHTML = attendanceHtml + oxGridHtml;
}

function scoreDateText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    // toISOString()은 UTC라 KST 자정 근처 Timestamp를 하루 앞으로 표시 → formatDateKST 사용(LOW).
    if (typeof value.toDate === 'function') return formatDateKST(value.toDate());
    if (value.seconds) return formatDateKST(new Date(value.seconds * 1000));
    return '';
}

function scoreNum(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value * 10) / 10
        : null;
}

function scoreValue(value) {
    const n = scoreNum(value);
    return n == null ? '—' : String(n);
}

function scoreHalfNum(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value * 2) / 2
        : null;
}

function scoreHalfValue(value) {
    const n = scoreHalfNum(value);
    return n == null ? '—' : String(n);
}

function finalScoreValue(result) {
    return result && Object.prototype.hasOwnProperty.call(result, 'finalScore')
        ? scoreValue(result.finalScore)
        : '—';
}

function departmentTotalPoints(department) {
    const configured = Number(department?.examConfig?.totalPoints);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const domainTotal = (department?.domains || []).reduce((sum, domain) => {
        const points = Number(domain?.totalPoints);
        return Number.isFinite(points) ? sum + points : sum;
    }, 0);
    return domainTotal > 0 ? domainTotal : 100;
}

function reportScoreValue(result, department) {
    if (!result) return '—';
    if (Object.prototype.hasOwnProperty.call(result, 'reportScore')) {
        return scoreHalfValue(result.reportScore);
    }
    return Object.prototype.hasOwnProperty.call(result, 'finalScore')
        ? scoreHalfValue((Number(result.finalScore) / departmentTotalPoints(department)) * 100)
        : '—';
}

function scoreLink(url, label = '보기') {
    return url
        ? `<a class="score-link" href="${escAttr(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>`
        : '—';
}

function shortDomainName(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    if (text.length <= 4 || text.includes('/')) return text;
    return text[0];
}

function renderDomainScores(result, department) {
    const scores = result.finalDomainScores || {};
    const domains = department?.domains || [];
    if (domains.length === 0) return '—';

    const items = domains
        .map(domain => {
            const value = scoreHalfNum(scores[domain.id]);
            if (value == null) return '';
            const label = shortDomainName(domain.name);
            return `<span class="score-domain-chip" title="${escAttr(domain.name)}">${esc(label)} ${esc(String(value))}</span>`;
        })
        .filter(Boolean);

    return items.length ? `<div class="score-domain-list">${items.join('')}</div>` : '—';
}

function renderScoreTable(title, icon, rows, emptyText, columns) {
    return `
        <div class="detail-card score-card">
            <div class="detail-card-title">
                ${msIcon(icon, '', 'style="color:var(--primary);font-size:18px;"')}
                ${esc(title)}
            </div>
            ${rows.length === 0 ? `<div class="detail-card-empty">${esc(emptyText)}</div>` : `
                <div class="score-row-list">
                    ${rows.map(row => `
                        <div class="score-row-card">
                            <div class="score-row-head">
                                <div class="score-row-title">${row.title ?? '—'}</div>
                                ${row.date ? `<div class="score-row-date">${row.date}</div>` : ''}
                            </div>
                            <div class="score-row-fields">
                                ${columns
                                    .filter(c => c.key !== 'title' && c.key !== 'date')
                                    .map(c => `
                                        <div class="score-row-field ${c.wide ? 'wide' : ''}">
                                            <span class="score-row-label">${esc(c.label)}</span>
                                            <span class="${c.align === 'right' ? 'score-cell-num' : ''}">${row[c.key] ?? '—'}</span>
                                        </div>
                                    `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        </div>
    `;
}

function externalEventLabel(event) {
    if (event.type === 'school') {
        const label = schoolLevelGradeLabel({ school: event.school, level: event.level, grade: event.grade });
        return `${event.year || ''} ${label} ${event.semester || ''}학기 ${event.examName || ''}`.replace(/\s+/g, ' ').trim();
    }
    if (event.type === 'suneung_index') {
        return `${event.year || ''} ${event.month || ''}월 수능인덱스`.replace(/\s+/g, ' ').trim();
    }
    return `${event.year || ''} ${event.month || ''}월 모의고사 ${event.grade ? `${event.grade}학년` : ''}`.replace(/\s+/g, ' ').trim();
}

// student_scores/{studentId} 요약 raw → 화면 row. 점수 해석은 기존 헬퍼 재사용(계산 위치 불변). F-11.
// (과거 results/external_score_events N+1 조회 → Cloud Function이 비정규화한 요약 1회 읽기로 전환)
function buildAcademyRows(academy, departmentsById) {
    return Object.values(academy || {}).map(a => {
        const department = departmentsById.get(a.deptId);
        return {
            title: esc(a.title || '진단평가'),
            date: esc(scoreDateText(a.date) || ''),
            score: esc(reportScoreValue(a.result, department)),
            domains: renderDomainScores(a.result, department),
        };
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function buildSuneungRows(entries) {
    return entries.map(({ event, score: s }) => ({
        title: esc(`${event.year || ''} ${event.month || ''}월 수능인덱스`.replace(/\s+/g, ' ').trim()),
        date: esc(event.date || event.updatedAt || ''),
        raw: esc(s.rawScore != null ? String(s.rawScore) : '—'),
        index: esc('준비 중'),
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// 외부 성적(학교내신·모의고사) 항목에 의미있는 점수/등급/성적표/메모가 있는지 — 화면 행 생성
// (buildExternalRows)과 성적 뱃지가 공유하는 단일 판정(SSoT). 무점수 placeholder는 양쪽 모두 제외.
function externalScoreIsMeaningful(s, type) {
    return scoreNum(s?.predictedScore) != null || scoreNum(s?.finalScore) != null
        || !!s?.predictedGrade || !!s?.finalGrade || !!s?.reportImageUrl
        || (type === 'mock' && (scoreNum(s?.percentile) != null || scoreNum(s?.standardScore) != null))
        || (type === 'school' && !!s?.memo);
}

function buildExternalRows(entries, type) {
    return entries.map(({ event, score: s }) => {
        // 점수/등급/성적표/메모가 하나도 없는 placeholder 응시 등록은 제외(빈 행 방지).
        if (!externalScoreIsMeaningful(s, type)) return null;
        const diff = scoreNum(s.finalScore) != null && scoreNum(s.predictedScore) != null
            ? scoreNum(s.finalScore - s.predictedScore)
            : null;
        const isSchool = type === 'school';
        const examNameOrder = ({ '중간': '1', '기말': '2' })[event.examName] || event.examName || '';
        const gradeKey = String(event.grade || '').padStart(2, '0');
        const sortKey = isSchool
            ? `${event.year || ''}-${gradeKey}-${event.semester || ''}-${examNameOrder}`
            : (event.date || event.updatedAt || '');
        return {
            title: esc(externalEventLabel(event) || event.title || ''),
            predicted: esc(scoreValue(s.predictedScore)),
            final: esc(scoreValue(s.finalScore)),
            diff: esc(diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff}`),
            grade: esc([s.predictedGrade, s.finalGrade].filter(Boolean).join(' → ') || '—'),
            extra: type === 'mock'
                ? esc([
                    s.percentile != null ? `백분위 ${scoreValue(s.percentile)}` : '',
                    s.standardScore != null ? `표준 ${scoreValue(s.standardScore)}` : '',
                ].filter(Boolean).join(', ') || '—')
                : esc(s.memo || '—'),
            report: scoreLink(s.reportImageUrl, s.reportImageName || '성적표'),
            date: isSchool ? '' : (event.date || event.updatedAt || ''),
            _sortKey: sortKey,
        };
    }).filter(Boolean).sort((a, b) => (b._sortKey || '').localeCompare(a._sortKey || ''));
}

// studentId 인자 우선 — renderStudentDetail이 그리는 상단 프로필과 동일 학생으로 점수를
// 채우기 위함(인자 생략 시 현재 선택 학생). selectedStudentId만 읽으면 상단≠점수 불일치 가능.
export async function loadScoreCard(studentId = state.selectedStudentId) {
    if (!studentId) return;

    const contentEl = document.getElementById('score-content');
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">성적을 불러오는 중...</div>';

    try {
        // student_scores/{studentId} 요약 1회 + departments 1회로 4개 섹션을 구성한다(과거 N+1 제거). F-11.
        const [scoreSnap, deptSnap] = await Promise.all([
            getDoc(doc(db, 'student_scores', studentId)),
            getDocs(collection(db, 'departments')),
        ]);
        if (state.selectedStudentId !== studentId) return;
        const sdata = scoreSnap.exists() ? scoreSnap.data() : {};
        const departmentsById = new Map();
        deptSnap.forEach(d => departmentsById.set(d.id, d.data()));
        const externalAll = Object.values(sdata.external || {});
        const academyRows = buildAcademyRows(sdata.academy, departmentsById);
        const suneungRows = buildSuneungRows(externalAll.filter(e => e.type === 'suneung_index'));
        const schoolRows = buildExternalRows(externalAll.filter(e => e.type === 'school'), 'school');
        const mockRows = buildExternalRows(externalAll.filter(e => e.type === 'mock'), 'mock');

        const academyHtml = renderScoreTable('진단평가', 'bar_chart', academyRows, '진단평가 결과가 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'date', label: '일자' },
            { key: 'score', label: '최종', align: 'right' },
            { key: 'domains', label: '영역', wide: true },
        ]);
        const suneungHtml = renderScoreTable('수능인덱스', 'insights', suneungRows, '수능인덱스 기록이 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'date', label: '일자' },
            { key: 'raw', label: '원점수', align: 'right' },
            { key: 'index', label: '수능인덱스', align: 'right' },
        ]);
        const schoolHtml = renderScoreTable('학교내신', 'school', schoolRows, '학교내신 성적 기록이 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'predicted', label: '예상', align: 'right' },
            { key: 'final', label: '확정', align: 'right' },
            { key: 'diff', label: '차이', align: 'right' },
            { key: 'grade', label: '등급' },
            { key: 'report', label: '성적표' },
            { key: 'extra', label: '메모', wide: true },
        ]);
        const mockHtml = renderScoreTable('모의고사', 'fact_check', mockRows, '모의고사 성적 기록이 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'predicted', label: '예상', align: 'right' },
            { key: 'final', label: '확정', align: 'right' },
            { key: 'diff', label: '차이', align: 'right' },
            { key: 'grade', label: '등급' },
            { key: 'report', label: '성적표' },
            { key: 'extra', label: '부가', wide: true },
        ]);

        contentEl.innerHTML = `<div class="score-tab-content">${academyHtml}${suneungHtml}${schoolHtml}${mockHtml}</div>`;
    } catch (err) {
        console.error('성적 조회 실패:', err);
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">성적 조회 실패: ' + esc(err.message) + '</div>';
    }
}

function renderTempClassOverrideCard(studentId) {
    const overrides = getStudentOverrides(studentId, state.selectedDate);
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return '';

    const listHtml = overrides.length > 0 ? overrides.map(o => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:var(--surface);border-radius:6px;">
            <span style="font-size:13px;font-weight:600;">${esc(o.override_date)}</span>
            <span style="font-size:12px;color:var(--text-sec);">${esc(o.original_class_code)} → ${esc(o.target_class_code)}</span>
            ${o.reason ? `<span style="font-size:11px;color:var(--text-third);">(${esc(o.reason)})</span>` : ''}
            <button class="btn btn-sm" style="margin-left:auto;color:var(--danger);padding:2px 6px;" onclick="cancelTempClassOverride('${escAttr(o.docId)}', '${escAttr(studentId)}')">취소</button>
        </div>
    `).join('') : '<div style="font-size:12px;color:var(--text-sec);padding:4px 0;">등록된 타반수업 없음</div>';

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('swap_horiz', '', 'style="color:var(--warning);font-size:18px;"')}
                타반수업
            </div>
            ${listHtml}
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openTempClassOverrideModal('${escAttr(studentId)}')">
                ${msIcon('add', '', 'style="font-size:14px;"')} 타반수업 추가
            </button>
        </div>
    `;
}

export function renderStudentDetail(studentId, { incremental = false } = {}) {
    // detail 영역이 DOM에 미렌더 상태면 (학생 detail 미열림 + realtime refresh 등) skip — null 안전망
    if (!document.getElementById('profile-avatar')) return;
    const studentChanged = studentId !== _lastRenderedStudentId;
    // 다른 학생으로 이동할 때 pending 클리닉 플래그 해제
    if (studentChanged) {
        state._pendingClinicStudentId = null;
    }
    _lastRenderedStudentId = studentId;

    // 학생 전환 + 출결/수업이력 탭 활성 시 자동 재조회 (활성=출결, 비활성=수업이력)
    if (studentChanged && studentId && state.detailTab === 'report') {
        _loadReportOrHistoryCard(studentId);
    }

    // 상세 탭 뱃지 — 학생 전환 시 기록·상담·성적 2주 이내 새 항목 여부로 갱신(탭을 안 열어도 보이게)
    if (studentChanged) _refreshDetailBadges(studentId);

    if (!studentId) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        // 빈 상태에서 좁은 화면 오버레이 클래스가 남으면 리사이즈 시 빈 패널이 화면을 덮는다
        document.getElementById('detail-panel').classList.remove('mobile-visible');
        return;
    }

    // 결석대장 카드 expanded 상태 보존
    const expandedAbsenceIndices = _getExpandedAbsenceIndices();

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const student = findStudent(studentId);
    if (!student) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        document.getElementById('detail-panel').classList.remove('mobile-visible');
        return;
    }

    const profileSummaryEl = document.getElementById('profile-academic-summary');
    if (profileSummaryEl) {
        const date = state.selectedDate || todayStr();
        const rawEnrollments = student.enrollments || [];
        const isInactiveStudent = _isInactiveDetailStudent(student);
        const relevantEnrollments = isInactiveStudent
            ? []
            : rawEnrollments.filter(e =>
                !(isValidDateStr(e.start_date) && e.start_date > date) &&
                !(isValidDateStr(e.end_date) && e.end_date < date)
            );
        const derivedEnrollments = isInactiveStudent ? [] : getActiveEnrollments(student, date)
            .filter(e => e.class_type !== '정규');
        const classes = summarizeEnrollmentClasses([...relevantEnrollments, ...derivedEnrollments]);
        profileSummaryEl.innerHTML = [
            studentShortLabel(student),
            classes.regular ? `정규 ${classes.regular}` : '',
            classes.other,
        ].filter(Boolean).map(line => `<div>${esc(line.length > 10 ? `${line.slice(0, 9)}…` : line)}</div>`).join('');
    }

    // 특강 모드: 특강 전용 상세 패널 (반 비소속 학생이면 false 반환 → 표준 상세로 계속)
    const searching = !!state.searchQuery?.trim();
    if (!searching && state._classMgmtMode === 'teukang' && state.selectedClassCode) {
        if (window.renderTeukangDetail?.(studentId)) return;
    }

    // 내신 모드: naesin.js로 위임 (간소화된 상세 패널)
    // 특강 모드에서 폴백된 학생은 잔존 naesin 서브필터에 걸리지 않고 표준 상세로 가야 함
    if (!searching && ((state.currentCategory === 'attendance' && state.currentSubFilter.has('naesin') && state._classMgmtMode !== 'teukang') ||
        (state._classMgmtMode === 'naesin' && state.selectedClassCode && _isNaesinClassCode(state.selectedClassCode)))) {
        if (window.renderNaesinDetail) {
            window.renderNaesinDetail(studentId);
            return;
        }
    }

    // 프로필
    document.getElementById('profile-avatar').textContent = (student.name || '?')[0];
    document.getElementById('detail-name').textContent = student.name || '';
    const snEl = document.getElementById('profile-student-number');
    if (snEl) {
        snEl.textContent = student.studentNumber ? `#${student.studentNumber}` : '';
        snEl.style.display = student.studentNumber ? '' : 'none';
    }

    // 연락처 표시 (이름 옆, 학생/학부모 각 줄)
    const phonesEl = document.getElementById('profile-phones');
    if (phonesEl) {
        phonesEl.innerHTML =
            `<div class="profile-phone"><span class="phone-label">학생</span>${student.student_phone ? esc(student.student_phone) : ''}</div>` +
            `<div class="profile-phone"><span class="phone-label">학부모</span>${student.parent_phone_1 ? esc(student.parent_phone_1) : ''}</div>`;
    }

    const rec = state.dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const arrivalTime = rec?.arrival_time || '';
    const isLeaveStudent = LEAVE_STATUSES.includes(student.status);
    // 내신기간 중에는 정규반 학습관리 카드(영역별숙제·테스트현황·다음숙제·숙제/테스트 미통과)를
    // 숨긴다 — 내신 종료 후 정규 복귀 시 자동 재표시. (1차 판정, 아래 분기에서 재사용)
    const isNaesinActive = isNaesinActiveToday(student, state.selectedDate);

    const isInactive = _isInactiveDetailStudent(student);
    const isWithdrawn = student.status === '퇴원';
    // 퇴원 학생: leave_request 한 번만 조회 (프로필 태그 + 퇴원 정보 카드에서 공유)
    const wdLeaveReq = isWithdrawn ? state.leaveRequests.find(lr => lr.student_id === studentId && lr.status === 'approved' &&
        (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원')) : null;
    // 마스터 status는 tone 배지가 전담. 비활성 분기의 tag-status 배지는 status 단어 없이
    // 보조정보(기간/날짜)만 남긴다 (재원 활성 분기는 출결/수업 표시 — 현행 유지).
    let tagClass, tagText;
    if (isWithdrawn) {
        tagClass = '';
        // 퇴원: 퇴원 날짜만 (없으면 배지 미렌더)
        tagText = _stripYear(wdLeaveReq?.withdrawal_date || '');
    } else if (isLeaveStudent) {
        tagClass = 'tag-leave';
        // 휴원: 휴원 기간만 (종료일 강조 ~MM-DD, 종료일 없으면 MM-DD~)
        const pauseStart = student.pause_start_date || '';
        const pauseEnd = student.pause_end_date || '';
        tagText = pauseEnd ? `~${_stripYear(pauseEnd)}` : pauseStart ? `${_stripYear(pauseStart)}~` : '';
    } else if (student.status === '등원예정') {
        // 등원예정: 가장 이른 미래 start_date(등원예정일)만 (없으면 배지 미렌더)
        tagClass = 'tag-pending';
        const today = state.selectedDate || todayStr();
        const futureStarts = (student.enrollments || [])
            .map(e => e.start_date)
            .filter(d => /^\d{4}-/.test(d || '') && d > today);
        const firstStart = futureStarts.length ? futureStarts.sort()[0] : '';
        tagText = firstStart ? _stripYear(firstStart) : '';
    } else if (!isEnrollableStatus(student.status)) {
        // 비재원(상담/종강): status는 tone 배지가 전담 — 보조 배지 미렌더
        tagClass = 'tag-pending';
        tagText = '';
    } else {
        const displayStatus = attStatus === '미확인' ? (isNaesinActive ? '내신' : '정규') : attStatus;
        tagClass = attStatus === '출석' ? 'tag-present' :
                   attStatus === '결석' ? 'tag-absent' :
                   attStatus === '지각' ? 'tag-late' : 'tag-pending';
        const showTime = (attStatus === '출석' || attStatus === '지각') && arrivalTime;
        tagText = showTime ? `${displayStatus} ${formatTime12h(arrivalTime)}` : displayStatus;
    }

    const siblings = [...(state.siblingMap[studentId] || [])]
        .map(sid => findStudent(sid))
        .filter(s => s?.name);
    const siblingHtml = siblings.length
        ? `<span class="tag tag-sibling">${msIcon('group', '', 'style="font-size:13px;"')} ${
            siblings.map(s => `<span style="cursor:pointer;text-decoration:underline;" role="link" tabindex="0" data-keyclick onclick="event.stopPropagation();selectStudent('${escAttr(s.docId)}')">${esc(s.name)}${esc(siblingStatusSuffix(s.status))}</span>`).join(', ')
          }</span>`
        : '';

    // 마스터 status tone 배지를 맨 앞에 병기. 보조 배지(tag-status)는 tagText 있을 때만 렌더.
    const masterStatusHtml = statusToneBadgeHtml(student.status || '');
    const auxBadgeHtml = tagText
        ? `<span class="tag tag-status ${tagClass}" ${isWithdrawn ? 'style="background:#dc2626;color:#fff;"' : ''}>${esc(tagText)}</span>`
        : '';

    document.getElementById('profile-tags').innerHTML = `
        ${masterStatusHtml}
        ${auxBadgeHtml}
        ${siblingHtml}
    `;

    // 비활성 학생일 때만 진단평가 입력 액션 바 노출.
    const inactiveBar = document.getElementById('inactive-action-bar');
    const diagBtn = document.getElementById('diagnostic-btn');
    if (inactiveBar && diagBtn) {
        if (_isInactiveDetailStudent(student)) {
            inactiveBar.style.display = '';
            diagBtn.onclick = () => window.openDiagnosticScheduleModal(studentId);
        } else {
            inactiveBar.style.display = 'none';
            diagBtn.onclick = null;
        }
    }

    // 재원현황 (프로필 내 표시)
    // 같은 학생 incremental 재렌더에서 재생성하면 fillTenure로 채워둔 값이 '…'로 리셋되는데
    // fillTenure는 !cardsUnchanged에서만 다시 호출돼 영구히 '…'로 멈춘다(M-14).
    // 학생이 바뀌었거나 tenure 자리표시자가 아직 없을 때만 재생성한다.
    const stayStatsEl = document.getElementById('profile-stay-stats');
    if (stayStatsEl && (studentChanged || !document.getElementById('detail-header-tenure'))) {
        stayStatsEl.innerHTML = buildStayStatsHtml(student);
    }

    // 카드들 렌더링
    const cardsContainer = document.getElementById('detail-cards');
    const studentHwTasks = state.hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const studentTestTasks = state.testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');

    // 등원 일정 카드 — 활성 enrollment만 표시 (휴원 학생 미표시)
    // 내신/자유학기 기간 중에는 그쪽으로 합성된 enrollment만 노출 (정규 자동 숨김)
    // 합성 enrollment의 schedule 객체에서 요일별 시간을 읽음
    // 단, 등원예정 학생은 미래 start_date enrollment도 보여줘야 함 (예: 5/19에 6/2 첫등원 예정인 학생)
    const enrollments = student.enrollments || [];
    const semesterEnrollments = student.status === '등원예정'
        ? enrollments
        : getActiveEnrollments(student, state.selectedDate);
    const dayNameForDetail = getDayName(state.selectedDate);
    const lp = deriveLevelPeriod(enrollments, todayStr());
    const lpLevel = (enrollments.find(e => e.start_date === lp.start && e.level_symbol)
        || semesterEnrollments.find(e => e.level_symbol) || {}).level_symbol || '';
    const levelPeriodHtml = lp.start
        ? `${lpLevel ? `<span class="stay-level-tag">${esc(lpLevel)}</span> ` : ''}${lp.start} &middot; ${lp.label}`
        : '—';
    const arrivalTimeHtml = (isLeaveStudent || isInactive) ? '' : semesterEnrollments.length > 0 ? `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('schedule', '', 'style="color:var(--primary);font-size:18px;"')}
                등원 일정
            </div>
            <div class="next-hw-detail-row">
                <span class="next-hw-detail-label">레벨기간</span>
                <span id="detail-level-period">${levelPeriodHtml}</span>
            </div>
            ${semesterEnrollments.map(e => {
                const idx = enrollments.indexOf(e);   // 합성 enrollment는 -1 → edit 버튼 숨김
                const code = enrollmentCode(e);
                const ct = e.class_type || '정규';
                const days = (e.day || []).join('·');
                const displayDay = (e.day || []).includes(dayNameForDetail) ? dayNameForDetail : e.day?.[0];
                const displayTime = getStudentStartTime(e, displayDay);
                // 시작 전(start_date 미래) enrollment는 요일이 맞아도 "오늘"로 표시하지 않음
                const notStarted = /^\d{4}-/.test(e.start_date || '') && e.start_date > state.selectedDate;
                const isToday = !notStarted && (e.day || []).includes(dayNameForDetail);
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;${isToday ? 'font-weight:600;color:var(--primary);' : 'opacity:0.7;'}">
                    <span style="font-size:13px;white-space:nowrap;">${esc(code)}</span>
                    ${ct !== '정규' ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:${ct === '내신' ? 'var(--warning)' : 'var(--info)'};color:#fff;">${esc(ct)}</span>` : ''}
                    <span style="font-size:12px;color:var(--text-sec);white-space:nowrap;">${esc(days)}</span>
                    <span style="font-size:13px;white-space:nowrap;">${displayTime ? esc(formatTime12h(displayTime)) : '-'}</span>
                    ${idx >= 0 ? msIcon('edit', '', `style="font-size:14px;color:var(--text-sec);cursor:pointer;margin-left:auto;" role="button" tabindex="0" data-keyclick aria-label="수강 정보 편집" onclick="openEnrollmentModal('${escAttr(studentId)}', ${idx})"`) : ''}
                </div>`;
            }).join('')}
        </div>
    ` : '';

    // 출결 사유 카드 (지각/결석/기타일 때만 표시)
    const showReason = ['지각', '결석'].includes(attStatus) ||
        (attStatus && !['미확인', '출석'].includes(attStatus));
    const reasonHtml = showReason ? `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon(
                    attStatus === '결석' ? 'cancel' :
                    attStatus === '지각' ? 'schedule' : 'info',
                    '',
                    `style="color:${
                        attStatus === '결석' ? 'var(--danger)' :
                        attStatus === '지각' ? 'var(--warning)' : 'var(--outline)'
                    };font-size:18px;"`
                )}
                ${esc(attStatus)} 사유
            </div>
            <textarea class="field-input" aria-label="출결 사유" style="width:100%;min-height:48px;resize:vertical;"
                placeholder="${esc(attStatus)} 사유를 입력하세요..."
                onchange="handleAttendanceChange('${studentId}', 'reason', this.value)">${esc(rec?.attendance?.reason || '')}</textarea>
        </div>
    ` : '';

    // 영역 숙제 현황 카드
    const isAttended = isAttendedStatus(attStatus);
    // 정규반 학습관리 카드 표시 게이트 — 출석했고 내신기간이 아닐 때만
    const showStudyCards = isAttended && !isNaesinActive;
    const detailDomains = isAttended ? getStudentDomains(studentId) : [];
    const d1st = isAttended ? (rec.hw_domains_1st || {}) : {};
    const d2nd = isAttended ? (rec.hw_domains_2nd || {}) : {};
    const hasAnyDomain = isAttended && (Object.values(d1st).some(v => v) || Object.values(d2nd).some(v => v));
    const has1stHw = isAttended && Object.values(d1st).some(v => v);
    const has2ndHw = isAttended && Object.values(d2nd).some(v => v);
    const domainHwHtml = !showStudyCards ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('domain_verification', '', 'style="color:var(--primary);font-size:18px;"')}
                영역별 숙제
            </div>
            ${!hasAnyDomain ? '<div class="detail-card-empty">영역 숙제 미입력</div>' : `
                <div class="detail-round-row">
                    ${has1stHw ? `<div class="detail-round-col">
                        <div class="detail-round-label">1차</div>
                        <div class="hw-domain-group">
                            ${detailDomains.map(d => oxChip(d, d1st[d] || '')).join('')}
                        </div>
                    </div>` : ''}
                    ${has2ndHw ? `<div class="detail-round-col">
                        <div class="detail-round-label">2차</div>
                        <div class="hw-domain-group">
                            ${detailDomains.filter(d => d1st[d] !== 'O').map(d => oxChip(d, d2nd[d] || '')).join('')}
                        </div>
                    </div>` : ''}
                </div>
            `}
        </div>
    `;

    // 테스트 OX 현황 카드
    const { sections: detailTestSections } = isAttended ? getStudentTestItems(studentId) : { sections: {} };
    const t1st = isAttended ? (rec.test_domains_1st || {}) : {};
    const t2nd = isAttended ? (rec.test_domains_2nd || {}) : {};
    const hasAnyTest = isAttended && (Object.values(t1st).some(v => v) || Object.values(t2nd).some(v => v));
    const has1stTest = isAttended && Object.values(t1st).some(v => v);
    const has2ndTest = isAttended && Object.values(t2nd).some(v => v);
    const domainTestHtml = !showStudyCards ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('quiz', '', 'style="color:var(--primary);font-size:18px;"')}
                테스트 현황
            </div>
            ${!hasAnyTest ? '<div class="detail-card-empty">테스트 미입력</div>' : `
                <div class="detail-round-row">
                    ${['1차', '2차'].map((round, ri) => {
                        const data = ri === 0 ? t1st : t2nd;
                        const hasData = ri === 0 ? has1stTest : has2ndTest;
                        if (!hasData) return '';
                        return `<div class="detail-round-col">
                            <div class="detail-round-label">${round}</div>
                            ${Object.entries(detailTestSections).map(([secName, items]) => {
                                // 2차: 1차에서 O인 항목은 제외
                                const filtered = ri === 1 ? items.filter(t => t1st[t] !== 'O') : items;
                                const hasAny = filtered.some(t => data[t]);
                                if (!hasAny) return '';
                                return `<div style="margin-bottom:6px;">
                                    <div class="detail-round-label">${esc(secName)}</div>
                                    <div class="hw-domain-group" style="margin-bottom:2px;">
                                        ${filtered.map(t => oxChip(t, data[t] || '')).join('')}
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>`;
                    }).join('')}
                </div>
            `}
        </div>
    `;

    // 다음숙제 카드 (반별 내용 표시 + 개인별 오버라이드 편집)
    const dayName2 = getDayName(state.selectedDate);
    const studentClasses = enrollments
        .filter(e => (e.day || []).includes(dayName2))
        .map(e => enrollmentCode(e))
        .filter(Boolean);
    const uniqueClasses = [...new Set(studentClasses)];
    const personalNextHw = rec.personal_next_hw || {};
    const nextHwHtml = (isNaesinActive || uniqueClasses.length === 0) ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('assignment', '', 'style="color:var(--primary);font-size:18px;"')}
                다음숙제
            </div>
            ${uniqueClasses.map(cc => {
                const domains = getClassDomains(cc);
                const classData = state.classNextHw[cc]?.domains || {};
                return `<div style="margin-bottom:10px;">
                    <div style="font-size:12px;font-weight:500;color:var(--text-sec);margin-bottom:6px;">${esc(cc)}</div>
                    ${domains.map(d => {
                        const pKey = `${cc}_${d}`;
                        const hasPersonal = personalNextHw[pKey] != null && personalNextHw[pKey] !== '';
                        const classVal = (classData[d] || '').trim();
                        const val = hasPersonal ? personalNextHw[pKey] : classVal;
                        const isNone = val === '없음';
                        const displayText = !val ? '미입력' : isNone ? '숙제 없음' : val;
                        const color = !val ? 'var(--outline)' : isNone ? 'var(--text-sec)' : 'var(--text-main)';
                        return `<div class="next-hw-detail-row" style="margin-bottom:4px;cursor:pointer;" role="button" tabindex="0" data-keyclick onclick="openPersonalNextHwModal('${escAttr(studentId)}', '${escAttr(cc)}', '${escAttr(d)}')">
                            <span class="next-hw-detail-label">${esc(d)}</span>
                            <span style="font-size:13px;color:${color};flex:1;">${esc(displayText)}</span>
                            ${hasPersonal ? '<span style="font-size:10px;color:var(--primary);">개인</span>' : ''}
                            ${msIcon('edit', '', 'style="font-size:14px;color:var(--outline);"')}
                        </div>`;
                    }).join('')}
                </div>`;
            }).join('')}
        </div>
    `;

    // 클리닉 카드
    const extraVisit = rec.extra_visit || {};
    const isPendingClinic = state._pendingClinicStudentId === studentId;
    const hasClinic = !!extraVisit.date || isPendingClinic;
    const isPastDate = state.selectedDate < todayStr();
    const clinicButtons = isPastDate
        ? ''
        : `<span style="display:flex;gap:2px;">
            ${hasClinic ? `<button class="icon-btn" style="width:28px;height:28px;" aria-label="클리닉 삭제" onclick="clearExtraVisit('${escAttr(studentId)}')">${msIcon('close', '', 'style="font-size:18px;color:var(--danger);"')}</button>` : ''}
            <button class="icon-btn" style="width:28px;height:28px;" aria-label="클리닉 추가" onclick="addExtraVisit('${escAttr(studentId)}')">${msIcon('add', '', 'style="font-size:18px;"')}</button>
        </span>`;
    const extraVisitHtml = `
        <div class="detail-card">
            <div class="detail-card-title detail-card-title-row">
                <span style="display:flex;align-items:center;gap:6px;">
                    ${msIcon('stethoscope', '', 'style="color:var(--primary);font-size:18px;"')}
                    클리닉
                </span>
                ${clinicButtons}
            </div>
            ${hasClinic ? renderClinicInputs(studentId, extraVisit, isPastDate) : ''}
        </div>
    `;

    let withdrawnHtml = '';
    if (isWithdrawn) {
        const wdDate = wdLeaveReq?.withdrawal_date || '';
        const wdReason = wdLeaveReq?.reason || '';
        const wdReqBy = wdLeaveReq ? getTeacherName(wdLeaveReq.requested_by) : '';
        const wdAppBy = wdLeaveReq ? getTeacherName(wdLeaveReq.approved_by) : '';
        const enrollInfo = enrollments.map(e => {
            const code = enrollmentCode(e);
            const days = (e.day || []).join('·');
            const ct = e.class_type || '정규';
            const time = e.start_time || e.time || '';
            const period = e.end_date ? ` ~${e.end_date.slice(5)}` : '';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">${esc(code)}</span>
                ${ct !== '정규' ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:${ct === '내신' ? 'var(--warning)' : 'var(--info)'};color:#fff;">${esc(ct)}</span>` : ''}
                <span style="font-size:12px;color:var(--text-sec);">${esc(days)}</span>
                ${time ? `<span style="font-size:12px;">${esc(formatTime12h(time))}</span>` : ''}
                ${period ? `<span style="font-size:11px;color:var(--text-sec);">${esc(period)}</span>` : ''}
            </div>`;
        }).join('');
        withdrawnHtml = `
            <div class="detail-card" style="border-left:3px solid #dc2626;">
                <div class="detail-card-title">
                    ${msIcon('person_off', '', 'style="color:#dc2626;font-size:18px;"')}
                    퇴원 정보
                </div>
                ${wdDate ? `<div style="font-size:13px;margin-bottom:6px;"><strong>퇴원일:</strong> ${esc(wdDate)}</div>` : ''}
                ${wdReason ? `<div style="font-size:13px;margin-bottom:6px;"><strong>사유:</strong> ${esc(wdReason)}</div>` : ''}
                <div style="font-size:11px;color:var(--text-sec);display:flex;gap:12px;flex-wrap:wrap;">
                    ${wdReqBy ? `<span>요청: ${esc(wdReqBy)}</span>` : ''}
                    ${wdAppBy ? `<span>승인: ${esc(wdAppBy)}</span>` : ''}
                </div>
                ${!wdLeaveReq ? '<div style="font-size:12px;color:var(--text-sec);margin-top:4px;">휴퇴원 요청서 기록 없음</div>' : ''}
            </div>
            ${enrollInfo ? `<div class="detail-card">
                <div class="detail-card-title">
                    ${msIcon('school', '', 'style="color:var(--text-sec);font-size:18px;"')}
                    수강 이력
                </div>
                ${enrollInfo}
            </div>` : ''}`;
    }

    const inactiveHtml = isWithdrawn ? withdrawnHtml : `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('person_off', '', 'style="color:var(--text-sec);font-size:18px;"')}
                ${esc(student.status || '비원생')} 학생
            </div>
            <div style="font-size:13px;color:var(--text-sec);">
                진단평가 예약은 상단 진단평가 버튼에서 진행할 수 있습니다.
            </div>
        </div>`;

    const cardsHtml = isInactive ? inactiveHtml : `
        <!-- AI 종합 상태 카드 (비동기 마운트) -->
        <div id="student-status-mount" data-student-id="${escAttr(studentId)}"></div>

        <!-- 복귀상담 카드 (복귀예정 뷰) -->
        ${renderReturnConsultCard(studentId)}

        ${renderChecklistCard(studentId)}
        ${reasonHtml}

        <!-- 개별 등원시간 카드 -->
        ${arrivalTimeHtml}

        <!-- 타반수업 카드 -->
        ${renderTempClassOverrideCard(studentId)}

        <!-- 영역별 숙제 카드 -->
        ${domainHwHtml}

        <!-- 테스트 현황 카드 -->
        ${domainTestHtml}

        <!-- 다음숙제 카드 -->
        ${nextHwHtml}

        <!-- 숙제 미통과 카드 (출석 학생만, 내신기간 제외) -->
        ${showStudyCards ? renderHwFailActionCard(studentId, detailDomains, d2nd, rec.hw_fail_action || {}, has2ndHw ? 'default' : '1st_only') : ''}

        <!-- 테스트 미통과 카드 (출석 학생만, 내신기간 제외) -->
        ${showStudyCards ? renderTestFailActionCard(studentId, detailTestSections, t2nd, rec.test_fail_action || {}, has2ndTest ? 'default' : '1st_only') : ''}

        <!-- 밀린 Task 카드 (숙제 + 테스트) -->
        ${renderPendingTasksCard(studentId, [...studentHwTasks, ...studentTestTasks])}

        <!-- 결석대장 카드 -->
        ${renderAbsenceRecordCard(studentId)}

        <!-- 클리닉 카드 -->
        ${extraVisitHtml}
    `;
    // 메모 카드는 기록(docu) 탭의 휴퇴원 요청서 아래로 이동(docu-card.js renderDocuTab).

    // 증분 렌더링: realtime 갱신에서 카드 HTML이 직전과 동일하고, 현재 detail-cards가
    // '이 학생의 표준 카드'(student-status-mount 마커)를 담고 있으면 교체를 건너뛴다.
    // detail-cards는 naesin/class/diagnostic 등과 공유되므로 마커로 점유 출처를 확인해
    // 다른 화면이 컨테이너를 점유한 사이의 stale skip을 방지한다.
    const cardsUnchanged = incremental && !studentChanged && _lastCardsHtml === cardsHtml &&
        !isInactive && !!cardsContainer.querySelector(`#student-status-mount[data-student-id="${CSS.escape(studentId)}"]`);

    if (!cardsUnchanged) {
        cardsContainer.innerHTML = cardsHtml;
        _lastCardsHtml = cardsHtml;

        // 체크리스트 완료 캐시 backfill — 실제 카드 갱신 시에만(M-15). 값이 바뀐 경우에만 write.
        if (!isInactive) {
            syncChecklistCache(studentId, getStudentChecklistStatus(studentId))
                .catch(err => console.warn('[checklist-cache] 동기화 실패:', err));
        }

        // 재원기간 — 헤더에 비동기로 채움 (history_logs deriveTenure, DB와 동일 로직)
        if (document.getElementById('detail-header-tenure')) fillTenure(studentId, student);

        // AI 종합 상태 카드 — 비동기 마운트 (퇴원 뷰 제외)
        if (!isInactive) {
            const statusMount = document.getElementById('student-status-mount');
            if (statusMount) {
                import('./student-status-card.js').then(({ renderStudentStatusCard, initStudentStatusCardDeps }) => {
                    initStudentStatusCardDeps({ readonly: READ_ONLY });
                    // stale 방지: 그 사이 다른 학생으로 바뀌었으면 스킵
                    if (statusMount.dataset.studentId === studentId) {
                        renderStudentStatusCard(studentId, statusMount);
                    }
                });
            }
        }
    }

    // 탭 상태 복원 — 학생 모드: 출결현황/성적 탭 노출.
    // 비활성 학생(퇴원/종강/상담 등)은 출결 의미가 약하므로 라벨을 "수업이력"으로 전환.
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) {
        tabsEl.style.display = '';
        const reportLabel = _isInactiveDetailStudent(student) ? '수업이력' : '출결';
        tabsEl.querySelectorAll('.detail-tab').forEach(t => {
            if (t.dataset.tab === 'report' || t.dataset.tab === 'score' || t.dataset.tab === 'consultation' || t.dataset.tab === 'docu') t.style.display = '';
            if (t.dataset.tab === 'report') t.textContent = reportLabel;
            t.classList.toggle('active', t.dataset.tab === state.detailTab);
        });
    }
    document.getElementById('detail-cards').style.display = state.detailTab === 'daily' ? '' : 'none';
    const reportTabEl = document.getElementById('report-tab');
    if (reportTabEl) reportTabEl.style.display = state.detailTab === 'report' ? '' : 'none';
    const scoreTabEl = document.getElementById('score-tab');
    if (scoreTabEl) {
        scoreTabEl.style.display = state.detailTab === 'score' ? '' : 'none';
        // realtime(incremental) 갱신에선 성적 탭을 다시 로드하지 않음 — 무관한 쓰기에 스크롤·상태 리셋 방지
        if (state.detailTab === 'score' && !incremental) loadScoreCard(studentId);
    }
    const consultTabEl = document.getElementById('consultation-tab');
    if (consultTabEl) {
        consultTabEl.style.display = state.detailTab === 'consultation' ? '' : 'none';
        if (studentChanged && studentId && state.detailTab === 'consultation' && _renderConsultationFn) {
            _renderConsultationFn(studentId);
        }
    }
    const messageTabEl = document.getElementById('message-tab');
    if (messageTabEl) {
        messageTabEl.style.display = state.detailTab === 'message' ? '' : 'none';
        if (studentChanged && studentId && state.detailTab === 'message') {
            // _renderMessageFn 미로드면 switchDetailTab이 import 후 렌더 — 소속반 단체 안내 탭에서
            // 학생으로 전환한 직후 stale 단체 안내 UI가 학생 화면에 남는 것을 방지.
            if (_renderMessageFn) _renderMessageFn(studentId);
            else switchDetailTab('message');
        }
    }
    const docuTabEl2 = document.getElementById('docu-tab');
    if (docuTabEl2) {
        docuTabEl2.style.display = state.detailTab === 'docu' ? '' : 'none';
        // 휴퇴원 카드가 docu 탭으로 이동했으므로, 같은 학생의 휴퇴원 액션(renderStudentDetail
        // 직접 재호출) 후에도 탭을 다시 그려야 카드 상태가 반영된다(studentChanged 무관).
        // 단 realtime(incremental) 갱신에선 다시 그리지 않음 — 무관한 쓰기에 펼침·스크롤 리셋 방지.
        if (studentId && state.detailTab === 'docu' && _renderDocuFn && !incremental) {
            _renderDocuFn(studentId);
        }
    }

    // 결석대장 카드 expanded 상태 복원 (카드를 다시 그렸을 때만 — skip 시 DOM 유지)
    if (!cardsUnchanged) _restoreExpandedAbsenceIndices(expandedAbsenceIndices);

    // 좁은 화면(<=1100px)에서 패널 표시 — 데스크톱에선 무해
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

// ─── 클리닉 저장 ────────────────────────────────────────────────────────────
// + 버튼 클릭 시 오늘 날짜를 바로 박지 않도록 pending 플래그(state) 사용

// 시간 select가 기본으로 표시하는 값 — 변경 없인 onchange가 안 와서 저장이 누락되므로
// saveExtraVisit이 이 값을 실제 저장값으로 보정한다 (표시값 = 저장값 보장)
const DEFAULT_CLINIC_TIME = '16:00';

// 클리닉 date/time/reason input 렌더 헬퍼 (daily-ops + naesin/teukang 공용)
export function renderClinicInputs(studentId, extraVisit, isReadonly) {
    const v = extraVisit || {};
    const dateOn = isReadonly ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'date', this.value)"`;
    const timeAttr = isReadonly ? 'disabled' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'time', this.value)"`;
    const reasonOn = isReadonly ? 'readonly' : imeInputAttrs(`saveExtraVisit('${escAttr(studentId)}', 'reason', this.value)`);
    return `<div style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;">
            <input type="date" class="field-input" aria-label="클리닉 날짜" style="flex:1;padding:4px 8px;font-size:12px;"
                value="${escAttr(v.date || '')}" ${dateOn}>
            ${renderTime12hSelect({
                value: v.time || DEFAULT_CLINIC_TIME,
                dataAttr: timeAttr,
                style: 'width:105px;padding:4px 8px;font-size:12px;',
            })}
        </div>
        <input type="text" class="field-input" aria-label="클리닉 사유" style="width:100%;padding:4px 8px;font-size:12px;"
            placeholder="사유 (예: 보충수업, 재시험 등)"
            value="${escAttr(v.reason || '')}" ${reasonOn}>
    </div>`;
}

function getClinicTimeConflict(studentId, extraVisit) {
    if (!extraVisit.date || !extraVisit.time) return null;
    const student = findStudent(studentId);
    if (!student) return null;
    const dayName = getDayName(extraVisit.date);
    const enroll = getActiveEnrollments(student, extraVisit.date).find(e =>
        (e.day || []).includes(dayName) && getStudentStartTime(e, dayName) === extraVisit.time
    );
    if (!enroll) return null;
    const labels = {
        '내신': '내신',
        '특강': '특강',
        '자유학기': '자유학기',
    };
    const label = labels[enroll.class_type] || '정규';
    return `${label} 등원 ${formatTime12h(extraVisit.time)}`;
}

export async function saveExtraVisit(studentId, field, value) {
    // 날짜가 입력되면 pending 해제
    if (field === 'date' && value) state._pendingClinicStudentId = null;
    const rec = state.dailyRecords[studentId] || {};
    // 이전 타겟(미래) 날짜 — 날짜를 옮기면 이전 타겟 문서의 클리닉을 정리해야 유령이 안 남는다(H-6).
    const prevTargetDate = (rec.extra_visit || {}).date;
    const extraVisit = { ...(rec.extra_visit || {}) };
    extraVisit[field] = value;
    if (extraVisit.date && !extraVisit.time) extraVisit.time = DEFAULT_CLINIC_TIME;
    const conflict = getClinicTimeConflict(studentId, extraVisit);
    if ((field === 'date' || field === 'time') && conflict) {
        const ok = confirm(`${conflict}과 클리닉 시간이 같습니다. 그래도 클리닉을 저장할까요?`);
        if (!ok) {
            renderStudentDetail(studentId);
            return;
        }
    }

    // 로컬 캐시 업데이트
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    state.dailyRecords[studentId].extra_visit = extraVisit;

    // 현재 날짜 레코드에 저장 (상세 패널 표시용)
    saveDailyRecord(studentId, { extra_visit: extraVisit });

    // 타겟 날짜가 다르면 타겟 날짜 레코드에도 저장 (등원예정 목록 표시용)
    const targetDate = extraVisit.date;
    const student = state.allStudents.find(s => s.docId === studentId);
    if (targetDate && targetDate !== state.selectedDate) {
        const docId = makeDailyRecordId(studentId, targetDate);
        try {
            const payload = { student_id: studentId, date: targetDate, extra_visit: extraVisit };
            if (student) payload.branch = branchFromStudent(student);
            await auditSet(doc(db, 'daily_records', docId), payload, { merge: true });
        } catch (err) {
            console.error('클리닉 미래 날짜 저장 실패:', err);
        }
    }

    // 타겟 날짜가 이전 미래 타겟과 다르면, 이전 타겟 문서의 extra_visit를 정리(유령 클리닉 방지, H-6)
    if (prevTargetDate && prevTargetDate !== targetDate && prevTargetDate !== state.selectedDate) {
        try {
            await auditSet(doc(db, 'daily_records', makeDailyRecordId(studentId, prevTargetDate)),
                { extra_visit: deleteField() }, { merge: true });
        } catch (err) {
            console.error('이전 클리닉 날짜 정리 실패:', err);
        }
    }
}

// + 버튼 클릭 → 저장 없이 빈 input 노출 (사용자가 날짜 선택 후 저장)
export async function addExtraVisit(studentId) {
    state._pendingClinicStudentId = studentId;
    renderStudentDetail(studentId);
}

// × 버튼 클릭 → extra_visit 삭제 + 리렌더
export async function clearExtraVisit(studentId) {
    if (state.selectedDate < todayStr()) { alert('과거 기록은 삭제할 수 없습니다.'); return; }
    const rec = state.dailyRecords[studentId];
    const prevExtraVisit = rec ? rec.extra_visit : undefined;
    // 미래 타겟 날짜에 저장된 클리닉이면 그 문서도 함께 지워야 유령이 안 남는다(H-6).
    const prevTargetDate = prevExtraVisit?.date;
    if (rec) delete rec.extra_visit;
    try {
        await saveImmediately(studentId, { extra_visit: deleteField() });
        if (prevTargetDate && prevTargetDate !== state.selectedDate) {
            await auditSet(doc(db, 'daily_records', makeDailyRecordId(studentId, prevTargetDate)),
                { extra_visit: deleteField() }, { merge: true });
        }
    } catch (err) {
        // 저장 실패 시 optimistic delete를 되돌린다. F-04.
        console.error('방문 삭제 실패:', err);
        if (rec && prevExtraVisit !== undefined) rec.extra_visit = prevExtraVisit;
    }
    renderStudentDetail(studentId);
    renderSubFilters();
    renderListPanel();
}

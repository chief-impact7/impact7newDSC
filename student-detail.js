// student-detail.js — 학생 상세 패널 렌더링 모듈
//
// 분리 출처: daily-ops.js (cluster C, Step 4)
// Injection: `renderSubFilters`, `renderListPanel`, `_isNaesinClassCode`는 daily-ops.js에서 주입.

import {
    collection, getDocs, doc, getDoc,
    query, where, deleteField
} from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state, LEAVE_STATUSES } from './state.js';
import {
    esc, escAttr, formatTime12h, oxDisplayClass,
    nowTimeStr, showSaveIndicator
} from './ui-utils.js';
import {
    enrollmentCode, findStudent,
    branchFromStudent, makeDailyRecordId
} from './student-helpers.js';
import {
    parseDateKST, todayStr, getDayName
} from './src/shared/firestore-helpers.js';
import { auditSet } from './audit.js';
import {
    getStudentDomains, getStudentTestItems, getClassDomains,
    getTeacherName, getStudentOverrides,
    saveDailyRecord, saveImmediately
} from './data-layer.js';
import { isAttendedStatus } from './attendance.js';
import {
    renderHwFailActionCard, renderPendingTasksCard, openPersonalNextHwModal
} from './hw-management.js';
import { renderTestFailActionCard } from './test-management.js';
import {
    renderAbsenceRecordCard, _getExpandedAbsenceIndices, _restoreExpandedAbsenceIndices
} from './absence-records.js';
import { renderLeaveRequestCard, renderReturnConsultCard } from './leave-request.js';
import { renderUnifiedMemoCard } from './role-memo.js';

// ─── Injection slots (daily-ops.js → initStudentDetailDeps) ─────────────────
let renderSubFilters, renderListPanel, _isNaesinClassCode;

export function initStudentDetailDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    _isNaesinClassCode = deps._isNaesinClassCode;
}

// ─── Module-local state ─────────────────────────────────────────────────────
let _lastRenderedStudentId = null;

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

    // 7. 귀가
    items.push({
        key: 'departure',
        label: '귀가',
        done: rec.departure?.status === '귀가'
    });

    return items;
}

function renderChecklistCard(studentId) {
    const items = getStudentChecklistStatus(studentId);
    const doneCount = items.filter(i => i.done).length;
    const total = items.length;
    const allDone = doneCount === total;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    const rec = state.dailyRecords[studentId] || {};
    const departure = rec.departure || {};
    const isDeparted = departure.status === '귀가';

    // Non-departure items that are not done
    const pendingItems = items.filter(i => !i.done && i.key !== 'departure');
    const canDepart = pendingItems.length === 0;

    let departureSection = '';
    if (isDeparted) {
        departureSection = `
            <button class="departure-btn departed" disabled>
                <span class="material-symbols-outlined" style="font-size:16px;">check_circle</span>
                귀가 완료 (${formatTime12h(departure.time || '')})
            </button>`;
    } else if (canDepart) {
        departureSection = `
            <button class="departure-btn ready" onclick="confirmDeparture('${escAttr(studentId)}')">
                <span class="material-symbols-outlined" style="font-size:16px;">logout</span>
                귀가 확인
            </button>`;
    } else {
        departureSection = `
            <button class="departure-btn not-ready" onclick="confirmDeparture('${escAttr(studentId)}')">
                <span class="material-symbols-outlined" style="font-size:16px;">logout</span>
                귀가 확인 (미완료 ${pendingItems.length}건)
            </button>`;
    }

    const parentMsgBtn = `
        <button class="departure-btn not-ready" style="margin-top:6px;background:#f3e8ff;color:#7c3aed;border:1px solid #e9d5ff;"
            onclick="event.stopPropagation(); openParentMessageModal('${escAttr(studentId)}')">
            <span class="material-symbols-outlined" style="font-size:16px;">sms</span>
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
                        <span class="material-symbols-outlined checklist-icon">${i.done ? 'check_circle' : 'radio_button_unchecked'}</span>
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
            status: '귀가',
            time: nowTimeStr(),
            confirmed_by: (state.currentUser?.email || '').split('@')[0],
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
        console.error('귀가 확인 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Student Detail Panel ───────────────────────────────────────────────────

function buildStayStatsHtml(student) {
    const enrollments = (student.enrollments || []).filter(e => e.level_symbol || e.start_date);
    if (!enrollments.length) return '';

    // 재원기간 (start_date 없거나 2020 이전이면 2026-01-01 기본값)
    const startDates = enrollments.map(e => e.start_date)
        .filter(d => d && d !== '?' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '2020-01-01')
        .sort();
    const firstDate = startDates.length ? startDates[0] : '2026-01-01';
    let periodHtml = '—';
    {
        const start = parseDateKST(firstDate);
        const now = parseDateKST(todayStr());
        const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
        const totalMonths = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
        const years = Math.floor(totalMonths / 12);
        const months = totalMonths % 12;
        const duration = diffDays < 0 ? '등원예정'
            : totalMonths < 1 ? `${diffDays}일`
            : years > 0 ? `${years}년${months > 0 ? ' ' + months + '개월' : ''}`
            : `${totalMonths}개월`;
        periodHtml = `${firstDate} 부터 &nbsp;&middot;&nbsp; <strong>${duration}</strong>`;
    }

    // 현재 활성 enrollment 구하기 (class_type별 가장 최근 시작된 enrollment)
    const today = todayStr();
    const byType = {};
    for (const e of enrollments) {
        const ct = e.class_type || '정규';
        if (!byType[ct]) byType[ct] = [];
        byType[ct].push(e);
    }
    const activeSet = new Set();
    for (const [, list] of Object.entries(byType)) {
        const validDate = (v) => v && /^\d{4}-/.test(v);
        const started = list
            .filter(e => !validDate(e.start_date) || e.start_date <= today)
            .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
        if (started.length > 0) activeSet.add(started[0]);
        else {
            const sorted = [...list].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
            activeSet.add(sorted[0]);
        }
    }

    // 레벨 이력 (현재 활성 enrollment 제외, 과거 학기만)
    const levelMap = {};
    for (const e of enrollments) {
        if (activeSet.has(e)) continue;
        const sym = e.level_symbol;
        if (!sym) continue;
        if (!levelMap[sym]) levelMap[sym] = { semesters: new Set(), firstDate: '' };
        if (e.semester) levelMap[sym].semesters.add(e.semester);
        if (e.start_date && (!levelMap[sym].firstDate || e.start_date < levelMap[sym].firstDate))
            levelMap[sym].firstDate = e.start_date;
    }

    const levelRows = Object.entries(levelMap)
        .sort((a, b) => (a[1].firstDate || '').localeCompare(b[1].firstDate || ''))
        .map(([sym, data]) => {
            const sems = [...data.semesters].sort();
            const semStr = sems.length ? sems.join(' \u00b7 ') : '—';
            const cnt = sems.length;
            return `<div class="stay-level-row">
                <span class="stay-level-tag">${esc(sym)}</span>
                <span class="stay-level-sems">${esc(semStr)}</span>
                <span class="stay-level-count">${cnt}학기</span>
            </div>`;
        }).join('');

    return `
        <div class="stay-period">
            <span class="stay-period-value">${periodHtml}</span>
        </div>
        ${levelRows ? `<div class="stay-levels">
            <div class="stay-level-list">${levelRows}</div>
        </div>` : ''}
    `;
}

// ─── 출결현황 탭 ──────────────────────────────────────────────────────────────
export function switchDetailTab(tab) {
    state.detailTab = tab;
    document.querySelectorAll('.detail-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.getElementById('detail-cards').style.display = tab === 'daily' ? '' : 'none';
    document.getElementById('report-tab').style.display = tab === 'report' ? '' : 'none';
    document.getElementById('score-tab').style.display = tab === 'score' ? '' : 'none';
    if (tab === 'score') loadScoreCard();
}

export async function loadReportCard() {
    const studentId = state.selectedStudentId;
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
        const records = [];
        snap.forEach(d => records.push(d.data()));
        records.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        renderReportCard(records);
    } catch (err) {
        console.error('출결현황 조회 실패:', err);
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">조회 실패: ' + esc(err.message) + '</div>';
    }
}

function renderReportCard(records) {
    const contentEl = document.getElementById('report-content');

    if (records.length === 0) {
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">해당 기간에 기록이 없습니다.</div>';
        return;
    }

    // ── 출석 집계 ──
    const attendanceRows = records.map(rec => {
        const date = rec.date || '';
        const dayName = date ? getDayName(date) : '';
        const status = rec.attendance?.status || '';
        const reason = rec.attendance?.reason || '';
        return { date, dayName, status, reason };
    }).filter(r => r.date);

    const attendanceHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">event_available</span>
                출석 (${attendanceRows.length}일)
            </div>
            <table class="report-attendance-table">
                <thead><tr><th>날짜</th><th>구분</th><th>비고</th></tr></thead>
                <tbody>
                    ${attendanceRows.map(r => {
                        const dateShort = r.date.slice(5).replace('-', '/');
                        const cls = r.status === '출석' ? 'att-present' :
                                    r.status === '결석' ? 'att-absent' :
                                    r.status === '지각' ? 'att-late' :
                                    r.status === '보충' ? 'att-makeup' : '';
                        return `<tr>
                            <td>${esc(dateShort)}(${esc(r.dayName)})</td>
                            <td class="${cls}">${esc(r.status || '-')}</td>
                            <td>${esc(r.reason)}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    // ── 숙제 O/△/X 집계 ──
    const hwDomains = new Set();
    records.forEach(rec => {
        Object.keys(rec.hw_domains_1st || {}).forEach(d => hwDomains.add(d));
        Object.keys(rec.hw_domains_2nd || {}).forEach(d => hwDomains.add(d));
    });

    const hwStats = {};
    hwDomains.forEach(d => { hwStats[d] = { O: 0, '△': 0, X: 0 }; });
    records.forEach(rec => {
        hwDomains.forEach(d => {
            const val = (rec.hw_domains_2nd?.[d]) || (rec.hw_domains_1st?.[d]) || '';
            if (val === 'O' || val === '△' || val === 'X') {
                hwStats[d][val]++;
            }
        });
    });

    // ── 테스트 O/△/X 집계 ──
    const testDomains = new Set();
    records.forEach(rec => {
        Object.keys(rec.test_domains_1st || {}).forEach(d => testDomains.add(d));
        Object.keys(rec.test_domains_2nd || {}).forEach(d => testDomains.add(d));
    });

    const testStats = {};
    testDomains.forEach(d => { testStats[d] = { O: 0, '△': 0, X: 0 }; });
    records.forEach(rec => {
        testDomains.forEach(d => {
            const val = (rec.test_domains_2nd?.[d]) || (rec.test_domains_1st?.[d]) || '';
            if (val === 'O' || val === '△' || val === 'X') {
                testStats[d][val]++;
            }
        });
    });

    const renderOxSection = (title, icon, stats) => {
        const domains = Object.keys(stats);
        if (domains.length === 0) return '';
        return `
            <div class="report-ox-section">
                <div class="report-ox-title">
                    <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">${icon}</span>
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

    const oxGridHtml = (hwDomains.size > 0 || testDomains.size > 0) ? `
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
    if (typeof value.toDate === 'function') return value.toDate().toISOString().slice(0, 10);
    if (value.seconds) return new Date(value.seconds * 1000).toISOString().slice(0, 10);
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

function scoreLink(url, label = '보기') {
    return url
        ? `<a class="score-link" href="${escAttr(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>`
        : '—';
}

function renderScoreTable(title, icon, rows, emptyText, columns) {
    return `
        <div class="detail-card score-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">${icon}</span>
                ${esc(title)}
            </div>
            ${rows.length === 0 ? `<div class="detail-card-empty">${esc(emptyText)}</div>` : `
                <div class="score-table-wrap">
                    <table class="score-table">
                        <thead>
                            <tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>
                        </thead>
                        <tbody>
                            ${rows.map(row => `<tr>
                                ${columns.map(c => `<td class="${c.align === 'right' ? 'score-cell-num' : ''}">${row[c.key] ?? '—'}</td>`).join('')}
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            `}
        </div>
    `;
}

function externalEventLabel(event) {
    if (event.type === 'school') {
        return `${event.year || ''} ${event.level || ''} ${event.school || ''} ${event.grade || ''}학년 ${event.semester || ''}학기 ${event.examName || ''}`.replace(/\s+/g, ' ').trim();
    }
    return `${event.year || ''} ${event.month || ''}월 모의고사 ${event.grade ? `${event.grade}학년` : ''}`.replace(/\s+/g, ' ').trim();
}

function studentNumberOf(student) {
    return student?.studentNumber || student?.registrationNo || '';
}

function isSameSchoolGradeResult(result, student) {
    const className = result.className || '';
    const school = student?.school || '';
    const grade = String(student?.grade || '').trim();
    return (!school || className.includes(school)) && (!grade || className.includes(`${grade}학년`));
}

async function firstResultByQuery(examId, field, value) {
    if (!value) return null;
    const snap = await getDocs(query(
        collection(db, 'results', examId, 'students'),
        where(field, '==', value)
    ));
    return snap.empty ? null : snap.docs[0];
}

async function findAcademyResultDoc(examId, studentId) {
    const directSnap = await getDoc(doc(db, 'results', examId, 'students', studentId));
    if (directSnap.exists()) return directSnap;

    const student = state.allStudents.find(s => s.docId === studentId);
    const studentNumber = studentNumberOf(student);

    return await firstResultByQuery(examId, 'studentId', studentId)
        || await firstResultByQuery(examId, 'studentNumber', studentNumber)
        || await firstResultByQuery(examId, 'registrationNo', studentNumber)
        || await findAcademyResultByName(examId, student);
}

async function findAcademyResultByName(examId, student) {
    if (!student?.name) return null;

    const snap = await getDocs(query(
        collection(db, 'results', examId, 'students'),
        where('studentName', '==', student.name)
    ));
    if (snap.empty) return null;
    if (snap.size === 1) return snap.docs[0];

    return snap.docs.find(d => isSameSchoolGradeResult(d.data(), student)) || null;
}

async function loadAcademyScores(studentId) {
    const examSnap = await getDocs(collection(db, 'exams'));
    const exams = [];
    examSnap.forEach(d => {
        const data = d.data();
        if (data.deptId) exams.push({ id: d.id, ...data });
    });

    const rows = await Promise.all(exams.map(async exam => {
        const resultSnap = await findAcademyResultDoc(exam.id, studentId);
        if (!resultSnap) return null;
        const r = resultSnap.data();
        const finalScore = scoreNum(r.finalScore);
        const rawScore = scoreNum(r.rawScore);
        const domainScores = r.finalDomainScores || r.domainRawScores || {};
        const domainText = Object.entries(domainScores)
            .map(([k, v]) => `${k} ${scoreValue(v)}`)
            .join(', ');
        return {
            title: esc(exam.title || '원내고사'),
            date: esc(scoreDateText(exam.schedule?.startDate) || ''),
            score: esc(finalScore != null ? finalScore : rawScore != null ? rawScore : '—'),
            status: exam.status === 'finalized' ? '<span class="score-badge finalized">확정</span>' : '<span class="score-badge draft">진행</span>',
            domains: esc(domainText || '—'),
        };
    }));

    return rows.filter(Boolean).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function loadExternalScores(studentId, type) {
    const eventSnap = await getDocs(query(collection(db, 'external_score_events'), where('type', '==', type)));
    const events = [];
    eventSnap.forEach(d => events.push({ id: d.id, ...d.data() }));

    const rows = await Promise.all(events.map(async event => {
        const scoreSnap = await getDoc(doc(db, 'external_score_events', event.id, 'students', studentId));
        if (!scoreSnap.exists()) return null;
        const s = scoreSnap.data();
        const diff = scoreNum(s.finalScore) != null && scoreNum(s.predictedScore) != null
            ? scoreNum(s.finalScore - s.predictedScore)
            : null;
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
            date: event.date || event.updatedAt || '',
        };
    }));

    return rows.filter(Boolean).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export async function loadScoreCard() {
    const studentId = state.selectedStudentId;
    if (!studentId) return;

    const contentEl = document.getElementById('score-content');
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">성적을 불러오는 중...</div>';

    try {
        const [academyRows, schoolRows, mockRows] = await Promise.all([
            loadAcademyScores(studentId).catch(err => {
                console.warn('원내고사 조회 실패:', err);
                return [];
            }),
            loadExternalScores(studentId, 'school').catch(err => {
                console.warn('내신 성적 조회 실패:', err);
                return [];
            }),
            loadExternalScores(studentId, 'mock').catch(err => {
                console.warn('모의고사 성적 조회 실패:', err);
                return [];
            }),
        ]);
        if (state.selectedStudentId !== studentId) return;

        const academyHtml = renderScoreTable('원내고사', 'bar_chart', academyRows, '원내고사 결과가 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'date', label: '일자' },
            { key: 'score', label: '점수', align: 'right' },
            { key: 'status', label: '상태' },
            { key: 'domains', label: '영역' },
        ]);
        const schoolHtml = renderScoreTable('학교내신', 'school', schoolRows, '학교내신 성적 기록이 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'predicted', label: '예상', align: 'right' },
            { key: 'final', label: '확정', align: 'right' },
            { key: 'diff', label: '차이', align: 'right' },
            { key: 'grade', label: '등급' },
            { key: 'report', label: '성적표' },
            { key: 'extra', label: '메모' },
        ]);
        const mockHtml = renderScoreTable('모의고사', 'fact_check', mockRows, '모의고사 성적 기록이 없습니다.', [
            { key: 'title', label: '시험' },
            { key: 'predicted', label: '예상', align: 'right' },
            { key: 'final', label: '확정', align: 'right' },
            { key: 'diff', label: '차이', align: 'right' },
            { key: 'grade', label: '등급' },
            { key: 'report', label: '성적표' },
            { key: 'extra', label: '부가' },
        ]);

        contentEl.innerHTML = `<div class="score-tab-content">${academyHtml}${schoolHtml}${mockHtml}</div>`;
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
                <span class="material-symbols-outlined" style="color:var(--warning);font-size:18px;">swap_horiz</span>
                타반수업
            </div>
            ${listHtml}
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openTempClassOverrideModal('${escAttr(studentId)}')">
                <span class="material-symbols-outlined" style="font-size:14px;">add</span> 타반수업 추가
            </button>
        </div>
    `;
}

export function renderStudentDetail(studentId) {
    // 다른 학생으로 이동할 때 pending 클리닉 플래그 해제
    if (studentId !== _lastRenderedStudentId) {
        state._pendingClinicStudentId = null;
    }
    _lastRenderedStudentId = studentId;

    if (!studentId) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
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
        return;
    }

    // 특강 모드: 특강 전용 상세 패널
    if (state._classMgmtMode === 'teukang' && state.selectedClassCode) {
        if (window.renderTeukangDetail) {
            window.renderTeukangDetail(studentId);
            return;
        }
    }

    // 내신 모드: naesin.js로 위임 (간소화된 상세 패널)
    if ((state.currentCategory === 'attendance' && state.currentSubFilter.has('naesin')) ||
        (state._classMgmtMode === 'naesin' && state.selectedClassCode && _isNaesinClassCode(state.selectedClassCode))) {
        if (window.renderNaesinDetail) {
            window.renderNaesinDetail(studentId);
            return;
        }
    }

    // 프로필
    document.getElementById('profile-avatar').textContent = (student.name || '?')[0];
    document.getElementById('detail-name').textContent = student.name || '';

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

    const isWithdrawn = student.status === '퇴원';
    // 퇴원 학생: leave_request 한 번만 조회 (프로필 태그 + 퇴원 정보 카드에서 공유)
    const wdLeaveReq = isWithdrawn ? state.leaveRequests.find(lr => lr.student_id === studentId && lr.status === 'approved' &&
        (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원')) : null;
    let tagClass, tagText;
    if (isWithdrawn) {
        tagClass = '';
        const wdDate = wdLeaveReq?.withdrawal_date || '';
        tagText = `퇴원${wdDate ? ` (${wdDate})` : ''}`;
    } else if (isLeaveStudent) {
        tagClass = 'tag-leave';
        const pauseStart = student.pause_start_date || '';
        const pauseEnd = student.pause_end_date || '';
        const period = pauseStart && pauseEnd ? ` (${pauseStart} ~ ${pauseEnd})` : pauseStart ? ` (${pauseStart} ~)` : '';
        tagText = `${student.status}${period}`;
    } else {
        const displayStatus = attStatus === '미확인' ? '정규' : attStatus;
        tagClass = attStatus === '출석' ? 'tag-present' :
                   attStatus === '결석' ? 'tag-absent' :
                   attStatus === '지각' ? 'tag-late' : 'tag-pending';
        const showTime = (attStatus === '출석' || attStatus === '지각') && arrivalTime;
        tagText = showTime ? `${displayStatus} ${formatTime12h(arrivalTime)}` : displayStatus;
    }

    const hasSibling = state.siblingMap[studentId]?.size > 0;
    const siblingNames = hasSibling ? [...new Set([...state.siblingMap[studentId]].map(sid => state.allStudents.find(x => x.docId === sid)?.name).filter(Boolean))].join(', ') : '';
    const siblingHtml = hasSibling ? `<span class="tag tag-sibling"><span class="material-symbols-outlined" style="font-size:13px;">group</span> ${esc(siblingNames)}</span>` : '';

    document.getElementById('profile-tags').innerHTML = `
        <span class="tag tag-status ${tagClass}" ${isWithdrawn ? 'style="background:#dc2626;color:#fff;"' : ''}>${esc(tagText)}</span>
        ${siblingHtml}
    `;

    // 재원현황 (프로필 내 표시)
    const stayStatsEl = document.getElementById('profile-stay-stats');
    if (stayStatsEl) stayStatsEl.innerHTML = buildStayStatsHtml(student);

    // 카드들 렌더링
    const cardsContainer = document.getElementById('detail-cards');
    const studentHwTasks = state.hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const studentTestTasks = state.testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');

    // 등원 일정 카드 — 요일 + 시간 표시 (휴원 학생 미표시)
    const semesterEnrollments = student.enrollments;
    const dayNameForDetail = getDayName(state.selectedDate);
    const arrivalTimeHtml = (isLeaveStudent || isWithdrawn) ? '' : semesterEnrollments.length > 0 ? `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">schedule</span>
                등원 일정
            </div>
            ${semesterEnrollments.map(e => {
                const idx = student.enrollments.indexOf(e);
                const code = enrollmentCode(e);
                const ct = e.class_type || '정규';
                const days = (e.day || []).join('·');
                const classDefault = state.classSettings[code]?.default_time || '';
                const individual = e.start_time || e.time || '';
                const isDefault = !individual || individual === classDefault;
                const displayTime = isDefault ? classDefault : individual;
                const isToday = (e.day || []).includes(dayNameForDetail);
                const periodStr = ct !== '정규' && e.end_date ? ` ~${e.end_date.slice(5)}` : '';
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;${isToday ? 'font-weight:600;' : 'opacity:0.7;'}">
                    <span style="font-size:13px;min-width:40px;">${esc(code)}</span>
                    ${ct !== '정규' ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:${ct === '내신' ? 'var(--warning)' : 'var(--info)'};color:#fff;">${esc(ct)}</span>` : ''}
                    <span style="font-size:12px;min-width:50px;color:var(--text-sec);">${esc(days)}</span>
                    <span style="font-size:13px;">${displayTime ? esc(formatTime12h(displayTime)) : '-'}</span>
                    ${periodStr ? `<span style="font-size:10px;color:var(--text-sec);">${esc(periodStr)}</span>` : ''}
                    ${isToday ? '<span style="font-size:10px;color:var(--primary);font-weight:600;">오늘</span>' : ''}
                    <span class="material-symbols-outlined" style="font-size:14px;color:var(--text-sec);cursor:pointer;margin-left:auto;" onclick="openEnrollmentModal('${escAttr(studentId)}', ${idx})">edit</span>
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
                <span class="material-symbols-outlined" style="color:${
                    attStatus === '결석' ? 'var(--danger)' :
                    attStatus === '지각' ? 'var(--warning)' : 'var(--outline)'
                };font-size:18px;">${
                    attStatus === '결석' ? 'cancel' :
                    attStatus === '지각' ? 'schedule' : 'info'
                }</span>
                ${esc(attStatus)} 사유
            </div>
            <textarea class="field-input" style="width:100%;min-height:48px;resize:vertical;"
                placeholder="${esc(attStatus)} 사유를 입력하세요..."
                onchange="handleAttendanceChange('${studentId}', 'reason', this.value)">${esc(rec?.attendance?.reason || '')}</textarea>
        </div>
    ` : '';

    // 영역 숙제 현황 카드
    const isAttended = isAttendedStatus(attStatus);
    const detailDomains = isAttended ? getStudentDomains(studentId) : [];
    const d1st = isAttended ? (rec.hw_domains_1st || {}) : {};
    const d2nd = isAttended ? (rec.hw_domains_2nd || {}) : {};
    const hasAnyDomain = isAttended && (Object.values(d1st).some(v => v) || Object.values(d2nd).some(v => v));
    const has1stHw = isAttended && Object.values(d1st).some(v => v);
    const has2ndHw = isAttended && Object.values(d2nd).some(v => v);
    const domainHwHtml = !isAttended ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">domain_verification</span>
                영역별 숙제
            </div>
            ${!hasAnyDomain ? '<div class="detail-card-empty">영역 숙제 미입력</div>' : `
                <div class="detail-round-row">
                    ${has1stHw ? `<div class="detail-round-col">
                        <div class="detail-round-label">1차</div>
                        <div class="hw-domain-group">
                            ${detailDomains.map(d => {
                                const val = d1st[d] || '';
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>` : ''}
                    ${has2ndHw ? `<div class="detail-round-col">
                        <div class="detail-round-label">2차</div>
                        <div class="hw-domain-group">
                            ${detailDomains.filter(d => d1st[d] !== 'O').map(d => {
                                const val = d2nd[d] || '';
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('')}
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
    const domainTestHtml = !isAttended ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">quiz</span>
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
                                    <span style="font-size:10px;color:var(--text-sec);">${esc(secName)}</span>
                                    <div class="hw-domain-group" style="margin-bottom:2px;">
                                        ${filtered.map(t => {
                                            const val = data[t] || '';
                                            return `<div class="hw-domain-item">
                                                <span class="hw-domain-label">${esc(t)}</span>
                                                <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                                            </div>`;
                                        }).join('')}
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
    const studentClasses = student.enrollments
        .filter(e => e.day.includes(dayName2))
        .map(e => enrollmentCode(e))
        .filter(Boolean);
    const uniqueClasses = [...new Set(studentClasses)];
    const personalNextHw = rec.personal_next_hw || {};
    const nextHwHtml = uniqueClasses.length === 0 ? '' : `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">assignment</span>
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
                        return `<div class="next-hw-detail-row" style="margin-bottom:4px;cursor:pointer;" onclick="openPersonalNextHwModal('${escAttr(studentId)}', '${escAttr(cc)}', '${escAttr(d)}')">
                            <span class="next-hw-detail-label" style="min-width:40px;">${esc(d)}</span>
                            <span style="font-size:13px;color:${color};flex:1;">${esc(displayText)}</span>
                            ${hasPersonal ? '<span style="font-size:10px;color:var(--primary);">개인</span>' : ''}
                            <span class="material-symbols-outlined" style="font-size:14px;color:var(--outline);">edit</span>
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
        ? (hasClinic ? '' : '')
        : `<span style="display:flex;gap:2px;">
            ${hasClinic ? `<button class="icon-btn" style="width:28px;height:28px;" onclick="clearExtraVisit('${escAttr(studentId)}')"><span class="material-symbols-outlined" style="font-size:18px;color:var(--danger);">close</span></button>` : ''}
            <button class="icon-btn" style="width:28px;height:28px;" onclick="addExtraVisit('${escAttr(studentId)}')"><span class="material-symbols-outlined" style="font-size:18px;">add</span></button>
        </span>`;
    const extraVisitHtml = `
        <div class="detail-card">
            <div class="detail-card-title" style="display:flex;align-items:center;justify-content:space-between;">
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">schedule</span>
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
        const enrollInfo = student.enrollments.map((e, idx) => {
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
                <span class="material-symbols-outlined" style="font-size:14px;color:var(--text-sec);cursor:pointer;margin-left:auto;" onclick="openEnrollmentModal('${escAttr(studentId)}', ${idx})">edit</span>
            </div>`;
        }).join('');
        withdrawnHtml = `
            <div class="detail-card" style="border-left:3px solid #dc2626;">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:#dc2626;font-size:18px;">person_off</span>
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
                    <span class="material-symbols-outlined" style="color:var(--text-sec);font-size:18px;">school</span>
                    수강 이력
                </div>
                ${enrollInfo}
            </div>` : ''}
            ${renderLeaveRequestCard(studentId)}
            ${renderAbsenceRecordCard(studentId)}
            ${renderUnifiedMemoCard(studentId)}`;
    }

    cardsContainer.innerHTML = isWithdrawn ? withdrawnHtml : `
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

        <!-- 숙제 미통과 카드 (출석 학생만) -->
        ${isAttended ? renderHwFailActionCard(studentId, detailDomains, d2nd, rec.hw_fail_action || {}, has2ndHw ? 'default' : '1st_only') : ''}

        <!-- 테스트 미통과 카드 (출석 학생만) -->
        ${isAttended ? renderTestFailActionCard(studentId, detailTestSections, t2nd, rec.test_fail_action || {}, has2ndTest ? 'default' : '1st_only') : ''}

        <!-- 밀린 Task 카드 (숙제 + 테스트) -->
        ${renderPendingTasksCard(studentId, [...studentHwTasks, ...studentTestTasks])}

        <!-- 결석대장 카드 -->
        ${renderAbsenceRecordCard(studentId)}

        <!-- 휴퇴원요청서 카드 -->
        ${renderLeaveRequestCard(studentId)}

        <!-- 클리닉 카드 -->
        ${extraVisitHtml}

        <!-- 메모 카드 (통합) -->
        ${renderUnifiedMemoCard(studentId)}
    `;

    // 탭 상태 복원
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) {
        tabsEl.querySelectorAll('.detail-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === state.detailTab);
        });
    }
    document.getElementById('detail-cards').style.display = state.detailTab === 'daily' ? '' : 'none';
    const reportTabEl = document.getElementById('report-tab');
    if (reportTabEl) reportTabEl.style.display = state.detailTab === 'report' ? '' : 'none';
    const scoreTabEl = document.getElementById('score-tab');
    if (scoreTabEl) {
        scoreTabEl.style.display = state.detailTab === 'score' ? '' : 'none';
        if (state.detailTab === 'score') loadScoreCard();
    }

    // 결석대장 카드 expanded 상태 복원
    _restoreExpandedAbsenceIndices(expandedAbsenceIndices);

    // 모바일에서 패널 보이기
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

// ─── 클리닉 저장 ────────────────────────────────────────────────────────────
// + 버튼 클릭 시 오늘 날짜를 바로 박지 않도록 pending 플래그(state) 사용

// 클리닉 date/time/reason input 렌더 헬퍼 (daily-ops + naesin/teukang 공용)
export function renderClinicInputs(studentId, extraVisit, isReadonly) {
    const v = extraVisit || {};
    const dateOn = isReadonly ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'date', this.value)"`;
    const timeOn = isReadonly ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'time', this.value)"`;
    const reasonOn = isReadonly ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'reason', this.value)"`;
    return `<div style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;">
            <input type="date" class="field-input" style="flex:1;padding:4px 8px;font-size:12px;"
                value="${escAttr(v.date || '')}" ${dateOn}>
            <input type="time" class="field-input" style="width:100px;padding:4px 8px;font-size:12px;"
                value="${escAttr(v.time || '')}" ${timeOn}>
        </div>
        <input type="text" class="field-input" style="width:100%;padding:4px 8px;font-size:12px;"
            placeholder="사유 (예: 보충수업, 재시험 등)"
            value="${escAttr(v.reason || '')}" ${reasonOn}>
    </div>`;
}

export async function saveExtraVisit(studentId, field, value) {
    // 날짜가 입력되면 pending 해제
    if (field === 'date' && value) state._pendingClinicStudentId = null;
    const rec = state.dailyRecords[studentId] || {};
    const extraVisit = { ...(rec.extra_visit || {}) };
    extraVisit[field] = value;

    // 로컬 캐시 업데이트
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    state.dailyRecords[studentId].extra_visit = extraVisit;

    // 현재 날짜 레코드에 저장 (상세 패널 표시용)
    saveDailyRecord(studentId, { extra_visit: extraVisit });

    // 타겟 날짜가 다르면 타겟 날짜 레코드에도 저장 (등원예정 목록 표시용)
    const targetDate = extraVisit.date;
    if (targetDate && targetDate !== state.selectedDate) {
        const docId = makeDailyRecordId(studentId, targetDate);
        const student = state.allStudents.find(s => s.docId === studentId);
        try {
            await auditSet(doc(db, 'daily_records', docId), {
                student_id: studentId,
                date: targetDate,
                branch: branchFromStudent(student || {}),
                extra_visit: extraVisit
            }, { merge: true });
        } catch (err) {
            console.error('클리닉 미래 날짜 저장 실패:', err);
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
    if (rec) delete rec.extra_visit;
    await saveImmediately(studentId, { extra_visit: deleteField() });
    renderStudentDetail(studentId);
    renderSubFilters();
    renderListPanel();
}

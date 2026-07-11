// ─── 반 계획 패널 (정규/내신 공용) ─────────────────────────────────────────
// 정규반 분석 / 내신반 계획 렌더링 + CSV·XLSX 내보내기.
// 입력은 allStudents + 모드(wizardData.classType)뿐. window 노출: renderPlanner / downloadPlanCsv / downloadPlanXlsx.
import * as XLSX from 'xlsx';
import {
    currentSchool,
    studentGrade,
    studentLevel,
    todayStr,
    studentShortLabel,
    ACTIVE_STUDENT_STATUSES,
} from './src/shared/firestore-helpers.js';
import { DAY_ORDER, LEAVE_STATUSES } from './state.js';
import { uniquePlanningEnrollments } from './class-setup-enrollment.js';
import { esc } from './ui-utils.js';
import { enrollmentCode } from './student-core.js';
import { wizardData, allStudents, showToast, popPerms } from './class-setup-state.js';
import { csvCell, safeCell } from './src/shared/csv.js';
import { branchFromClassNumber } from '@impact7/shared/branch';

// mode: '정규' (자유학기 포함) | '내신'
export function initPlanner(mode) {
    populatePlannerFilters(mode);
    renderPlanner();
}

function makeBaseRow(student) {
    return {
        docId: student.docId,
        name: student.name || '',
        // 학생 식별/표시는 항상 studentShortLabel 사용 (예: "양정중2")
        shortLabel: studentShortLabel(student),
        branch: getStudentBranch(student),
        school: normalizeText(currentSchool(student), '학교 미지정'),
        level: normalizeText(studentLevel(student), '학부 미지정'),
        grade: normalizeGrade(studentGrade(student)),
        phone: student.parent_phone_1 || student.student_phone || '',
        status: student.status || '',
    };
}

function isOnLeaveStatus(status) {
    return LEAVE_STATUSES.includes(status);
}

// 다운로드용 이름 라벨 — 휴원생은 (실휴원)/(가휴원) 접미사로 구분
function formatPlannerStudentLabel(row) {
    if (isOnLeaveStatus(row.status)) return `${row.name} (${row.status})`;
    return row.name;
}

// 정규 모드: enrollment(반) 단위로 펼친 row (한 학생이 N개 반에 등록되면 N개 row)
// 내신 모드: 학생 단위 row (한 학생당 1개)
function getPlannerRows(mode) {
    const active = allStudents.filter(s => ACTIVE_STUDENT_STATUSES.has(s.status));
    if (mode === '정규') {
        return active.flatMap(s =>
            getPlanningEnrollments(s).map(e => {
                const code = enrollmentCode(e);
                const days = Array.isArray(e.day) ? e.day.filter(d => DAY_ORDER.includes(d)) : [];
                return {
                    ...makeBaseRow(s),
                    days,
                    dayKey: days.length ? days.join(',') : '요일 미지정',
                    classCode: code || '반 미지정',
                    classes: code,
                };
            })
        ).sort(comparePlannerRows);
    }
    return active.map(s => {
        const days = getPlanningDays(s);
        return {
            ...makeBaseRow(s),
            days,
            dayKey: days.length ? days.join(',') : '요일 미지정',
            classes: getPlanningClassCodes(s).join(', '),
        };
    }).sort(comparePlannerRows);
}

function getStudentBranch(student) {
    const direct = String(student.branch || '').trim();
    if (direct === '2단지' || direct === '10단지') return direct;
    // class_number → 단지 파생은 shared 규칙 재사용 (내신 csKey '10단지…' 접두 우선 처리 포함)
    for (const e of getPlanningEnrollments(student)) {
        const branch = branchFromClassNumber(e.class_number);
        if (branch) return branch;
    }
    return '소속 미지정';
}

function getPlanningEnrollments(student) {
    return uniquePlanningEnrollments(student.enrollments, todayStr());
}

function getPlanningDays(student) {
    const set = new Set();
    getPlanningEnrollments(student).forEach(e => {
        (Array.isArray(e.day) ? e.day : []).forEach(day => {
            if (DAY_ORDER.includes(day)) set.add(day);
        });
    });
    return DAY_ORDER.filter(day => set.has(day));
}

function getPlanningClassCodes(student) {
    const set = new Set();
    getPlanningEnrollments(student).forEach(e => {
        const code = enrollmentCode(e);
        if (code) set.add(code);
    });
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

function populatePlannerFilters(mode) {
    const rows = getPlannerRows(mode);
    fillPlannerSelect('planner-filter-branch', '전체 소속', uniqueSorted(rows.map(r => r.branch), compareBranch));
    fillPlannerSelect('planner-filter-level', '전체 학부', uniqueSorted(rows.map(r => r.level), compareLevel));
    if (mode === '내신') {
        fillPlannerSelect('planner-filter-school', '전체 학교', uniqueSorted(rows.map(r => r.school)));
        fillPlannerSelect('planner-filter-grade', '전체 학년', uniqueSorted(rows.map(r => r.grade), compareGrade));
        fillPlannerSelect('planner-filter-day', '전체 요일', DAY_ORDER);
    }
}

function compareBranch(a, b) {
    const order = ['2단지', '10단지', '소속 미지정'];
    return order.indexOf(a) - order.indexOf(b) || a.localeCompare(b, 'ko');
}

function fillPlannerSelect(id, allLabel, values) {
    const el = document.getElementById(id);
    const current = el.value;
    el.innerHTML = `<option value="">${esc(allLabel)}</option>` +
        values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if ([...el.options].some(o => o.value === current)) el.value = current;
}

function getCurrentPlannerMode() {
    const t = wizardData.classType;
    return (t === '내신') ? '내신' : '정규';
}

function getFilteredPlannerRows(mode, allRows) {
    const branch = document.getElementById('planner-filter-branch')?.value || '';
    const level = document.getElementById('planner-filter-level')?.value || '';
    const school = (mode === '내신') ? (document.getElementById('planner-filter-school')?.value || '') : '';
    const grade = (mode === '내신') ? (document.getElementById('planner-filter-grade')?.value || '') : '';
    const day = (mode === '내신') ? (document.getElementById('planner-filter-day')?.value || '') : '';
    return (allRows || getPlannerRows(mode)).filter(r =>
        (!branch || r.branch === branch) &&
        (!level || r.level === level) &&
        (!school || r.school === school) &&
        (!grade || r.grade === grade) &&
        (!day || r.days.includes(day))
    );
}

function groupBy(rows, keyFn) {
    const grouped = new Map();
    rows.forEach(row => {
        const key = keyFn(row);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    });
    return grouped;
}

function renderPlannerGroups(grouped, { titleFn = (k) => k, metaFn }) {
    return [...grouped.entries()].map(([key, groupRows]) => {
        const studentHtml = groupRows.map(row => {
            const onLeave = isOnLeaveStatus(row.status);
            const leaveClass = onLeave ? ' planner-student--leave' : '';
            const leaveTag = onLeave ? `<span class="planner-leave-tag">${esc(row.status)}</span>` : '';
            return `<div class="planner-student${leaveClass}">
                <span class="planner-student-name">${esc(row.name)}${leaveTag}</span>
                <span class="planner-student-meta">${esc(metaFn(row))}</span>
            </div>`;
        }).join('');
        return `
            <section class="planner-group">
                <div class="planner-group-head">
                    <div class="planner-group-title">${esc(titleFn(key))}</div>
                    ${popPerms.classCounts ? `<span class="planner-count">${groupRows.length}명</span>` : ''}
                </div>
                <div class="planner-student-list">${studentHtml}</div>
            </section>
        `;
    }).join('');
}

function plannerCountSuffix(built) {
    return popPerms.classCounts ? ` (${built.studentCount}명, ${built.groupCount}그룹)` : '';
}

function renderPlanner() {
    const mode = getCurrentPlannerMode();
    const allRows = getPlannerRows(mode);
    const rows = getFilteredPlannerRows(mode, allRows);
    const stats = document.getElementById('planner-stats');
    const groups = document.getElementById('planner-groups');
    const totalRows = allRows.length;
    // 전체 재원생/등록 총수는 인원현황(기밀) — 권한자만 표시
    if (popPerms.all) {
        stats.textContent = (mode === '정규')
            ? `표시 ${rows.length}건 / 정규 등록 ${totalRows}건`
            : `표시 ${rows.length}명 / 재원생 ${totalRows}명`;
    } else {
        stats.textContent = '';
    }

    if (rows.length === 0) {
        groups.innerHTML = '<div class="planner-empty">조건에 맞는 학생이 없습니다.</div>';
        return;
    }

    if (mode === '정규') {
        const grouped = groupBy(rows, row => row.classCode);
        const sorted = new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')));
        groups.innerHTML = renderPlannerGroups(sorted, {
            metaFn: row => `${row.shortLabel} · ${row.branch}`,
        });
        return;
    }

    const grouped = groupBy(rows, row => [row.branch, row.level, row.school, row.grade, row.dayKey].join('|'));
    groups.innerHTML = renderPlannerGroups(grouped, {
        titleFn: key => key.split('|').join(' · '),
        metaFn: row => row.classes || '반 미지정',
    });
}
window.renderPlanner = renderPlanner;

/**
 * 필터된 row들을 그룹별로 묶어 (컬럼=그룹, 행=학생) 2D 매트릭스로 변환.
 * 내신: 헤더 5행(소속/학부/학교/학년/요일), 정규: 헤더 1행(반 코드).
 */
function buildPlannerMatrix(mode) {
    const rows = getFilteredPlannerRows(mode);
    if (rows.length === 0) return null;

    if (mode === '정규') {
        const groupMap = new Map();
        rows.forEach(r => {
            const key = r.classCode;
            if (!groupMap.has(key)) groupMap.set(key, { code: key, names: [] });
            groupMap.get(key).names.push(formatPlannerStudentLabel(r));
        });
        const groups = [...groupMap.values()].sort((a, b) => a.code.localeCompare(b.code, 'ko'));
        const maxNames = Math.max(...groups.map(g => g.names.length), 0);
        const HEADER_ROWS = 1;
        const totalRows = HEADER_ROWS + maxNames;
        const matrix = Array.from({ length: totalRows }, () => Array(groups.length).fill(''));
        groups.forEach((g, c) => {
            matrix[0][c] = g.code;
            g.names.forEach((name, i) => { matrix[HEADER_ROWS + i][c] = name; });
        });
        return { matrix, groupCount: groups.length, studentCount: rows.length };
    }

    // 내신
    const groupMap = new Map();
    rows.forEach(r => {
        const key = [r.branch, r.level, r.school, r.grade, r.dayKey].join('|');
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                branch: r.branch,
                level: r.level,
                school: r.school,
                grade: r.grade,
                dayKey: r.dayKey,
                names: [],
            });
        }
        groupMap.get(key).names.push(formatPlannerStudentLabel(r));
    });

    const groups = [...groupMap.values()];
    const maxNames = Math.max(...groups.map(g => g.names.length), 0);
    const HEADER_ROWS = 5; // 소속 / 학부 / 학교 / 학년 / 요일
    const totalRows = HEADER_ROWS + maxNames;

    const matrix = Array.from({ length: totalRows }, () => Array(groups.length).fill(''));
    groups.forEach((g, c) => {
        matrix[0][c] = g.branch;
        matrix[1][c] = g.level;
        matrix[2][c] = g.school;
        matrix[3][c] = g.grade;
        matrix[4][c] = g.dayKey;
        g.names.forEach((name, i) => {
            matrix[HEADER_ROWS + i][c] = name;
        });
    });

    return { matrix, groupCount: groups.length, studentCount: rows.length };
}

function _plannerExportLabel(mode) {
    return mode === '내신' ? '내신반 계획' : '정규반 분석';
}

window.downloadPlanCsv = function () {
    const mode = getCurrentPlannerMode();
    const built = buildPlannerMatrix(mode);
    if (!built) {
        showToast('다운로드할 학생이 없습니다.', 'error');
        return;
    }
    const label = _plannerExportLabel(mode);
    const csv = '\uFEFF' + built.matrix.map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label.replace(/ /g, '_')}_${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`${label} CSV 다운로드${plannerCountSuffix(built)}`, 'success');
};

window.downloadPlanXlsx = function () {
    const mode = getCurrentPlannerMode();
    const built = buildPlannerMatrix(mode);
    if (!built) {
        showToast('다운로드할 학생이 없습니다.', 'error');
        return;
    }
    const label = _plannerExportLabel(mode);
    const safeMatrix = built.matrix.map(row => row.map(safeCell));
    const ws = XLSX.utils.aoa_to_sheet(safeMatrix);
    ws['!cols'] = safeMatrix[0].map((_, c) => {
        const maxLen = safeMatrix.reduce((m, row) => Math.max(m, row[c].length), 0);
        return { wch: Math.min(Math.max(maxLen + 2, 8), 24) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, label);
    XLSX.writeFile(wb, `${label.replace(/ /g, '_')}_${todayStr()}.xlsx`);
    showToast(`${label} Excel 다운로드${plannerCountSuffix(built)}`, 'success');
};

function normalizeText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function normalizeGrade(value) {
    const text = String(value || '').trim();
    if (!text) return '학년 미지정';
    return text.endsWith('학년') ? text : `${text}학년`;
}

function uniqueSorted(values, compareFn) {
    return [...new Set(values.filter(Boolean))].sort(compareFn || ((a, b) => a.localeCompare(b, 'ko')));
}

function comparePlannerRows(a, b) {
    return compareBranch(a.branch, b.branch) ||
        compareLevel(a.level, b.level) ||
        a.school.localeCompare(b.school, 'ko') ||
        compareGrade(a.grade, b.grade) ||
        compareDayKey(a.dayKey, b.dayKey) ||
        a.name.localeCompare(b.name, 'ko');
}

function compareLevel(a, b) {
    const order = ['초등', '중등', '고등', '학부 미지정'];
    return order.indexOf(a) - order.indexOf(b) || a.localeCompare(b, 'ko');
}

function compareGrade(a, b) {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.localeCompare(b, 'ko');
}

function compareDayKey(a, b) {
    const score = (key) => {
        const parts = key.split(',');
        return DAY_ORDER.reduce((sum, day, idx) => sum + (parts.includes(day) ? idx + 1 : 0), 0);
    };
    return score(a) - score(b) || a.localeCompare(b, 'ko');
}


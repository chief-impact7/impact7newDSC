import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc, getDoc, writeBatch, arrayUnion
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { auth, db } from './firebase-config.js';
import { signInWithGoogle, logout } from './auth.js';
import { todayStr, studentShortLabel, ACTIVE_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { LEAVE_STATUSES, LEVEL_SHORT } from './state.js';
import { buildNaesinCsKey } from './student-helpers.js';
import { schoolSearchTerms } from './school-normalizer.js';
import { batchSet, batchUpdate } from './audit.js';

const CLASS_TYPE_LABELS = {
    '정규': '정규반',
    '내신': '내신반',
    '자유학기': '자유학기반',
    '특강': '특강',
};

function setStepTitle(id, suffix) {
    const el = document.getElementById(id);
    if (!el) return;
    const label = CLASS_TYPE_LABELS[wizardData.classType] || '반';
    el.textContent = `${label} ${suffix}`;
}

// ─── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentStep = 1;
const TOTAL_STEPS = 2;
const PLANNER_DAYS = ['월', '화', '수', '목', '금', '토', '일'];

// 마법사 데이터
const wizardData = {
    classType: '',       // '정규' | '내신' | '자유학기' | '특강'
    feeType: '',         // 특강 전용: '유료' | '무료'
    classCode: '',       // 생성될 반 코드
    levelSymbol: '',
    classNumber: '',
    school: '',
    grade: '',
    naesinBranch: '',
    naesinLevel: '',
    naesinGroup: '',
    specialName: '',
    naesinStart: '',
    naesinEnd: '',
    specialStart: '',
    specialEnd: '',
    freeStart: '',
    freeEnd: '',
    teacher: '',
    students: [],        // [{ docId, name, school, grade, status, enrollments }]
    days: [],            // ['월', '수', '금']
    schedule: {},        // { '월': '16:00', '수': '16:00' }
};

let allStudents = [];
let teachersList = [];


// ─── Auth ───────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const email = user.email || '';
        if (!email.endsWith('@gw.impact7.kr') && !email.endsWith('@impact7.kr')) {
            await logout();
            showToast('허용되지 않은 계정입니다.', 'error');
            return;
        }
        currentUser = user;
        window._auditUser = email;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = email.split('@')[0];
        await Promise.all([loadStudents(), loadTeachers()]);
        bindStudentEventDelegation();
        // 학생 로드 도중 step 2 진입(정규 카드 빠르게 클릭)했을 수 있음 — 빈 데이터로 그려진
        // 정규반 분석/학생 추가 패널을 재렌더해 채워준다.
        if (currentStep === 2) onEnterStep2();
    } else {
        currentUser = null;
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

async function loadStudents() {
    const snap = await getDocs(collection(db, 'students'));
    allStudents = [];
    snap.forEach(d => {
        const data = d.data();
        allStudents.push({ docId: d.id, ...data });
    });
    allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
}

// ─── 반 계획 패널 (정규/내신 공용) ─────────────────────────────────────────
// mode: '정규' (자유학기 포함) | '내신'
function initPlanner(mode) {
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
        school: normalizeText(student.school, '학교 미지정'),
        level: normalizeText(student.level, '학부 미지정'),
        grade: normalizeGrade(student.grade),
        phone: student.parent_phone_1 || student.student_phone || '',
        status: student.status || '',
    };
}

function isOnLeaveStatus(status) {
    return status === '실휴원' || status === '가휴원';
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
                const code = `${e.level_symbol || ''}${e.class_number || ''}`.trim();
                const days = Array.isArray(e.day) ? e.day.filter(d => PLANNER_DAYS.includes(d)) : [];
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
    // class_number 첫 자리로 추론 (RULES.md): 1→2단지, 2→10단지
    const enrolls = getPlanningEnrollments(student);
    for (const e of enrolls) {
        const head = String(e.class_number || '').trim().charAt(0);
        if (head === '1') return '2단지';
        if (head === '2') return '10단지';
    }
    return '소속 미지정';
}

function getPlanningEnrollments(student) {
    const today = todayStr();
    // class_type이 명시적으로 정규/자유학기인 것만 — fallback('|| 정규') 제거.
    // 잔존 enrollment(class_type 누락 또는 비정규 형식)가 정규로 오인되어 "반 미지정" 또는
    // 학교+학년 형식 그룹으로 흡수되던 문제 차단 (feedback_naesin_regular_identification.md).
    return (student.enrollments || []).filter(e => {
        if (e.class_type !== '정규' && e.class_type !== '자유학기') return false;
        return !e.end_date || e.end_date >= today;
    });
}

function getPlanningDays(student) {
    const set = new Set();
    getPlanningEnrollments(student).forEach(e => {
        (Array.isArray(e.day) ? e.day : []).forEach(day => {
            if (PLANNER_DAYS.includes(day)) set.add(day);
        });
    });
    return PLANNER_DAYS.filter(day => set.has(day));
}

function getPlanningClassCodes(student) {
    const set = new Set();
    getPlanningEnrollments(student).forEach(e => {
        const code = `${e.level_symbol || ''}${e.class_number || ''}`.trim();
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
        fillPlannerSelect('planner-filter-day', '전체 요일', PLANNER_DAYS);
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

function getFilteredPlannerRows(mode) {
    const branch = document.getElementById('planner-filter-branch')?.value || '';
    const level = document.getElementById('planner-filter-level')?.value || '';
    const school = (mode === '내신') ? (document.getElementById('planner-filter-school')?.value || '') : '';
    const grade = (mode === '내신') ? (document.getElementById('planner-filter-grade')?.value || '') : '';
    const day = (mode === '내신') ? (document.getElementById('planner-filter-day')?.value || '') : '';
    return getPlannerRows(mode).filter(r =>
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
                    <span class="planner-count">${groupRows.length}명</span>
                </div>
                <div class="planner-student-list">${studentHtml}</div>
            </section>
        `;
    }).join('');
}

function renderPlanner() {
    const mode = getCurrentPlannerMode();
    const rows = getFilteredPlannerRows(mode);
    const stats = document.getElementById('planner-stats');
    const groups = document.getElementById('planner-groups');
    const totalRows = getPlannerRows(mode).length;
    stats.textContent = (mode === '정규')
        ? `표시 ${rows.length}건 / 정규 등록 ${totalRows}건`
        : `표시 ${rows.length}명 / 재원생 ${totalRows}명`;

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
    showToast(`${label} CSV 다운로드 (${built.studentCount}명, ${built.groupCount}그룹)`, 'success');
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
    showToast(`${label} Excel 다운로드 (${built.studentCount}명, ${built.groupCount}그룹)`, 'success');
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
    const score = (key) => PLANNER_DAYS.reduce((sum, day, idx) => sum + (key.includes(day) ? idx + 1 : 0), 0);
    return score(a) - score(b) || a.localeCompare(b, 'ko');
}

// 셀 내용이 =, +, -, @, 탭, CR로 시작하면 Excel/Sheets가 수식으로 평가하므로
// 작은따옴표 prefix를 부착해 텍스트로 강제한다 (CSV/XLSX 공용).
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function safeCell(value) {
    const s = String(value ?? '');
    return FORMULA_TRIGGER.test(s) ? "'" + s : s;
}

function csvCell(value) {
    return `"${safeCell(value).replace(/"/g, '""')}"`;
}

async function loadTeachers() {
    const snap = await getDocs(collection(db, 'teachers'));
    teachersList = [];
    snap.forEach(d => teachersList.push({ email: d.id, ...d.data() }));
    teachersList.sort((a, b) =>
        (a.display_name || a.email).localeCompare(b.display_name || b.email, 'ko')
    );
    // 선생님 드롭다운 채우기
    const sel = document.getElementById('input-teacher');
    sel.innerHTML = '<option value="">선택</option>' +
        teachersList.map(t =>
            `<option value="${esc(t.email)}">${esc(t.email.split('@')[0])}</option>`
        ).join('');
}

// ─── Navigation ─────────────────────────────────────────────────────────────
function goToStep(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    document.getElementById(`step-${currentStep}`).style.display = 'none';
    currentStep = step;
    document.getElementById(`step-${currentStep}`).style.display = '';

    document.querySelectorAll('.progress-step').forEach((el, i) => {
        const s = i + 1;
        el.classList.toggle('active', s === currentStep);
        el.classList.toggle('done', s < currentStep);
    });
    document.querySelectorAll('.progress-line').forEach((el, i) => {
        el.classList.toggle('done', i + 1 < currentStep);
    });

    document.getElementById('btn-back').style.display = currentStep === 1 ? 'none' : '';
    document.getElementById('btn-submit').style.display = currentStep === TOTAL_STEPS ? '' : 'none';

    if (currentStep === 2) onEnterStep2();
}

window.prevStep = function () {
    goToStep(currentStep - 1);
};

// DOM에서 wizardData로 모든 form 데이터를 한 번에 끌어모은다 (부수효과 전용).
function collectFormData() {
    buildClassCode();
    wizardData.teacher = document.getElementById('input-teacher').value;
    wizardData.schedule = Object.fromEntries(
        wizardData.days.map(day => [
            day,
            document.getElementById(`time-${day}`)?.value || '16:00',
        ])
    );
}

// wizardData만 검사하는 순수 검증기 (부수효과 없음).
function validateForm() {
    if (!wizardData.classCode) {
        showToast('반 이름 정보를 입력하세요.', 'error');
        return false;
    }
    // class_type ↔ 반 코드 정합성 가드:
    // 정규/자유학기는 레벨(level_symbol)과 반 번호(class_number)가 모두 명시되어야 한다.
    // 한쪽만 입력된 채 등록되면 정채리 케이스처럼 "정규인데 반 미지정" placeholder가 생긴다.
    if (wizardData.classType === '정규' || wizardData.classType === '자유학기') {
        if (!wizardData.levelSymbol || !wizardData.classNumber) {
            showToast(`${wizardData.classType} 반은 레벨과 반 번호를 모두 입력해야 합니다.`, 'error');
            return false;
        }
    }
    if (wizardData.classType === '특강' && !wizardData.feeType) {
        showToast('유료/무료를 선택하세요.', 'error');
        return false;
    }
    if (wizardData.students.length === 0) {
        showToast('학생을 1명 이상 추가하세요.', 'error');
        return false;
    }
    if (wizardData.days.length === 0) {
        showToast('요일을 1개 이상 선택하세요.', 'error');
        return false;
    }
    return true;
}

// ─── Step 1: 반 유형 ────────────────────────────────────────────────────────
// 카드 클릭 시 type 저장 → 자동으로 Step 2 진행. 서로 다른 type으로 전환 시 stale 데이터 reset.
window.chooseClassTypeAndAdvance = function (type) {
    if (wizardData.classType && wizardData.classType !== type) {
        resetWizardForTypeChange();
    }
    wizardData.classType = type;
    document.querySelectorAll('.type-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.type === type);
    });
    goToStep(2);
};

// 타입 전환 시 stale 데이터 누적을 막기 위해 type 외 모든 wizardData 필드와
// 관련 DOM(input value, day-chip/fee-btn .selected)을 초기화한다.
// classType 자체는 호출자가 직후에 새 값으로 덮어쓴다.
function resetWizardForTypeChange() {
    Object.assign(wizardData, {
        feeType: '', classCode: '',
        levelSymbol: '', classNumber: '',
        school: '', grade: '',
        naesinBranch: '', naesinLevel: '', naesinGroup: '',
        specialName: '',
        naesinStart: '', naesinEnd: '',
        specialStart: '', specialEnd: '',
        freeStart: '', freeEnd: '',
        teacher: '',
        students: [], days: [], schedule: {},
    });

    [
        'input-level', 'input-class-number',
        'input-free-start', 'input-free-end',
        'input-naesin-branch', 'input-naesin-level',
        'input-school', 'input-grade', 'input-naesin-group',
        'input-naesin-start', 'input-naesin-end',
        'input-special-name', 'input-special-start', 'input-special-end',
        'input-teacher',
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.fee-type-btn').forEach(c => c.classList.remove('selected'));

    ['regular-preview', 'naesin-preview', 'special-preview'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

// ─── Step 2: 반 이름 ────────────────────────────────────────────────────────
function onEnterStep2() {
    const t = wizardData.classType;
    toggleNameForms(t);
    refreshStepTitles();
    togglePlannerPanel(t);

    renderSelectedStudents();
    renderTimeSettings();
    renderSummary();

    bindDateValidations();
    bindPreviewListeners();
    syncPreviewFromDom(t);
    restoreFeeButtonState(t);
}

function toggleNameForms(t) {
    document.getElementById('name-regular').style.display = (t === '정규' || t === '자유학기') ? '' : 'none';
    document.getElementById('name-naesin').style.display = t === '내신' ? '' : 'none';
    document.getElementById('name-special').style.display = t === '특강' ? '' : 'none';
    document.getElementById('free-semester-dates').style.display = t === '자유학기' ? '' : 'none';
}

function refreshStepTitles() {
    setStepTitle('step-2-title', '상세 설정');
    setStepTitle('section-title-name', '이름');
    setStepTitle('section-title-students', '학생 추가');
}

function togglePlannerPanel(t) {
    const showPlanner = (t === '내신' || t === '정규' || t === '자유학기');
    const mode = (t === '내신') ? '내신' : '정규';
    const body = document.getElementById('step-2-body');
    const planner = document.getElementById('planner-panel');
    if (planner) planner.style.display = showPlanner ? '' : 'none';
    if (body) body.classList.toggle('with-planner', showPlanner);
    if (!showPlanner) return;

    // 모드별 헤더 + 필터 가시성
    const titleEl = document.getElementById('planner-title');
    const subtitleEl = document.getElementById('planner-subtitle');
    if (titleEl) titleEl.textContent = (mode === '내신') ? '내신반 계획' : '정규반 분석';
    if (subtitleEl) subtitleEl.textContent = (mode === '내신')
        ? '재원생을 학교/학부/학년/요일로 분류해 보여줍니다.'
        : '재원생을 정규반(예: I102)별로 묶고 소속/학부로 필터합니다.';
    const showNaesinOnly = (mode === '내신');
    ['planner-filter-school', 'planner-filter-grade', 'planner-filter-day'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentElement) el.parentElement.style.display = showNaesinOnly ? '' : 'none';
    });
    // 다운로드 버튼은 정규/자유학기/내신 모두에서 노출
    const downloads = document.getElementById('planner-download-actions');
    if (downloads) downloads.style.display = '';

    initPlanner(mode);
    if (mode === '내신') populateSchoolList();
}

function bindDateValidations() {
    setupDateValidation('input-free-start', 'input-free-end');
    setupDateValidation('input-naesin-start', 'input-naesin-end');
    setupDateValidation('input-special-start', 'input-special-end');
}

// 동일 element-event 조합에 핸들러를 안전하게 재바인딩(중복 등록 방지).
function rebind(ids, events, handler) {
    (Array.isArray(ids) ? ids : [ids]).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        (Array.isArray(events) ? events : [events]).forEach(ev => {
            el.removeEventListener(ev, handler);
            el.addEventListener(ev, handler);
        });
    });
}

function bindPreviewListeners() {
    rebind(
        ['input-level', 'input-class-number', 'input-free-start', 'input-free-end'],
        ['input', 'change'], updateRegularPreview);
    rebind(
        ['input-naesin-branch', 'input-naesin-level', 'input-school', 'input-grade',
         'input-naesin-group', 'input-naesin-start', 'input-naesin-end'],
        ['input', 'change'], updateNaesinPreview);
    rebind(
        ['input-special-name', 'input-special-start', 'input-special-end'],
        ['input', 'change'], updateSpecialPreview);
    rebind('input-teacher', 'change', updateTeacherPreview);
}

// step 재진입 시 DOM 값을 wizardData로 강제 동기화하고 미리보기 갱신
function syncPreviewFromDom(t) {
    if (t === '정규' || t === '자유학기') updateRegularPreview();
    else if (t === '내신') updateNaesinPreview();
    else if (t === '특강') updateSpecialPreview();
    updateTeacherPreview();
}

function restoreFeeButtonState(t) {
    if (t !== '특강') return;
    document.querySelectorAll('.fee-type-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.fee === wizardData.feeType);
    });
}

function updateTeacherPreview() {
    wizardData.teacher = document.getElementById('input-teacher').value;
    renderSummary();
}

const _dateHandlers = new Map();
function setupDateValidation(startId, endId) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    const prev = _dateHandlers.get(startId);
    if (prev) startEl.removeEventListener('change', prev);
    const handler = () => {
        if (startEl.value) endEl.min = startEl.value;
        if (endEl.value && startEl.value && endEl.value < startEl.value) {
            endEl.value = startEl.value;
        }
    };
    _dateHandlers.set(startId, handler);
    startEl.addEventListener('change', handler);
    handler();
}

function updateRegularPreview() {
    const level = document.getElementById('input-level').value.trim();
    const num = document.getElementById('input-class-number').value.trim();
    const code = level && num ? `${level}${num}` : '';
    document.getElementById('regular-preview').textContent = code;
    wizardData.levelSymbol = level;
    wizardData.classNumber = num;
    wizardData.classCode = code;
    if (wizardData.classType === '자유학기') {
        wizardData.freeStart = document.getElementById('input-free-start').value;
        wizardData.freeEnd = document.getElementById('input-free-end').value;
    }
    renderSummary();
}

function updateNaesinPreview() {
    const code = buildClassCode();
    document.getElementById('naesin-preview').textContent = code || '';
    wizardData.naesinStart = document.getElementById('input-naesin-start').value;
    wizardData.naesinEnd = document.getElementById('input-naesin-end').value;
    populateSchoolList();
    renderSummary();
}

function updateSpecialPreview() {
    const name = document.getElementById('input-special-name').value.trim();
    document.getElementById('special-preview').textContent = name;
    wizardData.specialName = name;
    wizardData.specialStart = document.getElementById('input-special-start').value;
    wizardData.specialEnd = document.getElementById('input-special-end').value;
    wizardData.classCode = name;
    renderSummary();
}

window.selectFeeType = function (type) {
    wizardData.feeType = type;
    document.querySelectorAll('.fee-type-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.fee === type);
    });
    renderSummary();
};

function populateSchoolList() {
    const selectedShort = document.getElementById('input-naesin-level')?.value || '';
    const schools = new Set();
    allStudents.forEach(s => {
        const school = (s.school || '').trim();
        if (s.status !== '재원' || !school) return;
        if (selectedShort && LEVEL_SHORT[s.level] !== selectedShort) return;
        schools.add(school);
    });
    const dl = document.getElementById('school-list');
    dl.innerHTML = [...schools].sort((a, b) => a.localeCompare(b, 'ko'))
        .map(s => `<option value="${esc(s)}">`).join('');
}

function buildClassCode() {
    const t = wizardData.classType;
    if (t === '정규' || t === '자유학기') {
        const l = document.getElementById('input-level').value.trim();
        const n = document.getElementById('input-class-number').value.trim();
        if (!l || !n) return '';
        wizardData.classCode = `${l}${n}`;
        if (t === '자유학기') {
            wizardData.freeStart = document.getElementById('input-free-start').value;
            wizardData.freeEnd = document.getElementById('input-free-end').value;
        }
        return wizardData.classCode;
    }
    if (t === '내신') {
        const br = document.getElementById('input-naesin-branch').value;
        const lv = document.getElementById('input-naesin-level').value;
        const s = document.getElementById('input-school').value.trim();
        const g = document.getElementById('input-grade').value;
        const grp = document.getElementById('input-naesin-group').value;
        if (!br || !lv || !s || !g || !grp) return '';
        wizardData.naesinBranch = br;
        wizardData.naesinLevel = lv;
        wizardData.school = s;
        wizardData.grade = g;
        wizardData.naesinGroup = grp;
        wizardData.classCode = buildNaesinCsKey({ branch: br, school: s, level: lv, grade: g, group: grp });
        return wizardData.classCode;
    }
    if (t === '특강') {
        const name = document.getElementById('input-special-name').value.trim();
        if (!name) return '';
        wizardData.classCode = name;
        return wizardData.classCode;
    }
    return '';
}

// ─── 학생 추가 (Step 2 - students-section) ─────────────────────────────────
/** 전화번호 뒷 4자리 표시 (parent_phone_1 우선, 없으면 student_phone) */
function phoneSuffix(s) {
    const ph = s.parent_phone_1 || s.student_phone || '';
    const digits = ph.replace(/\D/g, '');
    if (digits.length < 4) return '';
    return ` (${digits.slice(-4)})`;
}

let _searchTimer = null;
window.searchStudents = function (q) {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => _doSearchStudents(q), 250);
};

function _doSearchStudents(q) {
    const results = document.getElementById('search-results');
    q = q.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    const selectedIds = new Set(wizardData.students.map(s => s.docId));
    const isSpecial = wizardData.classType === '특강';

    // 특강: 모든 상태 허용 (퇴원/종강 학생도 특강 수강 가능)
    // 기타 반 유형(정규/내신/자유학기): 활성 상태 + 휴원 제외
    //   — 정규의 일종이므로 휴원 중인 학생은 편성 대상 아님
    const filtered = allStudents
        .filter(s => {
            if (!isSpecial) {
                if (!ACTIVE_STUDENT_STATUSES.has(s.status)) return false;
                if (LEAVE_STATUSES.includes(s.status)) return false;
            }
            const name = (s.name || '').toLowerCase();
            const schoolTerms = schoolSearchTerms(s).map(t => t.toLowerCase());
            const codeMatches = (s.enrollments || []).some(e =>
                `${e.level_symbol || ''}${e.class_number || ''}`.toLowerCase().includes(q)
            );
            return name.includes(q) || schoolTerms.some(t => t.includes(q)) || codeMatches;
        })
        .sort((a, b) => {
            // 활성 학생 우선 → 이름순
            const aActive = ACTIVE_STUDENT_STATUSES.has(a.status) ? 0 : 1;
            const bActive = ACTIVE_STUDENT_STATUSES.has(b.status) ? 0 : 1;
            return aActive - bActive || (a.name || '').localeCompare(b.name || '', 'ko');
        })
        .slice(0, 20);

    const html = filtered.map(s => {
        const alreadySelected = selectedIds.has(s.docId);
        const isInactive = !ACTIVE_STUDENT_STATUSES.has(s.status);
        return `<div class="search-result-item ${alreadySelected ? 'already-selected' : ''}"
                     data-doc-id="${esc(s.docId)}">
                    <div class="result-info">
                        <span class="result-name">${esc(s.name)}</span>
                        <span class="result-meta">${esc(studentShortLabel(s))}${phoneSuffix(s)}</span>
                    </div>
                    <span class="result-status ${isInactive ? 'withdrawn' : ''}">${esc(s.status)}</span>
                </div>`;
    }).join('');

    results.innerHTML = html || '<div class="empty-selected">검색 결과 없음</div>';
}

// 검색 결과 / 선택 chip은 docId가 임의 ID일 수 있어 onclick 인라인을 피하고
// 컨테이너 단위 이벤트 위임으로 처리한다 (JS 문자열 인젝션 차단).
function bindStudentEventDelegation() {
    const results = document.getElementById('search-results');
    if (results && !results.dataset.delegated) {
        results.addEventListener('click', e => {
            const item = e.target.closest('.search-result-item[data-doc-id]');
            if (item) window.addStudent(item.dataset.docId);
        });
        results.dataset.delegated = '1';
    }
    const list = document.getElementById('selected-list');
    if (list && !list.dataset.delegated) {
        list.addEventListener('click', e => {
            const btn = e.target.closest('.remove-btn[data-doc-id]');
            if (btn) window.removeStudent(btn.dataset.docId);
        });
        list.dataset.delegated = '1';
    }
}

window.addStudent = function (docId) {
    if (wizardData.students.some(s => s.docId === docId)) return;
    const found = allStudents.find(s => s.docId === docId);
    if (!found) return;

    if (wizardData.classType === '내신') {
        const checks = [
            ['학교', wizardData.school, found.school || ''],
            ['과정', wizardData.naesinLevel, LEVEL_SHORT[found.level] || ''],
            ['학년', String(wizardData.grade), String(found.grade || '')],
        ];
        for (const [label, expected, actual] of checks) {
            if (expected !== actual) {
                showToast(`${label} 불일치: 마법사(${expected}) ↔ 학생(${actual || '미지정'})`, 'error');
                return;
            }
        }
    }

    // 자유학기제는 중학교 한정 운영 → 중등이 아니면 추가 차단
    if (wizardData.classType === '자유학기' && (found.level || '') !== '중등') {
        showToast(`자유학기는 중학생만 추가 가능합니다 (학부: ${found.level || '미지정'})`, 'error');
        return;
    }

    wizardData.students.push(found);
    renderSelectedStudents();
    refreshSearchAfterMutation();
};

window.removeStudent = function (docId) {
    wizardData.students = wizardData.students.filter(s => s.docId !== docId);
    renderSelectedStudents();
    refreshSearchAfterMutation();
};

// 학생 추가/제거 직후엔 즉시 재검색하되 pending debounce를 취소해 중복 렌더 방지.
function refreshSearchAfterMutation() {
    const searchInput = document.getElementById('student-search');
    if (!searchInput?.value) return;
    clearTimeout(_searchTimer);
    _doSearchStudents(searchInput.value);
}

function renderSelectedStudents() {
    document.getElementById('selected-count').textContent = wizardData.students.length;
    const list = document.getElementById('selected-list');
    if (wizardData.students.length === 0) {
        list.innerHTML = '<div class="empty-selected">검색으로 학생을 추가하세요</div>';
    } else {
        list.innerHTML = wizardData.students.map(s => {
            const meta = studentShortLabel(s);
            return `<div class="selected-chip">
                        <div class="selected-chip-info">
                            <span class="selected-chip-name">${esc(s.name)}</span>
                            <span class="selected-chip-meta">${esc(meta)}</span>
                        </div>
                        <button class="remove-btn" type="button" data-doc-id="${esc(s.docId)}">
                            <span class="material-symbols-outlined" style="font-size:18px;">close</span>
                        </button>
                    </div>`;
        }).join('');
    }
    renderSummary();
}

// ─── 요일 / 시간 (Step 2 - days-section) ────────────────────────────────────
window.toggleDay = function (day) {
    const idx = wizardData.days.indexOf(day);
    if (idx >= 0) wizardData.days.splice(idx, 1);
    else wizardData.days.push(day);

    wizardData.days.sort((a, b) => PLANNER_DAYS.indexOf(a) - PLANNER_DAYS.indexOf(b));

    document.querySelectorAll('.day-chip').forEach(c => {
        c.classList.toggle('selected', wizardData.days.includes(c.dataset.day));
    });

    renderTimeSettings();
};

function renderTimeSettings() {
    const container = document.getElementById('time-settings');
    container.innerHTML = wizardData.days.map(day => {
        const time = wizardData.schedule[day] || '16:00';
        wizardData.schedule[day] = time;
        return `<div class="time-row">
                    <label>${day}</label>
                    <input type="time" id="time-${day}" value="${time}" oninput="syncTimeFromInputs()">
                </div>`;
    }).join('');
    renderSummary();
}

window.syncTimeFromInputs = function () {
    wizardData.days.forEach(day => {
        const input = document.getElementById(`time-${day}`);
        if (input) wizardData.schedule[day] = input.value || '16:00';
    });
    renderSummary();
};

// ─── 미리보기 ─────────────────────────────────────────────────────────────
function renderSummary() {
    const card = document.getElementById('summary-card');
    if (!card) return;
    const d = wizardData;
    const teacherName = d.teacher ? d.teacher.split('@')[0] : '미지정';
    const dayTimeStr = d.days.length
        ? d.days.map(day => `${day} ${d.schedule[day] || ''}`).join(', ')
        : '미선택';

    let typeLabel = d.classType || '미선택';
    if (d.classType === '내신' && d.naesinStart && d.naesinEnd) {
        typeLabel += ` (${d.naesinStart} ~ ${d.naesinEnd})`;
    }
    if (d.classType === '자유학기' && d.freeStart) {
        typeLabel += ` (${d.freeStart} ~ ${d.freeEnd || '미정'})`;
    }
    if (d.classType === '특강' && d.specialStart) {
        typeLabel += ` (${d.specialStart} ~ ${d.specialEnd || '미정'})`;
    }

    card.innerHTML = `
        <div class="summary-row">
            <span class="summary-label">반 유형</span>
            <span class="summary-value">${esc(typeLabel)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">반 코드</span>
            <span class="summary-value">${esc(d.classCode || '미입력')}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">담당</span>
            <span class="summary-value">${esc(teacherName)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">요일/시간</span>
            <span class="summary-value">${esc(dayTimeStr)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">학생 (${d.students.length}명)</span>
            <div class="summary-students-list">
                ${d.students.map(s => `<span class="summary-student-tag">${esc(s.name)}</span>`).join('')}
            </div>
        </div>
    `;
}

// ─── Submit ─────────────────────────────────────────────────────────────────
window.submitWizard = async function () {
    collectFormData();
    if (!validateForm()) return;
    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    btn.textContent = '생성 중...';

    try {
        const d = wizardData;

        // 1. 기존 class_settings에 같은 코드가 있는지 확인
        const existingDoc = await getDoc(doc(db, 'class_settings', d.classCode));
        if (existingDoc.exists()) {
            const ok = confirm(`"${d.classCode}" 반이 이미 존재합니다. 설정을 덮어쓰시겠습니까?`);
            if (!ok) { btn.disabled = false; btn.textContent = '반 생성'; return; }
        }

        // 2. class_settings 데이터 준비 (commit은 batch에서 한번에)
        const classSettingsData = { teacher: d.teacher || '' };
        if (d.classType === '내신') {
            classSettingsData.class_type = '내신';
            classSettingsData.naesin_start = d.naesinStart;
            classSettingsData.naesin_end = d.naesinEnd;
            classSettingsData.schedule = d.schedule;
        } else if (d.classType === '자유학기') {
            // 자유학기는 정규와 class_code 공유 → schedule 덮어쓰지 않고 free_schedule에 저장
            classSettingsData.free_schedule = d.schedule;
            if (d.freeStart) classSettingsData.free_start = d.freeStart;
            if (d.freeEnd) classSettingsData.free_end = d.freeEnd;
        } else {
            classSettingsData.class_type = d.classType;
            classSettingsData.schedule = d.schedule;
            if (d.classType === '특강') {
                if (d.feeType) classSettingsData.fee_type = d.feeType;
                if (d.specialStart) classSettingsData.special_start = d.specialStart;
                if (d.specialEnd) classSettingsData.special_end = d.specialEnd;
            }
        }

        // 3. 학생별 enrollment 추가 (batch + arrayUnion으로 경합 방지)
        const today = todayStr();

        // 내신은 정규/자유학기 enrollment 수정이 필요해 학생 doc을 먼저 읽어야 한다.
        // 정규도 같은 학생의 옛 정규 enrollment를 자동 종료해야 하므로 미리 읽는다.
        // 직렬 await 대신 한 번에 병렬로 받아 RTT를 학생 수만큼이 아닌 1번으로 줄인다.
        const enrollmentsByDocId = new Map();
        if (d.classType === '내신' || d.classType === '정규') {
            const snaps = await Promise.all(
                d.students.map(s => getDoc(doc(db, 'students', s.docId)))
            );
            snaps.forEach(snap => {
                enrollmentsByDocId.set(snap.id, snap.data()?.enrollments || []);
            });
        }

        // 정규 enrollment 추가 시 옛 정규 enrollment의 자동 종료일(새 학기 start_date - 1).
        const yesterdayOf = (dateStr) => {
            const dt = new Date(dateStr + 'T00:00:00Z');
            dt.setUTCDate(dt.getUTCDate() - 1);
            return dt.toISOString().slice(0, 10);
        };

        // class_settings + 학생 enrollment를 한 batch에 묶어 부분 실패 시 데이터 불일치를 방지.
        const batch = writeBatch(db);
        batchSet(batch, doc(db, 'class_settings', d.classCode), classSettingsData, { merge: true });
        for (const student of d.students) {
            const studentRef = doc(db, 'students', student.docId);

            // 특강 수강생은 모두 status2: '특강' 설정
            if (d.classType === '특강') {
                batchUpdate(batch, studentRef, { status2: '특강' });
            }

            const newEnrollment = {
                class_type: d.classType,
                level_symbol: d.levelSymbol || '',
                class_number: d.classNumber || '',
                day: d.days,
                start_date: today,
            };

            if (d.classType === '내신') {
                newEnrollment.level_symbol = '';
                newEnrollment.class_number = '';
                if (d.naesinStart) newEnrollment.start_date = d.naesinStart;
                if (d.naesinEnd) newEnrollment.end_date = d.naesinEnd;
            }

            if (d.classType === '자유학기') {
                if (d.freeStart) newEnrollment.start_date = d.freeStart;
                if (d.freeEnd) newEnrollment.end_date = d.freeEnd;
            }

            if (d.classType === '특강') {
                newEnrollment.level_symbol = '';
                newEnrollment.class_number = d.classCode; // 반 이름 = 코드 (예: '수요특강')
                if (d.specialStart) newEnrollment.start_date = d.specialStart;
                if (d.specialEnd) newEnrollment.end_date = d.specialEnd;
            }

            // 안전망 가드: class_type ↔ 반 코드 정합성 (정채리 케이스 같은 빈 placeholder 차단).
            // validateForm/buildClassCode를 우회해 여기 도달하는 경로가 생기더라도 마지막에서 throw.
            const _hasCode = !!(newEnrollment.level_symbol || newEnrollment.class_number);
            if ((d.classType === '정규' || d.classType === '자유학기') && (!newEnrollment.level_symbol || !newEnrollment.class_number)) {
                throw new Error(`${d.classType} 반 등록에 level_symbol과 class_number가 모두 필요합니다.`);
            }
            if (d.classType === '특강' && !newEnrollment.class_number) {
                throw new Error('특강 반 등록에 class_number(반 이름)가 필요합니다.');
            }
            if (d.classType === '내신' && _hasCode) {
                throw new Error('내신 enrollment는 level_symbol/class_number를 비워야 합니다 (csKey 별도 관리).');
            }

            if (d.classType === '내신') {
                // 정규/자유학기 enrollment에 naesin_class_override 박아 명시 매핑.
                // arrayUnion으로는 기존 element 수정 불가 → 전체 enrollments 다시 쓰기.
                const updated = (enrollmentsByDocId.get(student.docId) || []).map(e =>
                    (e.class_type === '정규' || e.class_type === '자유학기')
                        ? { ...e, naesin_class_override: d.classCode }
                        : e
                );
                updated.push(newEnrollment);
                batchUpdate(batch, studentRef, { enrollments: updated });
            } else if (d.classType === '정규') {
                // 신학기 정규 enrollment 추가 시 옛 정규 enrollment를 강제 종료
                // (end_date 미설정 + 같은 class_type='정규'인 항목에 end_date=새 start_date - 1 설정).
                // 자유학기/내신은 정규의 일시 전환이라 종료하지 않는다.
                const closeDate = yesterdayOf(newEnrollment.start_date);
                const existing = enrollmentsByDocId.get(student.docId) || [];
                const updated = existing.map(e =>
                    (e.class_type === '정규' && !e.end_date)
                        ? { ...e, end_date: closeDate }
                        : e
                );
                updated.push(newEnrollment);
                batchUpdate(batch, studentRef, { enrollments: updated });
            } else {
                batchUpdate(batch, studentRef, {
                    enrollments: arrayUnion(newEnrollment),
                });
            }
        }
        await batch.commit();

        showToast(`"${d.classCode}" 반이 생성되었습니다! (${d.students.length}명)`, 'success');

        // 3초 후 DSC 홈으로 이동
        setTimeout(() => { window.location.href = '/'; }, 2000);

    } catch (err) {
        console.error('[submitWizard]', err);
        showToast(`생성 실패: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">check</span> 반 생성';
    }
};

// ─── Login ──────────────────────────────────────────────────────────────────
window.handleLogin = async function () {
    try {
        await signInWithGoogle();
    } catch (err) {
        showToast('로그인 실패: ' + err.message, 'error');
    }
};

window.handleLogout = async function () {
    await logout();
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

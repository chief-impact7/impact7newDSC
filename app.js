import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc,
    query, where, serverTimestamp, onSnapshot
} from 'firebase/firestore';
import { auth, db } from './firebase-config.js';
import { signInWithGoogle, logout } from './auth.js';
import { todayStr, getDayName, addDays } from './src/shared/firestore-helpers.js';
import { auditUpdate, auditSet, auditAdd } from './audit.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentUser = null;
let allStudents = [];          // students 컬렉션 전체 캐시
let dailyChecks = {};          // docId → daily_check 데이터
let postponedTasks = [];       // 해당 날짜의 연기 작업
let tempClassOverrides = [];   // 해당 날짜의 타반수업 오버라이드
let selectedDate = todayStr(); // YYYY-MM-DD
let saveTimers = {};           // 디바운스 타이머
let unsubDailyChecks = null;   // daily_checks 실시간 리스너 해제 함수

// ─── Helpers ─────────────────────────────────────────────────────────────────
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

const escAttr = (str) =>
    String(str ?? '').replace(/&/g, '&amp;').replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');


function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

const enrollmentCode = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;

const branchFromClassNumber = (num) => {
    const first = (num || '').trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
};

const branchFromStudent = (s) =>
    s.branch || (s.enrollments?.[0] ? branchFromClassNumber(s.enrollments[0].class_number) : '');

// 활성 enrollment만 반환. 내신/자유학기가 활성 기간이면 정규를 숨김.
function getActiveEnrollments(s, dateStr) {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];
    const today = dateStr || todayStr();
    const validDate = (d) => d && /^\d{4}-/.test(d);
    const hasActiveNaesin = enrollments.some(e =>
        e.class_type === '내신' &&
        validDate(e.start_date) && e.start_date <= today &&
        validDate(e.end_date) && e.end_date >= today
    );
    if (hasActiveNaesin) {
        return enrollments.filter(e => e.class_type !== '정규');
    }
    // 자유학기가 활성 기간이면 같은 반코드의 정규 숨김
    const activeFreeEnrolls = enrollments.filter(e =>
        e.class_type === '자유학기' &&
        validDate(e.start_date) && e.start_date <= today &&
        (!validDate(e.end_date) || e.end_date >= today)
    );
    if (activeFreeEnrolls.length > 0) {
        const freeCodes = new Set(activeFreeEnrolls.map(enrollmentCode));
        return enrollments.filter(e =>
            e.class_type !== '정규' || !freeCodes.has(enrollmentCode(e))
        );
    }
    return enrollments;
}

// 기존 flat 필드 → enrollments 배열 자동 변환
function normalizeEnrollments(s) {
    if (s.enrollments?.length) return s.enrollments;
    let levelSymbol = s.level_symbol || s.level_code || '';
    let classNumber = s.class_number || '';
    // Auto-correction: level_symbol에 숫자만 있으면 class_number로 이동
    if (/^\d+$/.test(levelSymbol) && !classNumber) {
        classNumber = levelSymbol;
        levelSymbol = '';
    }
    const day = normalizeDays(s.day);
    const ct = s.class_type || '정규';
    const e = { class_type: ct, level_symbol: levelSymbol, class_number: classNumber, day, start_date: s.start_date || '' };
    if (ct === '특강') e.end_date = s.special_end_date || '';
    return [e];
}

function makeDailyCheckId(date, studentId, enrollIdx) {
    return `${date}_${studentId}_${enrollIdx}`;
}

// ─── Field definitions ───────────────────────────────────────────────────────
// 각 섹션별 필드 정의 (PC 테이블 + 모바일 카드 공통)
const SECTIONS = [
    {
        key: 'attendance', label: '출결', cssClass: 'sec-attendance',
        fields: [
            { key: 'attendance', label: '출결', type: 'select', options: ['', '출석', '결석', '지각', '조퇴'] },
            { key: 'attendance_time', label: '시간', type: 'time' },
            { key: 'attendance_reason', label: '사유', type: 'text', wide: true },
        ]
    },
    {
        key: 'homework', label: '숙제', cssClass: 'sec-homework',
        fields: [
            { key: 'hw_reading', label: '독해', type: 'ox' },
            { key: 'hw_grammar', label: '문법', type: 'ox' },
            { key: 'hw_practice', label: '실전', type: 'ox' },
            { key: 'hw_listening', label: '청해', type: 'ox' },
            { key: 'hw_extra', label: '추가', type: 'ox' },
            { key: 'hw_vocab', label: '어휘', type: 'ox' },
            { key: 'hw_idiom', label: '숙어', type: 'ox' },
            { key: 'hw_verb3', label: '3단', type: 'ox' },
        ]
    },
    {
        key: 'review_test', label: '리뷰테스트', cssClass: 'sec-review-test',
        fields: [
            { key: 'test_reading', label: '독해', type: 'text' },
            { key: 'test_grammar', label: '문법', type: 'text' },
            { key: 'test_practice', label: '실전', type: 'text' },
            { key: 'test_listening', label: '청해', type: 'text' },
        ]
    },
    {
        key: 'isc', label: 'ISC', cssClass: 'sec-isc',
        fields: [
            { key: 'isc', label: 'ISC', type: 'text' },
        ]
    },
    {
        key: 'review', label: '부실 숙제 보완', cssClass: 'sec-review',
        fields: [
            { key: 'review_reading', label: '독해', type: 'ox' },
            { key: 'review_grammar', label: '문법', type: 'ox' },
            { key: 'review_practice', label: '실전', type: 'ox' },
            { key: 'review_listening', label: '청해', type: 'ox' },
            { key: 'review_extra', label: '추가', type: 'ox' },
            { key: 'review_vocab', label: '어휘', type: 'ox' },
            { key: 'review_idiom', label: '숙어', type: 'ox' },
            { key: 'review_verb3', label: '3단', type: 'ox' },
        ]
    },
    {
        key: 'retest', label: '재시', cssClass: 'sec-retest',
        fields: [
            { key: 'retest_isc', label: 'ISC', type: 'text' },
            { key: 'retest_reading', label: '독해', type: 'text' },
            { key: 'retest_grammar', label: '문법', type: 'text' },
            { key: 'retest_practice', label: '실전', type: 'text' },
            { key: 'retest_listening', label: '청해', type: 'text' },
            { key: 'retest_grading', label: '채점', type: 'text' },
        ]
    },
    {
        key: 'next_hw', label: '다음 숙제', cssClass: 'sec-next-hw',
        fields: [
            { key: 'next_listening', label: '청해', type: 'text', wide: true },
            { key: 'next_summary', label: '요약', type: 'text', wide: true },
            { key: 'next_reading', label: '독해', type: 'text', wide: true },
            { key: 'next_grammar', label: '문법', type: 'text', wide: true },
            { key: 'next_practice', label: '실전', type: 'text', wide: true },
            { key: 'next_listening2', label: '청해2', type: 'text', wide: true },
            { key: 'next_extra', label: '추가', type: 'text', wide: true },
        ]
    },
    {
        key: 'notes', label: '전달사항', cssClass: 'sec-notes',
        fields: [
            { key: 'note_class_to_study', label: '강의실→학습실', type: 'text', wide: true },
            { key: 'note_to_parent', label: '학원→부모님', type: 'text', wide: true },
        ]
    },
    {
        key: 'absent', label: '결석생 대응', cssClass: 'sec-absent',
        fields: [
            { key: 'absent_handler', label: '담당', type: 'text' },
            { key: 'absent_consultation', label: '상담내용', type: 'text', wide: true },
        ]
    },
    {
        key: 'lms', label: 'LMS', cssClass: 'sec-lms',
        fields: [
            { key: 'lms_content', label: '내용', type: 'text', wide: true },
        ]
    },
];

// ─── Auth ────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const email = user.email || '';
        const allowed = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
        if (!user.emailVerified || !allowed) {
            alert('허용되지 않은 계정입니다.\n학원 계정(@gw.impact7.kr 또는 @impact7.kr)으로 다시 로그인해주세요.');
            await logout();
            return;
        }

        currentUser = user;
        window._auditUser = user.email || null;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = 'block';
        document.getElementById('user-email').textContent = user.email;
        const avatar = document.querySelector('.avatar');
        avatar.textContent = user.email[0].toUpperCase();
        avatar.title = `${user.email} (클릭: 로그아웃)`;

        await loadAllStudents();
        setDate(todayStr());
    } else {
        currentUser = null;
        if (unsubDailyChecks) {
            unsubDailyChecks();
            unsubDailyChecks = null;
        }
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('main-screen').style.display = 'none';
    }
});

window.handleLogin = async () => {
    try {
        if (currentUser) await logout();
        else await signInWithGoogle();
    } catch (error) {
        const messages = {
            'auth/popup-blocked': '팝업이 차단됨 — 브라우저에서 팝업을 허용해주세요',
            'auth/popup-closed-by-user': '팝업이 닫혔습니다.',
            'auth/cancelled-popup-request': '이미 로그인 팝업이 열려 있습니다.',
        };
        alert(messages[error.code] || `로그인 실패: ${error.code}`);
    }
};

// ─── Load students (cached) ──────────────────────────────────────────────────
async function loadAllStudents() {
    try {
        const [snap1, snap2] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원']))),
            getDocs(query(collection(db, 'students'), where('status2', '==', '특강')))
        ]);
        const seen = new Set();
        allStudents = [];
        const addDoc = docSnap => {
            if (seen.has(docSnap.id)) return;
            seen.add(docSnap.id);
            const data = { id: docSnap.id, ...docSnap.data() };
            data.enrollments = normalizeEnrollments(data);
            allStudents.push(data);
        };
        snap1.docs.forEach(addDoc);
        snap2.docs.forEach(addDoc);
        allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        populateClassFilter();
    } catch (err) {
        console.error('[LOAD ERROR]', err);
    }
}

// ─── Date navigation ─────────────────────────────────────────────────────────
function setDate(dateStr) {
    selectedDate = dateStr;
    const dayName = getDayName(dateStr);
    document.getElementById('date-text').textContent = `${dateStr} (${dayName})`;
    document.getElementById('date-picker').value = dateStr;
    loadDailyData();
}

window.changeDate = (delta) => {
    setDate(addDays(selectedDate, delta));
};

window.goToday = () => setDate(todayStr());

window.openDatePicker = () => {
    const picker = document.getElementById('date-picker');
    picker.showPicker?.() || picker.click();
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        if (e.target.value) setDate(e.target.value);
    });
});

// ─── Filters ─────────────────────────────────────────────────────────────────
function populateClassFilter() {
    const classSet = new Set();
    allStudents.forEach(s => {
        (s.enrollments || []).forEach(e => {
            const code = enrollmentCode(e);
            if (code) classSet.add(code);
        });
    });
    const sorted = [...classSet].sort();
    const html = '<option value="">전체 반</option>' + sorted.map(c => `<option value="${escAttr(c)}">${esc(c)}</option>`).join('');
    document.getElementById('filter-class').innerHTML = html;
    document.getElementById('mobile-filter-class').innerHTML = html;
}

window.applyFilters = () => {
    // Sync PC & mobile filters
    const branchPC = document.getElementById('filter-branch').value;
    const classPC = document.getElementById('filter-class').value;
    const branchM = document.getElementById('mobile-filter-branch').value;
    const classM = document.getElementById('mobile-filter-class').value;

    // Determine which changed last — use PC if visible, else mobile
    const isMobile = window.innerWidth <= 768;
    const branch = isMobile ? branchM : branchPC;
    const classCode = isMobile ? classM : classPC;

    // Sync both
    document.getElementById('filter-branch').value = branch;
    document.getElementById('mobile-filter-branch').value = branch;
    document.getElementById('filter-class').value = classCode;
    document.getElementById('mobile-filter-class').value = classCode;

    renderAll(branch, classCode);
};

// ─── Load daily data ─────────────────────────────────────────────────────────
async function loadDailyData() {
    // 이전 리스너 해제
    if (unsubDailyChecks) {
        unsubDailyChecks();
        unsubDailyChecks = null;
    }

    dailyChecks = {};
    postponedTasks = [];
    tempClassOverrides = [];

    // postponed_tasks, temp_class_overrides는 일회성 조회 (변경 빈도 낮음)
    try {
        const [ptSnap, ovrSnap] = await Promise.all([
            getDocs(query(collection(db, 'postponed_tasks'), where('scheduled_date', '==', selectedDate), where('status', '==', 'pending'))),
            getDocs(query(collection(db, 'temp_class_overrides'), where('override_date', '==', selectedDate), where('status', '==', 'active'))),
        ]);
        ptSnap.forEach(docSnap => { postponedTasks.push({ id: docSnap.id, ...docSnap.data() }); });
        ovrSnap.forEach(docSnap => { tempClassOverrides.push({ id: docSnap.id, ...docSnap.data() }); });
    } catch (err) {
        console.error('[LOAD DAILY ERROR]', err);
    }

    // daily_checks는 실시간 리스너로 구독
    const checksQuery = query(collection(db, 'daily_checks'), where('date', '==', selectedDate));
    let isFirstSnapshot = true;

    unsubDailyChecks = onSnapshot(checksQuery, (snapshot) => {
        if (isFirstSnapshot) {
            // 최초 로드 — 전체 데이터 세팅 후 풀 렌더
            snapshot.forEach(docSnap => {
                dailyChecks[docSnap.id] = docSnap.data();
            });
            isFirstSnapshot = false;
            renderAll();
        } else {
            // 이후 변경 — 변경된 셀만 DOM 업데이트 (입력 중 방해 없음)
            snapshot.docChanges().forEach(change => {
                const docId = change.doc.id;
                const newData = change.doc.data();

                if (change.type === 'removed') {
                    delete dailyChecks[docId];
                    return;
                }

                // 로컬에서 저장 대기 중이면 원격 업데이트 무시 (충돌 방지)
                if (saveTimers[docId]) return;

                const oldData = dailyChecks[docId] || {};
                dailyChecks[docId] = newData;
                updateCellsInDOM(docId, oldData, newData);
            });
        }
    }, (err) => {
        console.error('[SNAPSHOT ERROR]', err);
    });
}

// ─── 원격 변경 시 개별 셀만 DOM 업데이트 ─────────────────────────────────────
function updateCellsInDOM(checkId, oldData, newData) {
    const escapedId = CSS.escape(checkId);
    const elements = document.querySelectorAll(`[data-check-id="${escapedId}"]`);
    if (elements.length === 0) return;

    elements.forEach(el => {
        const field = el.dataset.field;
        const newVal = newData[field] || '';
        const oldVal = oldData[field] || '';

        if (newVal === oldVal) return;

        // 현재 포커스된 요소는 건드리지 않음 (사용자가 입력 중)
        if (el === document.activeElement) return;

        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
            el.value = newVal;
        } else if (el.classList.contains('cell-ox')) {
            el.dataset.value = newVal;
            el.textContent = newVal;
            el.className = 'cell-ox ' + (newVal === 'O' ? 'att-present' : newVal === 'X' ? 'att-absent' : newVal === '\u25B3' ? 'att-late' : '');
        }
    });

    // 출결 상태에 따른 행 스타일 업데이트
    const firstEl = elements[0];
    const row = firstEl?.closest('tr');
    if (row && !row.classList.contains('postponed-row') && !row.classList.contains('override-out-row')) {
        if (newData.attendance === '결석') {
            row.classList.add('absent-row');
        } else {
            row.classList.remove('absent-row');
        }
    }
}

// ─── Get students for selected day ──────────────────────────────────────────
function getStudentsForDay(branchFilter, classFilter) {
    const dayName = getDayName(selectedDate);
    const rows = [];

    allStudents.forEach(s => {
        // 퇴원 학생 제외
        if (s.status === '퇴원') return;

        const branch = branchFromStudent(s);
        if (branchFilter && branch !== branchFilter) return;

        const activeEnrolls = getActiveEnrollments(s, selectedDate);
        activeEnrolls.forEach((e, idx) => {
            const days = normalizeDays(e.day);
            if (!days.includes(dayName)) return;

            const code = enrollmentCode(e);
            if (classFilter && code !== classFilter) return;

            // 이 학생이 이 반에서 타반수업으로 빠지는지 확인
            const overrideOut = tempClassOverrides.find(o =>
                o.student_id === s.id && o.original_class_code === code
            );

            // 원래 enrollments 배열에서의 index를 찾아 checkId에 사용
            const origIdx = (s.enrollments || []).indexOf(e);
            rows.push({
                student: s,
                enrollment: e,
                enrollIdx: origIdx >= 0 ? origIdx : idx,
                code,
                branch,
                checkId: makeDailyCheckId(selectedDate, s.id, origIdx >= 0 ? origIdx : idx),
                startTime: e.start_time || e.time || '',
                isOverridingOut: !!overrideOut,
                overrideTargetClass: overrideOut?.target_class_code || '',
            });
        });
    });

    // 타반수업 override-in 학생 추가
    tempClassOverrides.forEach(o => {
        const s = allStudents.find(st => st.id === o.student_id);
        if (!s || s.status === '퇴원') return;

        const branch = branchFromStudent(s);
        if (branchFilter && branch !== branchFilter) return;
        if (classFilter && o.target_class_code !== classFilter) return;

        rows.push({
            student: s,
            enrollment: null,
            enrollIdx: -1,
            code: o.target_class_code,
            branch,
            checkId: `${selectedDate}_${s.id}_ovr`,
            startTime: o.target_start_time || '',
            isOverrideIn: true,
            overrideOriginalClass: o.original_class_code || '',
        });
    });

    // Sort by start_time, then name
    rows.sort((a, b) => {
        const ta = a.startTime || '99:99';
        const tb = b.startTime || '99:99';
        if (ta !== tb) return ta.localeCompare(tb);
        return (a.student.name || '').localeCompare(b.student.name || '', 'ko');
    });

    return rows;
}

// ─── Render ──────────────────────────────────────────────────────────────────
function renderAll(branchFilter, classFilter) {
    branchFilter = branchFilter ?? document.getElementById('filter-branch').value;
    classFilter = classFilter ?? document.getElementById('filter-class').value;

    const rows = getStudentsForDay(branchFilter, classFilter);

    document.getElementById('student-count').textContent = `${rows.length}명`;

    renderTable(rows);
    renderCards(rows);
}

// ─── PC Table rendering ─────────────────────────────────────────────────────
function renderTable(rows) {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="45" class="empty-state"><p>해당 날짜에 수업이 없습니다.</p></td></tr>';
        return;
    }

    // Postponed tasks rows first
    postponedTasks.forEach(pt => {
        const tr = document.createElement('tr');
        tr.className = 'postponed-row';
        tr.innerHTML = `
            <td class="sticky-col col-name">${esc(pt.student_name)}</td>
            <td class="sticky-col col-class"><span class="postponed-badge">연기</span></td>
            <td class="sticky-col col-time">${esc(pt.scheduled_time || '')}</td>
            <td colspan="42" style="text-align:left;padding-left:12px;">
                <strong>${esc(pt.content)}</strong>
                (원래: ${esc(pt.original_date)}) — 담당: ${esc(pt.handler || '')}
                <button class="btn btn-sm btn-primary" onclick="completePostponed('${escAttr(pt.id)}')" style="margin-left:8px;">완료</button>
                <button class="btn btn-sm btn-secondary" onclick="absentPostponed('${escAttr(pt.id)}')" style="margin-left:4px;">결석</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    rows.forEach(row => {
        const checkData = dailyChecks[row.checkId] || {};
        const tr = document.createElement('tr');
        if (row.isOverridingOut) {
            tr.className = 'override-out-row';
        } else if (checkData.attendance === '결석') {
            tr.className = 'absent-row';
        }

        let html = '';
        // Sticky cols — 타반수업 배지 표시
        const nameBadge = row.isOverrideIn
            ? ` <span class="override-in-badge">타반(${esc(row.overrideOriginalClass)})</span>`
            : row.isOverridingOut
            ? ` <span class="override-badge">타반수업→${esc(row.overrideTargetClass)}</span>`
            : '';
        html += `<td class="sticky-col col-name">${esc(row.student.name)}${nameBadge}</td>`;
        html += `<td class="sticky-col col-class">${esc(row.code)}</td>`;
        html += `<td class="sticky-col col-time">${esc(row.startTime)}</td>`;

        // Data fields — override-out 학생은 비활성
        if (row.isOverridingOut) {
            SECTIONS.forEach(section => {
                section.fields.forEach(() => {
                    html += `<td style="background:#f5f5f5;color:#bbb;text-align:center;">—</td>`;
                });
            });
        } else {
            SECTIONS.forEach(section => {
                section.fields.forEach(field => {
                    const val = checkData[field.key] || '';
                    html += renderTableCell(field, val, row.checkId);
                });
            });
        }

        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
}

function renderTableCell(field, value, checkId) {
    const dataAttr = `data-check-id="${checkId}" data-field="${field.key}"`;

    if (field.type === 'select') {
        const opts = field.options.map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o || '—'}</option>`).join('');
        return `<td><select class="cell-select" ${dataAttr} onchange="handleCellChange(this)">${opts}</select></td>`;
    }

    if (field.type === 'ox') {
        const cls = value === 'O' ? 'att-present' : value === 'X' ? 'att-absent' : value === '\u25B3' ? 'att-late' : '';
        return `<td class="cell-ox ${cls}" ${dataAttr} data-value="${esc(value)}" onclick="cycleOX(this)">${esc(value)}</td>`;
    }

    if (field.type === 'time') {
        return `<td><input type="time" class="cell-input" ${dataAttr} value="${esc(value)}" onchange="handleCellChange(this)"></td>`;
    }

    // text
    const wide = field.wide ? ' wide' : '';
    return `<td><input type="text" class="cell-input${wide}" ${dataAttr} value="${esc(value)}" onchange="handleCellChange(this)"></td>`;
}

// ─── OX cycle ────────────────────────────────────────────────────────────────
window.cycleOX = (td) => {
    const cycle = ['O', '△', 'X', ''];
    const current = td.dataset.value || '';
    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
    const next = cycle[nextIdx];

    td.dataset.value = next;
    td.textContent = next;
    td.className = 'cell-ox ' + (next === 'O' ? 'att-present' : next === 'X' ? 'att-absent' : next === '\u25B3' ? 'att-late' : '');

    scheduleAutoSave(td.dataset.checkId, td.dataset.field, next);
};

// ─── Cell change handler ─────────────────────────────────────────────────────
window.handleCellChange = (el) => {
    const checkId = el.dataset.checkId;
    const field = el.dataset.field;
    const value = el.value;
    scheduleAutoSave(checkId, field, value);
};

// ─── Auto-save with debounce ─────────────────────────────────────────────────
function scheduleAutoSave(checkId, field, value) {
    // Update local cache immediately
    if (!dailyChecks[checkId]) {
        // Parse checkId: date_studentId_enrollIdx
        const parts = checkId.split('_');
        const enrollIdx = parseInt(parts.pop(), 10);
        const date = parts.shift();
        const studentId = parts.join('_');
        const student = allStudents.find(s => s.id === studentId);
        const enrollment = student?.enrollments?.[enrollIdx];

        dailyChecks[checkId] = {
            date: date,
            student_id: studentId,
            enrollment_index: enrollIdx,
            class_code: enrollment ? enrollmentCode(enrollment) : '',
            student_name: student?.name || '',
            branch: branchFromStudent(student || {}),
        };
    }
    dailyChecks[checkId][field] = value;

    // Debounce save
    const timerKey = checkId;
    if (saveTimers[timerKey]) clearTimeout(saveTimers[timerKey]);

    saveTimers[timerKey] = setTimeout(() => {
        saveDailyCheck(checkId);
        delete saveTimers[timerKey];
    }, 2000);
}

async function saveDailyCheck(checkId) {
    const data = dailyChecks[checkId];
    if (!data) return;

    showSaveIndicator('saving');

    try {
        await auditSet(doc(db, 'daily_checks', checkId), {
            ...data,
        }, { merge: true });

        showSaveIndicator('saved');
    } catch (err) {
        console.error('[SAVE ERROR]', err);
        showSaveIndicator('error');
    }
}

function showSaveIndicator(state) {
    const el = document.getElementById('save-indicator');
    const text = document.getElementById('save-text');

    el.style.display = 'flex';
    el.className = 'save-indicator' + (state === 'saved' ? ' saved' : state === 'error' ? ' error' : '');

    if (state === 'saving') {
        text.textContent = '저장 중...';
    } else if (state === 'saved') {
        text.textContent = '저장 완료';
        setTimeout(() => { el.style.display = 'none'; }, 1500);
    } else {
        text.textContent = '저장 실패';
        setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
}

// ─── Mobile card rendering ───────────────────────────────────────────────────
function renderCards(rows) {
    const container = document.getElementById('card-list');
    container.innerHTML = '';

    if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">event_busy</span><p>해당 날짜에 수업이 없습니다.</p></div>';
        return;
    }

    // Postponed tasks
    postponedTasks.forEach(pt => {
        const card = document.createElement('div');
        card.className = 'student-card';
        card.style.borderLeft = '3px solid var(--warning)';
        card.innerHTML = `
            <div class="card-header">
                <div class="card-header-left">
                    <span class="card-name">${esc(pt.student_name)}</span>
                    <span class="postponed-badge">연기</span>
                </div>
                <span class="card-time">${esc(pt.scheduled_time || '')}</span>
            </div>
            <div class="card-body open" style="display:block;">
                <p style="font-size:13px;margin-bottom:8px;"><strong>${esc(pt.content)}</strong> (원래: ${esc(pt.original_date)})</p>
                <p style="font-size:12px;color:var(--text-sec);">담당: ${esc(pt.handler || '')}</p>
                <div class="card-actions">
                    <button class="btn btn-primary btn-sm" onclick="completePostponed('${escAttr(pt.id)}')">완료</button>
                    <button class="btn btn-secondary btn-sm" onclick="absentPostponed('${escAttr(pt.id)}')">결석</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    rows.forEach(row => {
        const checkData = dailyChecks[row.checkId] || {};
        const card = document.createElement('div');
        card.className = 'student-card';
        if (row.isOverridingOut) card.style.opacity = '0.5';

        const attVal = checkData.attendance || '';
        const attClass = attVal === '출석' ? 'present' : attVal === '결석' ? 'absent' : attVal === '지각' ? 'late' : 'none';
        const attLabel = row.isOverridingOut ? '타반수업' : (attVal || '—');

        const overrideBadge = row.isOverrideIn
            ? `<span class="override-in-badge">타반(${esc(row.overrideOriginalClass)})</span>`
            : row.isOverridingOut
            ? `<span class="override-badge">→${esc(row.overrideTargetClass)}</span>`
            : '';

        card.innerHTML = `
            <div class="card-header" onclick="toggleCard(this)">
                <div class="card-header-left">
                    <span class="card-name">${esc(row.student.name)}</span>
                    ${overrideBadge}
                    <span class="card-class">${esc(row.code)}</span>
                    <span class="card-time">${esc(row.startTime)}</span>
                </div>
                <span class="card-att-badge ${row.isOverridingOut ? 'none' : attClass}">${esc(attLabel)}</span>
            </div>
            <div class="card-body">
                ${row.isOverridingOut ? '<p style="color:var(--text-sec);font-size:13px;padding:8px 0;">타반수업 중 — 입력 비활성</p>' : renderCardSections(row.checkId, checkData)}
                ${row.isOverridingOut ? '' : `<div class="card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openPostponeModal('${escAttr(row.student.id)}', '${escAttr(row.student.name)}', ${row.enrollIdx})">
                        연기/보강
                    </button>
                </div>`}
            </div>
        `;
        container.appendChild(card);
    });
}

function renderCardSections(checkId, checkData) {
    return SECTIONS.map(section => {
        const fieldsHtml = section.fields.map(field => {
            const val = checkData[field.key] || '';
            const wideClass = field.wide ? ' card-field-wide' : '';

            if (field.type === 'select') {
                const opts = field.options.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o || '—'}</option>`).join('');
                return `<div class="card-field${wideClass}">
                    <span class="card-field-label">${field.label}</span>
                    <select data-check-id="${checkId}" data-field="${field.key}" onchange="handleCellChange(this)">${opts}</select>
                </div>`;
            }

            if (field.type === 'ox') {
                return `<div class="card-field">
                    <span class="card-field-label">${field.label}</span>
                    <button class="cell-ox" data-check-id="${checkId}" data-field="${field.key}" data-value="${esc(val)}" onclick="cycleOX(this)"
                        style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:16px;font-weight:700;cursor:pointer;
                        color:${val === 'O' ? 'var(--success)' : val === 'X' ? 'var(--danger)' : val === '\u25B3' ? 'var(--warning)' : 'var(--text-third)'}">
                        ${val || '—'}
                    </button>
                </div>`;
            }

            if (field.type === 'time') {
                return `<div class="card-field${wideClass}">
                    <span class="card-field-label">${field.label}</span>
                    <input type="time" data-check-id="${checkId}" data-field="${field.key}" value="${esc(val)}" onchange="handleCellChange(this)">
                </div>`;
            }

            return `<div class="card-field${wideClass}">
                <span class="card-field-label">${field.label}</span>
                <input type="text" data-check-id="${checkId}" data-field="${field.key}" value="${esc(val)}" onchange="handleCellChange(this)">
            </div>`;
        }).join('');

        return `<div class="card-section">
            <div class="card-section-title ${section.cssClass}">${section.label}</div>
            <div class="card-fields">${fieldsHtml}</div>
        </div>`;
    }).join('');
}

window.toggleCard = (header) => {
    const body = header.nextElementSibling;
    body.classList.toggle('open');
    body.style.display = body.classList.contains('open') ? 'block' : 'none';
};

// ─── Postponed tasks ─────────────────────────────────────────────────────────
let _postponeContext = null;

window.openPostponeModal = (studentId, studentName, enrollIdx) => {
    _postponeContext = { studentId, enrollIdx };
    document.getElementById('postpone-student-name').textContent = studentName;
    document.getElementById('postpone-content').value = '';
    document.getElementById('postpone-handler').value = '';

    // Default: next day
    document.getElementById('postpone-date').value = addDays(selectedDate, 1);
    document.getElementById('postpone-time').value = '16:00';

    document.getElementById('postpone-modal').style.display = 'flex';
};

window.closePostponeModal = (e) => {
    if (e && e.target !== document.getElementById('postpone-modal')) return;
    document.getElementById('postpone-modal').style.display = 'none';
};

window.savePostponedTask = async () => {
    if (!_postponeContext) return;
    const content = document.getElementById('postpone-content').value.trim();
    const scheduledDate = document.getElementById('postpone-date').value;
    const scheduledTime = document.getElementById('postpone-time').value;
    const handler = document.getElementById('postpone-handler').value.trim();

    if (!content) { alert('미룬 내용을 입력하세요.'); return; }
    if (!scheduledDate) { alert('약속 날짜를 선택하세요.'); return; }

    const student = allStudents.find(s => s.id === _postponeContext.studentId);

    try {
        await auditAdd(collection(db, 'postponed_tasks'), {
            student_id: _postponeContext.studentId,
            student_name: student?.name || '',
            original_date: selectedDate,
            scheduled_date: scheduledDate,
            scheduled_time: scheduledTime,
            content,
            handler,
            status: 'pending',
            result: '',
            created_by: currentUser?.email || 'system',
            created_at: serverTimestamp(),
        });

        document.getElementById('postpone-modal').style.display = 'none';
        _postponeContext = null;

        // Reload if viewing the scheduled date
        if (selectedDate === scheduledDate) {
            await loadDailyData();
        }

        showSaveIndicator('saved');
    } catch (err) {
        console.error('[POSTPONE SAVE ERROR]', err);
        alert('연기 등록 실패: ' + err.message);
    }
};

window.completePostponed = async (taskId) => {
    try {
        await auditUpdate(doc(db, 'postponed_tasks', taskId), {
            status: 'done',
            result: '완료',
        });
        // 로컬 상태만 업데이트 (loadDailyData 재호출 대신)
        postponedTasks = postponedTasks.filter(t => t.id !== taskId);
        renderAll();
    } catch (err) {
        alert('처리 실패: ' + err.message);
    }
};

window.absentPostponed = async (taskId) => {
    try {
        await auditUpdate(doc(db, 'postponed_tasks', taskId), {
            status: 'absent',
            result: '결석',
        });
        // 로컬 상태만 업데이트 (loadDailyData 재호출 대신)
        postponedTasks = postponedTasks.filter(t => t.id !== taskId);
        renderAll();
    } catch (err) {
        alert('처리 실패: ' + err.message);
    }
};

// ─── Keyboard shortcut: ESC closes modal ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('postpone-modal');
        if (modal?.style.display !== 'none') {
            modal.style.display = 'none';
        }
    }
});

console.log('[DailyFlowCheck] App initialized.');

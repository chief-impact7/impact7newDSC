import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc, setDoc, getDoc, addDoc,
    query, where, serverTimestamp, updateDoc, writeBatch, arrayUnion
} from 'firebase/firestore';
import { auth, db } from './firebase-config.js';
import { signInWithGoogle, logout } from './auth.js';

// ─── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let allStudents = [];           // students 컬렉션 캐시
let dailyRecords = {};          // studentDocId → daily_record 데이터
let retakeSchedules = [];       // retake_schedule 전체
let hwFailTasks = [];           // hw_fail_tasks 전체
let selectedDate = todayStr();
let selectedStudentId = null;
let currentCategory = 'attendance'; // 'attendance' | 'homework' | 'test' | 'automation'
let currentSubFilter = new Set();    // L2 복수 선택 (빈 Set = 전체)
let l2Expanded = false;             // L2 서브필터 펼침 상태
let checkedItems = new Set();
let saveTimers = {};
let searchQuery = '';
let currentRole = null;
let roleMemos = [];
let memoTab = 'inbox';
let classSettings = {};          // classCode → { domains: [...] }
let selectedBranch = null;       // 소속 글로벌 필터 (null = 전체, '2단지' | '10단지')
let selectedClassCode = null;    // 반 글로벌 필터 (null = 전체, 'ax104' 등)
let savedSubFilters = {};        // 카테고리별 L2 선택 기억 { homework: Set['hw_1st'], ... }
let savedL2Expanded = {};        // 카테고리별 L2 펼침 상태 기억
const DEFAULT_DOMAINS = ['Gr', 'A/G', 'R/C'];

// ─── OX Helpers ─────────────────────────────────────────────────────────────
const OX_CYCLE = ['O', '△', 'X', ''];

function nextOXValue(current) {
    const idx = OX_CYCLE.indexOf(current || '');
    return OX_CYCLE[(idx + 1) % OX_CYCLE.length];
}

function oxDisplayClass(value) {
    if (value === 'O') return 'ox-green';
    if (value === 'X') return 'ox-red';
    if (value === '△') return 'ox-yellow';
    return 'ox-empty';
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

// HTML 속성(특히 onclick 내부 문자열 리터럴)에서 안전하게 사용하기 위한 이스케이프
const escAttr = (str) => {
    return esc(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
};

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDayName(dateStr) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return days[new Date(dateStr).getDay()];
}

function formatTime12h(time24) {
    if (!time24) return '';
    const [h, m] = time24.split(':');
    const hour = parseInt(h);
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${h12}:${m}`;
}

function nowTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const cn = s.enrollments?.[0]?.class_number || '';
    const first = cn.trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

function enrollmentCode(e) {
    return `${e.level_symbol || ''}${e.class_number || ''}`;
}

// 학교+학부앞글자+학년앞글자 조합 (예: 대일고1, 진명여고1)
function studentShortLabel(s) {
    let school = (s.school || '').replace('여자', '여');
    const dept = s.level || '';
    const grade = String(s.grade || '');
    if (!school) return '';
    return school + (dept ? dept[0] : '') + (grade ? grade[0] : '');
}

function makeDailyRecordId(studentDocId, date) {
    return `${studentDocId}_${date}`;
}

// ─── Class Settings (영역 관리) ─────────────────────────────────────────────

async function loadClassSettings() {
    const snap = await getDocs(collection(db, 'class_settings'));
    classSettings = {};
    snap.forEach(d => { classSettings[d.id] = d.data(); });
}

function getClassDomains(classCode) {
    return classSettings[classCode]?.domains || [...DEFAULT_DOMAINS];
}

function getStudentDomains(studentId) {
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return [...DEFAULT_DOMAINS];
    const domains = new Set();
    student.enrollments.forEach(e => {
        getClassDomains(enrollmentCode(e)).forEach(d => domains.add(d));
    });
    return domains.size > 0 ? [...domains] : [...DEFAULT_DOMAINS];
}

function getStudentTestItems(studentId) {
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return { sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)), flat: [] };
    const merged = {};
    student.enrollments.forEach(e => {
        const sections = getClassTestSections(enrollmentCode(e));
        for (const [secName, items] of Object.entries(sections)) {
            if (!merged[secName]) merged[secName] = new Set();
            items.forEach(t => merged[secName].add(t));
        }
    });
    const sections = {};
    for (const [secName, itemSet] of Object.entries(merged)) {
        sections[secName] = [...itemSet];
    }
    if (Object.keys(sections).length === 0) {
        return { sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)), flat: [] };
    }
    const flat = Object.values(sections).flat();
    return { sections, flat };
}

async function saveClassSettings(classCode, data) {
    await setDoc(doc(db, 'class_settings', classCode), data, { merge: true });
    classSettings[classCode] = { ...classSettings[classCode], ...data };
}

// ─── Firebase CRUD ──────────────────────────────────────────────────────────

async function loadStudents() {
    const snap = await getDocs(collection(db, 'students'));
    allStudents = [];
    snap.forEach(d => {
        const data = d.data();
        if (data.status === '퇴원') return;
        if (!data.enrollments?.length) {
            let levelSymbol = data.level_symbol || data.level_code || '';
            let classNumber = data.class_number || '';
            // Auto-correction: level_symbol에 숫자만 있으면 class_number로 이동
            if (/^\d+$/.test(levelSymbol) && !classNumber) {
                classNumber = levelSymbol;
                levelSymbol = '';
            }
            data.enrollments = [{
                class_type: data.class_type || '정규',
                level_symbol: levelSymbol,
                class_number: classNumber,
                day: normalizeDays(data.day),
                start_date: data.start_date || ''
            }];
        } else {
            data.enrollments = data.enrollments.map(e => ({
                ...e,
                day: normalizeDays(e.day)
            }));
        }
        allStudents.push({ docId: d.id, ...data });
    });
    allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
}

async function loadDailyRecords(date) {
    dailyRecords = {};
    try {
        const q = query(collection(db, 'daily_records'), where('date', '==', date));
        const snap = await getDocs(q);
        snap.forEach(d => {
            const data = d.data();
            dailyRecords[data.student_id] = { docId: d.id, ...data };
        });
    } catch (err) {
        console.error('daily_records 로드 실패:', err.message);
    }
}

async function loadRetakeSchedules() {
    retakeSchedules = [];
    try {
        const snap = await getDocs(collection(db, 'retake_schedule'));
        snap.forEach(d => {
            retakeSchedules.push({ docId: d.id, ...d.data() });
        });
    } catch (err) {
        console.error('retake_schedule 로드 실패:', err.message);
    }
}

async function loadHwFailTasks() {
    hwFailTasks = [];
    try {
        const snap = await getDocs(collection(db, 'hw_fail_tasks'));
        snap.forEach(d => {
            hwFailTasks.push({ docId: d.id, ...d.data() });
        });
    } catch (err) {
        console.error('hw_fail_tasks 로드 실패:', err.message);
    }
}

function saveDailyRecord(studentId, updates) {
    if (saveTimers[studentId]) clearTimeout(saveTimers[studentId]);
    showSaveIndicator('saving');

    saveTimers[studentId] = setTimeout(async () => {
        try {
            const docId = makeDailyRecordId(studentId, selectedDate);
            const student = allStudents.find(s => s.docId === studentId);
            await setDoc(doc(db, 'daily_records', docId), {
                student_id: studentId,
                date: selectedDate,
                branch: branchFromStudent(student || {}),
                ...updates,
                updated_by: currentUser.email,
                updated_at: serverTimestamp()
            }, { merge: true });

            // 로컬 캐시 업데이트
            if (!dailyRecords[studentId]) {
                dailyRecords[studentId] = { docId, student_id: studentId, date: selectedDate };
            }
            Object.assign(dailyRecords[studentId], updates);

            showSaveIndicator('saved');
        } catch (err) {
            console.error('저장 실패:', err);
            showSaveIndicator('error');
        }
    }, 2000);
}

async function saveRetakeSchedule(data) {
    showSaveIndicator('saving');
    try {
        const docRef = await addDoc(collection(db, 'retake_schedule'), {
            ...data,
            created_by: currentUser.email,
            created_at: serverTimestamp()
        });
        retakeSchedules.push({ docId: docRef.id, ...data });
        showSaveIndicator('saved');
        return docRef.id;
    } catch (err) {
        console.error('일정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Save Indicator ─────────────────────────────────────────────────────────
let saveIndicatorTimer = null;

function showSaveIndicator(status) {
    const el = document.getElementById('save-indicator');
    const text = document.getElementById('save-text');
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);

    el.style.display = 'flex';
    el.className = 'save-indicator';

    if (status === 'saving') {
        text.textContent = '저장 중...';
    } else if (status === 'saved') {
        text.textContent = '저장 완료';
        el.classList.add('saved');
        saveIndicatorTimer = setTimeout(() => el.style.display = 'none', 1500);
    } else {
        text.textContent = '저장 실패';
        el.classList.add('error');
        saveIndicatorTimer = setTimeout(() => el.style.display = 'none', 3000);
    }
}

// ─── Immediate Save (for toggles) ──────────────────────────────────────────

async function saveImmediately(studentId, updates) {
    showSaveIndicator('saving');
    try {
        const docId = makeDailyRecordId(studentId, selectedDate);
        const student = allStudents.find(s => s.docId === studentId);
        await setDoc(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: selectedDate,
            branch: branchFromStudent(student || {}),
            ...updates,
            updated_by: currentUser.email,
            updated_at: serverTimestamp()
        }, { merge: true });

        if (!dailyRecords[studentId]) {
            dailyRecords[studentId] = { docId, student_id: studentId, date: selectedDate };
        }
        Object.assign(dailyRecords[studentId], updates);

        showSaveIndicator('saved');
    } catch (err) {
        console.error('저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 반 관리 헬퍼 ────────────────────────────────────────────────────────────

function getUniqueClassCodes() {
    const dayName = getDayName(selectedDate);
    const codes = new Set();
    allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (selectedBranch && branchFromStudent(s) !== selectedBranch) return;
        s.enrollments.forEach(e => {
            if (!e.day.includes(dayName)) return;
            const code = enrollmentCode(e);
            if (code) codes.add(code);
        });
    });
    return [...codes].sort();
}

function getClassMgmtCount(filterKey) {
    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e => e.day.includes(dayName))
    );
    if (selectedBranch) students = students.filter(s => branchFromStudent(s) === selectedBranch);
    if (filterKey === 'all') return students.length;
    return students.filter(s =>
        s.enrollments.some(e => e.day.includes(dayName) && enrollmentCode(e) === filterKey)
    ).length;
}

// ─── Category & SubFilter ──────────────────────────────────────────────────

function setCategory(category) {
    // 소속은 글로벌 필터 — 카테고리를 바꾸지 않고 L2 토글만
    if (category === 'branch') {
        const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
        const isExpanded = branchL1?.classList.contains('expanded');
        branchL1?.classList.toggle('expanded', !isExpanded);
        renderBranchFilter();
        renderSubFilters();
        renderListPanel();
        return;
    }

    // 반 관리도 글로벌 필터 — 카테고리를 바꾸지 않고 반 코드 드롭다운만 토글
    if (category === 'class_mgmt') {
        const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
        const isExpanded = classL1?.classList.contains('expanded');
        classL1?.classList.toggle('expanded', !isExpanded);
        renderClassCodeFilter();
        renderFilterChips();
        renderSubFilters();
        renderListPanel();
        return;
    }

    if (currentCategory === category) {
        // 같은 카테고리 클릭: L2 토글 (필터는 유지)
        l2Expanded = !l2Expanded;
        savedL2Expanded[category] = l2Expanded;
    } else {
        // 이전 카테고리 상태 저장 (필터 유지)
        savedSubFilters[currentCategory] = new Set(currentSubFilter);
        savedL2Expanded[currentCategory] = false; // L2는 접지만 필터는 유지

        currentCategory = category;

        // 새 카테고리의 저장된 필터 복원
        currentSubFilter.clear();
        if (savedSubFilters[category]?.size > 0) {
            for (const f of savedSubFilters[category]) {
                currentSubFilter.add(f);
            }
        }
        l2Expanded = true;
        savedL2Expanded[category] = true;
    }
    checkedItems.clear();

    // L1 active 토글 (branch, class_mgmt 제외 — 글로벌 필터)
    document.querySelectorAll('.nav-l1').forEach(el => {
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        el.classList.toggle('active', el.dataset.category === category);
    });

    // L2 서브필터 렌더링
    renderSubFilters();
    updateL1ExpandIcons();
    updateBatchBar();
    renderListPanel();
}

function updateL1ExpandIcons() {
    document.querySelectorAll('.nav-l1').forEach(el => {
        const icon = el.querySelector('.nav-l1-expand');
        if (!icon) return;
        // branch, class_mgmt는 별도 관리
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        const isActive = el.dataset.category === currentCategory;
        icon.textContent = (isActive && l2Expanded) ? 'expand_less' : 'expand_more';
    });
}

function renderSubFilters() {
    const container = document.getElementById('nav-l2-group');
    const filters = {
        attendance: [
            { key: 'pre_arrival', label: '등원전' },
            { key: 'present', label: '출석' },
            { key: 'late', label: '지각' },
            { key: 'absent', label: '결석' },
            { key: 'other', label: '기타' }
        ],
        homework: [
            { key: 'hw_1st', label: '1차' },
            { key: 'hw_2nd', label: '2차' },
            { key: 'hw_next', label: '다음숙제' }
        ],
        test: [
            { key: 'test_1st', label: '1차' },
            { key: 'test_2nd', label: '2차' }
        ],
        automation: [
            { key: 'auto_hw_missing', label: '미제출 숙제' },
            { key: 'auto_retake', label: '재시 필요' },
            { key: 'auto_unchecked', label: '미체크 출석' }
        ]
    };

    const items = filters[currentCategory] || [];

    if (items.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-sec);font-size:13px;">추후 확장 예정</div>';
    } else {
        container.innerHTML = items.map(f => {
            const isActive = currentSubFilter.has(f.key) ? 'active' : '';
            const { count, total } = getSubFilterCount(f.key);
            return `<div class="nav-l2 ${isActive}" data-filter="${f.key}" onclick="setSubFilter('${f.key}')">
                ${esc(f.label)}
                ${total > 0 ? `<span class="nav-l2-count">${count}/${total}</span>` : ''}
            </div>`;
        }).join('');
    }

    // L2 컨테이너를 활성 L1 바로 뒤에 배치
    const activeL1 = document.querySelector('.nav-l1.active');
    if (activeL1) {
        activeL1.after(container);
    }

    // 펼침/접힘 상태 반영
    container.style.display = l2Expanded ? '' : 'none';
}

function renderBranchFilter() {
    let container = document.getElementById('nav-branch-l2');
    const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
    if (!branchL1) return;

    if (!container) {
        container = document.createElement('div');
        container.id = 'nav-branch-l2';
        container.className = 'nav-l2-group';
        branchL1.after(container);
    }

    const branches = [
        { key: '2단지', label: '2단지' },
        { key: '10단지', label: '10단지' }
    ];
    const active = allStudents.filter(s => s.status !== '퇴원');

    container.innerHTML = branches.map(b => {
        const isActive = selectedBranch === b.key ? 'active' : '';
        const count = active.filter(s => branchFromStudent(s) === b.key).length;
        return `<div class="nav-l2 ${isActive}" data-filter="${b.key}" onclick="setBranch('${b.key}')">
            ${esc(b.label)}
            ${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
        </div>`;
    }).join('');

    const isExpanded = branchL1.classList.contains('expanded');
    container.style.display = isExpanded ? '' : 'none';

    // 소속 L1 expand 아이콘 업데이트
    const icon = branchL1.querySelector('.nav-l1-expand');
    if (icon) icon.textContent = isExpanded ? 'expand_less' : 'expand_more';

    // 소속 선택 시 L1에 시각적 표시
    branchL1.classList.toggle('has-filter', !!selectedBranch);
}

function renderClassCodeFilter() {
    let container = document.getElementById('nav-class-l2');
    const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
    if (!classL1) return;

    if (!container) {
        container = document.createElement('div');
        container.id = 'nav-class-l2';
        container.className = 'nav-l2-group';
        classL1.after(container);
    }

    const classCodes = getUniqueClassCodes();
    const dayName = getDayName(selectedDate);

    container.innerHTML = classCodes.map(code => {
        const isActive = selectedClassCode === code ? 'active' : '';
        const count = allStudents.filter(s =>
            s.enrollments.some(e => e.day.includes(dayName) && enrollmentCode(e) === code)
        ).length;
        return `<div class="nav-l2 ${isActive}" data-filter="${code}" onclick="setClassCode('${escAttr(code)}')">
            ${esc(code)}
            ${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
        </div>`;
    }).join('');

    const isExpanded = classL1.classList.contains('expanded');
    container.style.display = isExpanded ? '' : 'none';

    const icon = classL1.querySelector('.nav-l1-expand');
    if (icon) icon.textContent = isExpanded ? 'expand_less' : 'expand_more';

    classL1.classList.toggle('has-filter', !!selectedClassCode);
}

function setClassCode(code) {
    selectedClassCode = selectedClassCode === code ? null : code;
    selectedStudentId = null; // 반 변경 시 학생 선택 해제
    checkedItems.clear();
    renderClassCodeFilter();
    renderFilterChips();
    renderSubFilters();
    updateBatchBar();
    renderListPanel();
    // 반 해제 시 디테일 초기화
    if (!selectedClassCode) {
        renderStudentDetail(null);
    }
}

function setBranch(branchKey) {
    selectedBranch = selectedBranch === branchKey ? null : branchKey;
    checkedItems.clear();
    renderBranchFilter();
    renderSubFilters();
    updateBatchBar();
    renderListPanel();
}

function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    if (!container) return;

    const categoryLabels = { attendance: '출결', homework: '숙제', test: '테스트', automation: '자동화' };
    const subFilterLabels = {
        pre_arrival: '등원전', present: '출석', late: '지각', absent: '결석', other: '기타',
        hw_1st: '1차', hw_2nd: '2차', hw_next: '다음숙제',
        test_1st: '1차', test_2nd: '2차',
        auto_hw_missing: '미제출 숙제', auto_retake: '재시 필요', auto_unchecked: '미체크 출석'
    };

    const chips = [];

    // 모든 콘텐츠 카테고리의 활성 필터를 칩으로 표시
    const allFilters = { ...savedSubFilters };
    allFilters[currentCategory] = new Set(currentSubFilter);

    for (const [cat, filters] of Object.entries(allFilters)) {
        if (!filters?.size || !categoryLabels[cat]) continue;
        const catLabel = categoryLabels[cat];
        const subLabel = [...filters].map(k => subFilterLabels[k] || k).join('·');
        chips.push({ label: `${catLabel}: ${subLabel}`, onRemove: `clearCat:${cat}` });
    }

    // 소속 칩
    if (selectedBranch) {
        chips.push({ label: `소속: ${selectedBranch}`, onRemove: 'clearBranch' });
    }

    // 반 칩
    if (selectedClassCode) {
        chips.push({ label: `반: ${selectedClassCode}`, onRemove: 'clearClassCode' });
    }

    if (chips.length === 0) {
        container.innerHTML = '<span class="filter-chips-empty">전체</span>';
    } else {
        container.innerHTML = chips.map(c =>
            `<span class="filter-chip">${esc(c.label)}<button class="filter-chip-close" onclick="removeFilterChip('${escAttr(c.onRemove)}')">&times;</button></span>`
        ).join('') +
            `<button class="filter-chip-clear-all" onclick="clearAllFilters()" title="모든 필터 해제">&times;</button>`;
    }
}

function removeFilterChip(action) {
    if (action.startsWith('clearCat:')) {
        const cat = action.replace('clearCat:', '');
        if (cat === currentCategory) {
            currentSubFilter.clear();
            l2Expanded = false;
        }
        savedSubFilters[cat] = new Set();
        savedL2Expanded[cat] = false;
        // L2 UI 동기화
        renderSubFilters();
        updateL1ExpandIcons();
    } else if (action === 'clearBranch') {
        selectedBranch = null;
        const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
        branchL1?.classList.remove('expanded');
        renderBranchFilter();
    } else if (action === 'clearClassCode') {
        selectedClassCode = null;
        const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
        classL1?.classList.remove('expanded');
        renderClassCodeFilter();
        // 디테일 패널 초기화
        selectedStudentId = null;
        renderStudentDetail(null);
    }
    checkedItems.clear();
    updateBatchBar();
    renderFilterChips();
    renderListPanel();
}

function clearAllFilters() {
    // 콘텐츠 필터 전부 해제
    currentSubFilter.clear();
    for (const cat of Object.keys(savedSubFilters)) {
        savedSubFilters[cat] = new Set();
        savedL2Expanded[cat] = false;
    }
    l2Expanded = false;
    // 글로벌 필터 해제
    selectedBranch = null;
    selectedClassCode = null;
    document.querySelector('.nav-l1[data-category="branch"]')?.classList.remove('expanded');
    document.querySelector('.nav-l1[data-category="class_mgmt"]')?.classList.remove('expanded');
    // UI 동기화
    selectedStudentId = null;
    renderStudentDetail(null);
    checkedItems.clear();
    renderBranchFilter();
    renderClassCodeFilter();
    renderSubFilters();
    updateL1ExpandIcons();
    updateBatchBar();
    renderFilterChips();
    renderListPanel();
}

window.removeFilterChip = removeFilterChip;
window.clearAllFilters = clearAllFilters;

function setSubFilter(filterKey) {
    // 단일 선택: 같은 필터 클릭 시 해제, 다른 필터 클릭 시 교체
    if (currentSubFilter.has(filterKey)) {
        currentSubFilter.clear();
    } else {
        currentSubFilter.clear();
        currentSubFilter.add(filterKey);
    }
    checkedItems.clear();

    document.querySelectorAll('.nav-l2').forEach(el => {
        el.classList.toggle('active', currentSubFilter.has(el.dataset.filter));
    });

    // 현재 카테고리의 L2 상태 저장
    savedSubFilters[currentCategory] = new Set(currentSubFilter);

    updateBatchBar();
    renderListPanel();
}

function getSubFilterCount(filterKey) {
    const dayName = getDayName(selectedDate);
    let todayStudents = allStudents.filter(s =>
        s.enrollments.some(e => e.day.includes(dayName))
    );
    if (selectedBranch) todayStudents = todayStudents.filter(s => branchFromStudent(s) === selectedBranch);
    if (selectedClassCode) todayStudents = todayStudents.filter(s => s.enrollments.some(e => enrollmentCode(e) === selectedClassCode));

    const total = todayStudents.length;
    const r = (count) => ({ count, total });

    if (currentCategory === 'attendance') {
        switch (filterKey) {
            case 'all': return r(total);
            case 'pre_arrival': return r(todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return !rec?.attendance?.status || rec.attendance.status === '미확인';
            }).length);
            case 'present': return r(todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '출석').length);
            case 'late': return r(todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '지각').length);
            case 'absent': return r(todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '결석').length);
            case 'other': return r(todayStudents.filter(s => {
                const st = dailyRecords[s.docId]?.attendance?.status;
                return st && !['미확인', '출석', '지각', '결석'].includes(st);
            }).length);
            default: return r(0);
        }
    }

    if (currentCategory === 'homework') {
        switch (filterKey) {
            case 'all': return r(total);
            case 'hw_1st': return r(todayStudents.filter(s => {
                const domains = dailyRecords[s.docId]?.hw_domains_1st;
                return domains && Object.values(domains).some(v => v);
            }).length);
            case 'hw_2nd': return r(todayStudents.filter(s => {
                const domains = getStudentDomains(s.docId);
                const d1st = dailyRecords[s.docId]?.hw_domains_1st || {};
                return domains.some(d => d1st[d] !== 'O');
            }).length);
            case 'hw_next': return r(todayStudents.filter(s => (dailyRecords[s.docId]?.homework || []).length >= 3).length);
            case 'not_submitted': return r(todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length;
            }).length);
            case 'submitted': return r(todayStudents.filter(s => dailyRecords[s.docId]?.homework?.some(h => h.status === '제출')).length);
            case 'confirmed': return r(todayStudents.filter(s => dailyRecords[s.docId]?.homework?.some(h => h.status === '확인완료')).length);
            default: return r(0);
        }
    }

    if (currentCategory === 'test') {
        switch (filterKey) {
            case 'all': return r(total);
            case 'test_1st': return r(todayStudents.filter(s => {
                const d = dailyRecords[s.docId]?.test_domains_1st;
                return d && Object.values(d).some(v => v);
            }).length);
            case 'test_2nd': return r(todayStudents.filter(s => {
                const { flat } = getStudentTestItems(s.docId);
                const d1st = dailyRecords[s.docId]?.test_domains_1st || {};
                return flat.some(t => d1st[t] !== 'O');
            }).length);
            default: return r(0);
        }
    }

    if (currentCategory === 'automation') {
        switch (filterKey) {
            case 'auto_hw_missing': return r(todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return !rec?.homework?.length || rec.homework.some(h => h.status === '미제출');
            }).length);
            case 'auto_retake': return r(todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return rec?.tests?.some(t => t.result === '재시필요');
            }).length);
            case 'auto_unchecked': return r(todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return !rec?.attendance?.status || rec.attendance.status === '미확인';
            }).length);
            default: return r(0);
        }
    }

    return 0;
}

// ─── Filtering ──────────────────────────────────────────────────────────────

function getFilteredStudents() {
    // 반 관리: 오늘 등원 예정 학생만 표시
    if (currentCategory === 'class_mgmt') {
        const dayName = getDayName(selectedDate);
        let students = allStudents.filter(s =>
            s.status !== '퇴원' && s.enrollments.some(e => e.day.includes(dayName))
        );
        if (selectedBranch) students = students.filter(s => branchFromStudent(s) === selectedBranch);
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            students = students.filter(s =>
                s.name?.toLowerCase().includes(q) ||
                s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q))
            );
        }
        if (currentSubFilter.size > 0 && !currentSubFilter.has('all')) {
            students = students.filter(s =>
                s.enrollments.some(e => currentSubFilter.has(enrollmentCode(e)))
            );
        }
        return students;
    }

    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.enrollments.some(e => e.day.includes(dayName))
    );

    // 소속 글로벌 필터
    if (selectedBranch) students = students.filter(s => branchFromStudent(s) === selectedBranch);

    // 반 글로벌 필터
    if (selectedClassCode) {
        students = students.filter(s =>
            s.enrollments.some(e => enrollmentCode(e) === selectedClassCode)
        );
    }

    // 검색어 필터
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        students = students.filter(s =>
            s.name?.toLowerCase().includes(q) ||
            s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q))
        );
    }

    // 모든 카테고리 필터를 AND로 적용
    // 현재 카테고리는 currentSubFilter, 나머지는 savedSubFilters에서
    const allFilters = { ...savedSubFilters };
    allFilters[currentCategory] = new Set(currentSubFilter);

    // 출결 필터
    const attF = allFilters['attendance'];
    if (attF?.size > 0) {
        students = students.filter(s => {
            const rec = dailyRecords[s.docId];
            const st = rec?.attendance?.status || '미확인';
            for (const f of attF) {
                if (f === 'pre_arrival' && (!st || st === '미확인')) return true;
                if (f === 'present' && st === '출석') return true;
                if (f === 'late' && st === '지각') return true;
                if (f === 'absent' && st === '결석') return true;
                if (f === 'other' && st && !['미확인', '출석', '지각', '결석'].includes(st)) return true;
            }
            return false;
        });
    }

    // 숙제 필터
    const hwF = allFilters['homework'];
    if (hwF?.size > 0) {
        const isHw1st = hwF.has('hw_1st');
        const isHw2nd = hwF.has('hw_2nd');
        if (isHw1st) {
            // 1차: 전원 표시
        } else if (isHw2nd) {
            students = students.filter(s => {
                const domains = getStudentDomains(s.docId);
                const d1st = dailyRecords[s.docId]?.hw_domains_1st || {};
                return domains.some(d => d1st[d] !== 'O');
            });
        } else {
            students = students.filter(s => {
                const rec = dailyRecords[s.docId];
                for (const f of hwF) {
                    if (f === 'hw_next' && (rec?.homework || []).length >= 3) return true;
                    if (f === 'not_submitted' && (rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length)) return true;
                    if (f === 'submitted' && rec?.homework?.some(h => h.status === '제출')) return true;
                    if (f === 'confirmed' && rec?.homework?.some(h => h.status === '확인완료')) return true;
                }
                return false;
            });
        }
    }

    // 테스트 필터
    const testF = allFilters['test'];
    if (testF?.size > 0) {
        const isTest1st = testF.has('test_1st');
        const isTest2nd = testF.has('test_2nd');
        if (isTest1st) {
            // 1차: 전원 표시
        } else if (isTest2nd) {
            students = students.filter(s => {
                const { flat } = getStudentTestItems(s.docId);
                const d1st = dailyRecords[s.docId]?.test_domains_1st || {};
                return flat.some(t => d1st[t] !== 'O');
            });
        } else {
            students = students.filter(s => {
                const rec = dailyRecords[s.docId];
                for (const f of testF) {
                    if (f === 'scheduled' && rec?.tests?.some(t => t.score === undefined || t.score === null)) return true;
                    if (f === 'pass' && rec?.tests?.some(t => t.result === '통과')) return true;
                    if (f === 'retake' && rec?.tests?.some(t => t.result === '재시필요')) return true;
                }
                return false;
            });
        }
    }

    // 자동화 필터
    const autoF = allFilters['automation'];
    if (autoF?.size > 0) {
        students = students.filter(s => {
            const rec = dailyRecords[s.docId];
            for (const f of autoF) {
                if (f === 'auto_hw_missing' && (!rec?.homework?.length || rec.homework.some(h => h.status === '미제출'))) return true;
                if (f === 'auto_retake' && rec?.tests?.some(t => t.result === '재시필요')) return true;
                if (f === 'auto_unchecked' && (!rec?.attendance?.status || rec.attendance.status === '미확인')) return true;
            }
            return false;
        });
    }

    // 출결 필터 활성 시 등원시간 임박순 정렬
    const allF = { ...savedSubFilters };
    allF[currentCategory] = new Set(currentSubFilter);
    if (allF['attendance']?.size > 0 || currentCategory === 'attendance') {
        const dayName = getDayName(selectedDate);
        students.sort((a, b) => {
            const timeA = a.enrollments.find(e => e.day.includes(dayName))?.start_time || '99:99';
            const timeB = b.enrollments.find(e => e.day.includes(dayName))?.start_time || '99:99';
            return timeA.localeCompare(timeB);
        });
    }

    // hw_fail_action 등원일이 오늘인 학생 추가 포함 (정규 수업 없어도 리스트에 나타나야 함)
    const hwVisitStudents = allStudents.filter(s => {
        if (students.some(st => st.docId === s.docId)) return false; // 이미 포함
        const hwFail = dailyRecords[s.docId]?.hw_fail_action || {};
        return Object.values(hwFail).some(a => a.type === '등원' && a.scheduled_date === selectedDate);
    });
    if (hwVisitStudents.length > 0) {
        students = [...students, ...hwVisitStudents];
    }

    return students;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderListPanel() {
    const students = getFilteredStudents();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    // 필터 칩 렌더링
    renderFilterChips();

    countEl.textContent = `${students.length}명`;

    // 전체 선택 체크박스 상태 동기화
    const selectAllCb = document.getElementById('select-all-checkbox');
    if (selectAllCb) {
        selectAllCb.checked = students.length > 0 && students.every(s => checkedItems.has(s.docId));
        selectAllCb.indeterminate = students.some(s => checkedItems.has(s.docId)) && !selectAllCb.checked;
    }

    if (students.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">person_search</span>
            <p>해당하는 학생이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = students.map(s => {
        const isActive = s.docId === selectedStudentId ? 'active' : '';
        const isChecked = checkedItems.has(s.docId) ? 'checked' : '';
        const code = (s.enrollments || []).map(e => enrollmentCode(e)).join(', ');
        const branch = branchFromStudent(s);

        let toggleHtml = '';

        if (currentCategory === 'attendance') {
            const rec = dailyRecords[s.docId];
            const attStatus = rec?.attendance?.status || '미확인';
            const statuses = ['등원전', '출석', '지각', '결석', '조퇴', '기타'];
            // 미확인 maps to 등원전 for display
            const currentDisplay = attStatus === '미확인' ? '등원전' : attStatus;
            toggleHtml = `<div class="toggle-group">` +
                statuses.map(st => {
                    let activeClass = '';
                    if (st === currentDisplay) {
                        if (st === '출석') activeClass = 'active-present';
                        else if (st === '결석') activeClass = 'active-absent';
                        else if (st === '지각') activeClass = 'active-late';
                        else activeClass = 'active-other';
                    }
                    return `<button class="toggle-btn ${activeClass}" onclick="event.stopPropagation(); toggleAttendance('${s.docId}', '${st}')">${st}</button>`;
                }).join('') +
                `</div>`;
        } else if (currentCategory === 'homework') {
            const rec = dailyRecords[s.docId];
            const isHw1st = currentSubFilter.has('hw_1st');
            const isHw2nd = currentSubFilter.has('hw_2nd');
            const isHwNext = currentSubFilter.has('hw_next');

            if (isHw1st || isHw2nd) {
                const field = isHw1st ? 'hw_domains_1st' : 'hw_domains_2nd';
                const domainData = rec?.[field] || {};
                const allDomains = getStudentDomains(s.docId);
                // 2차: 1차에서 O가 아닌 영역만 표시
                const domains = isHw2nd
                    ? allDomains.filter(d => (rec?.hw_domains_1st || {})[d] !== 'O')
                    : allDomains;
                toggleHtml = `<div class="hw-domain-group">` +
                    domains.map(d => {
                        const val = domainData[d] || '';
                        const cls = oxDisplayClass(val);
                        return `<div class="hw-domain-item">
                            <span class="hw-domain-label">${esc(d)}</span>
                            <button class="hw-domain-ox ${cls}" data-student="${s.docId}" data-field="${field}" data-domain="${escAttr(d)}"
                                onclick="event.stopPropagation(); toggleHwDomainOX('${s.docId}', '${field}', '${escAttr(d)}')">${esc(val || '—')}</button>
                        </div>`;
                    }).join('') +
                    `</div>`;
            } else if (isHwNext) {
                // L2 hw_next: 기존 커스텀 숙제 배열
                const homework = rec?.homework || [];
                if (homework.length === 0) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">숙제 없음</span></div>`;
                } else {
                    toggleHtml = homework.map((h, i) => {
                        const hStatuses = ['미제출', '제출', '확인완료'];
                        return `<div style="margin-top:4px;"><span style="font-size:12px;color:var(--text-sec);margin-right:8px;">${esc(h.title || '숙제'+(i+1))}</span>
                            <div class="toggle-group" style="display:inline-flex;">` +
                            hStatuses.map(st => {
                                let activeClass = '';
                                if (h.status === st) {
                                    activeClass = st === '확인완료' ? 'active-present' : st === '제출' ? 'active-late' : 'active-absent';
                                }
                                return `<button class="toggle-btn ${activeClass}" onclick="event.stopPropagation(); toggleHomework('${s.docId}', ${i}, '${st}')">${st}</button>`;
                            }).join('') +
                            `</div></div>`;
                    }).join('');
                }
            } else {
                // L1 숙제 (서브필터 없음): 읽기전용 영역 상태 요약
                const d1st = rec?.hw_domains_1st || {};
                const d2nd = rec?.hw_domains_2nd || {};
                const domains = getStudentDomains(s.docId);
                const has1st = Object.values(d1st).some(v => v);
                const has2nd = Object.values(d2nd).some(v => v);

                if (!has1st && !has2nd) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">영역 숙제 미입력</span></div>`;
                } else {
                    let summaryParts = [];
                    if (has1st) {
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">1차</span><div class="hw-domain-group">` +
                            domains.map(d => {
                                const val = d1st[d] || '';
                                const cls = oxDisplayClass(val);
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('') +
                            `</div></div>`);
                    }
                    if (has2nd) {
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">2차</span><div class="hw-domain-group">` +
                            domains.map(d => {
                                const val = d2nd[d] || '';
                                const cls = oxDisplayClass(val);
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('') +
                            `</div></div>`);
                    }
                    toggleHtml = summaryParts.join('');
                }
            }
        } else if (currentCategory === 'test') {
            const rec = dailyRecords[s.docId];
            const isTest1st = currentSubFilter.has('test_1st');
            const isTest2nd = currentSubFilter.has('test_2nd');

            if (isTest1st || isTest2nd) {
                // 1차/2차: 섹션별 OX 토글
                const field = isTest1st ? 'test_domains_1st' : 'test_domains_2nd';
                const domainData = rec?.[field] || {};
                const { sections } = getStudentTestItems(s.docId);
                const d1st = rec?.test_domains_1st || {};

                let sectionHtmlParts = [];
                for (const [secName, items] of Object.entries(sections)) {
                    const filtered = isTest2nd ? items.filter(t => d1st[t] !== 'O') : items;
                    if (filtered.length === 0) continue;
                    sectionHtmlParts.push(
                        `<div style="margin-top:4px;">` +
                        `<div class="hw-domain-group">` +
                        filtered.map(t => {
                            const val = domainData[t] || '';
                            const cls = oxDisplayClass(val);
                            return `<div class="hw-domain-item">
                                <span class="hw-domain-label">${esc(t)}</span>
                                <button class="hw-domain-ox ${cls}" data-student="${s.docId}" data-field="${field}" data-domain="${escAttr(t)}"
                                    onclick="event.stopPropagation(); toggleHwDomainOX('${s.docId}', '${field}', '${escAttr(t)}')">${esc(val || '—')}</button>
                            </div>`;
                        }).join('') +
                        `</div></div>`
                    );
                }
                toggleHtml = sectionHtmlParts.length > 0
                    ? sectionHtmlParts.join('')
                    : `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">테스트 항목 없음</span></div>`;
            } else {
                // L1 테스트 (서브필터 없음): 읽기전용 요약
                const d1st = rec?.test_domains_1st || {};
                const d2nd = rec?.test_domains_2nd || {};
                const { sections } = getStudentTestItems(s.docId);
                const has1st = Object.values(d1st).some(v => v);
                const has2nd = Object.values(d2nd).some(v => v);

                if (!has1st && !has2nd) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">테스트 미입력</span></div>`;
                } else {
                    let summaryParts = [];
                    for (const [round, data] of [['1차', d1st], ['2차', d2nd]]) {
                        if (!Object.values(data).some(v => v)) continue;
                        let secParts = [];
                        for (const [secName, items] of Object.entries(sections)) {
                            const hasAny = items.some(t => data[t]);
                            if (!hasAny) continue;
                            secParts.push(
                                `<div class="hw-domain-group">` +
                                items.map(t => {
                                    const val = data[t] || '';
                                    const cls = oxDisplayClass(val);
                                    return `<div class="hw-domain-item">
                                        <span class="hw-domain-label">${esc(t)}</span>
                                        <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                    </div>`;
                                }).join('') +
                                `</div>`
                            );
                        }
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">${round}</span><div style="display:flex;flex-direction:column;gap:2px;">${secParts.join('')}</div></div>`);
                    }
                    toggleHtml = summaryParts.join('');
                }
            }
        } else if (currentCategory === 'automation') {
            const autoRec = dailyRecords[s.docId];
            const issues = [];
            if (!autoRec?.homework?.length) {
                issues.push('<span class="tag tag-absent" style="font-size:11px;">숙제 미등록</span>');
            } else {
                const missing = autoRec.homework.filter(h => h.status === '미제출');
                if (missing.length > 0) {
                    issues.push(...missing.map(h => `<span class="tag tag-absent" style="font-size:11px;">미제출: ${esc(h.title || '숙제')}</span>`));
                }
            }
            if (autoRec?.tests?.length) {
                const retakes = autoRec.tests.filter(t => t.result === '재시필요');
                if (retakes.length > 0) {
                    issues.push(...retakes.map(t => `<span class="tag tag-late" style="font-size:11px;">재시: ${esc(t.title || '테스트')} (${t.score != null ? t.score + '점' : '-'})</span>`));
                }
            }
            if (!autoRec?.attendance?.status || autoRec.attendance.status === '미확인') {
                issues.push('<span class="tag tag-pending" style="font-size:11px;">출석 미체크</span>');
            }
            if (issues.length > 0) {
                toggleHtml = `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${issues.join('')}</div>`;
            } else {
                toggleHtml = `<div style="margin-top:4px;"><span style="font-size:12px;color:var(--text-sec);">이슈 없음</span></div>`;
            }
        } else if (currentCategory === 'class_mgmt') {
            toggleHtml = s.enrollments.map((e, idx) => {
                const days = e.day?.join('\u00B7') || '';
                const time = e.start_time ? formatTime12h(e.start_time) : '';
                return `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:var(--text-sec);">${esc(enrollmentCode(e))} ${days} ${time}</span>
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openEnrollmentModal('${s.docId}', ${idx})">편집</button>
                </div>`;
            }).join('');
        }

        // 등원시간
        const rec = dailyRecords[s.docId];
        const arrivalTime = rec?.arrival_time;
        const dayName = getDayName(selectedDate);
        const todayEnroll = s.enrollments.find(e => e.day.includes(dayName));
        const scheduledTime = todayEnroll?.start_time;

        // hw_fail_tasks 등원 예약 시간 (선택날짜 기준 pending)
        const visitTasks = hwFailTasks.filter(t =>
            t.student_id === s.docId &&
            t.type === '등원' &&
            t.scheduled_date === selectedDate &&
            t.status === 'pending'
        );

        let timeLabel = '', timeValue = '', timeClass = '';
        if (arrivalTime) {
            timeLabel = '등원'; timeValue = formatTime12h(arrivalTime); timeClass = 'arrived';
        } else if (scheduledTime) {
            timeLabel = '예정'; timeValue = formatTime12h(scheduledTime);
        }
        const timeHtml = [
            timeValue ? `<div class="item-time-block ${timeClass}">
                <span class="item-time-label">${timeLabel}</span>
                <span class="item-time-value">${esc(timeValue)}</span>
            </div>` : '',
            // 정규 수업과 시간이 다른 등원 예약 시간 추가 표시
            ...visitTasks
                .filter(t => t.scheduled_time && t.scheduled_time !== scheduledTime)
                .map(t => `<div class="item-time-block" style="color:var(--danger);">
                    <span class="item-time-label" style="color:var(--danger);">보충</span>
                    <span class="item-time-value" style="color:var(--danger);">${esc(formatTime12h(t.scheduled_time))}</span>
                </div>`)
        ].join('');

        // hw_fail_tasks 기반 아이콘 (대체숙제/등원예약) - pending 상태만
        const pendingTasks = hwFailTasks.filter(t => t.student_id === s.docId && t.status === 'pending');
        const hasAltHw = pendingTasks.some(t => t.type === '대체숙제');
        const hasVisit = pendingTasks.some(t => t.type === '등원');
        const hwFailIconHtml = hasAltHw
            ? `<span class="hw-fail-badge hw-fail-alt" title="대체숙제 있음"><span class="material-symbols-outlined" style="font-size:14px;">edit_note</span></span>`
            : hasVisit
            ? `<span class="hw-fail-badge hw-fail-visit" title="등원 예약 있음"><span class="material-symbols-outlined" style="font-size:14px;">directions_walk</span></span>`
            : '';

        return `<div class="list-item ${isActive}" data-id="${s.docId}" onclick="selectStudent('${s.docId}')">
            <input type="checkbox" class="item-checkbox" ${isChecked}
                onclick="event.stopPropagation(); toggleCheck('${s.docId}', this.checked)">
            <div class="item-info">
                <span class="item-title">${esc(s.name)}${hwFailIconHtml} <span class="item-class-type">${esc(todayEnroll?.class_type || '')}</span></span>
                <span class="item-desc">${esc(code)}${studentShortLabel(s) ? ', ' + esc(studentShortLabel(s)) : ''}</span>
            </div>
            ${timeHtml}
            <div class="item-actions">${toggleHtml}</div>
        </div>`;
    }).join('');

    // 반 상세 표시: 반(+소속)만 선택되고, 콘텐츠 서브필터 없을 때
    const allFilters = { ...savedSubFilters };
    allFilters[currentCategory] = new Set(currentSubFilter);
    const hasContentFilter = ['attendance', 'homework', 'test', 'automation'].some(cat => allFilters[cat]?.size > 0);
    if (selectedClassCode && !selectedStudentId && !hasContentFilter) {
        renderClassDetail(selectedClassCode);
    }
}

// ─── Class Detail Panel ─────────────────────────────────────────────────────

const DEFAULT_TEST_SECTIONS = {
    '기반학습테스트': ['Vo', 'Id', 'ISC'],
    '리뷰테스트': []
};

function getClassTestSections(classCode) {
    const saved = classSettings[classCode]?.test_sections;
    if (saved) return JSON.parse(JSON.stringify(saved));
    // 최초: 리뷰테스트를 영역숙제관리(domains) 기반으로 초기화
    const sections = JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS));
    sections['리뷰테스트'] = [...getClassDomains(classCode)];
    return sections;
}

function renderClassDetail(classCode) {
    if (!classCode) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
    }

    selectedStudentId = null; // 학생 선택 해제

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const dayName = getDayName(selectedDate);
    let classStudents = allStudents.filter(s =>
        s.status !== '퇴원' &&
        s.enrollments.some(e => enrollmentCode(e) === classCode && e.day.includes(dayName))
    );
    if (selectedBranch) {
        classStudents = classStudents.filter(s => branchFromStudent(s) === selectedBranch);
    }
    const domains = getClassDomains(classCode);
    const testSections = getClassTestSections(classCode);

    // 프로필 헤더를 반 정보로 교체
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">${classStudents.length}명</span>
    `;

    const cardsContainer = document.getElementById('detail-cards');

    // ① 등원예정시간 (enrollment start_time — 영구 저장)
    const arrivalRows = classStudents.map(s => {
        const todayEnroll = s.enrollments.find(e => enrollmentCode(e) === classCode && e.day.includes(dayName));
        const currentTime = todayEnroll?.start_time || '';
        return `<div class="arrival-time-row">
            <span class="arrival-student-name">${esc(s.name)}</span>
            <input type="time" class="arrival-time-input" data-student-id="${s.docId}" value="${currentTime}">
        </div>`;
    }).join('');

    // ② 영역숙제관리
    const domainChips = domains.map((d, i) => `
        <span class="domain-chip">
            ${esc(d)}
            <button class="domain-chip-remove" onclick="event.stopPropagation(); removeClassDomain('${escAttr(classCode)}', ${i})" title="삭제">&times;</button>
        </span>
    `).join('');

    // ③ 테스트관리 — 섹션별 구성
    const sectionNames = Object.keys(testSections);
    const testSectionsHtml = sectionNames.map(secName => {
        const tests = testSections[secName] || [];
        const testChips = tests.map((t, i) => `
            <span class="domain-chip">
                ${esc(t)}
                <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestFromSection('${escAttr(classCode)}', '${escAttr(secName)}', ${i})" title="삭제">&times;</button>
            </span>
        `).join('');
        return `
            <div class="test-section">
                <div class="test-section-header">
                    <span class="test-section-name">${esc(secName)}</span>
                    <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestSection('${escAttr(classCode)}', '${escAttr(secName)}')" title="섹션 삭제">&times;</button>
                </div>
                <div class="domain-chips-container">${testChips || '<span style="font-size:12px;color:var(--text-sec);">테스트 없음</span>'}</div>
                <div class="domain-add-row">
                    <input type="text" class="field-input" data-test-section="${escAttr(secName)}" placeholder="테스트 이름" style="flex:1;"
                        onkeydown="if(event.key==='Enter') addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">
                    <button class="btn btn-primary btn-sm" onclick="addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">추가</button>
                </div>
                <button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="resetTestSection('${escAttr(classCode)}', '${escAttr(secName)}')">기본값 복원</button>
            </div>
        `;
    }).join('');

    cardsContainer.innerHTML = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">schedule</span>
                등원예정시간
            </div>
            <div class="arrival-bulk-row">
                <input type="time" id="arrival-bulk-time-detail" class="arrival-time-input">
                <button class="btn btn-primary btn-sm" onclick="applyClassArrivalTimeDetail('${escAttr(classCode)}')">전체 적용</button>
            </div>
            <div class="arrival-student-list">${arrivalRows || '<span class="detail-card-empty">학생 없음</span>'}</div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">category</span>
                영역숙제관리
            </div>
            <div class="domain-chips-container">${domainChips || '<span class="detail-card-empty">영역 없음</span>'}</div>
            <div class="domain-add-row">
                <input type="text" id="domain-add-input" class="field-input" placeholder="새 영역 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addClassDomain('${escAttr(classCode)}')">
                <button class="btn btn-primary btn-sm" onclick="addClassDomain('${escAttr(classCode)}')">추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetClassDomains('${escAttr(classCode)}')">기본값 복원</button>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">quiz</span>
                테스트관리
            </div>
            ${testSectionsHtml}
            <div class="domain-add-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
                <input type="text" id="test-section-add-input" class="field-input" placeholder="새 섹션 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addTestSection('${escAttr(classCode)}')">
                <button class="btn btn-secondary btn-sm" onclick="addTestSection('${escAttr(classCode)}')">섹션 추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetTestSections('${escAttr(classCode)}')">기본값 복원</button>
        </div>

        <div class="class-detail-actions">
            <button class="btn btn-primary" onclick="saveClassScheduledTimes('${escAttr(classCode)}')">
                <span class="material-symbols-outlined" style="font-size:18px;">save</span> 반에 저장
            </button>
            <button class="btn btn-secondary" onclick="clearClassDetail()">
                <span class="material-symbols-outlined" style="font-size:18px;">delete_sweep</span> 클리어
            </button>
        </div>
    `;

    // 모바일에서 디테일 패널 표시
    if (window.innerWidth <= 768) {
        document.getElementById('detail-panel').classList.add('mobile-visible');
    }
}

// ─── Class Detail 핸들러 ────────────────────────────────────────────────────

async function addClassDomain(classCode) {
    const input = document.getElementById('domain-add-input');
    const name = input?.value.trim();
    if (!name) return;
    try {
        const domains = getClassDomains(classCode);
        if (domains.includes(name)) { alert('이미 존재하는 영역입니다.'); return; }
        domains.push(name);
        // 리뷰테스트에도 동기화 추가
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트'] && !sections['리뷰테스트'].includes(name)) {
            sections['리뷰테스트'].push(name);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        input.value = '';
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 추가 실패:', e);
        alert('영역 추가에 실패했습니다: ' + e.message);
    }
}

async function removeClassDomain(classCode, index) {
    try {
        const domains = getClassDomains(classCode);
        if (domains.length <= 1) { alert('최소 1개의 영역이 필요합니다.'); return; }
        const removed = domains.splice(index, 1)[0];
        // 리뷰테스트에서도 동기화 삭제
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트']) {
            const ri = sections['리뷰테스트'].indexOf(removed);
            if (ri !== -1) sections['리뷰테스트'].splice(ri, 1);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 삭제 실패:', e);
        alert('영역 삭제에 실패했습니다: ' + e.message);
    }
}

async function resetClassDomains(classCode) {
    try {
        // 리뷰테스트도 기본 영역으로 초기화
        const sections = getClassTestSections(classCode);
        sections['리뷰테스트'] = [...DEFAULT_DOMAINS];
        await saveClassSettings(classCode, { domains: [...DEFAULT_DOMAINS], test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

async function addTestToSection(classCode, sectionName) {
    const input = document.querySelector(`input[data-test-section="${sectionName}"]`);
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) sections[sectionName] = [];
    if (sections[sectionName].includes(name)) { alert('이미 존재하는 테스트입니다.'); return; }
    sections[sectionName].push(name);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

async function removeTestFromSection(classCode, sectionName, index) {
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) return;
    sections[sectionName].splice(index, 1);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

async function addTestSection(classCode) {
    const input = document.getElementById('test-section-add-input');
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (sections[name] !== undefined) { alert('이미 존재하는 섹션입니다.'); return; }
    sections[name] = [];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

async function removeTestSection(classCode, sectionName) {
    const sections = getClassTestSections(classCode);
    if (Object.keys(sections).length <= 1) { alert('최소 1개의 섹션이 필요합니다.'); return; }
    delete sections[sectionName];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

async function resetTestSections(classCode) {
    await saveClassSettings(classCode, { test_sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)) });
    renderClassDetail(classCode);
}

async function resetTestSection(classCode, sectionName) {
    try {
        const sections = getClassTestSections(classCode);
        // 리뷰테스트는 영역숙제관리 기반, 기반학습테스트는 Vo/Id/ISC, 나머지는 빈 배열
        if (sectionName === '리뷰테스트') {
            sections[sectionName] = [...getClassDomains(classCode)];
        } else {
            sections[sectionName] = [...(DEFAULT_TEST_SECTIONS[sectionName] || [])];
        }
        await saveClassSettings(classCode, { test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('섹션 기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

async function applyClassArrivalTimeDetail(classCode) {
    const timeInput = document.getElementById('arrival-bulk-time-detail');
    const time = timeInput?.value;
    if (!time) { alert('시간을 먼저 입력하세요.'); return; }

    const dayName = getDayName(selectedDate);
    let classStudents = allStudents.filter(s =>
        s.status !== '퇴원' &&
        s.enrollments.some(e => enrollmentCode(e) === classCode && e.day.includes(dayName))
    );
    if (selectedBranch) {
        classStudents = classStudents.filter(s => branchFromStudent(s) === selectedBranch);
    }

    showSaveIndicator('saving');
    try {
        const batch = writeBatch(db);
        classStudents.forEach(s => {
            const enrollments = [...s.enrollments];
            const idx = enrollments.findIndex(e => enrollmentCode(e) === classCode && e.day.includes(dayName));
            if (idx !== -1) {
                enrollments[idx] = { ...enrollments[idx], start_time: time };
                batch.update(doc(db, 'students', s.docId), { enrollments });
                s.enrollments = enrollments;
            }
        });
        await batch.commit();
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('등원예정시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

async function saveClassScheduledTimes(classCode) {
    const dayName = getDayName(selectedDate);
    const inputs = document.querySelectorAll('.arrival-time-input[data-student-id]');

    showSaveIndicator('saving');
    try {
        const batch = writeBatch(db);
        let hasChanges = false;

        inputs.forEach(input => {
            const studentId = input.dataset.studentId;
            const time = input.value;
            const student = allStudents.find(s => s.docId === studentId);
            if (!student) return;

            const enrollments = [...student.enrollments];
            const idx = enrollments.findIndex(e => enrollmentCode(e) === classCode && e.day.includes(dayName));
            if (idx !== -1) {
                enrollments[idx] = { ...enrollments[idx], start_time: time };
                batch.update(doc(db, 'students', studentId), { enrollments });
                student.enrollments = enrollments;
                hasChanges = true;
            }
        });

        if (hasChanges) {
            await batch.commit();
        }
        showSaveIndicator('saved');
        renderListPanel();
    } catch (err) {
        console.error('등원예정시간 일괄 저장 실패:', err);
        showSaveIndicator('error');
    }
}

function clearClassDetail() {
    document.querySelectorAll('.arrival-time-input').forEach(input => {
        input.value = '';
    });
}

// ─── HW Fail Action Card ────────────────────────────────────────────────────
// 2차 숙제 미통과 영역을 자동 감지하여 '등원' 또는 '대체숙제' 처리 입력 카드를 렌더링

function renderHwFailActionCard(studentId, domains, d2nd, hwFailAction) {
    // 2차에서 X 또는 △인 영역만 미통과 처리 대상
    // d2nd가 아예 비어있으면 (2차 미진행) 카드 숨김
    const d2ndHasAny = Object.values(d2nd).some(v => v);
    if (!d2ndHasAny) return '';

    // d2nd에서 X 또는 △인 영역만 추출 (O·빈칸 제외)
    const failDomains = domains.filter(d => {
        const val = d2nd[d] || '';
        return val === 'X' || val === '△';
    });

    if (failDomains.length === 0) {
        // 모두 O일 때: 축하 메시지만 표시
        return `
            <div class="detail-card hw-fail-card">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:var(--success);font-size:18px;">check_circle</span>
                    2차 숙제 처리
                </div>
                <div class="detail-card-empty" style="color:var(--success);">✅ 2차 모두 통과!</div>
            </div>
        `;
    }

    const rows = failDomains.map(domain => {
        const action = hwFailAction[domain] || {};
        const type = action.type || '';
        const isVisit = type === '등원';
        const isAlt = type === '대체숙제';
        const escapedDomain = escAttr(domain);

        return `
            <div class="hw-fail-domain-row" data-domain="${escapedDomain}">
                <div class="hw-fail-domain-header">
                    <span class="hw-domain-label" style="font-weight:600;font-size:13px;">${esc(domain)}</span>
                    <span class="hw-domain-ox hw-fail-ox ${oxDisplayClass(d2nd[domain] || '')}" style="font-size:12px;padding:2px 6px;">${esc(d2nd[domain] || '—')}</span>
                    <div class="hw-fail-type-btns">
                        <button class="hw-fail-type-btn ${isVisit ? 'active' : ''}"
                            onclick="selectHwFailType('${escAttr(studentId)}', '${escapedDomain}', '등원', this)">
                            <span class="material-symbols-outlined" style="font-size:14px;">directions_walk</span>등원
                        </button>
                        <button class="hw-fail-type-btn ${isAlt ? 'active' : ''}"
                            onclick="selectHwFailType('${escAttr(studentId)}', '${escapedDomain}', '대체숙제', this)">
                            <span class="material-symbols-outlined" style="font-size:14px;">edit_note</span>대체숙제
                        </button>
                        ${type ? `<button class="hw-fail-type-btn hw-fail-clear-btn"
                            onclick="clearHwFailType('${escAttr(studentId)}', '${escapedDomain}')">취소</button>` : ''}
                    </div>
                </div>
                ${isVisit ? `
                    <div class="hw-fail-detail">
                        <div class="hw-fail-detail-row">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">등원일시</label>
                            <input type="date" class="field-input hw-fail-input" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}"
                                onchange="updateHwFailField('${escAttr(studentId)}', '${escapedDomain}', 'scheduled_date', this.value)">
                            <input type="time" class="field-input hw-fail-input" style="width:90px;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_time || '16:00')}"
                                onchange="updateHwFailField('${escAttr(studentId)}', '${escapedDomain}', 'scheduled_time', this.value)">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || currentUser?.email || '').split('@')[0])}</div>
                    </div>
                ` : isAlt ? `
                    <div class="hw-fail-detail">
                        <input type="text" class="field-input hw-fail-input" style="width:100%;padding:4px 8px;font-size:12px;"
                            placeholder="대체 숙제 내용 (예: 단어장 50개)"
                            value="${escAttr(action.alt_hw || '')}"
                            onchange="updateHwFailField('${escAttr(studentId)}', '${escapedDomain}', 'alt_hw', this.value)">
                        <div class="hw-fail-detail-row" style="margin-top:4px;">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">제출기한</label>
                            <input type="date" class="field-input hw-fail-input" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}"
                                onchange="updateHwFailField('${escAttr(studentId)}', '${escapedDomain}', 'scheduled_date', this.value)">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || currentUser?.email || '').split('@')[0])}</div>
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
                2차 미통과 처리 (${failDomains.length}개 영역)
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                2차 미통과 영역에 '등원 약속' 또는 '대체 숙제'를 지정하세요.
            </div>
            ${rows}
        </div>
    `;
}

// 처리 유형 선택 (등원 / 대체숙제)
window.selectHwFailType = async function(studentId, domain, type, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    const hwFailAction = { ...(rec.hw_fail_action || {}) };
    const current = hwFailAction[domain] || {};

    // 같은 버튼 클릭 시 토글 해제
    if (current.type === type) {
        delete hwFailAction[domain];
    } else {
        hwFailAction[domain] = {
            ...current,
            type,
            handler: currentUser?.email || '',
            scheduled_date: current.scheduled_date || '',
            scheduled_time: current.scheduled_time || (type === '등원' ? '16:00' : ''),
            alt_hw: current.alt_hw || '',
            updated_at: new Date().toISOString(),
        };
    }

    await saveHwFailAction(studentId, hwFailAction);
    renderStudentDetail(studentId);
};

// 처리 유형 초기화
window.clearHwFailType = async function(studentId, domain) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    const hwFailAction = { ...(rec.hw_fail_action || {}) };
    delete hwFailAction[domain];
    await saveHwFailAction(studentId, hwFailAction);
    renderStudentDetail(studentId);
};

// 개별 필드 업데이트 (디바운스 저장)
let hwFailSaveTimers = {};
window.updateHwFailField = function(studentId, domain, field, value) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    if (!dailyRecords[studentId]) dailyRecords[studentId] = {};
    if (!dailyRecords[studentId].hw_fail_action) dailyRecords[studentId].hw_fail_action = {};
    if (!dailyRecords[studentId].hw_fail_action[domain]) dailyRecords[studentId].hw_fail_action[domain] = {};
    dailyRecords[studentId].hw_fail_action[domain][field] = value;
    dailyRecords[studentId].hw_fail_action[domain].updated_at = new Date().toISOString();

    const timerKey = `${studentId}_${domain}`;
    if (hwFailSaveTimers[timerKey]) clearTimeout(hwFailSaveTimers[timerKey]);
    hwFailSaveTimers[timerKey] = setTimeout(async () => {
        await saveHwFailAction(studentId, dailyRecords[studentId].hw_fail_action);
        delete hwFailSaveTimers[timerKey];
    }, 1500);
};

// Firestore에 hw_fail_action 저장 + hw_fail_tasks 컬렉션에도 동기화
async function saveHwFailAction(studentId, hwFailAction) {
    const docId = makeDailyRecordId(studentId, selectedDate);
    const student = allStudents.find(s => s.docId === studentId);
    try {
        await setDoc(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: selectedDate,
            branch: branchFromStudent(student || {}),
            hw_fail_action: hwFailAction,
            updated_by: currentUser.email,
            updated_at: serverTimestamp()
        }, { merge: true });
        if (!dailyRecords[studentId]) dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
        dailyRecords[studentId].hw_fail_action = hwFailAction;

        // hw_fail_tasks 컬렉션 동기화 (domain당 1개 doc: studentId_domain_sourceDate)
        for (const [domain, action] of Object.entries(hwFailAction)) {
            if (!action.type) continue;
            const taskDocId = `${studentId}_${domain}_${selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = hwFailTasks.find(t => t.docId === taskDocId);
            // 이미 완료/취소된 태스크는 덮어쓰지 않음
            if (existing && existing.status !== 'pending') continue;

            const taskData = {
                student_id: studentId,
                student_name: student?.name || '',
                domain,
                type: action.type,
                source_date: selectedDate,
                scheduled_date: action.scheduled_date || '',
                scheduled_time: action.scheduled_time || '',
                alt_hw: action.alt_hw || '',
                handler: (action.handler || currentUser?.email || '').split('@')[0],
                status: 'pending',
                created_by: (currentUser?.email || '').split('@')[0],
                created_at: existing?.created_at || new Date().toISOString(),
                branch: branchFromStudent(student || ''),
            };
            await setDoc(doc(db, 'hw_fail_tasks', taskDocId), taskData, { merge: true });
            // 로컬 캐시 갱신
            const idx = hwFailTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                hwFailTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                hwFailTasks.push({ docId: taskDocId, ...taskData });
            }
        }

        // 삭제된 domain의 pending tasks: 타입 제거 시 hw_fail_tasks에서도 상태 업데이트
        for (const t of hwFailTasks.filter(t => t.student_id === studentId && t.source_date === selectedDate && t.status === 'pending')) {
            const action = hwFailAction[t.domain];
            if (!action || !action.type) {
                await updateDoc(doc(db, 'hw_fail_tasks', t.docId), {
                    status: '취소',
                    cancelled_by: (currentUser?.email || '').split('@')[0],
                    cancelled_at: new Date().toISOString()
                });
                t.status = '취소';
            }
        }

        showSaveIndicator('saved');
    } catch (err) {
        console.error('hw_fail_action 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 밀린 Task 카드 렌더링 ───────────────────────────────────────────────────

function renderPendingTasksCard(studentId, tasks) {
    if (tasks.length === 0) return '';

    const taskRows = tasks.map(t => {
        const typeIcon = t.type === '등원'
            ? `<span class="material-symbols-outlined" style="font-size:14px;color:var(--danger);">directions_walk</span>`
            : `<span class="material-symbols-outlined" style="font-size:14px;color:var(--primary);">edit_note</span>`;

        const detail = t.type === '등원'
            ? `${esc(t.scheduled_date || '')}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`
            : `${esc(t.alt_hw || '내용 미입력')}${t.scheduled_date ? ' (기한: ' + esc(t.scheduled_date) + ')' : ''}`;

        return `
            <div class="pending-task-card">
                <div class="pending-task-header">
                    <span class="pending-task-domain">${esc(t.domain)}</span>
                    ${typeIcon}
                    <span class="pending-task-type">${esc(t.type)}</span>
                    <span class="pending-task-source">출처: ${esc(t.source_date || '')}</span>
                </div>
                <div class="pending-task-detail">${detail}</div>
                <div class="pending-task-meta">담당: ${esc(t.handler || '')} · 입력: ${esc(t.created_by || '')}</div>
                <div class="pending-task-actions">
                    <button class="hw-fail-type-btn active" style="background:var(--success);border-color:var(--success);font-size:11px;"
                        onclick="completeHwFailTask('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">check_circle</span>완료
                    </button>
                    <button class="hw-fail-type-btn hw-fail-clear-btn" style="font-size:11px;"
                        onclick="cancelHwFailTask('${escAttr(t.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">cancel</span>취소
                    </button>
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
            <div style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">완료 또는 취소 처리로 해결하세요.</div>
            ${taskRows}
        </div>
    `;
}

// 밀린 Task 완료 처리
window.completeHwFailTask = async function(taskDocId, studentId) {
    if (!confirm('완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'hw_fail_tasks', taskDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const t = hwFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '완료'; t.completed_by = completedBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
};

// 밀린 Task 취소 처리
window.cancelHwFailTask = async function(taskDocId, studentId) {
    if (!confirm('취소 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'hw_fail_tasks', taskDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const t = hwFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '취소'; t.cancelled_by = cancelledBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
};

// ─── Student Detail Panel ───────────────────────────────────────────────────

function renderStudentDetail(studentId) {
    if (!studentId) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
    }

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    // 프로필
    document.getElementById('profile-avatar').textContent = (student.name || '?')[0];
    document.getElementById('detail-name').textContent = student.name || '';

    const rec = dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const code = student.enrollments.map(e => enrollmentCode(e)).join(', ');
    const branch = branchFromStudent(student);

    const tagClass = attStatus === '출석' ? 'tag-present' :
                     attStatus === '결석' ? 'tag-absent' :
                     attStatus === '지각' ? 'tag-late' : 'tag-pending';

    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">${esc(student.level || '')} · ${esc(code)} · ${esc(branch)}</span>
        <span class="tag tag-status ${tagClass}">${esc(attStatus)}</span>
    `;

    // 카드들 렌더링
    const cardsContainer = document.getElementById('detail-cards');
    const homework = rec.homework || [];
    const tests = rec.tests || [];
    const studentRetakes = retakeSchedules.filter(r => r.student_id === studentId && r.status === '예정');
    const studentHwTasks = hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');

    const incompleteHomework = homework.filter(h => h.status !== '확인완료');
    const incompleteTests = tests.filter(t => t.result === '재시필요');

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
    const detailDomains = getStudentDomains(studentId);
    const d1st = rec.hw_domains_1st || {};
    const d2nd = rec.hw_domains_2nd || {};
    const hasAnyDomain = Object.values(d1st).some(v => v) || Object.values(d2nd).some(v => v);
    const domainHwHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">domain_verification</span>
                영역별 숙제
            </div>
            ${!hasAnyDomain ? '<div class="detail-card-empty">영역 숙제 미입력</div>' : `
                <div style="margin-bottom:8px;">
                    <div style="font-size:12px;font-weight:500;color:var(--text-sec);margin-bottom:4px;">1차</div>
                    <div class="hw-domain-group">
                        ${detailDomains.map(d => {
                            const val = d1st[d] || '';
                            return `<div class="hw-domain-item">
                                <span class="hw-domain-label">${esc(d)}</span>
                                <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
                <div>
                    <div style="font-size:12px;font-weight:500;color:var(--text-sec);margin-bottom:4px;">2차</div>
                    <div class="hw-domain-group">
                        ${detailDomains.map(d => {
                            const val = d2nd[d] || '';
                            return `<div class="hw-domain-item">
                                <span class="hw-domain-label">${esc(d)}</span>
                                <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            `}
        </div>
    `;

    // 테스트 OX 현황 카드
    const { sections: detailTestSections } = getStudentTestItems(studentId);
    const t1st = rec.test_domains_1st || {};
    const t2nd = rec.test_domains_2nd || {};
    const hasAnyTest = Object.values(t1st).some(v => v) || Object.values(t2nd).some(v => v);
    const domainTestHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">quiz</span>
                테스트 현황
            </div>
            ${!hasAnyTest ? '<div class="detail-card-empty">테스트 미입력</div>' : `
                ${['1차', '2차'].map((round, ri) => {
                    const data = ri === 0 ? t1st : t2nd;
                    if (!Object.values(data).some(v => v)) return '';
                    return `<div style="margin-bottom:8px;">
                        <div style="font-size:12px;font-weight:500;color:var(--text-sec);margin-bottom:4px;">${round}</div>
                        ${Object.entries(detailTestSections).map(([secName, items]) => {
                            const hasAny = items.some(t => data[t]);
                            if (!hasAny) return '';
                            return `<span style="font-size:10px;color:var(--text-sec);">${esc(secName)}</span>
                                <div class="hw-domain-group" style="margin-bottom:4px;">
                                    ${items.map(t => {
                                        const val = data[t] || '';
                                        return `<div class="hw-domain-item">
                                            <span class="hw-domain-label">${esc(t)}</span>
                                            <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
                                        </div>`;
                                    }).join('')}
                                </div>`;
                        }).join('')}
                    </div>`;
                }).join('')}
            `}
        </div>
    `;

    cardsContainer.innerHTML = `
        ${reasonHtml}

        <!-- 영역별 숙제 카드 -->
        ${domainHwHtml}

        <!-- 테스트 현황 카드 -->
        ${domainTestHtml}

        <!-- 미완료 숙제 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--warning);font-size:18px;">assignment_late</span>
                미완료 숙제 (${incompleteHomework.length})
            </div>
            ${incompleteHomework.length === 0
                ? '<div class="detail-card-empty">모든 숙제 완료!</div>'
                : incompleteHomework.map((h, i) => {
                    const origIdx = homework.indexOf(h);
                    return `<div class="detail-item">
                        <span>${esc(h.title || '숙제')} · ${esc(h.subject || '')}</span>
                        <select class="field-input" style="width:auto;padding:2px 8px;font-size:12px;"
                            onchange="handleHomeworkStatusChange('${studentId}', ${origIdx}, this.value); renderStudentDetail('${studentId}');">
                            <option value="미제출" ${h.status === '미제출' ? 'selected' : ''}>미제출</option>
                            <option value="제출" ${h.status === '제출' ? 'selected' : ''}>제출</option>
                            <option value="확인완료" ${h.status === '확인완료' ? 'selected' : ''}>확인완료</option>
                        </select>
                    </div>`;
                }).join('')
            }
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openHomeworkModal('${studentId}')">
                <span class="material-symbols-outlined" style="font-size:16px;">add</span> 숙제 추가
            </button>
        </div>

        <!-- 미완료 테스트 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--danger);font-size:18px;">quiz</span>
                재시 필요 테스트 (${incompleteTests.length})
            </div>
            ${incompleteTests.length === 0
                ? '<div class="detail-card-empty">재시 필요 테스트 없음</div>'
                : incompleteTests.map(t => `<div class="detail-item">
                    <div>
                        <div>${esc(t.title || '테스트')}</div>
                        <div style="font-size:11px;color:var(--text-sec);">${t.score != null ? t.score + '점' : '-'} / ${t.pass_score || '-'}점</div>
                    </div>
                    <span class="tag tag-absent">재시필요</span>
                </div>`).join('')
            }
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openTestModal('${studentId}')">
                <span class="material-symbols-outlined" style="font-size:16px;">add</span> 테스트 기록
            </button>
        </div>

        <!-- 연기/재시 일정 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">event_repeat</span>
                예정 일정 (${studentRetakes.length})
            </div>
            ${studentRetakes.length === 0
                ? '<div class="detail-card-empty">예정된 일정 없음</div>'
                : studentRetakes.map(r => `<div class="detail-item">
                    <div>
                        <div>${esc(r.title || '')}</div>
                        <div style="font-size:11px;color:var(--text-sec);">${esc(r.scheduled_date || '')} · ${esc(r.subject || '')}</div>
                    </div>
                    <div style="display:flex;gap:4px;">
                        <button class="btn btn-primary btn-sm" onclick="completeRetake('${r.docId}')">완료</button>
                        <button class="btn btn-secondary btn-sm" onclick="cancelRetake('${r.docId}')">취소</button>
                    </div>
                </div>`).join('')
            }
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openScheduleModal(['${studentId}'])">
                <span class="material-symbols-outlined" style="font-size:16px;">add</span> 일정 추가
            </button>
        </div>

        <!-- 숙제 2차 미통과 처리 카드 -->
        ${renderHwFailActionCard(studentId, detailDomains, d2nd, rec.hw_fail_action || {})}

        <!-- 밀린 Task 카드 -->
        ${renderPendingTasksCard(studentId, studentHwTasks)}

        <!-- 롤 메모 카드 -->
        ${renderStudentRoleMemoCard(studentId)}

        <!-- 메모 카드 -->
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--text-sec);font-size:18px;">sticky_note_2</span>
                메모
            </div>
            <textarea class="field-input" style="width:100%;min-height:60px;resize:vertical;"
                placeholder="메모 입력..."
                onchange="saveDailyRecord('${studentId}', { note: this.value })">${esc(rec.note || '')}</textarea>
        </div>
    `;

    // 모바일에서 패널 보이기
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

// ─── Toggle handlers (immediate save) ──────────────────────────────────────

function toggleAttendance(studentId, displayStatus) {
    // 2명 이상 체크된 경우 일괄입력 모달 표시
    if (checkedItems.size >= 2 && checkedItems.has(studentId)) {
        showAttendanceBatchModal(displayStatus);
        return;
    }
    applyAttendance(studentId, displayStatus);
}

function applyAttendance(studentId, displayStatus, force = false, silent = false) {
    // 등원전 → 미확인으로 매핑
    const firestoreStatus = displayStatus === '등원전' ? '미확인' : displayStatus;

    const rec = dailyRecords[studentId] || {};
    const currentStatus = rec?.attendance?.status || '미확인';

    // force=true 시 강제 설정, 아니면 같은 상태 클릭 → 미확인으로 토글
    const newStatus = force ? firestoreStatus : (currentStatus === firestoreStatus ? '미확인' : firestoreStatus);

    const attendance = { ...(rec.attendance || {}), status: newStatus };

    const updates = { attendance };
    if (newStatus === '출석' || newStatus === '지각') {
        if (!rec?.arrival_time) {
            updates.arrival_time = nowTimeStr();
        }
    } else if (newStatus === '미확인') {
        updates.arrival_time = '';
    }

    saveImmediately(studentId, updates);

    if (!dailyRecords[studentId]) {
        dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
    }
    dailyRecords[studentId].attendance = attendance;

    if (silent) return;

    const row = document.querySelector(`.list-item[data-id="${studentId}"]`);
    if (row) {
        const newDisplay = newStatus === '미확인' ? '등원전' : newStatus;
        row.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.remove('active-present', 'active-late', 'active-absent', 'active-other');
            if (btn.textContent.trim() === newDisplay) {
                if (newDisplay === '출석') btn.classList.add('active-present');
                else if (newDisplay === '지각') btn.classList.add('active-late');
                else if (newDisplay === '결석') btn.classList.add('active-absent');
                else btn.classList.add('active-other');
            }
        });
    }

    renderSubFilters();

    if (currentCategory === 'attendance' && currentSubFilter.size > 0 && row) {
        const matchesFilter = doesStatusMatchFilter(newStatus, currentSubFilter);
        if (!matchesFilter) {
            row.classList.add('fade-out');
            row.addEventListener('transitionend', () => {
                renderListPanel();
            }, { once: true });
            setTimeout(() => {
                if (row.classList.contains('fade-out')) renderListPanel();
            }, 500);
        } else {
            renderListPanel();
        }
    } else {
        renderListPanel();
    }

    if (selectedStudentId === studentId) renderStudentDetail(studentId);
}

function showAttendanceBatchModal(displayStatus) {
    const statuses = ['출석', '지각', '결석', '조퇴'];
    document.getElementById('batch-confirm-title').textContent = '출결 일괄입력';
    document.getElementById('batch-confirm-message').innerHTML =
        `<div style="text-align:center;color:var(--text-sec);font-size:13px;margin-bottom:12px;">${checkedItems.size}명 일괄입력 — 값을 선택하세요</div>` +
        `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">` +
        statuses.map(st => {
            const cls = st === '출석' ? 'active-present' : st === '지각' ? 'active-late' : st === '결석' ? 'active-absent' : 'active-other';
            return `<button class="toggle-btn ${cls}" style="font-size:14px;padding:8px 16px;" onclick="confirmBatchAttendance('${st}')">${st}</button>`;
        }).join('') +
        `</div>`;
    document.getElementById('batch-confirm-ok').style.display = 'none';
    document.getElementById('batch-confirm-modal').style.display = 'flex';
}

function confirmBatchAttendance(status) {
    document.getElementById('batch-confirm-title').textContent = '출결 일괄입력 확인';
    document.getElementById('batch-confirm-message').innerHTML =
        `<p>${checkedItems.size}명을 <b style="font-size:16px;">${esc(status)}</b>(으)로 처리하시겠습니까?</p>`;
    const okBtn = document.getElementById('batch-confirm-ok');
    okBtn.style.display = '';
    okBtn.textContent = '일괄입력';
    okBtn.onclick = () => executeBatchAttendance(status);
}

function executeBatchAttendance(status) {
    document.getElementById('batch-confirm-modal').style.display = 'none';
    const okBtn = document.getElementById('batch-confirm-ok');
    okBtn.textContent = '확인';
    okBtn.onclick = executeBatchAction;

    for (const sid of checkedItems) {
        applyAttendance(sid, status, true, true); // force + silent
    }
    renderSubFilters();
    renderListPanel();
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
}

// 학생의 출결 상태가 현재 L2 필터에 매칭되는지 판별
function doesStatusMatchFilter(firestoreStatus, filterSet) {
    for (const f of filterSet) {
        if (f === 'pre_arrival' && (!firestoreStatus || firestoreStatus === '미확인')) return true;
        if (f === 'present' && firestoreStatus === '출석') return true;
        if (f === 'late' && firestoreStatus === '지각') return true;
        if (f === 'absent' && firestoreStatus === '결석') return true;
        if (f === 'other' && firestoreStatus && !['미확인', '출석', '지각', '결석'].includes(firestoreStatus)) return true;
    }
    return false;
}

function checkCanEditGrading(studentId) {
    const rec = dailyRecords[studentId] || {};
    const st = rec?.attendance?.status;
    if (st === '출석' || st === '지각' || st === '조퇴') return true;
    alert('등원(출석, 지각, 조퇴) 상태인 학생만 입력할 수 있습니다.');
    return false;
}

function toggleHomework(studentId, hwIndex, status) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    const homework = [...(rec.homework || [])];
    if (homework[hwIndex]) {
        homework[hwIndex] = { ...homework[hwIndex], status };
        saveImmediately(studentId, { homework });

        if (!dailyRecords[studentId]) {
            dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
        }
        dailyRecords[studentId].homework = homework;

        renderSubFilters();
        renderListPanel();
        if (selectedStudentId === studentId) renderStudentDetail(studentId);
    }
}

function oxFieldLabel(field) {
    const labels = { hw_domains_1st: '숙제1차', hw_domains_2nd: '숙제2차', test_domains_1st: '테스트1차', test_domains_2nd: '테스트2차' };
    return labels[field] || field;
}

function toggleHwDomainOX(studentId, field, domain) {
    // 체크된 학생이 2명 이상이면 값 선택 모달
    if (checkedItems.size >= 2 && checkedItems.has(studentId)) {
        const invalidStudents = Array.from(checkedItems).filter(id => {
            const st = dailyRecords[id]?.attendance?.status;
            return !(st === '출석' || st === '지각' || st === '조퇴');
        });
        if (invalidStudents.length > 0) {
            alert('선택된 학생 중 등원(출석, 지각, 조퇴) 상태가 아닌 학생이 포함되어 있습니다.\\n선택 해제 후 다시 시도해주세요.');
            return;
        }
        showHwDomainBatchModal(field, domain, oxFieldLabel(field));
        return;
    }

    if (!checkCanEditGrading(studentId)) return;
    applyHwDomainOX(studentId, field, domain);
    renderSubFilters();
    if (selectedStudentId === studentId) renderStudentDetail(studentId);
}

function showHwDomainBatchModal(field, domain, label) {
    // 1단계: 값 선택
    document.getElementById('batch-confirm-title').textContent = `${label} · ${domain}`;
    document.getElementById('batch-confirm-message').innerHTML =
        `<div style="text-align:center;color:var(--text-sec);font-size:13px;margin-bottom:12px;">${checkedItems.size}명 일괄입력 — 값을 선택하세요</div>` +
        `<div style="display:flex;gap:10px;justify-content:center;">` +
            `<button class="hw-domain-ox ox-green" style="width:52px;height:44px;font-size:18px;" onclick="confirmBatchHwDomainOX('${field}','${escAttr(domain)}','O')">O</button>` +
            `<button class="hw-domain-ox ox-yellow" style="width:52px;height:44px;font-size:18px;" onclick="confirmBatchHwDomainOX('${field}','${escAttr(domain)}','△')">△</button>` +
            `<button class="hw-domain-ox ox-red" style="width:52px;height:44px;font-size:18px;" onclick="confirmBatchHwDomainOX('${field}','${escAttr(domain)}','X')">X</button>` +
            `<button class="hw-domain-ox ox-empty" style="width:52px;height:44px;font-size:18px;" onclick="confirmBatchHwDomainOX('${field}','${escAttr(domain)}','')">—</button>` +
        `</div>`;
    document.getElementById('batch-confirm-ok').style.display = 'none';
    document.getElementById('batch-confirm-modal').style.display = 'flex';
}

function confirmBatchHwDomainOX(field, domain, value) {
    // 2단계: 확인
    const label = oxFieldLabel(field);
    const displayVal = value || '취소(빈값)';
    document.getElementById('batch-confirm-title').textContent = '일괄입력 확인';
    document.getElementById('batch-confirm-message').innerHTML =
        `<p>${checkedItems.size}명의 <b>${esc(label)} · ${esc(domain)}</b> 영역을 <b style="font-size:16px;">${esc(displayVal)}</b>(으)로 저장하시겠습니까?</p>`;
    const okBtn = document.getElementById('batch-confirm-ok');
    okBtn.style.display = '';
    okBtn.textContent = '일괄입력';
    okBtn.onclick = () => executeBatchHwDomainOX(field, domain, value);
}

function executeBatchHwDomainOX(field, domain, value) {
    document.getElementById('batch-confirm-modal').style.display = 'none';
    // 확인 버튼 원복
    const okBtn = document.getElementById('batch-confirm-ok');
    okBtn.textContent = '확인';
    okBtn.onclick = executeBatchAction;

    for (const sid of checkedItems) {
        applyHwDomainOX(sid, field, domain, value);
    }
    renderSubFilters();
    renderListPanel();
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
}

function applyHwDomainOX(studentId, field, domain, forceValue) {
    const rec = dailyRecords[studentId] || {};
    const domainData = { ...(rec[field] || {}) };
    const currentVal = domainData[domain] || '';
    const newVal = forceValue !== undefined ? forceValue : nextOXValue(currentVal);
    domainData[domain] = newVal;

    // 즉시 저장
    saveImmediately(studentId, { [field]: domainData });

    // 로컬 캐시 업데이트
    if (!dailyRecords[studentId]) {
        dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
    }
    dailyRecords[studentId][field] = domainData;

    // DOM 직접 업데이트 (버튼만 갱신)
    const btn = document.querySelector(`.hw-domain-ox[data-student="${studentId}"][data-field="${field}"][data-domain="${CSS.escape(domain)}"]`);
    if (btn) {
        btn.classList.remove('ox-green', 'ox-red', 'ox-yellow', 'ox-empty');
        btn.classList.add(oxDisplayClass(newVal));
        btn.textContent = newVal || '—';
    }
}

// ─── Field change handlers ──────────────────────────────────────────────────

function handleAttendanceChange(studentId, field, value) {
    const rec = dailyRecords[studentId] || {};
    const attendance = { ...(rec.attendance || {}), [field]: value };
    saveDailyRecord(studentId, { attendance });

    // 로컬 캐시 즉시 업데이트 (UI 반영)
    if (!dailyRecords[studentId]) {
        dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
    }
    dailyRecords[studentId].attendance = attendance;

    // 목록 태그 즉시 업데이트
    if (field === 'status') {
        renderListPanel();
    }
}

function handleHomeworkStatusChange(studentId, hwIndex, value) {
    const rec = dailyRecords[studentId] || {};
    const homework = [...(rec.homework || [])];
    if (homework[hwIndex]) {
        homework[hwIndex] = { ...homework[hwIndex], status: value };
        saveDailyRecord(studentId, { homework });

        if (!dailyRecords[studentId]) {
            dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
        }
        dailyRecords[studentId].homework = homework;
    }
}

// ─── Checkbox & Batch ───────────────────────────────────────────────────────

function toggleCheck(studentId, checked) {
    if (checked) checkedItems.add(studentId);
    else checkedItems.delete(studentId);
    updateBatchBar();
}

function updateBatchBar() {
    const bar = document.getElementById('batch-bar');
    const countEl = document.getElementById('batch-count');
    const actionsEl = document.getElementById('batch-actions');

    if (checkedItems.size === 0) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    countEl.textContent = `${checkedItems.size}명 선택`;

    let buttons = '';
    if (currentCategory === 'attendance') {
        buttons = ''; // 출결 일괄입력은 토글버튼 직접 클릭 방식 사용
    } else if (currentCategory === 'homework') {
        const isHwDomain = currentSubFilter.has('hw_1st') || currentSubFilter.has('hw_2nd');
        if (isHwDomain) {
            // 1차/2차: OX 버튼 직접 클릭으로 일괄 입력 — 배치 바는 선택 인원만 표시
            buttons = '';
        } else {
            buttons = `
                <button class="batch-btn" onclick="confirmBatchAction('homework_status', '제출')">제출 확인</button>
                <button class="batch-btn" onclick="confirmBatchAction('homework_status', '확인완료')">확인완료</button>
                <button class="batch-btn" onclick="confirmBatchAction('homework_notify', '미제출 통보')">미제출 통보</button>`;
        }
    } else if (currentCategory === 'test') {
        const isTestDomain = currentSubFilter.has('test_1st') || currentSubFilter.has('test_2nd');
        if (isTestDomain) {
            buttons = '';
        } else {
            buttons = `
                <button class="batch-btn" onclick="confirmBatchAction('test_result', '통과')">통과 처리</button>
                <button class="batch-btn" onclick="confirmBatchAction('test_result', '재시필요')">재시 지정</button>`;
        }
    } else if (currentCategory === 'automation') {
        buttons = `
            <button class="batch-btn" onclick="confirmBatchAction('attendance', '출석')">출석 처리</button>
            <button class="batch-btn" onclick="confirmBatchAction('homework_notify', '미제출 통보')">미제출 통보</button>`;
    }

    actionsEl.innerHTML = buttons;
}

let _pendingBatchAction = null;

function confirmBatchAction(action, value) {
    _pendingBatchAction = { action, value };
    document.getElementById('batch-confirm-title').textContent = '일괄 처리 확인';
    document.getElementById('batch-confirm-message').textContent =
        `${checkedItems.size}명에게 "${value}" 처리를 적용하시겠습니까?`;
    document.getElementById('batch-confirm-modal').style.display = 'flex';
}

async function executeBatchAction() {
    document.getElementById('batch-confirm-modal').style.display = 'none';
    if (!_pendingBatchAction) return;

    const { action, value } = _pendingBatchAction;
    _pendingBatchAction = null;

    await handleBatchAction(action, value);
}

async function handleBatchAction(action, value) {
    if (checkedItems.size === 0) return;
    const ids = Array.from(checkedItems);

    showSaveIndicator('saving');

    try {
        const batch = writeBatch(db);

        for (const studentId of ids) {
            const docId = makeDailyRecordId(studentId, selectedDate);
            const ref = doc(db, 'daily_records', docId);
            const student = allStudents.find(s => s.docId === studentId);

            const baseData = {
                student_id: studentId,
                date: selectedDate,
                branch: branchFromStudent(student || {}),
                updated_by: currentUser.email,
                updated_at: serverTimestamp()
            };

            if (action === 'attendance') {
                batch.set(ref, { ...baseData, attendance: { status: value } }, { merge: true });
                if (!dailyRecords[studentId]) {
                    dailyRecords[studentId] = { docId, student_id: studentId, date: selectedDate };
                }
                dailyRecords[studentId].attendance = { ...(dailyRecords[studentId].attendance || {}), status: value };
            } else if (action === 'homework_status') {
                const rec = dailyRecords[studentId] || {};
                const homework = (rec.homework || []).map(h => ({ ...h, status: value }));
                batch.set(ref, { ...baseData, homework }, { merge: true });
                if (dailyRecords[studentId]) dailyRecords[studentId].homework = homework;
            } else if (action === 'homework_notify') {
                // TODO: 실제 알림 발송 로직 연동 (현재는 로그만 남김)
                console.log(`[NOTIFY] ${studentId} 학생에게 숙제 미제출 통보`);
            } else if (action === 'test_result') {
                const rec = dailyRecords[studentId] || {};
                const tests = (rec.tests || []).map(t => ({ ...t, result: value }));
                batch.set(ref, { ...baseData, tests }, { merge: true });
                if (dailyRecords[studentId]) dailyRecords[studentId].tests = tests;
            } else if (action === 'retake_status') {
                const retakes = retakeSchedules.filter(r => r.student_id === studentId && r.status === '예정');
                for (const r of retakes) {
                    batch.update(doc(db, 'retake_schedule', r.docId), { status: value, updated_at: serverTimestamp() });
                    r.status = value;
                }
            }
        }

        await batch.commit();

        checkedItems.clear();
        updateBatchBar();
        renderSubFilters();
        renderListPanel();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('일괄 처리 실패:', err);
        showSaveIndicator('error');
    }
}

function toggleSelectAll(checked) {
    const students = getFilteredStudents();
    checkedItems.clear();
    if (checked) {
        students.forEach(s => checkedItems.add(s.docId));
    }
    updateBatchBar();
    renderListPanel();
}

function clearSelection() {
    checkedItems.clear();
    updateBatchBar();
    renderListPanel();
}

// ─── Date navigation ────────────────────────────────────────────────────────

function updateDateDisplay() {
    const dayName = getDayName(selectedDate);
    document.getElementById('date-text').textContent = `${selectedDate} (${dayName})`;
    const picker = document.getElementById('date-picker');
    if (picker) picker.value = selectedDate;
}

async function reloadForDate() {
    await Promise.all([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadRoleMemos()]);
    updateDateDisplay();
    renderSubFilters();
    renderListPanel();
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
}

function changeDate(delta) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);
    selectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    reloadForDate();
}

function openDatePicker() {
    const picker = document.getElementById('date-picker');
    picker.showPicker?.() || picker.click();
}

function goToday() {
    selectedDate = todayStr();
    reloadForDate();
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        if (e.target.value) {
            selectedDate = e.target.value;
            reloadForDate();
        }
    });
});

// ─── Retake actions ─────────────────────────────────────────────────────────

async function completeRetake(retakeDocId) {
    if (!confirm('이 일정을 완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'retake_schedule', retakeDocId), {
            status: '완료',
            updated_at: serverTimestamp()
        });
        const r = retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) r.status = '완료';
        renderSubFilters();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

async function cancelRetake(retakeDocId) {
    if (!confirm('이 일정을 취소하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'retake_schedule', retakeDocId), {
            status: '취소',
            updated_at: serverTimestamp()
        });
        const r = retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) r.status = '취소';
        renderSubFilters();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Modal helpers ──────────────────────────────────────────────────────────

function closeModal(id, event) {
    if (event.target === event.currentTarget) {
        document.getElementById(id).style.display = 'none';
    }
}

let _scheduleTargetIds = [];

function openScheduleModal(studentIds) {
    _scheduleTargetIds = studentIds;
    // 기본값 설정
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 1);
    const nextDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    document.getElementById('schedule-type').value = '재시';
    document.getElementById('schedule-subject').value = '';
    document.getElementById('schedule-title').value = '';
    document.getElementById('schedule-date').value = nextDay;
    document.getElementById('schedule-modal').style.display = 'flex';
}

function openHomeworkModal(studentId) {
    if (!checkCanEditGrading(studentId)) return;
    selectedStudentId = studentId;
    const domains = getStudentDomains(studentId);
    const select = document.getElementById('hw-subject');
    select.innerHTML = domains.map(d =>
        `<option value="${esc(d)}">${esc(d)}</option>`
    ).join('') + '<option value="기타">기타</option>';
    document.getElementById('hw-title').value = '';
    document.getElementById('hw-status').value = '미제출';
    document.getElementById('homework-modal').style.display = 'flex';
}

function openTestModal(studentId) {
    if (!checkCanEditGrading(studentId)) return;
    selectedStudentId = studentId;
    const domains = getStudentDomains(studentId);
    const select = document.getElementById('test-subject');
    select.innerHTML = domains.map(d =>
        `<option value="${esc(d)}">${esc(d)}</option>`
    ).join('') + '<option value="기타">기타</option>';
    document.getElementById('test-title').value = '';
    document.getElementById('test-type').value = '정기';
    document.getElementById('test-score').value = '';
    document.getElementById('test-pass-score').value = '80';
    document.getElementById('test-modal').style.display = 'flex';
}

// ─── Modal save functions ───────────────────────────────────────────────────

async function saveScheduleFromModal() {
    const type = document.getElementById('schedule-type').value;
    const subject = document.getElementById('schedule-subject').value.trim();
    const title = document.getElementById('schedule-title').value.trim();
    const scheduledDate = document.getElementById('schedule-date').value;

    if (!title) { alert('제목을 입력하세요.'); return; }
    if (!scheduledDate) { alert('날짜를 선택하세요.'); return; }

    showSaveIndicator('saving');
    try {
        for (const studentId of _scheduleTargetIds) {
            await saveRetakeSchedule({
                student_id: studentId,
                type,
                subject,
                title,
                original_date: selectedDate,
                scheduled_date: scheduledDate,
                status: '예정',
                result_score: null
            });
        }
        document.getElementById('schedule-modal').style.display = 'none';
        _scheduleTargetIds = [];
        renderSubFilters();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('일정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

async function saveHomeworkFromModal() {
    const title = document.getElementById('hw-title').value.trim();
    const subject = document.getElementById('hw-subject').value;
    const status = document.getElementById('hw-status').value;

    if (!title) { alert('숙제 제목을 입력하세요.'); return; }
    if (!selectedStudentId) return;

    const rec = dailyRecords[selectedStudentId] || {};
    const homework = [...(rec.homework || []), { title, subject, status, note: '' }];

    saveDailyRecord(selectedStudentId, { homework });

    if (!dailyRecords[selectedStudentId]) {
        dailyRecords[selectedStudentId] = { student_id: selectedStudentId, date: selectedDate };
    }
    dailyRecords[selectedStudentId].homework = homework;

    document.getElementById('homework-modal').style.display = 'none';
    renderStudentDetail(selectedStudentId);
}

async function saveTestFromModal() {
    const title = document.getElementById('test-title').value.trim();
    const subject = document.getElementById('test-subject').value;
    const type = document.getElementById('test-type').value;
    const score = document.getElementById('test-score').value ? Number(document.getElementById('test-score').value) : null;
    const passScore = document.getElementById('test-pass-score').value ? Number(document.getElementById('test-pass-score').value) : null;

    if (!title) { alert('테스트명을 입력하세요.'); return; }
    if (!selectedStudentId) return;

    let result = '미완료';
    if (score != null && passScore != null) {
        result = score >= passScore ? '통과' : '재시필요';
    }

    const rec = dailyRecords[selectedStudentId] || {};
    const tests = [...(rec.tests || []), { title, subject, type, score, pass_score: passScore, result, note: '' }];

    saveDailyRecord(selectedStudentId, { tests });

    if (!dailyRecords[selectedStudentId]) {
        dailyRecords[selectedStudentId] = { student_id: selectedStudentId, date: selectedDate };
    }
    dailyRecords[selectedStudentId].tests = tests;

    document.getElementById('test-modal').style.display = 'none';
    renderStudentDetail(selectedStudentId);
}

// ─── 등원예정시간 (반 상세 패널에서 사용, students 컬렉션에 영구 저장) ──────

async function saveStudentScheduledTime(studentId, classCode, time) {
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const dayName = getDayName(selectedDate);
    const enrollments = [...student.enrollments];
    const idx = enrollments.findIndex(e => enrollmentCode(e) === classCode && e.day.includes(dayName));
    if (idx === -1) return;

    enrollments[idx] = { ...enrollments[idx], start_time: time };

    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        showSaveIndicator('saved');
    } catch (err) {
        console.error('등원예정시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 롤(역할) 관리 ──────────────────────────────────────────────────────────

async function loadUserRole() {
    if (!currentUser) return;
    try {
        const docRef = doc(db, 'user_settings', currentUser.email);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            currentRole = snap.data().role || '행정';
        } else {
            currentRole = '행정';
            await setDoc(docRef, { role: '행정', updated_at: serverTimestamp() });
        }
        renderRoleSelector();
        updateMemoUI();
    } catch (err) {
        console.error('롤 로드 실패:', err);
        currentRole = '행정';
        renderRoleSelector();
        updateMemoUI();
    }
}

async function selectRole(role) {
    if (!currentUser) return;
    currentRole = role;
    renderRoleSelector();
    updateMemoUI();

    try {
        await setDoc(doc(db, 'user_settings', currentUser.email), {
            role,
            updated_at: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.error('롤 저장 실패:', err);
    }

    await loadRoleMemos();
}

function renderRoleSelector() {
    const container = document.getElementById('role-chips');
    if (!container) return;
    container.querySelectorAll('.role-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.role === currentRole);
    });
}

function updateMemoUI() {
    const bell = document.getElementById('memo-bell');
    const memoSection = document.getElementById('sidebar-memo-section');
    const roleSelector = document.getElementById('role-selector');

    if (currentUser) {
        roleSelector.style.display = '';
    }

    if (currentRole) {
        bell.style.display = '';
        memoSection.style.display = '';
    }
}

// ─── 롤 메모 CRUD ───────────────────────────────────────────────────────────

async function loadRoleMemos() {
    if (!currentUser || !currentRole) return;
    roleMemos = [];

    try {
        const q = query(
            collection(db, 'role_memos'),
            where('date', '==', selectedDate)
        );
        const snap = await getDocs(q);
        snap.forEach(d => {
            const data = d.data();
            // 내가 보낸 것 OR 나에게 온 것
            const isSent = data.sender_email === currentUser.email;
            const isReceived = data.target_roles?.includes(currentRole);
            if (isSent || isReceived) {
                roleMemos.push({ docId: d.id, ...data, _isSent: isSent, _isReceived: isReceived });
            }
        });
        roleMemos.sort((a, b) => {
            const ta = a.created_at?.toMillis?.() || 0;
            const tb = b.created_at?.toMillis?.() || 0;
            return tb - ta;
        });
    } catch (err) {
        console.error('메모 로드 실패:', err);
    }

    updateMemoBadge();
    renderMemoPanel();
}

function updateMemoBadge() {
    const badge = document.getElementById('memo-badge');
    const sidebarBadge = document.getElementById('memo-unread-sidebar');
    if (!badge || !sidebarBadge) return;

    // 수신 메모 중 미읽음 (자기가 보낸 건 제외)
    const unreadCount = roleMemos.filter(m =>
        m._isReceived && m.sender_email !== currentUser?.email && !m.read_by?.includes(currentUser?.email)
    ).length;

    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = '';
        sidebarBadge.textContent = unreadCount;
        sidebarBadge.style.display = '';
    } else {
        badge.style.display = 'none';
        sidebarBadge.style.display = 'none';
    }
}

function toggleMemoSection() {
    const panel = document.getElementById('memo-panel');
    const icon = document.getElementById('memo-expand-icon');
    if (panel.style.display === 'none') {
        panel.style.display = '';
        icon.textContent = 'expand_less';
        renderMemoPanel();
    } else {
        panel.style.display = 'none';
        icon.textContent = 'expand_more';
    }
}

function toggleMemoPanel() {
    const panel = document.getElementById('memo-panel');
    const section = document.getElementById('sidebar-memo-section');
    const icon = document.getElementById('memo-expand-icon');

    // 사이드바가 모바일에서 닫혀있으면 열기
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.add('mobile-open');
        overlay.classList.add('visible');
    }

    // 패널 열기
    if (panel.style.display === 'none') {
        panel.style.display = '';
        icon.textContent = 'expand_less';
        renderMemoPanel();
    }
}

function setMemoTab(tab) {
    memoTab = tab;
    renderMemoPanel();
}

function renderMemoPanel() {
    const tabsContainer = document.getElementById('memo-tabs');
    const contentContainer = document.getElementById('memo-content');
    if (!tabsContainer || !contentContainer) return;

    tabsContainer.innerHTML = `
        <button class="memo-tab ${memoTab === 'inbox' ? 'active' : ''}" onclick="setMemoTab('inbox')">수신함</button>
        <button class="memo-tab ${memoTab === 'outbox' ? 'active' : ''}" onclick="setMemoTab('outbox')">발신함</button>
    `;

    renderMemoList(contentContainer);
}

function renderMemoList(container) {
    if (!container) container = document.getElementById('memo-content');
    if (!container) return;

    // 탭에 따라 발신/수신 필터
    let memos;
    if (memoTab === 'outbox') {
        memos = roleMemos.filter(m => m.sender_email === currentUser?.email);
    } else {
        memos = roleMemos.filter(m => m._isReceived && m.sender_email !== currentUser?.email);
    }

    let html = '';

    if (memos.length === 0) {
        html = `<div style="padding:12px;color:var(--text-sec);font-size:13px;text-align:center;">${memoTab === 'outbox' ? '보낸 메모가 없습니다' : '받은 메모가 없습니다'}</div>`;
    } else {
        html = memos.map(m => {
            const isUnread = m._isReceived && m.sender_email !== currentUser?.email && !m.read_by?.includes(currentUser?.email);
            const studentLabel = m.type === 'student' && m.student_name ? `<div class="memo-item-student">${esc(m.student_name)}</div>` : '';
            const targets = m.target_roles?.join(', ') || '';
            const timeStr = m.created_at?.toDate?.()
                ? m.created_at.toDate().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                : '';

            const senderLabel = memoTab === 'outbox'
                ? '→ ' + esc(targets)
                : esc(m.sender_email?.split('@')[0] || '') + ' (' + esc(m.sender_role || '') + ')';

            return `<div class="memo-item ${isUnread ? 'unread' : ''}" onclick="expandMemo('${m.docId}', this)">
                <div class="memo-item-header">
                    <span class="memo-item-sender">${senderLabel}</span>
                    <span class="memo-item-date">${esc(timeStr)}</span>
                </div>
                ${studentLabel}
                <div class="memo-item-content">${esc(m.content || '')}</div>
            </div>`;
        }).join('');
    }

    // 모든 롤에서 메모 보내기 버튼
    html += `<button class="memo-send-btn" onclick="openMemoModal()">
        <span class="material-symbols-outlined" style="font-size:18px;">add</span>
        메모 보내기
    </button>`;

    container.innerHTML = html;
}

async function expandMemo(memoDocId, el) {
    const contentEl = el.querySelector('.memo-item-content');
    if (contentEl) {
        contentEl.classList.toggle('expanded');
    }

    // 수신 메모 읽음 처리 (자기가 보낸 건 제외)
    const memo = roleMemos.find(m => m.docId === memoDocId);
    if (memo && memo.sender_email !== currentUser?.email) {
        await markMemoRead(memoDocId);
    }
}

async function markMemoRead(memoDocId) {
    if (!currentUser) return;
    const memo = roleMemos.find(m => m.docId === memoDocId);
    if (!memo || memo.read_by?.includes(currentUser.email)) return;

    try {
        await updateDoc(doc(db, 'role_memos', memoDocId), {
            read_by: arrayUnion(currentUser.email),
            updated_at: serverTimestamp()
        });
        if (!memo.read_by) memo.read_by = [];
        memo.read_by.push(currentUser.email);
        updateMemoBadge();
    } catch (err) {
        console.error('메모 읽음 처리 실패:', err);
    }
}

function openMemoModal(studentId) {
    document.getElementById('memo-type').value = studentId ? 'student' : 'free';
    document.getElementById('memo-student-search').value = '';
    document.getElementById('memo-student-id').value = studentId || '';
    document.getElementById('memo-student-dropdown').style.display = 'none';
    document.getElementById('memo-content-input').value = '';

    // 학생 지정 시 자동 선택
    const selectedEl = document.getElementById('memo-student-selected');
    if (studentId) {
        const student = allStudents.find(s => s.docId === studentId);
        selectedEl.textContent = student ? student.name : '';
    } else {
        selectedEl.textContent = '';
    }

    toggleMemoStudentField();

    // 수신 대상: 자기 롤 제외한 나머지 롤을 체크박스로 동적 생성
    const allRoles = ['행정', '교수', '관리'];
    const otherRoles = allRoles.filter(r => r !== currentRole);
    const checksContainer = document.getElementById('memo-target-checks');
    checksContainer.innerHTML = otherRoles.map((r, i) =>
        `<label><input type="checkbox" value="${r}" ${i === 0 ? 'checked' : ''}> ${r}</label>`
    ).join('');

    document.getElementById('memo-modal').style.display = 'flex';
}

function toggleMemoStudentField() {
    const type = document.getElementById('memo-type').value;
    const field = document.getElementById('memo-student-field');
    field.style.display = type === 'student' ? '' : 'none';
}

function searchMemoStudent(query) {
    const dropdown = document.getElementById('memo-student-dropdown');
    if (!query || query.length < 1) {
        dropdown.style.display = 'none';
        return;
    }

    const q = query.toLowerCase();
    const matches = allStudents.filter(s => s.name?.toLowerCase().includes(q)).slice(0, 8);

    if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    dropdown.innerHTML = matches.map(s => {
        const code = (s.enrollments || []).map(e => enrollmentCode(e)).join(', ');
        return `<div class="memo-student-dropdown-item" onclick="selectMemoStudent('${escAttr(s.docId)}', '${escAttr(s.name)}')">${esc(s.name)} <span style="color:var(--text-sec);font-size:11px;">${esc(code)}</span></div>`;
    }).join('');
    dropdown.style.display = '';
}

function selectMemoStudent(studentId, studentName) {
    document.getElementById('memo-student-id').value = studentId;
    document.getElementById('memo-student-selected').textContent = studentName;
    document.getElementById('memo-student-search').value = '';
    document.getElementById('memo-student-dropdown').style.display = 'none';
}

async function sendMemo() {
    if (!currentUser || !currentRole) {
        alert('로그인 후 역할을 선택하세요.');
        return;
    }

    const type = document.getElementById('memo-type').value;
    const studentId = document.getElementById('memo-student-id').value || null;
    const studentName = type === 'student' ? document.getElementById('memo-student-selected').textContent : null;
    const content = document.getElementById('memo-content-input').value.trim();

    if (!content) {
        alert('내용을 입력하세요.');
        return;
    }

    // 수신 대상 수집
    const targetRoles = [];
    document.querySelectorAll('#memo-target-checks input:checked').forEach(cb => {
        targetRoles.push(cb.value);
    });
    if (targetRoles.length === 0) {
        alert('수신 대상을 선택하세요.');
        return;
    }

    if (type === 'student' && !studentId) {
        alert('학생을 선택하세요.');
        return;
    }

    showSaveIndicator('saving');
    try {
        await addDoc(collection(db, 'role_memos'), {
            type,
            student_id: studentId,
            student_name: studentName,
            content,
            sender_email: currentUser.email,
            sender_role: currentRole,
            target_roles: targetRoles,
            date: selectedDate,
            read_by: [],
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });

        document.getElementById('memo-modal').style.display = 'none';
        await loadRoleMemos();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('메모 전송 실패:', err);
        showSaveIndicator('error');
    }
}

function getStudentRoleMemos(studentId) {
    return roleMemos.filter(m => m.type === 'student' && m.student_id === studentId);
}

function renderStudentRoleMemoCard(studentId) {
    const memos = getStudentRoleMemos(studentId);
    const student = allStudents.find(s => s.docId === studentId);

    let memosHtml = '';
    if (memos.length === 0) {
        memosHtml = '<div class="detail-card-empty">이 학생에 대한 롤 메모 없음</div>';
    } else {
        memosHtml = memos.map(m => {
            const timeStr = m.created_at?.toDate?.()
                ? m.created_at.toDate().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                : '';
            return `<div class="detail-role-memo">
                <div class="detail-role-memo-header">
                    <span class="detail-role-memo-sender">${esc(m.sender_email?.split('@')[0] || '')} (${esc(m.sender_role || '')})</span>
                    <span class="detail-role-memo-date">${esc(timeStr)}</span>
                </div>
                <div class="detail-role-memo-content">${esc(m.content || '')}</div>
            </div>`;
        }).join('');
    }

    const sendBtn = `<button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openMemoModal('${studentId}')">
        <span class="material-symbols-outlined" style="font-size:16px;">add</span> 메모 보내기
    </button>`;

    return `<div class="detail-card">
        <div class="detail-card-title">
            <span class="material-symbols-outlined" style="color:#7b61ff;font-size:18px;">mail</span>
            롤 메모 (${memos.length})
        </div>
        ${memosHtml}
        ${sendBtn}
    </div>`;
}

// ─── Enrollment 편집 ─────────────────────────────────────────────────────────
let editingEnrollment = { studentId: null, enrollIdx: 0 };

function openEnrollmentModal(studentId, enrollIdx) {
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    editingEnrollment = { studentId, enrollIdx };
    const enroll = student.enrollments[enrollIdx] || {};

    document.getElementById('enroll-student-name').textContent = student.name || '';
    document.getElementById('enroll-level').value = enroll.level_symbol || '';
    document.getElementById('enroll-class-num').value = enroll.class_number || '';
    document.getElementById('enroll-time').value = enroll.start_time || '';

    // 요일 버튼 초기화
    const days = enroll.day || [];
    document.querySelectorAll('#enroll-days .day-btn').forEach(btn => {
        btn.classList.toggle('active', days.includes(btn.dataset.day));
    });

    document.getElementById('enrollment-modal').style.display = 'flex';
}

async function saveEnrollment() {
    const { studentId, enrollIdx } = editingEnrollment;
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const levelSymbol = document.getElementById('enroll-level').value.trim();
    const classNumber = document.getElementById('enroll-class-num').value.trim();
    const startTime = document.getElementById('enroll-time').value;

    // 선택된 요일 수집
    const selectedDays = [];
    document.querySelectorAll('#enroll-days .day-btn.active').forEach(btn => {
        selectedDays.push(btn.dataset.day);
    });

    // enrollments 배열 업데이트
    const enrollments = [...student.enrollments];
    enrollments[enrollIdx] = {
        ...enrollments[enrollIdx],
        level_symbol: levelSymbol,
        class_number: classNumber,
        day: selectedDays,
        start_time: startTime
    };

    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'students', studentId), { enrollments });

        // 로컬 캐시 업데이트
        student.enrollments = enrollments;

        document.getElementById('enrollment-modal').style.display = 'none';
        renderSubFilters();
        renderListPanel();
        if (selectedStudentId === studentId) renderStudentDetail(studentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('수강 정보 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Sidebar toggle (mobile) ────────────────────────────────────────────────

window.toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (window.innerWidth <= 768) {
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('visible');
    } else {
        sidebar.classList.toggle('hidden');
    }
};

window.closeSidebar = () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
};

window.closeDetail = () => {
    document.getElementById('detail-panel').classList.remove('mobile-visible');
    selectedStudentId = null;
    renderListPanel();
};

// ─── Auth ───────────────────────────────────────────────────────────────────

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
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = user.email;
        document.getElementById('user-avatar').textContent = (user.email || 'U')[0].toUpperCase();

        await loadStudents();
        await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadUserRole(), loadClassSettings()]);
        await loadRoleMemos().catch(() => {});
        updateDateDisplay();
        renderBranchFilter();
        renderSubFilters();
        updateL1ExpandIcons();
        renderListPanel();
    } else {
        currentUser = null;
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

// ─── Keyboard shortcut: ESC closes modals ───────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['schedule-modal', 'homework-modal', 'test-modal', 'batch-confirm-modal', 'enrollment-modal', 'memo-modal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal?.style.display !== 'none') {
                modal.style.display = 'none';
            }
        });
    }
});

// ─── Window global exposure ─────────────────────────────────────────────────

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

let _searchTimer = null;
window.handleSearch = (value) => {
    searchQuery = value;
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => renderListPanel(), 150);
};

window.changeDate = changeDate;
window.openDatePicker = openDatePicker;
window.goToday = goToday;
window.setCategory = setCategory;
window.setSubFilter = setSubFilter;
window.setBranch = setBranch;
window.toggleAttendance = toggleAttendance;
window.confirmBatchAttendance = confirmBatchAttendance;
window.executeBatchAttendance = executeBatchAttendance;
window.toggleHomework = toggleHomework;
window.toggleHwDomainOX = toggleHwDomainOX;
window.confirmBatchHwDomainOX = confirmBatchHwDomainOX;
window.executeBatchHwDomainOX = executeBatchHwDomainOX;
window.setClassCode = setClassCode;
window.confirmBatchAction = confirmBatchAction;
window.executeBatchAction = executeBatchAction;
window.closeSidebar = closeSidebar;
window.closeDetail = closeDetail;
window.renderStudentDetail = renderStudentDetail;

window.refreshData = async () => {
    showSaveIndicator('saving');
    await loadStudents();
    await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadRoleMemos(), loadClassSettings()]);
    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
    showSaveIndicator('saved');
};

window.toggleSelectAll = toggleSelectAll;
window.clearSelection = clearSelection;

window.selectStudent = (id) => {
    selectedStudentId = id;
    renderListPanel();
    renderStudentDetail(id);
};

window.closeModal = closeModal;
window.saveSchedule = saveScheduleFromModal;
window.saveHomework = saveHomeworkFromModal;
window.saveTest = saveTestFromModal;
window.saveDailyRecord = saveDailyRecord;
window.toggleCheck = toggleCheck;
window.handleAttendanceChange = handleAttendanceChange;
window.handleHomeworkStatusChange = handleHomeworkStatusChange;
window.openScheduleModal = openScheduleModal;
window.openHomeworkModal = openHomeworkModal;
window.openTestModal = openTestModal;
window.completeRetake = completeRetake;
window.cancelRetake = cancelRetake;
window.handleBatchAction = handleBatchAction;
window.openEnrollmentModal = openEnrollmentModal;
window.saveEnrollment = saveEnrollment;
window.saveStudentScheduledTime = saveStudentScheduledTime;
window.saveClassScheduledTimes = saveClassScheduledTimes;
window.clearClassDetail = clearClassDetail;
window.addClassDomain = addClassDomain;
window.removeClassDomain = removeClassDomain;
window.resetClassDomains = resetClassDomains;
window.addTestToSection = addTestToSection;
window.removeTestFromSection = removeTestFromSection;
window.addTestSection = addTestSection;
window.removeTestSection = removeTestSection;
window.resetTestSections = resetTestSections;
window.resetTestSection = resetTestSection;
window.applyClassArrivalTimeDetail = applyClassArrivalTimeDetail;

// 롤/메모 관련
window.selectRole = selectRole;
window.toggleMemoSection = toggleMemoSection;
window.toggleMemoPanel = toggleMemoPanel;
window.setMemoTab = setMemoTab;
window.openMemoModal = openMemoModal;
window.sendMemo = sendMemo;
window.toggleMemoStudentField = toggleMemoStudentField;
window.searchMemoStudent = searchMemoStudent;
window.selectMemoStudent = selectMemoStudent;
window.markMemoRead = markMemoRead;
window.expandMemo = expandMemo;

// ─── 임시출석 ──────────────────────────────────────────────────────────────

function openTempAttendanceModal() {
    document.getElementById('temp-att-name').value = '';
    document.getElementById('temp-att-school').value = '';
    document.getElementById('temp-att-level').value = '';
    document.getElementById('temp-att-grade').value = '';
    document.getElementById('temp-att-student-phone').value = '';
    document.getElementById('temp-att-parent-phone').value = '';
    document.getElementById('temp-att-memo').value = '';
    document.getElementById('temp-att-date').value = selectedDate;
    document.getElementById('temp-att-time').value = nowTimeStr();
    document.getElementById('temp-attendance-modal').style.display = '';
}

async function saveTempAttendance() {
    const name = document.getElementById('temp-att-name').value.trim();
    if (!name) { alert('이름을 입력하세요.'); return; }

    const data = {
        name,
        school: document.getElementById('temp-att-school').value.trim(),
        level: document.getElementById('temp-att-level').value,
        grade: document.getElementById('temp-att-grade').value.trim(),
        student_phone: document.getElementById('temp-att-student-phone').value.trim(),
        parent_phone_1: document.getElementById('temp-att-parent-phone').value.trim(),
        memo: document.getElementById('temp-att-memo').value.trim(),
        temp_date: document.getElementById('temp-att-date').value,
        temp_time: document.getElementById('temp-att-time').value,
        created_at: serverTimestamp(),
        created_by: currentUser?.email || ''
    };

    try {
        await addDoc(collection(db, 'temp_attendance'), data);
        document.getElementById('temp-attendance-modal').style.display = 'none';
        showSaveIndicator('saved');
    } catch (err) {
        console.error('임시출석 저장 실패:', err);
        alert('저장에 실패했습니다.');
    }
}

window.openTempAttendanceModal = openTempAttendanceModal;
window.saveTempAttendance = saveTempAttendance;

console.log('[DailyOps] App initialized.');

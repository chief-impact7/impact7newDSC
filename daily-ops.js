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
const DEFAULT_DOMAINS = ['Gr', 'A/G', 'R/C'];

// ─── Helpers ────────────────────────────────────────────────────────────────
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
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
    const ampm = hour >= 12 ? '오후' : '오전';
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${ampm} ${h12}:${m}`;
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
        // 접을 때 필터 해제
        if (isExpanded && selectedBranch) {
            selectedBranch = null;
            branchL1?.classList.remove('expanded');
            renderBranchFilter();
            renderSubFilters();
            renderListPanel();
            return;
        }
        branchL1?.classList.toggle('expanded', !isExpanded);
        renderBranchFilter();
        return;
    }

    if (currentCategory === category) {
        // 같은 카테고리 클릭: L2 필터 활성이면 해제+접기(현황판), 아니면 L2 토글
        if (currentSubFilter.size > 0) {
            currentSubFilter.clear();
            l2Expanded = false;
        } else {
            l2Expanded = !l2Expanded;
        }
    } else {
        currentCategory = category;
        currentSubFilter.clear();
        l2Expanded = true;
    }
    checkedItems.clear();

    // L1 active 토글 (branch 제외)
    document.querySelectorAll('.nav-l1').forEach(el => {
        if (el.dataset.category === 'branch') return;
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
        automation: [],
        class_mgmt: []
    };

    // 반 관리: 동적 서브필터 생성
    let items;
    if (currentCategory === 'class_mgmt') {
        const classCodes = getUniqueClassCodes();
        items = [{ key: 'all', label: '전체' }];
        classCodes.forEach(code => items.push({ key: code, label: code }));
    } else {
        items = filters[currentCategory] || [];
    }

    if (items.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-sec);font-size:13px;">추후 확장 예정</div>';
    } else {
        container.innerHTML = items.map(f => {
            const isActive = currentSubFilter.has(f.key) ? 'active' : '';
            const count = currentCategory === 'class_mgmt' ? getClassMgmtCount(f.key) : getSubFilterCount(f.key);
            return `<div class="nav-l2 ${isActive}" data-filter="${f.key}" onclick="setSubFilter('${f.key}')">
                ${esc(f.label)}
                ${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
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

function setBranch(branchKey) {
    selectedBranch = selectedBranch === branchKey ? null : branchKey;
    checkedItems.clear();
    renderBranchFilter();
    renderSubFilters();
    updateBatchBar();
    renderListPanel();
}

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

    updateBatchBar();
    renderListPanel();

    // 반 관리 모드에서 반 코드 선택 시 상세 패널에 반 설정 표시
    if (currentCategory === 'class_mgmt' && filterKey !== 'all' && currentSubFilter.has(filterKey)) {
        renderClassDetail(filterKey);
    } else if (currentCategory === 'class_mgmt' && !currentSubFilter.size) {
        // 반 선택 해제 시 상세 패널 초기화
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
    }
}

function getSubFilterCount(filterKey) {
    const dayName = getDayName(selectedDate);
    let todayStudents = allStudents.filter(s =>
        s.enrollments.some(e => e.day.includes(dayName))
    );
    if (selectedBranch) todayStudents = todayStudents.filter(s => branchFromStudent(s) === selectedBranch);

    if (currentCategory === 'attendance') {
        switch (filterKey) {
            case 'all': return todayStudents.length;
            case 'pre_arrival': return todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return !rec?.attendance?.status || rec.attendance.status === '미확인';
            }).length;
            case 'present': return todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '출석').length;
            case 'late': return todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '지각').length;
            case 'absent': return todayStudents.filter(s => dailyRecords[s.docId]?.attendance?.status === '결석').length;
            case 'other': return todayStudents.filter(s => {
                const st = dailyRecords[s.docId]?.attendance?.status;
                return st && !['미확인', '출석', '지각', '결석'].includes(st);
            }).length;
            default: return 0;
        }
    }

    if (currentCategory === 'homework') {
        switch (filterKey) {
            case 'all': return todayStudents.length;
            case 'not_submitted': return todayStudents.filter(s => {
                const rec = dailyRecords[s.docId];
                return rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length;
            }).length;
            case 'submitted': return todayStudents.filter(s => dailyRecords[s.docId]?.homework?.some(h => h.status === '제출')).length;
            case 'confirmed': return todayStudents.filter(s => dailyRecords[s.docId]?.homework?.some(h => h.status === '확인완료')).length;
            default: return 0;
        }
    }

    if (currentCategory === 'test') {
        switch (filterKey) {
            case 'all': return todayStudents.length;
            case 'scheduled': return todayStudents.filter(s => dailyRecords[s.docId]?.tests?.some(t => t.score === undefined || t.score === null)).length;
            case 'pass': return todayStudents.filter(s => dailyRecords[s.docId]?.tests?.some(t => t.result === '통과')).length;
            case 'retake': return todayStudents.filter(s => dailyRecords[s.docId]?.tests?.some(t => t.result === '재시필요')).length;
            default: return 0;
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

    // 검색어 필터
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        students = students.filter(s =>
            s.name?.toLowerCase().includes(q) ||
            s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q))
        );
    }

    // 서브필터 복수 선택 (OR 로직): 선택된 것 중 하나라도 매칭되면 표시
    if (currentSubFilter.size > 0) {
        if (currentCategory === 'attendance') {
            students = students.filter(s => {
                const rec = dailyRecords[s.docId];
                const st = rec?.attendance?.status || '미확인';
                for (const f of currentSubFilter) {
                    if (f === 'pre_arrival' && (!st || st === '미확인')) return true;
                    if (f === 'present' && st === '출석') return true;
                    if (f === 'late' && st === '지각') return true;
                    if (f === 'absent' && st === '결석') return true;
                    if (f === 'other' && st && !['미확인', '출석', '지각', '결석'].includes(st)) return true;
                }
                return false;
            });
        } else if (currentCategory === 'homework') {
            students = students.filter(s => {
                const rec = dailyRecords[s.docId];
                for (const f of currentSubFilter) {
                    if (f === 'hw_1st' || f === 'hw_2nd' || f === 'hw_next') return true; // 차수 필터는 추후 확장
                    if (f === 'not_submitted' && (rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length)) return true;
                    if (f === 'submitted' && rec?.homework?.some(h => h.status === '제출')) return true;
                    if (f === 'confirmed' && rec?.homework?.some(h => h.status === '확인완료')) return true;
                }
                return false;
            });
        } else if (currentCategory === 'test') {
            students = students.filter(s => {
                const rec = dailyRecords[s.docId];
                for (const f of currentSubFilter) {
                    if (f === 'test_1st' || f === 'test_2nd') return true; // 차수 필터는 추후 확장
                    if (f === 'scheduled' && rec?.tests?.some(t => t.score === undefined || t.score === null)) return true;
                    if (f === 'pass' && rec?.tests?.some(t => t.result === '통과')) return true;
                    if (f === 'retake' && rec?.tests?.some(t => t.result === '재시필요')) return true;
                }
                return false;
            });
        }
    }

    // 출결: 등원시간(start_time) 임박순 정렬
    if (currentCategory === 'attendance') {
        const dayName = getDayName(selectedDate);
        students.sort((a, b) => {
            const timeA = a.enrollments.find(e => e.day.includes(dayName))?.start_time || '99:99';
            const timeB = b.enrollments.find(e => e.day.includes(dayName))?.start_time || '99:99';
            return timeA.localeCompare(timeB);
        });
    }

    return students;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderListPanel() {
    const students = getFilteredStudents();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    // 카테고리별 라벨
    const categoryLabels = { attendance: '출결', homework: '숙제', test: '테스트', automation: '자동화', class_mgmt: '반 관리' };

    // L2 필터 활성 시 필터명 표시
    const subFilterLabels = {
        pre_arrival: '등원전', present: '출석', late: '지각', absent: '결석', other: '기타',
        hw_1st: '1차', hw_2nd: '2차', hw_next: '다음숙제',
        test_1st: '1차', test_2nd: '2차'
    };

    document.getElementById('filter-label').textContent = categoryLabels[currentCategory] || '';

    const subLabel = document.getElementById('sub-filter-label');
    if (currentSubFilter.size > 0 && !currentSubFilter.has('all')) {
        const filterNames = [...currentSubFilter].map(k => subFilterLabels[k] || k).join(' · ');
        subLabel.textContent = filterNames;
    } else {
        subLabel.textContent = '전체';
    }

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
        const code = s.enrollments.map(e => enrollmentCode(e)).join(', ');
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
        } else if (currentCategory === 'test') {
            const rec = dailyRecords[s.docId];
            const tests = rec?.tests || [];
            if (tests.length === 0) {
                toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">테스트 없음</span></div>`;
            } else {
                toggleHtml = tests.map((t, i) => {
                    const scoreText = t.score != null ? `${t.score}점` : '-';
                    const resultClass = t.result === '통과' ? 'active-present' : t.result === '재시필요' ? 'active-absent' : 'active-other';
                    return `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span style="font-size:12px;color:var(--text-sec);">${esc(t.title || '테스트'+(i+1))} (${scoreText}/${t.pass_score || '-'})</span>
                        <span class="toggle-btn ${t.result ? resultClass : ''}" style="pointer-events:none;font-size:11px;">${esc(t.result || '미완료')}</span>
                    </div>`;
                }).join('');
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

        // 등원시간 표시: 실제 기록된 시간 또는 예정 시간
        let timeTag = '';
        const rec = dailyRecords[s.docId];
        const arrivalTime = rec?.arrival_time;
        if (arrivalTime) {
            timeTag = `<span class="item-time arrived">${esc(formatTime12h(arrivalTime))}</span>`;
        } else if (currentCategory === 'attendance' || currentCategory === 'class_mgmt') {
            const dayName = getDayName(selectedDate);
            const todayEnroll = s.enrollments.find(e => e.day.includes(dayName));
            const st = todayEnroll?.start_time;
            if (st) timeTag = `<span class="item-time">${esc(formatTime12h(st))}</span>`;
        }

        return `<div class="list-item ${isActive}" data-id="${s.docId}" onclick="selectStudent('${s.docId}')">
            <input type="checkbox" class="item-checkbox" ${isChecked}
                onclick="event.stopPropagation(); toggleCheck('${s.docId}', this.checked)">
            <div class="item-main">
                <div class="item-header">
                    <span class="item-title">${esc(s.name)}</span>
                    ${timeTag}
                    <span class="item-desc">${esc(s.level || '')} · ${esc(code)} · ${esc(branch)}</span>
                </div>
                ${toggleHtml}
            </div>
        </div>`;
    }).join('');
}

// ─── Class Detail Panel ─────────────────────────────────────────────────────

const DEFAULT_TEST_SECTIONS = {
    '기반학습테스트': [],
    '리뷰테스트': []
};

function getClassTestSections(classCode) {
    return classSettings[classCode]?.test_sections || JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS));
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
            <button class="domain-chip-remove" onclick="event.stopPropagation(); removeClassDomain('${esc(classCode)}', ${i})" title="삭제">&times;</button>
        </span>
    `).join('');

    // ③ 테스트관리 — 섹션별 구성
    const sectionNames = Object.keys(testSections);
    const testSectionsHtml = sectionNames.map(secName => {
        const tests = testSections[secName] || [];
        const testChips = tests.map((t, i) => `
            <span class="domain-chip">
                ${esc(t)}
                <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestFromSection('${esc(classCode)}', '${esc(secName)}', ${i})" title="삭제">&times;</button>
            </span>
        `).join('');
        return `
            <div class="test-section">
                <div class="test-section-header">
                    <span class="test-section-name">${esc(secName)}</span>
                    <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestSection('${esc(classCode)}', '${esc(secName)}')" title="섹션 삭제">&times;</button>
                </div>
                <div class="domain-chips-container">${testChips || '<span style="font-size:12px;color:var(--text-sec);">테스트 없음</span>'}</div>
                <div class="domain-add-row">
                    <input type="text" class="field-input" data-test-section="${esc(secName)}" placeholder="테스트 이름" style="flex:1;"
                        onkeydown="if(event.key==='Enter') addTestToSection('${esc(classCode)}', '${esc(secName)}')">
                    <button class="btn btn-primary btn-sm" onclick="addTestToSection('${esc(classCode)}', '${esc(secName)}')">추가</button>
                </div>
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
                <button class="btn btn-primary btn-sm" onclick="applyClassArrivalTimeDetail('${esc(classCode)}')">전체 적용</button>
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
                    onkeydown="if(event.key==='Enter') addClassDomain('${esc(classCode)}')">
                <button class="btn btn-primary btn-sm" onclick="addClassDomain('${esc(classCode)}')">추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetClassDomains('${esc(classCode)}')">기본값 복원</button>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">quiz</span>
                테스트관리
            </div>
            ${testSectionsHtml}
            <div class="domain-add-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
                <input type="text" id="test-section-add-input" class="field-input" placeholder="새 섹션 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addTestSection('${esc(classCode)}')">
                <button class="btn btn-secondary btn-sm" onclick="addTestSection('${esc(classCode)}')">섹션 추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetTestSections('${esc(classCode)}')">기본값 복원</button>
        </div>

        <div class="class-detail-actions">
            <button class="btn btn-primary" onclick="saveClassScheduledTimes('${esc(classCode)}')">
                <span class="material-symbols-outlined" style="font-size:18px;">save</span> 일괄 저장
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
    const domains = getClassDomains(classCode);
    if (domains.includes(name)) { alert('이미 존재하는 영역입니다.'); return; }
    domains.push(name);
    await saveClassSettings(classCode, { domains });
    renderClassDetail(classCode);
}

async function removeClassDomain(classCode, index) {
    const domains = getClassDomains(classCode);
    if (domains.length <= 1) { alert('최소 1개의 영역이 필요합니다.'); return; }
    domains.splice(index, 1);
    await saveClassSettings(classCode, { domains });
    renderClassDetail(classCode);
}

async function resetClassDomains(classCode) {
    await saveClassSettings(classCode, { domains: [...DEFAULT_DOMAINS] });
    renderClassDetail(classCode);
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

    cardsContainer.innerHTML = `
        ${reasonHtml}

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
    // 등원전 → 미확인으로 매핑
    const firestoreStatus = displayStatus === '등원전' ? '미확인' : displayStatus;

    const rec = dailyRecords[studentId] || {};
    const currentStatus = rec?.attendance?.status || '미확인';

    // 같은 상태 클릭 → 미확인으로 토글 (해제)
    const newStatus = currentStatus === firestoreStatus ? '미확인' : firestoreStatus;

    const attendance = { ...(rec.attendance || {}), status: newStatus };

    // 출석/지각 시 실제 등원시간 자동 기록, 등원전으로 되돌리면 삭제
    const updates = { attendance };
    if (newStatus === '출석' || newStatus === '지각') {
        if (!rec?.arrival_time) {
            updates.arrival_time = nowTimeStr();
        }
    } else if (newStatus === '미확인') {
        updates.arrival_time = '';
    }

    // 즉시 저장 (debounce 없이)
    saveImmediately(studentId, updates);

    // 로컬 캐시 즉시 업데이트
    if (!dailyRecords[studentId]) {
        dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
    }
    dailyRecords[studentId].attendance = attendance;

    // DOM에서 해당 학생의 버튼 스타일 직접 업데이트
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

    // L2 카운트 갱신
    renderSubFilters();

    // L2 필터 활성 상태에서 학생이 더 이상 현재 필터에 맞지 않으면 페이드아웃
    if (currentCategory === 'attendance' && currentSubFilter.size > 0 && row) {
        const matchesFilter = doesStatusMatchFilter(newStatus, currentSubFilter);
        if (!matchesFilter) {
            row.classList.add('fade-out');
            row.addEventListener('transitionend', () => {
                renderListPanel();
            }, { once: true });
            // transitionend 미발생 시 안전장치
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

function toggleHomework(studentId, hwIndex, status) {
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
        buttons = `
            <button class="batch-btn" onclick="confirmBatchAction('attendance', '출석')">출석 처리</button>
            <button class="batch-btn" onclick="confirmBatchAction('attendance', '지각')">지각 처리</button>
            <button class="batch-btn" onclick="confirmBatchAction('attendance', '결석')">결석 처리</button>`;
    } else if (currentCategory === 'homework') {
        buttons = `
            <button class="batch-btn" onclick="confirmBatchAction('homework_status', '제출')">제출 확인</button>
            <button class="batch-btn" onclick="confirmBatchAction('homework_status', '확인완료')">확인완료</button>
            <button class="batch-btn" onclick="confirmBatchAction('homework_notify', '미제출 통보')">미제출 통보</button>`;
    } else if (currentCategory === 'test') {
        buttons = `
            <button class="batch-btn" onclick="confirmBatchAction('test_result', '통과')">통과 처리</button>
            <button class="batch-btn" onclick="confirmBatchAction('test_result', '재시필요')">재시 지정</button>`;
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
    await Promise.all([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadRoleMemos()]);
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
        const code = s.enrollments.map(e => enrollmentCode(e)).join(', ');
        return `<div class="memo-student-dropdown-item" onclick="selectMemoStudent('${s.docId}', '${esc(s.name)}')">${esc(s.name)} <span style="color:var(--text-sec);font-size:11px;">${esc(code)}</span></div>`;
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
        await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadUserRole(), loadClassSettings()]);
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

window.handleSearch = (value) => {
    searchQuery = value;
    renderListPanel();
};

window.changeDate = changeDate;
window.openDatePicker = openDatePicker;
window.goToday = goToday;
window.setCategory = setCategory;
window.setSubFilter = setSubFilter;
window.setBranch = setBranch;
window.toggleAttendance = toggleAttendance;
window.toggleHomework = toggleHomework;
window.confirmBatchAction = confirmBatchAction;
window.executeBatchAction = executeBatchAction;
window.closeSidebar = closeSidebar;
window.closeDetail = closeDetail;
window.renderStudentDetail = renderStudentDetail;

window.refreshData = async () => {
    showSaveIndicator('saving');
    await loadStudents();
    await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadRoleMemos(), loadClassSettings()]);
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

console.log('[DailyOps] App initialized.');

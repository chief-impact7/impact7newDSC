import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc, setDoc, getDoc, addDoc,
    query, where, serverTimestamp, updateDoc, writeBatch, arrayUnion, deleteField, Timestamp, deleteDoc
} from 'firebase/firestore';
import { auth, db, geminiModel } from './firebase-config.js';
import { signInWithGoogle, logout, getGoogleAccessToken } from './auth.js';
import { initHelpGuide } from './help-guide.js';

// ─── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let allStudents = [];           // students 컬렉션 캐시
let dailyRecords = {};          // studentDocId → daily_record 데이터
let retakeSchedules = [];       // retake_schedule 전체
let hwFailTasks = [];           // hw_fail_tasks 전체
let testFailTasks = [];         // test_fail_tasks 전체
let tempAttendances = [];       // temp_attendance 전체 (해당 날짜)
let absenceRecords = [];        // absence_records (open 상태)
let leaveRequests = [];          // leave_requests (requested + approved)
let withdrawnStudents = [];      // 퇴원 학생 (퇴원→휴원 검색용)
let selectedDate = todayStr();
let selectedStudentId = null;
let currentCategory = 'attendance'; // 'attendance' | 'homework' | 'test' | 'automation'
let currentSubFilter = new Set();    // L2 복수 선택 (빈 Set = 전체)
let l2Expanded = false;             // L2 서브필터 펼침 상태
let saveTimers = {};
let searchQuery = '';
let currentRole = null;
let roleMemos = [];
let memoTab = 'inbox';
let classSettings = {};          // classCode → { domains: [...], teacher, sub_teacher }
let teachersList = [];           // teachers 컬렉션 캐시 [{ email, display_name }]
let selectedBranch = null;       // 소속 글로벌 필터 (null = 전체, '2단지' | '10단지')
let selectedBranchLevel = null;  // 소속 L3 필터 (null = 전체, '초등' | '중등' | '고등')
let selectedClassCode = null;    // 반 글로벌 필터 (null = 전체, 'ax104' 등)
let selectedSemester = null;     // 학기 글로벌 필터 (null = 전체, '2026-Winter' 등)
let latestSemester = null;       // 가장 최신 학기 (읽기전용 판별용)
let semesterSettings = {};       // semester → { start_date }
let currentSemester = null;      // 오늘 기준 현재 학기
let siblingMap = {};             // docId → Set of sibling docIds
let allContacts = [];            // contacts 컬렉션 캐시
let bulkMode = false;
let selectedStudentIds = new Set();
let groupViewMode = localStorage.getItem('dsc_groupViewMode') || 'none'; // 'none' | 'branch' | 'class'
let savedSubFilters = {};        // 카테고리별 L2 선택 기억 { homework: Set['hw_1st'], ... }
let savedL2Expanded = {};        // 카테고리별 L2 펼침 상태 기억
let classNextHw = {};            // classCode → { domains: { "Gr": "...", ... } }
let nextHwSaveTimers = {};       // classCode_domain → timer
let selectedNextHwClass = null;  // 다음숙제 반별 상세에서 선택된 반 코드
let nextHwModalTarget = { classCode: null, domain: null }; // 모달 타겟
let detailTab = 'daily'; // 'daily' | 'report'
let _editingTempDocId = null;   // null=생성모드, string=수정모드
const TEMP_FIELD_LABELS = {
    name: '이름', branch: '소속', school: '학교', level: '학부', grade: '학년',
    student_phone: '학생연락처', parent_phone_1: '학부모연락처', memo: '메모',
    temp_date: '예정날짜', temp_time: '예정시간'
};
const DEFAULT_DOMAINS = ['Gr', 'A/G', 'R/C'];
const KOREAN_CHAR_RE = /^[\uAC00-\uD7AF]/;
const SV_SOURCE_MAP = {
    sv_absence_makeup: ['absence_makeup'],
    sv_clinic: ['extra'],
    sv_diagnostic: ['temp'],
    sv_fail: ['hw_fail', 'test_fail']
};
const SV_L3_KEYS = Object.keys(SV_SOURCE_MAP);

// ─── OX Helpers ─────────────────────────────────────────────────────────────
const OX_CYCLE = ['O', '△', 'X', ''];
const VISIT_STATUS_CYCLE = ['pending', '완료', '기타'];
let _visitStatusPending = {};  // docId → { source, nextStatus, studentId }

function _toVisitStatus(rawStatus) {
    return rawStatus === '완료' ? '완료' : rawStatus === '기타' ? '기타' : '미완료';
}

function _visitBtnStyles(status) {
    const cls = status === '완료' ? 'active-present' : status === '기타' ? 'active-other' : '';
    const sty = (status === 'pending' || status === '미완료') ? 'color:var(--text-sec);border-color:var(--border);' : '';
    return { cls, sty: `padding:2px 10px;font-size:12px;min-width:auto;${sty}` };
}

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

// ─── 한글 초성 검색 헬퍼 ───────────────────────────────────────────────────
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const getChosung = (str) => [...(str || '')].map(ch => {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) return CHO[Math.floor((code - 0xAC00) / 588)];
    return ch;
}).join('');
const isChosungOnly = (str) => str && [...str].every(ch => CHO.includes(ch));
const matchChosung = (target, term) => {
    if (!target || !term) return false;
    return getChosung(target).includes(term);
};

// ─── 형제 맵 빌드 ──────────────────────────────────────────────────────────
function buildSiblingMap() {
    siblingMap = {};
    const idToStudent = new Map(allStudents.map(s => [s.docId, s]));
    const phoneToIds = {};
    allStudents.forEach(s => {
        const phones = [...new Set([s.parent_phone_1, s.parent_phone_2]
            .map(p => (p || '').replace(/\D/g, '')).filter(p => p.length >= 9))];
        phones.forEach(p => {
            if (!phoneToIds[p]) phoneToIds[p] = [];
            phoneToIds[p].push(s.docId);
        });
    });
    Object.values(phoneToIds).forEach(ids => {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length < 2) return;
        uniqueIds.forEach(id => {
            const student = idToStudent.get(id);
            if (!student) return;
            const siblings = uniqueIds.filter(sid => {
                if (sid === id) return false;
                const other = idToStudent.get(sid);
                return other && other.name !== student.name;
            });
            if (siblings.length > 0) {
                if (!siblingMap[id]) siblingMap[id] = new Set();
                siblings.forEach(sid => siblingMap[id].add(sid));
            }
        });
    });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

// HTML 엔티티 디코딩 (&amp; → &, &#39; → ', &quot; → " 등)
const decodeHtmlEntities = (str) => {
    if (!str) return str;
    const ta = document.createElement('textarea');
    ta.innerHTML = str;
    return ta.value;
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

function matchesBranchFilter(s) {
    if (selectedBranch && branchFromStudent(s) !== selectedBranch) return false;
    if (selectedBranch && selectedBranchLevel && (s.level || '') !== selectedBranchLevel) return false;
    return true;
}

function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`;
}
const allClassCodes = (s) => (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);

// 학생 등원시간: 개별 시간 → 반 기본 시간 fallback
function getStudentStartTime(enrollment) {
    if (!enrollment) return '';
    return enrollment.start_time || classSettings[enrollmentCode(enrollment)]?.default_time || '';
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

// ─── Teachers (선생님 목록) ─────────────────────────────────────────────────

async function loadTeachers() {
    const oneWeekAgo = Timestamp.fromDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const q = query(collection(db, 'teachers'), where('last_login', '>=', oneWeekAgo));
    const snap = await getDocs(q);
    teachersList = [];
    snap.forEach(d => teachersList.push({ email: d.id, ...d.data() }));
    teachersList.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email, 'ko'));
}

async function trackTeacherLogin(user) {
    if (!user?.email) return;
    try {
        await setDoc(doc(db, 'teachers', user.email), {
            email: user.email,
            display_name: user.displayName || user.email.split('@')[0],
            photo_url: user.photoURL || '',
            last_login: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('Teacher login tracking failed:', err);
    }
}

function getTeacherName(email) {
    if (!email) return '';
    return email.split('@')[0];
}

// ─── Class Next Homework (반별 다음숙제) ────────────────────────────────────

async function loadClassNextHw(date) {
    const q2 = query(collection(db, 'class_next_hw'), where('date', '==', date));
    const snap = await getDocs(q2);
    classNextHw = {};
    snap.forEach(d => {
        const data = d.data();
        classNextHw[data.class_code] = data;
    });
}

function saveClassNextHw(classCode, domain, text, immediate = false) {
    const timerKey = `${classCode}_${domain}`;
    if (nextHwSaveTimers[timerKey]) clearTimeout(nextHwSaveTimers[timerKey]);

    // 로컬 상태 즉시 업데이트
    if (!classNextHw[classCode]) {
        classNextHw[classCode] = { class_code: classCode, date: selectedDate, domains: {} };
    }
    classNextHw[classCode].domains[domain] = text;

    const doSave = async () => {
        showSaveIndicator('saving');
        try {
            const docId = `${classCode}_${selectedDate}`;
            await setDoc(doc(db, 'class_next_hw', docId), {
                class_code: classCode,
                date: selectedDate,
                domains: classNextHw[classCode].domains,
                updated_by: currentUser.email,
                updated_at: serverTimestamp()
            }, { merge: true });
            showSaveIndicator('saved');
        } catch (err) {
            console.error('다음숙제 저장 실패:', err);
            showSaveIndicator('error');
        }
    };

    if (immediate) {
        doSave();
    } else {
        nextHwSaveTimers[timerKey] = setTimeout(doSave, 2000);
    }
}

function getNextHwStatus(classCode) {
    const domains = getClassDomains(classCode);
    const data = classNextHw[classCode]?.domains || {};
    const filled = domains.filter(d => {
        const v = (data[d] || '').trim();
        return v === '없음' || v.length > 0;
    }).length;
    return { filled, total: domains.length };
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
            // 중복 enrollment 제거 (같은 반코드+학기)
            const seen = new Set();
            data.enrollments = data.enrollments.filter(e => {
                const key = `${enrollmentCode(e)}_${e.semester || ''}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
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
        const q = query(collection(db, 'retake_schedule'), where('status', '==', '예정'));
        const snap = await getDocs(q);
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
        const q = query(collection(db, 'hw_fail_tasks'), where('status', '==', 'pending'));
        const snap = await getDocs(q);
        snap.forEach(d => {
            hwFailTasks.push({ docId: d.id, ...d.data() });
        });
    } catch (err) {
        console.error('hw_fail_tasks 로드 실패:', err.message);
    }
}

async function loadTestFailTasks() {
    testFailTasks = [];
    try {
        const q = query(collection(db, 'test_fail_tasks'), where('status', '==', 'pending'));
        const snap = await getDocs(q);
        snap.forEach(d => {
            testFailTasks.push({ docId: d.id, ...d.data() });
        });
    } catch (err) {
        console.error('test_fail_tasks 로드 실패:', err.message);
    }
}

async function loadTempAttendances(date) {
    tempAttendances = [];
    try {
        const q = query(collection(db, 'temp_attendance'), where('temp_date', '==', date));
        const snap = await getDocs(q);
        snap.forEach(d => tempAttendances.push({ docId: d.id, ...d.data() }));
    } catch (err) {
        console.error('temp_attendance 로드 실패:', err.message);
    }
}

async function loadAbsenceRecords() {
    absenceRecords = [];
    try {
        const q = query(collection(db, 'absence_records'), where('status', '==', 'open'));
        const snap = await getDocs(q);
        const withdrawnIds = new Set(allStudents.filter(s => s.status === '퇴원').map(s => s.docId));
        snap.forEach(d => {
            if (!withdrawnIds.has(d.data().student_id)) {
                absenceRecords.push({ docId: d.id, ...d.data() });
            }
        });
    } catch (err) {
        console.error('absence_records 로드 실패:', err.message);
    }
}

async function loadLeaveRequests() {
    leaveRequests = [];
    try {
        const q = query(collection(db, 'leave_requests'), where('status', 'in', ['requested', 'approved']));
        const snap = await getDocs(q);
        snap.forEach(d => leaveRequests.push({ docId: d.id, ...d.data() }));
    } catch (err) {
        console.error('leave_requests 로드 실패:', err.message);
    }
}

async function loadWithdrawnStudents() {
    withdrawnStudents = [];
    try {
        const q = query(collection(db, 'students'), where('status', '==', '퇴원'));
        const snap = await getDocs(q);
        snap.forEach(d => withdrawnStudents.push({ docId: d.id, ...d.data() }));
    } catch (err) {
        console.error('퇴원 학생 로드 실패:', err.message);
    }
}

function saveDailyRecord(studentId, updates) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
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
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
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
        if (!matchesBranchFilter(s)) return;
        s.enrollments.forEach(e => {
            if (!e.day.includes(dayName)) return;
            if (selectedSemester && e.semester !== selectedSemester) return;
            const code = enrollmentCode(e);
            if (code) codes.add(code);
        });
    });
    return [...codes].sort();
}

function getClassMgmtCount(filterKey) {
    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        )
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (filterKey === 'all') return students.length;
    return students.filter(s =>
        s.enrollments.some(e =>
            e.day.includes(dayName) && enrollmentCode(e) === filterKey &&
            (!selectedSemester || e.semester === selectedSemester)
        )
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


    // L1 active 토글 (branch, class_mgmt 제외 — 글로벌 필터)
    document.querySelectorAll('.nav-l1').forEach(el => {
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        el.classList.toggle('active', el.dataset.category === category);
    });

    // L2 서브필터 렌더링
    renderSubFilters();
    updateL1ExpandIcons();

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
            { key: 'scheduled_visit', label: '비정규', children: [
                { key: 'sv_absence_makeup', label: '결석보충' },
                { key: 'sv_clinic', label: '클리닉' },
                { key: 'sv_diagnostic', label: '진단평가' },
                { key: 'sv_fail', label: '미통과' }
            ]},
            { key: 'pre_arrival', label: '정규', children: [
                { key: 'enroll_pending', label: '등원예정' },
                { key: 'present', label: '출석' },
                { key: 'late', label: '지각' },
                { key: 'absent', label: '결석' },
                { key: 'other', label: '기타' },
                { key: 'departure_check', label: '귀가점검' }
            ]}
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
        ],
        admin: [
            { key: 'absence_ledger', label: '결석대장' },
            { key: 'leave_request', label: '휴퇴원요청' },
            { key: 'return_upcoming', label: '복귀예정' }
        ]
    };

    const items = filters[currentCategory] || [];

    if (items.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-sec);font-size:13px;">추후 확장 예정</div>';
    } else {
        _subFilterBase = null; // 캐시 초기화
        _returnUpcomingCache = null;
        _scheduledVisitsCache = null;
        _enrollPendingCache = null;
        let html = '';
        for (const f of items) {
            const childKeys = f.children ? f.children.map(c => c.key) : [];
            const parentOrChildActive = currentSubFilter.has(f.key) || childKeys.some(k => currentSubFilter.has(k));
            const isActive = currentSubFilter.has(f.key) ? 'active' : '';
            const isExpanded = parentOrChildActive ? 'l2-expanded' : '';
            const parentClass = f.children ? 'l2-parent' : '';
            const expandIcon = f.children
                ? `<span class="material-symbols-outlined l2-expand-icon">${parentOrChildActive ? 'expand_less' : 'expand_more'}</span>`
                : '';
            const { count, total } = getSubFilterCount(f.key);
            const badge = count > 0 || total > 0
                ? `<span class="nav-l2-count">${total > 0 ? `${count}/${total}` : count}</span>`
                : '';
            html += `<div class="nav-l2 ${parentClass} ${isExpanded} ${isActive}" data-filter="${f.key}" onclick="setSubFilter('${f.key}')">
                ${esc(f.label)}
                ${badge}
                ${expandIcon}
            </div>`;
            if (f.children && parentOrChildActive) {
                for (const child of f.children) {
                    const childActive = currentSubFilter.has(child.key) ? 'active' : '';
                    const { count: cc, total: ct } = getSubFilterCount(child.key);
                    const childBadge = cc > 0 || ct > 0
                        ? `<span class="nav-l2-count">${ct > 0 ? `${cc}/${ct}` : cc}</span>`
                        : '';
                    html += `<div class="nav-l2 nav-l3 ${childActive}" data-filter="${child.key}" onclick="setSubFilter('${child.key}')">
                        ${esc(child.label)}
                        ${childBadge}
                    </div>`;
                }
            }
        }
        container.innerHTML = html;
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
        { key: '2단지', label: '2단지', children: ['초등', '중등', '고등'] },
        { key: '10단지', label: '10단지', children: ['초등', '중등', '고등'] }
    ];
    const dayName = getDayName(selectedDate);
    const active = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        )
    );

    let html = '';
    for (const b of branches) {
        const branchStudents = active.filter(s => branchFromStudent(s) === b.key);
        const count = branchStudents.length;
        const isBranchSelected = selectedBranch === b.key;
        const parentActive = isBranchSelected && !selectedBranchLevel ? 'active' : '';
        const expanded = isBranchSelected ? 'l2-expanded' : '';

        html += `<div class="nav-l2 l2-parent ${parentActive} ${expanded}" data-filter="${b.key}" onclick="setBranch('${b.key}')">
            ${esc(b.label)}
            ${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
            <span class="material-symbols-outlined l2-expand-icon">${isBranchSelected ? 'expand_less' : 'expand_more'}</span>
        </div>`;

        if (isBranchSelected) {
            for (const level of b.children) {
                const levelCount = branchStudents.filter(s => (s.level || '') === level).length;
                const levelActive = selectedBranchLevel === level ? 'active' : '';
                html += `<div class="nav-l2 nav-l3 ${levelActive}" data-filter="${b.key}_${level}" onclick="setBranchLevel('${level}')">
                    ${esc(level)}
                    ${levelCount > 0 ? `<span class="nav-l2-count">${levelCount}</span>` : ''}
                </div>`;
            }
        }
    }
    container.innerHTML = html;

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
            s.enrollments.some(e =>
                e.day.includes(dayName) && enrollmentCode(e) === code &&
                (!selectedSemester || e.semester === selectedSemester)
            )
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

    renderClassCodeFilter();
    renderFilterChips();
    renderSubFilters();

    renderListPanel();
    // 반 해제 시 디테일 초기화
    if (!selectedClassCode) {
        renderStudentDetail(null);
    }
}

function setBranch(branchKey) {
    if (selectedBranch === branchKey) {
        selectedBranch = null;
        selectedBranchLevel = null;
    } else {
        selectedBranch = branchKey;
        selectedBranchLevel = null;
    }

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
}

function setBranchLevel(level) {
    selectedBranchLevel = selectedBranchLevel === level ? null : level;

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
}

// ─── 학기 필터 ──────────────────────────────────────────────────────────────

// ─── 학기 설정 (시작일) ──────────────────────────────────────────────────
async function loadSemesterSettings() {
    const snap = await getDocs(collection(db, 'semester_settings'));
    semesterSettings = {};
    snap.forEach(d => { semesterSettings[d.id] = d.data(); });
}

function getCurrentSemester() {
    const today = todayStr(); // 'YYYY-MM-DD'
    const entries = Object.entries(semesterSettings)
        .filter(([, v]) => v.start_date)
        .sort((a, b) => a[1].start_date.localeCompare(b[1].start_date));

    // 오늘 이하인 가장 최근 start_date의 학기가 현재 학기
    let result = null;
    for (const [semester, { start_date }] of entries) {
        if (start_date <= today) result = semester;
    }
    currentSemester = result;
    return result;
}

function isPastSemester() {
    if (!currentSemester) return false;
    // 1) 학기 필터가 과거 학기인 경우
    if (selectedSemester && selectedSemester !== currentSemester) return true;
    // 2) 선택된 날짜가 현재 학기 시작일 이전인 경우
    const startDate = semesterSettings[currentSemester]?.start_date;
    if (startDate && selectedDate < startDate) return true;
    return false;
}

function buildSemesterFilter() {
    const sel = document.getElementById('semester-filter');
    if (!sel) return;
    const semesters = new Set();
    allStudents.forEach(s =>
        (s.enrollments || []).forEach(e => { if (e.semester) semesters.add(e.semester); })
    );
    // Spring1/Spring2는 Spring으로 통합되었으므로 필터에서 제외
    semesters.delete('2026-Spring1');
    semesters.delete('2026-Spring2');
    semesters.delete('2027-Spring1');
    semesters.delete('2027-Spring2');
    const sorted = [...semesters].sort().reverse();
    latestSemester = sorted[0] || null;
    // 전역 변수 → DOM → localStorage 순으로 보존된 값 복원
    // currentSemester가 있으면 기본값으로 사용
    const saved = selectedSemester || sel.value || localStorage.getItem('dsc_semester_filter') || currentSemester || '';
    sel.innerHTML = '<option value="">전체 학기</option>' +
        sorted.map(s => `<option value="${s}">${s}</option>`).join('');
    if (saved && sorted.includes(saved)) {
        sel.value = saved;
        selectedSemester = saved;
    } else {
        sel.value = '';
        selectedSemester = null;
    }
}

function handleSemesterFilter(val) {
    selectedSemester = val || null;
    if (val) {
        localStorage.setItem('dsc_semester_filter', val);
    } else {
        localStorage.removeItem('dsc_semester_filter');
    }

    updateReadonlyBanner();
    renderFilterChips();
    renderSubFilters();
    renderListPanel();
}
window.handleSemesterFilter = handleSemesterFilter;

function updateReadonlyBanner() {
    const banner = document.getElementById('semester-readonly-banner');
    if (banner) banner.style.display = isPastSemester() ? '' : 'none';
}

// ─── 학기 시작일 설정 모달 ──────────────────────────────────────────────────
function openSemesterSettingsModal() {
    const modal = document.getElementById('semester-settings-modal');
    const body = document.getElementById('semester-settings-body');
    if (!modal || !body) return;

    // 학기 목록: enrollment에서 추출된 학기들
    const semesters = new Set();
    allStudents.forEach(s =>
        (s.enrollments || []).forEach(e => { if (e.semester) semesters.add(e.semester); })
    );
    semesters.delete('2026-Spring1');
    semesters.delete('2026-Spring2');
    semesters.delete('2027-Spring1');
    semesters.delete('2027-Spring2');
    const sorted = [...semesters].sort();

    if (sorted.length === 0) {
        body.innerHTML = '<p style="color:var(--text-sec);font-size:13px;">등록된 학기가 없습니다.</p>';
    } else {
        body.innerHTML = sorted.map(sem => {
            const setting = semesterSettings[sem] || {};
            const isCurrent = sem === currentSemester;
            return `<div class="semester-setting-row">
                <span class="semester-setting-label">${sem}${isCurrent ? '<span class="current-badge">현재</span>' : ''}</span>
                <input type="date" class="semester-setting-date" value="${setting.start_date || ''}"
                    onchange="saveSemesterStartDate('${sem}', this.value)">
            </div>`;
        }).join('');
    }

    modal.style.display = 'flex';
}
window.openSemesterSettingsModal = openSemesterSettingsModal;

async function saveSemesterStartDate(semester, startDate) {
    try {
        if (startDate) {
            await setDoc(doc(db, 'semester_settings', semester), { start_date: startDate });
            semesterSettings[semester] = { start_date: startDate };
        } else {
            await deleteDoc(doc(db, 'semester_settings', semester));
            delete semesterSettings[semester];
        }
        getCurrentSemester();
        updateReadonlyBanner();
        // 모달 내 현재 배지 업데이트
        openSemesterSettingsModal();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('학기 시작일 저장 실패:', err);
        showSaveIndicator('error');
    }
}
window.saveSemesterStartDate = saveSemesterStartDate;

function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    if (!container) return;

    const categoryLabels = { attendance: '출결', homework: '숙제', test: '테스트', automation: '자동화', admin: '행정' };
    const subFilterLabels = {
        scheduled_visit: '비정규', pre_arrival: '정규', present: '출석', late: '지각', absent: '결석', other: '기타',
        departure_check: '귀가점검', absence_ledger: '결석대장',
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
        const branchLabel = selectedBranchLevel ? `${selectedBranch} ${selectedBranchLevel}` : selectedBranch;
        chips.push({ label: `소속: ${branchLabel}`, onRemove: 'clearBranch' });
    }

    // 반 칩
    if (selectedClassCode) {
        chips.push({ label: `반: ${selectedClassCode}`, onRemove: 'clearClassCode' });
    }

    // 학기는 사이드바 드롭다운에서 제어 — 칩에 표시하지 않음

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
        selectedBranchLevel = null;
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
    }


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
    // 글로벌 필터 해제 (학기는 사이드바 드롭다운에서만 제어 — 유지)
    selectedBranch = null;
    selectedBranchLevel = null;
    selectedClassCode = null;
    document.querySelector('.nav-l1[data-category="branch"]')?.classList.remove('expanded');
    document.querySelector('.nav-l1[data-category="class_mgmt"]')?.classList.remove('expanded');
    // UI 동기화
    selectedStudentId = null;
    renderStudentDetail(null);

    renderBranchFilter();
    renderClassCodeFilter();
    renderSubFilters();
    updateL1ExpandIcons();

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

    // 현재 카테고리의 L2 상태 저장
    savedSubFilters[currentCategory] = new Set(currentSubFilter);

    // L3 확장/축소 반영을 위해 innerHTML 재구성
    renderSubFilters();
    renderListPanel();
}

const REGULAR_CLASS_TYPES = ['정규', '내신', '특강'];

let _regularDayCache = { date: null, dayName: null };
function hasRegularEnrollmentToday(student) {
    if (_regularDayCache.date !== selectedDate) {
        _regularDayCache = { date: selectedDate, dayName: getDayName(selectedDate) };
    }
    const dayName = _regularDayCache.dayName;
    return student.enrollments.some(e =>
        e.day.includes(dayName) &&
        (!selectedSemester || e.semester === selectedSemester) &&
        REGULAR_CLASS_TYPES.includes(e.class_type || '정규')
    );
}

// 비정규 등원 여부 판별 (hw_fail/test_fail/extra_visit)
function isVisitStudent(docId) {
    const hwFail = dailyRecords[docId]?.hw_fail_action || {};
    if (Object.values(hwFail).some(a => a.type === '등원' && a.scheduled_date === selectedDate)) return true;
    if (testFailTasks.some(t => t.student_id === docId && t.type === '등원' && t.scheduled_date === selectedDate && t.status === 'pending')) return true;
    if (dailyRecords[docId]?.extra_visit?.date === selectedDate) return true;
    return false;
}

// 캐시: renderSubFilters에서 탭당 반복 호출 시 base list 재계산 방지
let _subFilterBase = null;

function _getSubFilterBase() {
    if (_subFilterBase) return _subFilterBase;

    const dayName = getDayName(selectedDate);
    let todayStudents = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        )
    );
    todayStudents = todayStudents.filter(s => matchesBranchFilter(s));
    if (selectedClassCode) todayStudents = todayStudents.filter(s => s.enrollments.some(e =>
        e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === selectedClassCode
    ));

    const existingIds = new Set(todayStudents.map(s => s.docId));
    const visitStudentIds = new Set();
    allStudents.forEach(s => {
        if (existingIds.has(s.docId)) return;
        if (selectedClassCode && !s.enrollments.some(e => enrollmentCode(e) === selectedClassCode)) return;
        if (isVisitStudent(s.docId)) {
            todayStudents.push(s);
            existingIds.add(s.docId);
            visitStudentIds.add(s.docId);
        }
    });

    const regularOnly = todayStudents.filter(s => !visitStudentIds.has(s.docId));
    _subFilterBase = { todayStudents, visitStudentIds, regularOnly };
    return _subFilterBase;
}

function getSubFilterCount(filterKey) {
    const { todayStudents, regularOnly } = _getSubFilterBase();
    const total = todayStudents.length;
    const r = (count) => ({ count, total });

    if (currentCategory === 'attendance') {
        const regularTotal = regularOnly.length;
        const rr = (count) => ({ count, total: regularTotal });

        switch (filterKey) {
            case 'scheduled_visit': {
                const visits = getScheduledVisits();
                const pending = visits.filter(v => v.status === 'pending').length;
                return { count: pending, total: visits.length };
            }
            case 'all': return rr(regularTotal);
            case 'pre_arrival': {
                const preStudents = regularOnly.filter(s => hasRegularEnrollmentToday(s));
                const enrollPending = getEnrollPendingVisits();
                const pending = preStudents.filter(s => {
                    const rec = dailyRecords[s.docId];
                    return !rec?.attendance?.status || rec.attendance.status === '미확인';
                }).length + enrollPending.length;
                return { count: pending, total: preStudents.length + enrollPending.length };
            }
            case 'enroll_pending': {
                const visits = getEnrollPendingVisits();
                return { count: visits.length, total: visits.length };
            }
            case 'present': return rr(regularOnly.filter(s => dailyRecords[s.docId]?.attendance?.status === '출석').length);
            case 'late': return rr(regularOnly.filter(s => dailyRecords[s.docId]?.attendance?.status === '지각').length);
            case 'absent': return rr(regularOnly.filter(s => dailyRecords[s.docId]?.attendance?.status === '결석').length);
            case 'other': return rr(regularOnly.filter(s => {
                const st = dailyRecords[s.docId]?.attendance?.status;
                return st && !['미확인', '출석', '지각', '결석'].includes(st);
            }).length);
            case 'departure_check': {
                const departed = regularOnly.filter(s => dailyRecords[s.docId]?.departure?.status === '귀가').length;
                return { count: departed, total: regularTotal };
            }
            default: {
                const svSources = SV_SOURCE_MAP[filterKey];
                if (svSources) {
                    const visits = getScheduledVisits().filter(v => svSources.includes(v.source));
                    const pending = visits.filter(v => v.status === 'pending').length;
                    return { count: pending, total: visits.length };
                }
                return rr(0);
            }
        }
    }

    if (currentCategory === 'admin') {
        switch (filterKey) {
            case 'absence_ledger': {
                let filtered = absenceRecords.filter(r => r.absence_date === selectedDate);
                if (selectedBranch) filtered = filtered.filter(r => r.branch === selectedBranch);
                return { count: filtered.length, total: 0 };
            }
            case 'leave_request': {
                let filtered = leaveRequests.filter(r => _leaveRequestDate(r) === selectedDate);
                if (selectedBranch) filtered = filtered.filter(r => r.branch === selectedBranch);
                const pending = filtered.filter(r => r.status === 'requested').length;
                return { count: pending, total: filtered.length };
            }
            case 'return_upcoming': {
                const items = _getReturnUpcomingStudents();
                const urgent = items.filter(x => x.daysLeft <= 7).length;
                return { count: urgent, total: items.length };
            }
            default: return { count: 0, total: 0 };
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
            case 'hw_next': {
                const classCodes = getUniqueClassCodes();
                const filledCount = classCodes.filter(cc => {
                    const { filled, total } = getNextHwStatus(cc);
                    return filled > 0;
                }).length;
                return { count: filledCount, total: classCodes.length };
            }
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

    return { count: 0, total: 0 };
}

// ─── 비정규 통합 집계 ────────────────────────────────────────────────────────

// 학교+학부+학년 → 축약 표시 (예: "진명여자고등학교" → "진명여고", + 학년 → "진명여고1")
function _formatTempSchoolInfo(ta) {
    let school = (ta.school || '').replace('여자', '여');
    const level = ta.level || '';
    const grade = ta.grade || '';
    // 학부 접미어 축약: 초등→초, 중등→중, 고등→고
    const levelShort = level === '초등' ? '초' : level === '중등' ? '중' : level === '고등' ? '고' : '';
    // 학교명에 이미 '초/중/고'로 끝나면 학부 생략
    const endsWithLevel = /[초중고]$|초등학교$|중학교$|고등학교$/.test(school);
    if (endsWithLevel) {
        school = school.replace(/초등학교$/, '초').replace(/중학교$/, '중').replace(/고등학교$/, '고');
        return school + grade;
    }
    return (school + levelShort + grade) || '';
}

let _scheduledVisitsCache = null;
function getScheduledVisits() {
    if (_scheduledVisitsCache) return _scheduledVisitsCache;
    const visits = [];
    // 이메일/아이디에서 이름 prefix 추출: "홍길동" → "길동", "Iris Lee" → "Iris", "chief" → "chief"
    const callerName = (emailOrId) => {
        if (!emailOrId) return '';
        const id = emailOrId.split('@')[0];
        const teacher = teachersList.find(tc => tc.email === emailOrId || tc.email.split('@')[0] === id);
        const name = teacher?.display_name || id;
        if (KOREAN_CHAR_RE.test(name)) return name.length >= 2 ? name.slice(1) : name;
        return name.split(' ')[0];
    };

    // 1) 진단평가 (temp_attendance)
    for (const ta of tempAttendances) {
        visits.push({
            id: `temp_${ta.docId}`,
            source: 'temp',
            sourceLabel: '진단평가',
            sourceColor: '#7c3aed',
            studentId: null,
            name: ta.name || '(이름 없음)',
            time: ta.temp_time || '',
            detail: _formatTempSchoolInfo(ta) || '',
            status: (ta.visit_status === '완료' || ta.visit_status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(ta.visit_status),
            caller: callerName(ta.created_by),
            completedBy: callerName(ta.completed_by),
            completedAt: ta.completed_at || '',
            docId: ta.docId
        });
    }

    // 2) 숙제미통과 등원 (hwFailTasks)
    for (const t of hwFailTasks) {
        if (t.type !== '등원' || t.scheduled_date !== selectedDate || (t.status !== 'pending' && t.status !== '완료' && t.status !== '기타')) continue;
        visits.push({
            id: `hw_fail_${t.docId}`,
            source: 'hw_fail',
            sourceLabel: '숙제미통과',
            sourceColor: '#dc2626',
            studentId: t.student_id,
            name: t.student_name || t.student_id,
            time: t.scheduled_time || '',
            detail: `${t.domain || ''} (${_stripYear(t.source_date)})`,
            status: (t.status === '완료' || t.status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(t.status),
            caller: callerName(t.created_by || ''),
            completedBy: callerName(t.completed_by || ''),
            completedAt: t.completed_at || '',
            docId: t.docId
        });
    }

    // 3) 테스트미통과 등원 (testFailTasks)
    for (const t of testFailTasks) {
        if (t.type !== '등원' || t.scheduled_date !== selectedDate || (t.status !== 'pending' && t.status !== '완료' && t.status !== '기타')) continue;
        visits.push({
            id: `test_fail_${t.docId}`,
            source: 'test_fail',
            sourceLabel: '테스트미통과',
            sourceColor: '#ea580c',
            studentId: t.student_id,
            name: t.student_name || t.student_id,
            time: t.scheduled_time || '',
            detail: `${t.item || t.domain || ''} (${_stripYear(t.source_date)})`,
            status: (t.status === '완료' || t.status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(t.status),
            caller: callerName(t.created_by || ''),
            completedBy: callerName(t.completed_by || ''),
            completedAt: t.completed_at || '',
            docId: t.docId
        });
    }

    // 4) 클리닉 (dailyRecords[*].extra_visit)
    for (const [sid, rec] of Object.entries(dailyRecords)) {
        const ev = rec.extra_visit;
        if (!ev || ev.date !== selectedDate) continue;
        const student = allStudents.find(s => s.docId === sid);
        visits.push({
            id: `extra_${sid}`,
            source: 'extra',
            sourceLabel: '클리닉',
            sourceColor: '#2563eb',
            studentId: sid,
            name: student?.name || sid,
            time: ev.time || '',
            detail: ev.reason || '',
            status: (ev.visit_status === '완료' || ev.visit_status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(ev.visit_status),
            caller: callerName(rec.updated_by),
            completedBy: callerName(ev.completed_by),
            completedAt: ev.completed_at || '',
            docId: sid
        });
    }

    // 5) 결석보충 (absenceRecords) — 등원예정은 정규 쪽으로 이동
    for (const r of absenceRecords) {
        if (r.resolution !== '보충' || r.makeup_date !== selectedDate || r.status !== 'open') continue;
        visits.push({
            id: `absence_makeup_${r.docId}`,
            source: 'absence_makeup',
            sourceLabel: '결석보충',
            sourceColor: '#dc2626',
            studentId: r.student_id,
            name: r.student_name || r.student_id,
            time: r.makeup_time || '',
            detail: `${r.class_code || ''} (${_stripYear(r.absence_date)})`,
            status: r.makeup_status === '완료' ? 'completed' : 'pending',
            visitStatus: r.makeup_status === '완료' ? '완료' : (r.makeup_status === '미등원' ? '미등원' : ''),
            caller: '',
            completedBy: r.makeup_completed_by ? (r.makeup_completed_by.split('@')[0]) : '',
            completedAt: r.makeup_completed_at || '',
            docId: r.docId
        });
    }

    // 시간임박순 정렬
    visits.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    _scheduledVisitsCache = visits;
    return visits;
}

let _enrollPendingCache = null;
function getEnrollPendingVisits() {
    if (_enrollPendingCache) return _enrollPendingCache;
    const visits = [];
    for (const s of allStudents) {
        if (s.status !== '등원예정') continue;
        if (!matchesBranchFilter(s)) continue;
        const todaysEnrolls = (s.enrollments || []).filter(e => e.start_date === selectedDate);
        if (!todaysEnrolls.length) continue;
        visits.push({
            id: `enroll_${s.docId}`,
            source: 'enroll_pending',
            sourceLabel: '등원예정',
            sourceColor: '#059669',
            studentId: s.docId,
            name: s.name || s.docId,
            time: '',
            detail: todaysEnrolls.map(e => `${e.level_symbol || ''}${e.class_number || ''}`).filter(Boolean).join(', '),
            status: 'pending',
            caller: '',
            completedBy: '',
            completedAt: '',
            docId: s.docId
        });
    }
    _enrollPendingCache = visits;
    return visits;
}

// ─── Filtering ──────────────────────────────────────────────────────────────

function getFilteredStudents() {
    // 반 관리: 오늘 등원 예정 학생만 표시
    if (currentCategory === 'class_mgmt') {
        const dayName = getDayName(selectedDate);
        let students = allStudents.filter(s =>
            s.status !== '퇴원' && s.enrollments.some(e =>
                e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
            )
        );
        students = students.filter(s => matchesBranchFilter(s));
        if (searchQuery) {
            const q = searchQuery.trim().toLowerCase();
            const chosungMode = isChosungOnly(q);
            students = students.filter(s => {
                if (chosungMode) return matchChosung(s.name, q) || matchChosung(s.school, q);
                return (s.name?.toLowerCase().includes(q)) ||
                    (s.school?.toLowerCase().includes(q)) ||
                    (s.student_phone?.includes(q)) ||
                    (s.parent_phone_1?.includes(q)) ||
                    s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q)) ||
                    s.enrollments.some(e => { const t = classSettings[enrollmentCode(e)]?.teacher; return t && getTeacherName(t).toLowerCase().includes(q); });
            });
        }
        if (currentSubFilter.size > 0 && !currentSubFilter.has('all')) {
            students = students.filter(s =>
                s.enrollments.some(e =>
                    e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && currentSubFilter.has(enrollmentCode(e))
                )
            );
        }
        return students;
    }

    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        )
    );

    // 소속 글로벌 필터
    students = students.filter(s => matchesBranchFilter(s));

    // 반 글로벌 필터
    if (selectedClassCode) {
        students = students.filter(s =>
            s.enrollments.some(e =>
                e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === selectedClassCode
            )
        );
    }

    // 검색어 필터
    if (searchQuery) {
        const q = searchQuery.trim().toLowerCase();
        const chosungMode = isChosungOnly(q);
        students = students.filter(s => {
            if (chosungMode) return matchChosung(s.name, q) || matchChosung(s.school, q);
            return (s.name?.toLowerCase().includes(q)) ||
                (s.school?.toLowerCase().includes(q)) ||
                (s.student_phone?.includes(q)) ||
                (s.parent_phone_1?.includes(q)) ||
                s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q)) ||
                s.enrollments.some(e => { const t = classSettings[enrollmentCode(e)]?.teacher; return t && getTeacherName(t).toLowerCase().includes(q); });
        });
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
                if (f === 'pre_arrival' && (!st || st === '미확인')) return hasRegularEnrollmentToday(s);
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
                    if (f === 'hw_next') return true; // 반별 UI로 전환되므로 학생 필터링 스킵
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
            const timeA = getStudentStartTime(a.enrollments.find(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester))) || '99:99';
            const timeB = getStudentStartTime(b.enrollments.find(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester))) || '99:99';
            return timeA.localeCompare(timeB);
        });
    }

    // hw_fail / test_fail / extra_visit 등원일이 오늘인 학생 추가 포함 (정규 수업 없어도 리스트에 나타나야 함)
    // 단, 출결 필터 활성 시 비정규 학생은 추가하지 않음 (비정규 페이지에서만 표시)
    const attFilterActive = allFilters['attendance']?.size > 0;
    if (!attFilterActive) {
        const existingIds = new Set(students.map(s => s.docId));
        const visitStudents = allStudents.filter(s => {
            if (existingIds.has(s.docId)) return false;
            if (selectedClassCode && !s.enrollments.some(e => enrollmentCode(e) === selectedClassCode)) return false;
            return isVisitStudent(s.docId);
        });
        if (visitStudents.length > 0) {
            let filtered = visitStudents;
            if (searchQuery) {
                const q = searchQuery.trim().toLowerCase();
                const chosungMode = isChosungOnly(q);
                filtered = filtered.filter(s => {
                    if (chosungMode) return matchChosung(s.name, q) || matchChosung(s.school, q);
                    return (s.name?.toLowerCase().includes(q)) ||
                        (s.school?.toLowerCase().includes(q)) ||
                        s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q));
                });
            }
            students = [...students, ...filtered];
        }
    }

    return students;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatCompletedBadge(completedBy, completedAt) {
    if (!completedBy) return '';
    let timeStr = '';
    if (completedAt) {
        const d = new Date(completedAt);
        if (!isNaN(d)) timeStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `<span class="visit-caller-badge">(${esc(completedBy)}${timeStr ? ': ' + timeStr : ''} 확인)</span>`;
}

function renderScheduledVisitList() {
    let visits = getScheduledVisits();

    // L3 필터 적용
    const activeL3 = [...currentSubFilter].find(k => SV_SOURCE_MAP[k]);
    if (activeL3) {
        const sources = SV_SOURCE_MAP[activeL3];
        visits = visits.filter(v => sources.includes(v.source));
    }

    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    renderFilterChips();
    countEl.textContent = `${visits.length}건`;

    if (visits.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">event_available</span>
            <p>비정규 항목이 없습니다</p>
        </div>`;
        return;
    }

    // 등원전 / 소스별 그룹 / 확인완료 분리
    const isPreArrival = (v) => {
        if (!v.studentId) return true; // 비등록(진단평가 등)은 등원전 취급
        const st = dailyRecords[v.studentId]?.attendance?.status || '미확인';
        return st === '미확인';
    };
    const pendingVisits = visits.filter(v => v.status === 'pending');
    const completedVisits = visits.filter(v => v.status === 'completed');
    const preArrival = pendingVisits.filter(v => isPreArrival(v));
    const arrived = pendingVisits.filter(v => !isPreArrival(v));

    // 소스별 라벨
    const SOURCE_LABELS = {
        extra: '클리닉', temp: '진단평가',
        hw_fail: '숙제미통과', test_fail: '테스트미통과', absence_makeup: '결석보충'
    };
    // 소스별 그룹핑 (순서: 클리닉 → 진단평가 → 숙제미통과 → 테스트미통과 → 결석보충)
    const SOURCE_ORDER = ['extra', 'temp', 'hw_fail', 'test_fail', 'absence_makeup'];
    const arrivedBySource = {};
    for (const v of arrived) {
        if (!arrivedBySource[v.source]) arrivedBySource[v.source] = [];
        arrivedBySource[v.source].push(v);
    }

    const renderVisitItem = (v) => {
        const isCompleted = v.status === 'completed';
        const completedClass = isCompleted ? 'visit-completed' : '';
        const clickHandler = v.studentId
            ? `onclick="selectedStudentId='${escAttr(v.studentId)}'; renderStudentDetail('${escAttr(v.studentId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"`
            : (v.source === 'temp' ? `onclick="renderTempAttendanceDetail('${escAttr(v.docId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"` : '');
        const guestBadge = !v.studentId ? '<span class="visit-guest-badge">비등록</span>' : '';
        const callerBadge = v.caller ? `<span class="visit-caller-badge">(${esc(v.caller)})</span>` : '';
        const completedInfo = isCompleted ? formatCompletedBadge(v.completedBy, v.completedAt) : '';
        const dataId = v.studentId || v.id;

        // 시간 블록 + 출결 토글 (studentId가 있는 경우만)
        let timeHtml = '';
        let toggleHtml = '';
        const rec = v.studentId ? dailyRecords[v.studentId] : null;
        const arrivalTime = rec?.arrival_time;
        if (arrivalTime) {
            timeHtml = `<div class="item-time-block arrived">
                <span class="item-time-label">등원</span>
                <span class="item-time-value">${esc(formatTime12h(arrivalTime))}</span>
            </div>`;
        } else if (v.time) {
            timeHtml = `<div class="item-time-block">
                <span class="item-time-label">예정</span>
                <span class="item-time-value">${esc(formatTime12h(v.time))}</span>
            </div>`;
        }

        if (v.studentId) {
            const attStatus = rec?.attendance?.status || '미확인';
            const currentDisplay = attStatus === '미확인' ? '등원전' : attStatus;
            let activeClass = '';
            if (currentDisplay === '출석') activeClass = 'active-present';
            else if (currentDisplay === '지각') activeClass = 'active-late';
            else if (currentDisplay === '결석') activeClass = 'active-absent';
            else activeClass = 'active-other';
            toggleHtml = `<button class="toggle-btn ${activeClass}" style="min-width:48px;" onclick="event.stopPropagation(); cycleVisitAttendance('${escAttr(v.studentId)}')">${currentDisplay}</button>`;
        } else if (v.source === 'temp') {
            const ta = tempAttendances.find(t => t.docId === v.docId);
            const arrStatus = ta?.temp_arrival || '';
            const arrDisplay = arrStatus === '등원' ? '등원' : arrStatus === '미등원' ? '미등원' : '등원전';
            let activeClass = '';
            if (arrDisplay === '등원') activeClass = 'active-present';
            else if (arrDisplay === '미등원') activeClass = 'active-absent';
            else activeClass = 'active-other';
            toggleHtml = `<button class="toggle-btn ${activeClass}" style="min-width:48px;" onclick="event.stopPropagation(); cycleTempArrival('${escAttr(v.docId)}')">${arrDisplay}</button>`;
        }

        const confirmBtn = isCompleted
            ? `<button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;color:var(--text-sec);border-color:var(--border);" onclick="event.stopPropagation(); resetScheduledVisit('${escAttr(v.source)}', '${escAttr(v.docId)}', ${v.studentId ? `'${escAttr(v.studentId)}'` : 'null'})">초기화</button>`
            : (() => {
                const vs = v.visitStatus || '미완료';
                const { cls, sty } = _visitBtnStyles(vs);
                const sid = v.studentId ? `'${escAttr(v.studentId)}'` : 'null';
                return `<button class="toggle-btn ${cls}" data-visit-id="${escAttr(v.docId)}" style="${sty}" onclick="event.stopPropagation(); cycleVisitStatus('${escAttr(v.source)}', '${escAttr(v.docId)}', ${sid})">${esc(vs)}</button><button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;" onclick="event.stopPropagation(); confirmVisitStatus('${escAttr(v.docId)}')">확인</button>`;
            })();

        return `<div class="list-item visit-item ${completedClass}" data-id="${escAttr(dataId)}" ${clickHandler} style="${(v.studentId || v.source === 'temp') ? 'cursor:pointer;' : ''}">
            <div class="item-info">
                <span class="item-title">${esc(v.name)}</span>
                <span class="item-desc"><span class="visit-source-badge" style="background:${v.sourceColor};">${esc(v.sourceLabel)}</span> ${guestBadge}</span>
            </div>
            ${timeHtml}
            ${toggleHtml}
            <div class="item-actions">
                <span style="font-size:12px;color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${callerBadge ? callerBadge + ' ' : ''}${esc(v.detail)}${completedInfo ? ' ' + completedInfo : ''}</span>
            </div>
            ${confirmBtn}
        </div>`;
    };

    let html = '';
    // 1) 등원전: 시간임박순
    if (preArrival.length > 0) {
        html += preArrival.map(renderVisitItem).join('');
    }
    // 2) 소스별 그룹
    for (const src of SOURCE_ORDER) {
        const group = arrivedBySource[src];
        if (!group || group.length === 0) continue;
        html += `<div class="leave-section-divider"><span>${SOURCE_LABELS[src] || src} (${group.length}건)</span></div>`;
        html += group.map(renderVisitItem).join('');
    }
    // 3) 확인 완료
    if (completedVisits.length > 0) {
        html += `<div class="leave-section-divider"><span>확인 완료 (${completedVisits.length}건)</span></div>`;
        html += completedVisits.map(renderVisitItem).join('');
    }
    container.innerHTML = html;
}

function renderEnrollPendingItem(v) {
    const clickHandler = `onclick="selectedStudentId='${escAttr(v.studentId)}'; renderStudentDetail('${escAttr(v.studentId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"`;
    return `<div class="list-item visit-item" data-id="${escAttr(v.studentId)}" ${clickHandler} style="cursor:pointer;">
        <div class="item-info">
            <span class="item-title">${esc(v.name)}</span>
            <span class="item-desc"><span class="visit-source-badge" style="background:${v.sourceColor};">${esc(v.sourceLabel)}</span> ${esc(v.detail)}</span>
        </div>
    </div>`;
}

function renderEnrollPendingSection() {
    const visits = getEnrollPendingVisits();
    if (visits.length === 0) return '';
    let html = `<div class="leave-section-divider"><span>등원예정 (${visits.length}건)</span></div>`;
    html += visits.map(renderEnrollPendingItem).join('');
    return html;
}

function renderEnrollPendingOnly() {
    const visits = getEnrollPendingVisits();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    renderFilterChips();
    countEl.textContent = `${visits.length}건`;

    if (visits.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">event_available</span>
            <p>등원예정 학생이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = visits.map(renderEnrollPendingItem).join('');
}

function renderDepartureCheckList() {
    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        )
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (selectedClassCode) students = students.filter(s => s.enrollments.some(e =>
        e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === selectedClassCode
    ));
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        students = students.filter(s =>
            s.name?.toLowerCase().includes(q) ||
            s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q))
        );
    }

    // 정렬: 미귀가 먼저, 그 안에서 진행률 높은순
    students.sort((a, b) => {
        const depA = dailyRecords[a.docId]?.departure?.status === '귀가' ? 1 : 0;
        const depB = dailyRecords[b.docId]?.departure?.status === '귀가' ? 1 : 0;
        if (depA !== depB) return depA - depB;
        const checkA = getStudentChecklistStatus(a.docId);
        const checkB = getStudentChecklistStatus(b.docId);
        const pctA = checkA.filter(i => i.done).length / (checkA.length || 1);
        const pctB = checkB.filter(i => i.done).length / (checkB.length || 1);
        return pctB - pctA; // 진행률 높은순
    });

    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();
    countEl.textContent = `${students.length}명`;

    if (students.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">fact_check</span>
            <p>해당하는 학생이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = students.map(s => {
        const items = getStudentChecklistStatus(s.docId);
        const doneCount = items.filter(i => i.done).length;
        const total = items.length;
        const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
        const isDeparted = dailyRecords[s.docId]?.departure?.status === '귀가';
        const isActive = s.docId === selectedStudentId ? 'active' : '';

        let statusTag = '';
        if (isDeparted) {
            statusTag = '<span class="departure-status-tag departed">귀가</span>';
        } else if (doneCount > 0) {
            statusTag = '<span class="departure-status-tag in-progress">진행중</span>';
        } else {
            statusTag = '<span class="departure-status-tag not-started">대기</span>';
        }

        return `<div class="list-item departure-list-item ${isActive}" data-id="${s.docId}"
            onclick="selectedStudentId='${escAttr(s.docId)}'; renderStudentDetail('${escAttr(s.docId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"
            style="cursor:pointer;${isDeparted ? 'opacity:0.5;' : ''}">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                <span style="font-weight:500;min-width:56px;">${esc(s.name)}</span>
                ${statusTag}
                <span style="font-size:11px;color:var(--text-sec);">${doneCount}/${total}</span>
            </div>
            <div class="departure-list-progress" style="width:60px;">
                <div class="departure-list-progress-fill ${pct === 100 ? 'complete' : ''}" style="width:${pct}%"></div>
            </div>
        </div>`;
    }).join('');
}

// ─── 결석대장 리스트 뷰 ─────────────────────────────────────────────────────

function _renderValidityBadge(reasonValid) {
    if (!reasonValid) return '';
    const cls = reasonValid === '정당' ? 'valid' : 'invalid';
    return `<span class="absence-validity-badge ${cls}">${esc(reasonValid)}</span>`;
}

function _getAbsenceStatusGroup(r) {
    if (!r.consultation_done) return { order: 0, label: '미상담', badgeClass: 'unconsulted' };
    if (r.resolution === 'pending') return { order: 1, label: '처리 미결정', badgeClass: 'undecided' };
    if (r.resolution === '보충') {
        if (r.makeup_status === '미등원') return { order: 3, label: '보충 미등원', badgeClass: 'noshow' };
        if (r.makeup_status === '완료') return { order: 4, label: '보충 완료', badgeClass: 'completed' };
        return { order: 2, label: '보충 예정', badgeClass: 'makeup' };
    }
    if (r.resolution === '정산') return { order: 5, label: '정산 대기', badgeClass: 'settlement' };
    return { order: 6, label: '기타', badgeClass: 'undecided' };
}

function renderAbsenceLedgerList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    let records = absenceRecords.filter(r => r.absence_date === selectedDate);
    if (selectedBranch) records = records.filter(r => r.branch === selectedBranch);

    countEl.textContent = `${records.length}건`;

    if (records.length === 0) {
        container.innerHTML = '<div class="empty-state">열린 결석 기록이 없습니다.</div>';
        return;
    }

    // 상태별 그룹 정렬
    records.sort((a, b) => {
        const ga = _getAbsenceStatusGroup(a);
        const gb = _getAbsenceStatusGroup(b);
        if (ga.order !== gb.order) return ga.order - gb.order;
        return (b.absence_date || '').localeCompare(a.absence_date || '');
    });

    let currentGroup = -1;
    let html = '';
    for (const r of records) {
        const group = _getAbsenceStatusGroup(r);
        if (group.order !== currentGroup) {
            currentGroup = group.order;
            html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(group.label)}</div>`;
        }
        const isActive = r.student_id === selectedStudentId;
        const validityBadge = _renderValidityBadge(r.reason_valid);
        const consultBtn = r.consultation_done
            ? '<span class="material-symbols-outlined" style="font-size:14px;color:var(--success);">check_circle</span>'
            : `<button class="btn-icon" style="padding:2px;" onclick="event.stopPropagation(); toggleConsultation('${escAttr(r.docId)}', '${escAttr(r.student_id)}')" title="상담 완료 처리"><span class="material-symbols-outlined" style="font-size:14px;color:var(--text-sec);">phone_callback</span></button>`;

        const _createdBy = getTeacherName(r.created_by);
        const metaStr = _createdBy ? ` · ${_createdBy} ${_fmtTs(r.created_at)}` : '';

        html += `<div class="list-item ${isActive ? 'active' : ''}" data-id="${escAttr(r.student_id)}"
            onclick="selectedStudentId='${escAttr(r.student_id)}'; renderStudentDetail('${escAttr(r.student_id)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');">
            <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                ${consultBtn}
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:center;gap:4px;">
                        <span style="font-weight:600;font-size:13px;">${esc(r.student_name)}</span>
                        <span class="absence-status-badge ${group.badgeClass}">${esc(group.label)}</span>
                        ${validityBadge}
                    </div>
                    <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                        ${esc(r.class_code || '')} · ${esc(_stripYear(r.absence_date))}${r.reason ? ' · ' + esc(r.reason) : ''}${metaStr}
                    </div>
                </div>
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

// ─── 휴퇴원요청서 리스트 ─────────────────────────────────────────────────────

function _leaveRequestTypeBadge(r) {
    const typeMap = {
        '휴원요청': { label: '휴원', color: '#2563eb' },
        '휴원연장': { label: '연장', color: '#0891b2' },
        '퇴원요청': { label: '퇴원', color: '#dc2626' },
        '휴원→퇴원': { label: '휴→퇴', color: '#dc2626' },
        '퇴원→휴원': { label: '퇴→휴', color: '#7c3aed' }
    };
    const t = typeMap[r.request_type] || { label: r.request_type, color: '#666' };
    let badge = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${t.color};">${esc(t.label)}</span>`;
    if (r.leave_sub_type) {
        badge += `<span style="font-size:11px;color:var(--text-sec);margin-left:2px;">${esc(r.leave_sub_type)}</span>`;
    }
    return badge;
}

function _leaveTypeBadgeOrFallback(lr, statusText) {
    return lr ? _leaveRequestTypeBadge(lr) : `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:#6b7280;">${esc(statusText)}</span>`;
}

function _leaveRequestStatusBadge(status) {
    const map = {
        'requested': { label: '대기', cls: 'absence-status-badge unconsulted' },
        'approved': { label: '승인', cls: 'absence-status-badge completed' },
        'rejected': { label: '반려', cls: 'absence-status-badge noshow' },
        'cancelled': { label: '취소', cls: 'absence-status-badge undecided' }
    };
    const m = map[status] || { label: status, cls: '' };
    return `<span class="${m.cls}">${esc(m.label)}</span>`;
}

let _selectedLeaveRequestId = null;

function _leaveRequestDate(r) {
    if (!r.requested_at) return '';
    const d = r.requested_at.toDate ? r.requested_at.toDate() : new Date(r.requested_at);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function renderLeaveRequestList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    let records = leaveRequests.filter(r => _leaveRequestDate(r) === selectedDate);
    if (selectedBranch) records = records.filter(r => r.branch === selectedBranch);
    countEl.textContent = `${records.length}건`;

    // 새 요청 버튼
    let html = `<div style="padding:8px 12px;">
        <button class="lr-btn lr-btn-tonal" style="width:100%;" onclick="openLeaveRequestModal()">
            <span class="material-symbols-outlined">add</span> 새 요청
        </button>
    </div>`;

    if (records.length === 0) {
        html += '<div class="empty-state">휴퇴원 요청이 없습니다.</div>';
        container.innerHTML = html;
        return;
    }

    // 그룹: 승인 대기 → 승인 완료
    const pending = records.filter(r => r.status === 'requested');
    const approved = records.filter(r => r.status === 'approved');

    const groups = [
        { label: '승인 대기', items: pending },
        { label: '승인 완료', items: approved }
    ];

    for (const g of groups) {
        if (g.items.length === 0) continue;
        html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(g.label)} (${g.items.length})</div>`;
        for (const r of g.items) {
            const isActive = r.student_id === selectedStudentId && r.docId === _selectedLeaveRequestId;
            const classCodes = (r.class_codes || []).join(', ');
            const _by = getTeacherName(r.requested_by);
            const tsStr = _fmtTs(r.requested_at);

            html += `<div class="list-item ${isActive ? 'active' : ''}" data-id="${escAttr(r.docId)}"
                onclick="selectLeaveRequest('${escAttr(r.docId)}')">
                <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <span style="font-weight:600;font-size:13px;">${esc(r.student_name)}</span>
                            ${_leaveRequestTypeBadge(r)}
                            ${_leaveRequestStatusBadge(r.status)}
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                            ${esc(classCodes)}${_by ? ' · ' + esc(_by) : ''} · ${esc(tsStr)}
                        </div>
                    </div>
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
}

function selectLeaveRequest(docId) {
    _selectedLeaveRequestId = docId;
    const r = leaveRequests.find(lr => lr.docId === docId);
    if (r) {
        selectedStudentId = r.student_id;
        renderLeaveRequestList();
        renderStudentDetail(r.student_id);
    }
}

// ─── 복귀예정 리스트 ──────────────────────────────────────────────────────

let _returnUpcomingCache = null;
function _getReturnUpcomingStudents() {
    if (_returnUpcomingCache) return _returnUpcomingCache;
    const now = new Date(); now.setHours(0,0,0,0);
    const approvedByStudent = new Map();
    for (const r of leaveRequests) {
        if (r.status === 'approved') approvedByStudent.set(r.student_id, r);
    }
    const results = [];
    for (const s of allStudents) {
        if (!LEAVE_STATUSES.includes(s.status) || !s.pause_end_date) continue;
        if (selectedBranch && s.branch !== selectedBranch) continue;
        const end = new Date(s.pause_end_date); end.setHours(0,0,0,0);
        const daysLeft = Math.ceil((end - now) / 86400000);
        if (daysLeft < 0 || daysLeft > 14) continue;
        results.push({ student: s, daysLeft, leaveRequest: approvedByStudent.get(s.docId) || null });
    }
    results.sort((a, b) => a.daysLeft - b.daysLeft);
    _returnUpcomingCache = results;
    return results;
}

function renderReturnUpcomingList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();

    const items = _getReturnUpcomingStudents();
    countEl.textContent = `${items.length}건`;

    if (items.length === 0) {
        container.innerHTML = '<div class="empty-state">2주 이내 복귀예정 학생이 없습니다.</div>';
        return;
    }

    const urgent = items.filter(x => x.daysLeft <= 7);
    const soon = items.filter(x => x.daysLeft > 7);

    const groups = [
        { label: '1주일 이내 복귀예정', items: urgent, ddayCls: 'urgent' },
        { label: '2주일 이내 복귀예정', items: soon, ddayCls: 'soon' }
    ];

    let html = '';
    for (const g of groups) {
        if (g.items.length === 0) continue;
        html += `<div class="visit-source-header" style="margin-top:8px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--text-sec);">${esc(g.label)} (${g.items.length})</div>`;
        for (const { student: s, daysLeft, leaveRequest: lr } of g.items) {
            const isActive = s.docId === selectedStudentId;
            const codes = allClassCodes(s).join(', ');
            const ddayLabel = daysLeft === 0 ? 'D-Day' : `D-${daysLeft}`;
            const typeBadge = _leaveTypeBadgeOrFallback(lr, s.status);
            const consultDone = s.return_consult_done;
            const consultIcon = `<span class="return-consult-icon material-symbols-outlined" title="복귀상담" style="color:${consultDone ? '#22c55e' : '#f59e0b'};" onclick="event.stopPropagation();toggleReturnConsult('${escAttr(s.docId)}')">${consultDone ? 'check_circle' : 'phone_in_talk'}</span>`;

            html += `<div class="list-item ${isActive ? 'active' : ''}" data-id="${escAttr(s.docId)}"
                onclick="selectReturnUpcomingStudent('${escAttr(s.docId)}')">
                <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <span style="font-weight:600;font-size:13px;">${esc(s.name)}</span>
                            ${typeBadge}
                            <span class="return-dday ${g.ddayCls}">${ddayLabel}</span>
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:2px;">
                            ${esc(codes)}${s.pause_end_date ? ' · 복귀 ' + esc(s.pause_end_date) : ''}
                        </div>
                    </div>
                    ${consultIcon}
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
}

function selectReturnUpcomingStudent(studentId) {
    selectedStudentId = studentId;
    renderReturnUpcomingList();
    renderStudentDetail(studentId);
}

function renderListPanel() {
    // 비정규 L2 또는 L3(sv_*) 서브필터 활성 시 통합 리스트로 전환
    if (currentCategory === 'attendance' && (
        currentSubFilter.has('scheduled_visit') ||
        SV_L3_KEYS.some(k => currentSubFilter.has(k))
    )) {
        renderScheduledVisitList();
        return;
    }

    // 등원예정 L3 선택 시 등원예정만 표시
    if (currentCategory === 'attendance' && currentSubFilter.has('enroll_pending')) {
        renderEnrollPendingOnly();
        return;
    }

    // 귀가점검 서브필터 활성 시 귀가 체크 리스트로 전환
    if (currentCategory === 'attendance' && currentSubFilter.has('departure_check')) {
        renderDepartureCheckList();
        return;
    }

    // 결석대장 서브필터 활성 시 결석대장 리스트로 전환
    if (currentCategory === 'admin' && currentSubFilter.has('absence_ledger')) {
        renderAbsenceLedgerList();
        return;
    }

    // 휴퇴원요청서 서브필터 활성 시 요청서 리스트로 전환
    if (currentCategory === 'admin' && currentSubFilter.has('leave_request')) {
        renderLeaveRequestList();
        return;
    }

    // 복귀예정 서브필터 활성 시 복귀예정 리스트로 전환
    if (currentCategory === 'admin' && currentSubFilter.has('return_upcoming')) {
        renderReturnUpcomingList();
        return;
    }

    // hw_next 서브필터 활성 시 반별 리스트로 전환
    if (currentCategory === 'homework' && currentSubFilter.has('hw_next')) {
        renderNextHwClassList();
        return;
    }

    const students = getFilteredStudents();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    const todayDate = new Date(todayStr());
    // 필터 칩 렌더링
    renderFilterChips();

    // contacts 검색 (검색어가 있을 때만)
    let contactResults = [];
    if (searchQuery) {
        const q = searchQuery.trim().toLowerCase();
        const chosungMode = isChosungOnly(q);
        const studentIdSet = new Set(allStudents.map(s => s.docId));
        contactResults = allContacts.filter(c => {
            if (studentIdSet.has(c.id)) return false;
            if (chosungMode) return matchChosung(c.name, q) || matchChosung(c.school, q);
            return (c.name && c.name.toLowerCase().includes(q)) ||
                (c.school && c.school.toLowerCase().includes(q)) ||
                (c.student_phone && c.student_phone.includes(q)) ||
                (c.parent_phone_1 && c.parent_phone_1.includes(q));
        }).slice(0, 50);
    }

    // 벌크 모드: 현재 목록에 없는 학생 선택 해제, 0명이면 벌크모드 종료
    if (bulkMode) {
        const visibleIds = new Set(students.map(s => s.docId));
        for (const id of [...selectedStudentIds]) {
            if (!visibleIds.has(id)) selectedStudentIds.delete(id);
        }
        if (selectedStudentIds.size === 0) {
            exitBulkMode();
        } else {
            updateBulkBar();
        }
    }

    // 정규(pre_arrival) L2 활성 시 등원예정 인원도 카운트에 포함
    const enrollPendingCount = (currentCategory === 'attendance' && currentSubFilter.has('pre_arrival'))
        ? getEnrollPendingVisits().length : 0;
    countEl.textContent = `${students.length + enrollPendingCount}명`;

    if (students.length === 0 && contactResults.length === 0 && enrollPendingCount === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">person_search</span>
            <p>해당하는 학생이 없습니다</p>
        </div>`;
        return;
    }

    // 후속대책 버튼 표시 조건 — 한 번만 계산
    const isHw1stFilter = currentCategory === 'homework' && currentSubFilter.has('hw_1st');
    const isTest1stFilter = currentCategory === 'test' && currentSubFilter.has('test_1st');

    const renderItemHtml = (s) => {
        const isActive = s.docId === selectedStudentId ? 'active' : '';
        const dayN = getDayName(selectedDate);
        const code = (s.enrollments || []).filter(e => e.day.includes(dayN) && (!selectedSemester || e.semester === selectedSemester)).map(e => enrollmentCode(e)).join(', ') || (s.enrollments || []).map(e => enrollmentCode(e)).join(', ');
        const branch = branchFromStudent(s);

        let toggleHtml = '';
        const isLeave = LEAVE_STATUSES.includes(s.status);

        if (isLeave) {
            // 휴원 학생은 모든 카테고리에서 입력 버튼 숨김
            toggleHtml = '';
        } else if (currentCategory === 'attendance') {
            const rec = dailyRecords[s.docId];
            const attStatus = rec?.attendance?.status || '미확인';
            const statuses = ['정규', '출석', '지각', '결석', '조퇴', '기타'];
            // 미확인 maps to 정규 for display
            const currentDisplay = attStatus === '미확인' ? '정규' : attStatus;
            toggleHtml = `<div class="toggle-group">` +
                statuses.map(st => {
                    let activeClass = '';
                    if (st === currentDisplay) {
                        if (st === '출석') activeClass = 'active-present';
                        else if (st === '결석') activeClass = 'active-absent';
                        else if (st === '지각') activeClass = 'active-late';
                        else activeClass = 'active-other';
                    }
                    return `<button class="toggle-btn ${activeClass}" onclick="event.stopPropagation(); toggleAttendance('${escAttr(s.docId)}', '${st}')">${st}</button>`;
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
                            <button class="hw-domain-ox ${cls}" data-student="${escAttr(s.docId)}" data-field="${field}" data-domain="${escAttr(d)}"
                                onclick="event.stopPropagation(); toggleHwDomainOX('${escAttr(s.docId)}', '${field}', '${escAttr(d)}')">${esc(val || '—')}</button>
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
                                return `<button class="toggle-btn ${activeClass}" onclick="event.stopPropagation(); toggleHomework('${escAttr(s.docId)}', ${i}, '${st}')">${st}</button>`;
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
                                <button class="hw-domain-ox ${cls}" data-student="${escAttr(s.docId)}" data-field="${field}" data-domain="${escAttr(t)}"
                                    onclick="event.stopPropagation(); toggleHwDomainOX('${escAttr(s.docId)}', '${field}', '${escAttr(t)}')">${esc(val || '—')}</button>
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
                const time = getStudentStartTime(e) ? formatTime12h(getStudentStartTime(e)) : '';
                return `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:var(--text-sec);">${esc(enrollmentCode(e))} ${days} ${time}</span>
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openEnrollmentModal('${escAttr(s.docId)}', ${idx})">편집</button>
                </div>`;
            }).join('');
        }

        // 등원시간 (휴원 학생은 미표시)
        let timeHtml = '';
        const rec = dailyRecords[s.docId];
        const dayName = getDayName(selectedDate);
        const todayEnroll = s.enrollments.find(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester));
        if (!isLeave) {
            const arrivalTime = rec?.arrival_time;
            const scheduledTime = getStudentStartTime(todayEnroll);

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
            timeHtml = [
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
        }

        // hw_fail_tasks 기반 아이콘 (대체숙제/등원예약) - pending 상태만
        const pendingTasks = hwFailTasks.filter(t => t.student_id === s.docId && t.status === 'pending');
        const hasAltHw = pendingTasks.some(t => t.type === '대체숙제');
        const hasVisit = pendingTasks.some(t => t.type === '등원');
        const hwFailIconHtml = hasAltHw
            ? `<span class="hw-fail-badge hw-fail-alt" title="대체숙제 있음"><span class="material-symbols-outlined" style="font-size:14px;">edit_note</span></span>`
            : hasVisit
            ? `<span class="hw-fail-badge hw-fail-visit" title="등원 예약 있음"><span class="material-symbols-outlined" style="font-size:14px;">directions_walk</span></span>`
            : '';

        // 형제 아이콘
        const hasSibling = siblingMap[s.docId]?.size > 0;
        const siblingNames = hasSibling ? [...siblingMap[s.docId]].map(sid => allStudents.find(x => x.docId === sid)?.name).filter(Boolean).join(', ') : '';
        const siblingIcon = hasSibling ? `<span class="item-icon item-icon-sibling" title="형제: ${esc(siblingNames)}"><span class="material-symbols-outlined">group</span></span>` : '';

        // 담당 뱃지 (첫 번째 반코드 기준)
        const todayCodes = (s.enrollments || []).filter(e => e.day.includes(dayN) && (!selectedSemester || e.semester === selectedSemester)).map(e => enrollmentCode(e));
        const primaryCode = todayCodes[0] || allClassCodes(s)[0] || '';
        const teacherEmail = classSettings[primaryCode]?.teacher;
        const teacherBadge = teacherEmail ? `<span class="teacher-badge" title="담당: ${esc(getTeacherName(teacherEmail))}">${esc(getTeacherName(teacherEmail))}</span>` : '';

        const leaveBadge = LEAVE_STATUSES.includes(s.status)
            ? `<span class="tag tag-leave">${esc(s.status)}</span>` : '';

        // 신규 학생 뱃지 (enrollment start_date가 14일 이내)
        const newBadge = isNewStudent(s, todayDate) ? '<span class="tag tag-new">N</span>' : '';

        // 후속대책 버튼: 1차 서브필터에서 미통과(X/△) 영역이 있으면 표시
        let followUpBtnHtml = '';
        if (!isLeave && (isHw1stFilter || isTest1stFilter)) {
            const rec = dailyRecords[s.docId] || {};
            const field = isHw1stFilter ? 'hw_domains_1st' : 'test_domains_1st';
            const category = isHw1stFilter ? 'homework' : 'test';
            const hasFail1st = Object.values(rec[field] || {}).some(v => v && v !== 'O');
            if (hasFail1st) {
                followUpBtnHtml = `<button class="follow-up-btn" title="후속대책" onclick="event.stopPropagation(); openFollowUpAction('${escAttr(s.docId)}', '${category}')"><span class="material-symbols-outlined" style="font-size:16px;">assignment_late</span></button>`;
            }
        }

        return `<div class="list-item ${isActive}${bulkMode ? ' bulk-mode' : ''}${selectedStudentIds.has(s.docId) ? ' bulk-selected' : ''}" data-id="${escAttr(s.docId)}" onclick="handleListItemClick(event, '${escAttr(s.docId)}')">
            <input type="checkbox" class="list-item-checkbox" ${selectedStudentIds.has(s.docId) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(s.docId)}', this.checked)">
            <div class="item-info">
                <span class="item-title">${esc(s.name)}${newBadge}${leaveBadge}${siblingIcon}${hwFailIconHtml} ${teacherBadge}</span>
                <span class="item-desc">${esc(code)}${todayEnroll?.class_type ? ' · ' + esc(todayEnroll.class_type) : ''}${studentShortLabel(s) ? ' · ' + esc(studentShortLabel(s)) : ''}</span>
            </div>
            ${timeHtml}
            <div class="item-actions">${toggleHtml}</div>
            ${followUpBtnHtml}
        </div>`;
    };

    // 휴원 학생 분리
    const activeStudents = students.filter(s => !LEAVE_STATUSES.includes(s.status));
    const leaveStudents = students.filter(s => LEAVE_STATUSES.includes(s.status));

    // 정규/비정규 분리 조건: attendance 카테고리이고 출석/지각/결석/기타 서브필터 활성 시
    const shouldSplitRegular = currentCategory === 'attendance' &&
        currentSubFilter.size > 0 &&
        !currentSubFilter.has('all') &&
        !currentSubFilter.has('pre_arrival') &&
        !currentSubFilter.has('enroll_pending') &&
        !currentSubFilter.has('scheduled_visit') &&
        !currentSubFilter.has('departure_check') &&
        !SV_L3_KEYS.some(k => currentSubFilter.has(k));

    // 정규/비정규 분리 (single-pass)
    let regularActive, irregularActive;
    if (shouldSplitRegular) {
        regularActive = [];
        irregularActive = [];
        for (const s of activeStudents) {
            (hasRegularEnrollmentToday(s) ? regularActive : irregularActive).push(s);
        }
    } else {
        regularActive = activeStudents;
        irregularActive = [];
    }

    const appendIrregularAndLeave = (html) => {
        if (irregularActive.length > 0) {
            html += `<div class="leave-section-divider"><span>비정규 (${irregularActive.length}명)</span></div>`;
            html += irregularActive.map(renderItemHtml).join('');
        }
        if (leaveStudents.length > 0) {
            html += `<div class="leave-section-divider"><span>휴원 학생 (${leaveStudents.length}명)</span></div>`;
            html += leaveStudents.map(renderItemHtml).join('');
        }
        return html;
    };

    // 정규(pre_arrival) L2 선택 시 등원예정 섹션 상단 삽입
    const enrollPendingHtml = (currentCategory === 'attendance' && currentSubFilter.has('pre_arrival'))
        ? renderEnrollPendingSection() : '';

    // 그룹 뷰 or 일반 렌더링
    if (groupViewMode !== 'none') {
        const groups = {};
        regularActive.forEach(s => {
            if (groupViewMode === 'branch') {
                const key = branchFromStudent(s) || '미지정';
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            } else {
                const codes = allClassCodes(s);
                const key = codes.length ? codes[0] : '미지정';
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            }
        });
        const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));
        let html = enrollPendingHtml + sortedKeys.map(key => {
            const headerHtml = `<div class="group-header"><span class="group-label">${esc(key)}</span><span class="group-count">${groups[key].length}명</span></div>`;
            return headerHtml + groups[key].map(renderItemHtml).join('');
        }).join('');
        container.innerHTML = appendIrregularAndLeave(html);
    } else {
        let html = enrollPendingHtml + regularActive.map(renderItemHtml).join('');
        container.innerHTML = appendIrregularAndLeave(html);
    }

    // 과거 연락처 결과 표시 (검색 시)
    if (contactResults.length > 0) {
        let contactHtml = `<div class="leave-section-divider"><span>과거 연락처 (${contactResults.length}명)</span></div>`;
        contactResults.forEach(c => {
            const phone = c.parent_phone_1 || c.student_phone || '';
            const last4 = phone.replace(/\D/g, '').slice(-4);
            const schoolGrade = [c.school || '', c.grade ? c.grade + '학년' : ''].filter(Boolean).join(' ');
            const sub = [schoolGrade, last4 ? `☎${last4}` : ''].filter(Boolean).join(' · ');
            contactHtml += `<div class="list-item contact-item" style="cursor:pointer" onclick="window.openContactAsTemp('${escAttr(c.id)}')">
                <div class="item-info">
                    <span class="item-title">${esc(c.name || '—')} <span class="tag-past">과거</span></span>
                    <span class="item-desc">${esc(sub || '—')}</span>
                </div>
            </div>`;
        });
        container.insertAdjacentHTML('beforeend', contactHtml);
    }

    // 반 상세 표시: 반(+소속)만 선택되고, 콘텐츠 서브필터 없을 때
    const allFilters = { ...savedSubFilters };
    allFilters[currentCategory] = new Set(currentSubFilter);
    const hasContentFilter = ['attendance', 'homework', 'test', 'automation', 'admin'].some(cat => allFilters[cat]?.size > 0);
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
        s.enrollments.some(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === classCode)
    );
    classStudents = classStudents.filter(s => matchesBranchFilter(s));
    const domains = getClassDomains(classCode);
    const testSections = getClassTestSections(classCode);

    // 프로필 헤더를 반 정보로 교체 (학생 상세에서 남은 데이터 클리어)
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
    document.getElementById('profile-phones').innerHTML = '';
    document.getElementById('profile-stay-stats').innerHTML = '';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">${classStudents.length}명</span>
    `;

    const cardsContainer = document.getElementById('detail-cards');

    // ① 등원예정시간 — 반 기본 시간만 설정 (학생별 개별시간은 학생 상세패널에서)
    const defaultTime = classSettings[classCode]?.default_time || '';

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

    // ④ 담당/부담당 배정
    const currentTeacher = classSettings[classCode]?.teacher || '';
    const currentSubTeacher = classSettings[classCode]?.sub_teacher || '';
    const teacherOptions = teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${t.email === currentTeacher ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
    const subTeacherOptions = teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${t.email === currentSubTeacher ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');

    cardsContainer.innerHTML = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">person</span>
                담당 배정
            </div>
            <div class="teacher-assign-grid">
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label">담당</label>
                    <select class="field-input teacher-assign-select" id="teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${teacherOptions}
                    </select>
                </div>
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label">부담당</label>
                    <select class="field-input teacher-assign-select" id="sub-teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${subTeacherOptions}
                    </select>
                </div>
            </div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">schedule</span>
                등원예정시간
            </div>
            <div class="arrival-bulk-row">
                <input type="time" class="arrival-time-input" value="${defaultTime}"
                    onchange="saveClassDefaultTime('${escAttr(classCode)}', this.value)">
            </div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:4px;">변경 시 자동 저장</div>
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

    `;

    // 모바일에서 디테일 패널 표시
    if (window.innerWidth <= 768) {
        document.getElementById('detail-panel').classList.add('mobile-visible');
    }
}

// ─── Class Detail 핸들러 ────────────────────────────────────────────────────

async function saveTeacherAssign(classCode) {
    const teacher = document.getElementById('teacher-select')?.value || '';
    const subTeacher = document.getElementById('sub-teacher-select')?.value || '';
    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { teacher, sub_teacher: subTeacher });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('담당 저장 실패:', err);
        showSaveIndicator('error');
    }
}
window.saveTeacherAssign = saveTeacherAssign;

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
    const input = document.querySelector(`input[data-test-section="${CSS.escape(sectionName)}"]`);
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

async function saveClassDefaultTime(classCode, time) {
    if (!time) return;
    showSaveIndicator('saving');
    try {
        await saveClassSettings(classCode, { default_time: time });
        showSaveIndicator('saved');
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
    } catch (err) {
        console.error('반 기본 시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── HW Fail Action Card ────────────────────────────────────────────────────
// 2차 숙제 미통과 영역을 자동 감지하여 '등원' 또는 '대체숙제' 처리 입력 카드를 렌더링

function renderHwFailActionCard(studentId, domains, d2nd, hwFailAction, mode = 'default') {
    const rec = dailyRecords[studentId] || {};
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

    const descLabel = is1stOnly
        ? '1차 미통과 영역에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.'
        : '2차 미통과 영역에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.';

    const rows = failDomains.map(domain => {
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
                ${is1stOnly ? '후속대책' : '숙제 미통과'} (${failDomains.length}개 영역)
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                ${descLabel}
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
        // 1) 서버 확인이 필요한 항목들을 병렬로 읽기
        const hwTaskEntries = Object.entries(hwFailAction).filter(([, action]) => action.type);
        const hwTaskChecks = await Promise.all(hwTaskEntries.map(async ([domain, action]) => {
            const taskDocId = `${studentId}_${domain}_${selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = hwFailTasks.find(t => t.docId === taskDocId);
            if (existing && existing.status !== 'pending') return null; // 스킵
            let serverSnap = null;
            if (!existing) {
                serverSnap = await getDoc(doc(db, 'hw_fail_tasks', taskDocId));
                if (serverSnap.exists() && serverSnap.data().status !== 'pending') return null; // 스킵
            }
            return { domain, action, taskDocId, existing };
        }));

        // 2) 쓰기를 배치로 모아서 커밋
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
                source_date: selectedDate,
                scheduled_date: action.scheduled_date || '',
                scheduled_time: action.scheduled_time || '',
                alt_hw: action.alt_hw || '',
                handler: (action.handler || currentUser?.email || '').split('@')[0],
                status: 'pending',
                created_by: (currentUser?.email || '').split('@')[0],
                created_at: existing?.created_at || new Date().toISOString(),
                branch: branchFromStudent(student || {}),
            };
            hwWriteBatch.set(doc(db, 'hw_fail_tasks', taskDocId), taskData, { merge: true });
            hwWriteCount++;
            // 로컬 캐시 갱신
            const idx = hwFailTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                hwFailTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                hwFailTasks.push({ docId: taskDocId, ...taskData });
            }
        }
        if (hwWriteCount > 0) await hwWriteBatch.commit();

        // 삭제된 domain의 pending tasks: 타입 제거 시 hw_fail_tasks에서도 상태 업데이트
        const hwCancelTargets = hwFailTasks.filter(t => t.student_id === studentId && t.source_date === selectedDate && t.status === 'pending' && (!hwFailAction[t.domain] || !hwFailAction[t.domain].type));
        if (hwCancelTargets.length > 0) {
            const cancelBatch = writeBatch(db);
            for (const t of hwCancelTargets) {
                cancelBatch.update(doc(db, 'hw_fail_tasks', t.docId), {
                    status: '취소',
                    cancelled_by: (currentUser?.email || '').split('@')[0],
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

// ─── 밀린 Task 카드 렌더링 ───────────────────────────────────────────────────

function _stripYear(dateStr) {
    if (!dateStr) return '';
    return dateStr.replace(/^\d{4}-/, '');
}

function _fmtTs(ts, includeTime = false) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const base = `${d.getMonth()+1}/${d.getDate()}`;
    return includeTime
        ? `${base} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
        : base;
}

function _isNoShow(t) {
    return t.type === '등원' && t.status === 'pending'
        && t.scheduled_date && t.scheduled_date < selectedDate;
}

function _renderRescheduleHistory(history) {
    if (!history || !Array.isArray(history) || history.length === 0) return '';
    const sorted = [...history].sort((a, b) => (b.rescheduled_at || '').localeCompare(a.rescheduled_at || ''));
    const items = sorted.map(h => {
        const prevLabel = `${_stripYear(h.prev_date)}${h.prev_time ? ' ' + formatTime12h(h.prev_time) : ''}`;
        const newLabel = `${_stripYear(h.new_date)}${h.new_time ? ' ' + formatTime12h(h.new_time) : ''}`;
        const reason = h.reason ? ` (${esc(h.reason)})` : '';
        const by = h.rescheduled_by ? ` by ${esc(h.rescheduled_by)}` : '';
        return `<div class="reschedule-history-item">${esc(prevLabel)} → ${esc(newLabel)}${reason}${by}</div>`;
    }).join('');
    return `<div class="reschedule-history">
        <div class="reschedule-history-title">재지정 이력</div>
        ${items}
    </div>`;
}

function renderPendingTasksCard(studentId, tasks) {
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

// ─── 밀린 Task 재지정 ─────────────────────────────────────────────────────────

let _rescheduleTarget = null;

window.openRescheduleModal = function(collection, docId, studentId) {
    // 결석대장 재예약
    if (collection === 'absence_records') {
        const r = absenceRecords.find(x => x.docId === docId);
        if (!r) return;
        _rescheduleTarget = { collection, docId, studentId };
        document.getElementById('reschedule-prev-info').innerHTML =
            `<strong>현재 보충 예정:</strong> ${r.makeup_date ? esc(_stripYear(r.makeup_date)) : '미정'}${r.makeup_time ? ' ' + esc(formatTime12h(r.makeup_time)) : ''}`;
        document.getElementById('reschedule-date').value = '';
        document.getElementById('reschedule-time').value = r.makeup_time || '16:00';
        document.getElementById('reschedule-reason').value = '';
        document.getElementById('reschedule-modal').style.display = 'flex';
        return;
    }
    const arr = collection === 'test_fail_tasks' ? testFailTasks : hwFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;
    _rescheduleTarget = { collection, docId, studentId };
    document.getElementById('reschedule-prev-info').innerHTML =
        `<strong>현재 예정:</strong> ${esc(_stripYear(t.scheduled_date))}${t.scheduled_time ? ' ' + esc(formatTime12h(t.scheduled_time)) : ''}`;
    document.getElementById('reschedule-date').value = '';
    document.getElementById('reschedule-time').value = t.scheduled_time || '16:00';
    document.getElementById('reschedule-reason').value = '';
    document.getElementById('reschedule-modal').style.display = 'flex';
};

window.saveReschedule = async function() {
    if (!_rescheduleTarget) return;
    const { collection: col, docId, studentId } = _rescheduleTarget;
    const newDate = document.getElementById('reschedule-date').value;
    const newTime = document.getElementById('reschedule-time').value;
    const reason = document.getElementById('reschedule-reason').value.trim();
    if (!newDate) { alert('새 날짜를 입력하세요.'); return; }

    // 결석대장 재예약 분기
    if (col === 'absence_records') {
        const r = absenceRecords.find(x => x.docId === docId);
        if (!r) return;
        const entry = {
            prev_date: r.makeup_date || '',
            prev_time: r.makeup_time || '',
            new_date: newDate,
            new_time: newTime || '',
            rescheduled_by: (currentUser?.email || '').split('@')[0],
            rescheduled_at: new Date().toISOString()
        };
        if (reason) entry.reason = reason;

        showSaveIndicator('saving');
        try {
            await updateDoc(doc(db, 'absence_records', docId), {
                makeup_date: newDate,
                makeup_time: newTime || '',
                makeup_status: 'pending',
                reschedule_history: arrayUnion(entry),
                updated_by: currentUser?.email || '',
                updated_at: serverTimestamp()
            });
            r.makeup_date = newDate;
            r.makeup_time = newTime || '';
            r.makeup_status = 'pending';
            if (!r.reschedule_history) r.reschedule_history = [];
            r.reschedule_history.push(entry);

            document.getElementById('reschedule-modal').style.display = 'none';
            _rescheduleTarget = null;
            renderStudentDetail(studentId);
            renderListPanel();
            showSaveIndicator('saved');
        } catch (err) {
            console.error('결석 재예약 저장 실패:', err);
            showSaveIndicator('error');
        }
        return;
    }

    const arr = col === 'test_fail_tasks' ? testFailTasks : hwFailTasks;
    const t = arr.find(x => x.docId === docId);
    if (!t) return;

    const entry = {
        prev_date: t.scheduled_date || '',
        prev_time: t.scheduled_time || '',
        new_date: newDate,
        new_time: newTime || '',
        rescheduled_by: (currentUser?.email || '').split('@')[0],
        rescheduled_at: new Date().toISOString()
    };
    if (reason) entry.reason = reason;

    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, col, docId), {
            scheduled_date: newDate,
            scheduled_time: newTime || '',
            reschedule_history: arrayUnion(entry)
        });
        // 로컬 캐시 업데이트
        t.scheduled_date = newDate;
        t.scheduled_time = newTime || '';
        if (!t.reschedule_history) t.reschedule_history = [];
        t.reschedule_history.push(entry);

        document.getElementById('reschedule-modal').style.display = 'none';
        _rescheduleTarget = null;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('재지정 저장 실패:', err);
        showSaveIndicator('error');
    }
};

// ─── 결석대장 CRUD ───────────────────────────────────────────────────────────

window.updateAbsenceField = async function(docId, field, value, studentId) {
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            [field]: value,
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r[field] = value;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('결석대장 필드 업데이트 실패:', err);
        showSaveIndicator('error');
    }
};

window.toggleConsultation = async function(docId, studentId) {
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    const sid = studentId || r.student_id;
    const newVal = !r.consultation_done;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            consultation_done: newVal,
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r.consultation_done = newVal;
        if (sid) renderStudentDetail(sid);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('상담 토글 실패:', err);
        showSaveIndicator('error');
    }
};

window.toggleReturnConsult = async function(studentId) {
    const s = allStudents.find(x => x.docId === studentId);
    if (!s) return;
    const newVal = !s.return_consult_done;
    showSaveIndicator('saving');
    try {
        const updateData = { return_consult_done: newVal };
        if (newVal) {
            updateData.return_consult_done_by = currentUser?.email || '';
            updateData.return_consult_done_at = serverTimestamp();
        } else {
            updateData.return_consult_done_by = deleteField();
            updateData.return_consult_done_at = deleteField();
        }
        await updateDoc(doc(db, 'students', studentId), updateData);
        s.return_consult_done = newVal;
        if (newVal) {
            s.return_consult_done_by = currentUser?.email || '';
            s.return_consult_done_at = new Date();
        } else {
            delete s.return_consult_done_by;
            delete s.return_consult_done_at;
        }
        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('복귀상담 토글 실패:', err);
        showSaveIndicator('error');
    }
};

let _returnConsultNoteTimer = null;
window.updateReturnConsultNote = function(studentId, value) {
    const s = allStudents.find(x => x.docId === studentId);
    if (!s) return;
    s.return_consult_note = value;
    if (_returnConsultNoteTimer) clearTimeout(_returnConsultNoteTimer);
    _returnConsultNoteTimer = setTimeout(async () => {
        showSaveIndicator('saving');
        try {
            await updateDoc(doc(db, 'students', studentId), {
                return_consult_note: value
            });
            showSaveIndicator('saved');
        } catch (err) {
            console.error('복귀상담 메모 저장 실패:', err);
            showSaveIndicator('error');
        }
    }, 600);
};

window.setAbsenceResolution = async function(docId, resolution, studentId) {
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    const newRes = r.resolution === resolution ? 'pending' : resolution;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            resolution: newRes,
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r.resolution = newRes;
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('처리방법 설정 실패:', err);
        showSaveIndicator('error');
    }
};

window.completeAbsenceMakeup = async function(docId, studentId) {
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            makeup_status: '완료',
            makeup_completed_by: currentUser?.email || '',
            makeup_completed_at: serverTimestamp(),
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r.makeup_status = '완료';
        r.makeup_completed_by = currentUser?.email || '';
        r.makeup_completed_at = new Date();
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('보충완료 처리 실패:', err);
        showSaveIndicator('error');
    }
};

window.markAbsenceNoShow = async function(docId, studentId) {
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            makeup_status: '미등원',
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r.makeup_status = '미등원';
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('미등원 처리 실패:', err);
        showSaveIndicator('error');
    }
};

window.switchToSettlement = async function(docId, studentId) {
    if (!confirm('정산으로 전환하시겠습니까?')) return;
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            resolution: '정산',
            makeup_status: 'pending',
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        r.resolution = '정산';
        r.makeup_status = 'pending';
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('정산전환 실패:', err);
        showSaveIndicator('error');
    }
};

window.closeAbsenceRecord = async function(docId, studentId) {
    if (!confirm('이 결석 건의 행정절차를 종료하시겠습니까?\n(목록에서 사라지며 되돌릴 수 없습니다)')) return;
    const r = absenceRecords.find(x => x.docId === docId);
    if (!r) return;
    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'absence_records', docId), {
            status: 'closed',
            updated_by: currentUser?.email || '',
            updated_at: serverTimestamp()
        });
        absenceRecords = absenceRecords.filter(x => x.docId !== docId);
        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('결석대장 종료 실패:', err);
        showSaveIndicator('error');
    }
};

window.openAbsenceRescheduleModal = function(docId, studentId) {
    window.openRescheduleModal('absence_records', docId, studentId);
};

// ─── Test Fail Action (테스트 2차 미통과 처리) ────────────────────────────────

function renderTestFailActionCard(studentId, testSections, t2nd, testFailAction, mode = 'default') {
    const rec = dailyRecords[studentId] || {};
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

    const descLabel = is1stOnly
        ? '1차 미통과 항목에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.'
        : '2차 미통과 항목에 \'등원 약속\' 또는 \'대체 숙제\'를 지정하세요.';

    const rows = failItems.map(item => {
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
                            <input type="date" class="field-input hw-fail-input" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}"
                                onchange="updateTestFailField('${escAttr(studentId)}', '${escapedItem}', 'scheduled_date', this.value)">
                            <input type="time" class="field-input hw-fail-input" style="width:90px;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_time || '16:00')}"
                                onchange="updateTestFailField('${escAttr(studentId)}', '${escapedItem}', 'scheduled_time', this.value)">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || currentUser?.email || '').split('@')[0])}</div>
                    </div>
                ` : isAlt ? `
                    <div class="hw-fail-detail">
                        <input type="text" class="field-input hw-fail-input" style="width:100%;padding:4px 8px;font-size:12px;"
                            placeholder="대체 숙제 내용 (예: 단어장 50개)"
                            value="${escAttr(action.alt_hw || '')}"
                            onchange="updateTestFailField('${escAttr(studentId)}', '${escapedItem}', 'alt_hw', this.value)">
                        <div class="hw-fail-detail-row" style="margin-top:4px;">
                            <label class="field-label" style="font-size:11px;color:var(--text-sec);flex-shrink:0;">제출기한</label>
                            <input type="date" class="field-input hw-fail-input" style="flex:1;padding:4px 8px;font-size:12px;"
                                value="${escAttr(action.scheduled_date || '')}"
                                onchange="updateTestFailField('${escAttr(studentId)}', '${escapedItem}', 'scheduled_date', this.value)">
                        </div>
                        <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">담당: ${esc((action.handler || currentUser?.email || '').split('@')[0])}</div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');

    return `
        <div class="detail-card hw-fail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--danger);font-size:18px;">quiz</span>
                ${is1stOnly ? '후속대책' : '테스트 미통과'} (${failItems.length}개)
            </div>
            <div class="hw-fail-desc" style="font-size:12px;color:var(--text-sec);margin-bottom:10px;">
                ${descLabel}
            </div>
            ${rows}
        </div>
    `;
}

window.selectTestFailType = async function(studentId, item, type, btnEl) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    const testFailAction = { ...(rec.test_fail_action || {}) };
    const current = testFailAction[item] || {};

    if (current.type === type) {
        delete testFailAction[item];
    } else {
        testFailAction[item] = {
            ...current,
            type,
            handler: currentUser?.email || '',
            scheduled_date: current.scheduled_date || '',
            scheduled_time: current.scheduled_time || (type === '등원' ? '16:00' : ''),
            alt_hw: current.alt_hw || '',
            updated_at: new Date().toISOString(),
        };
    }

    await saveTestFailAction(studentId, testFailAction);
    renderStudentDetail(studentId);
};

window.clearTestFailType = async function(studentId, item) {
    if (!checkCanEditGrading(studentId)) return;
    const rec = dailyRecords[studentId] || {};
    const testFailAction = { ...(rec.test_fail_action || {}) };
    delete testFailAction[item];
    await saveTestFailAction(studentId, testFailAction);
    renderStudentDetail(studentId);
};

let testFailSaveTimers = {};
window.updateTestFailField = function(studentId, item, field, value) {
    if (!checkCanEditGrading(studentId)) return;
    if (!dailyRecords[studentId]) dailyRecords[studentId] = {};
    if (!dailyRecords[studentId].test_fail_action) dailyRecords[studentId].test_fail_action = {};
    if (!dailyRecords[studentId].test_fail_action[item]) dailyRecords[studentId].test_fail_action[item] = {};
    dailyRecords[studentId].test_fail_action[item][field] = value;
    dailyRecords[studentId].test_fail_action[item].updated_at = new Date().toISOString();

    const timerKey = `test_${studentId}_${item}`;
    if (testFailSaveTimers[timerKey]) clearTimeout(testFailSaveTimers[timerKey]);
    testFailSaveTimers[timerKey] = setTimeout(async () => {
        await saveTestFailAction(studentId, dailyRecords[studentId].test_fail_action);
        delete testFailSaveTimers[timerKey];
    }, 1500);
};

async function saveTestFailAction(studentId, testFailAction) {
    const docId = makeDailyRecordId(studentId, selectedDate);
    const student = allStudents.find(s => s.docId === studentId);
    try {
        await setDoc(doc(db, 'daily_records', docId), {
            student_id: studentId,
            date: selectedDate,
            branch: branchFromStudent(student || {}),
            test_fail_action: testFailAction,
            updated_by: currentUser.email,
            updated_at: serverTimestamp()
        }, { merge: true });
        if (!dailyRecords[studentId]) dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
        dailyRecords[studentId].test_fail_action = testFailAction;

        // test_fail_tasks 컬렉션 동기화
        // 1) 서버 확인이 필요한 항목들을 병렬로 읽기
        const testTaskEntries = Object.entries(testFailAction).filter(([, action]) => action.type);
        const testTaskChecks = await Promise.all(testTaskEntries.map(async ([item, action]) => {
            const taskDocId = `test_${studentId}_${item}_${selectedDate}`.replace(/[^\w\s가-힣-]/g, '_');
            const existing = testFailTasks.find(t => t.docId === taskDocId);
            if (existing && existing.status !== 'pending') return null; // 스킵
            let serverSnap = null;
            if (!existing) {
                serverSnap = await getDoc(doc(db, 'test_fail_tasks', taskDocId));
                if (serverSnap.exists() && serverSnap.data().status !== 'pending') return null; // 스킵
            }
            return { item, action, taskDocId, existing };
        }));

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
                source_date: selectedDate,
                scheduled_date: action.scheduled_date || '',
                scheduled_time: action.scheduled_time || '',
                alt_hw: action.alt_hw || '',
                handler: (action.handler || currentUser?.email || '').split('@')[0],
                status: 'pending',
                created_by: (currentUser?.email || '').split('@')[0],
                created_at: existing?.created_at || new Date().toISOString(),
                branch: branchFromStudent(student || {}),
            };
            testWriteBatch.set(doc(db, 'test_fail_tasks', taskDocId), taskData, { merge: true });
            testWriteCount++;
            const idx = testFailTasks.findIndex(t => t.docId === taskDocId);
            if (idx >= 0) {
                testFailTasks[idx] = { docId: taskDocId, ...taskData };
            } else {
                testFailTasks.push({ docId: taskDocId, ...taskData });
            }
        }
        if (testWriteCount > 0) await testWriteBatch.commit();

        // 삭제된 item의 pending tasks 취소
        const testCancelTargets = testFailTasks.filter(t => t.student_id === studentId && t.source_date === selectedDate && t.status === 'pending' && (!testFailAction[t.domain] || !testFailAction[t.domain].type));
        if (testCancelTargets.length > 0) {
            const cancelBatch = writeBatch(db);
            for (const t of testCancelTargets) {
                cancelBatch.update(doc(db, 'test_fail_tasks', t.docId), {
                    status: '취소',
                    cancelled_by: (currentUser?.email || '').split('@')[0],
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

window.completeTestFailTask = async function(taskDocId, studentId) {
    if (!confirm('완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'test_fail_tasks', taskDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const t = testFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '완료'; t.completed_by = completedBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
};

window.cancelTestFailTask = async function(taskDocId, studentId) {
    if (!confirm('취소 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'test_fail_tasks', taskDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const t = testFailTasks.find(t => t.docId === taskDocId);
        if (t) { t.status = '취소'; t.cancelled_by = cancelledBy; }
        renderStudentDetail(studentId);
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
};

// ─── Next Homework Class List ────────────────────────────────────────────────

function renderNextHwClassList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    renderFilterChips();

    const classCodes = getUniqueClassCodes();
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
        const isActive = cc === selectedNextHwClass ? 'active' : '';
        const statusClass = filled === total ? 'next-hw-complete' : filled > 0 ? 'next-hw-partial' : '';
        const domains = getClassDomains(cc);
        const data = classNextHw[cc]?.domains || {};

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

function selectNextHwClass(classCode) {
    selectedNextHwClass = classCode;
    renderNextHwClassList();
    renderNextHwClassDetail(classCode);
    // 모바일: 디테일 패널 보이기
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

function openNextHwModal(classCode, domain) {
    nextHwModalTarget = { classCode, domain };
    const data = classNextHw[classCode]?.domains || {};
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

function saveNextHwFromModal() {
    const { classCode, domain } = nextHwModalTarget;
    if (!classCode || !domain) return;

    const text = document.getElementById('next-hw-modal-text').value.trim();
    if (!text) { alert('내용을 입력하세요'); return; }

    saveClassNextHw(classCode, domain, text, true);
    document.getElementById('next-hw-modal').style.display = 'none';
    refreshNextHwViews(classCode);
}

function saveNextHwNone() {
    const { classCode, domain } = nextHwModalTarget;
    if (!classCode || !domain) return;

    saveClassNextHw(classCode, domain, '없음', true);
    document.getElementById('next-hw-modal').style.display = 'none';
    refreshNextHwViews(classCode);
}

// ─── 개인별 다음숙제 모달 (학생 상세 패널에서 사용) ─────────────────────────
let personalNextHwTarget = { studentId: null, classCode: null, domain: null };

function openPersonalNextHwModal(studentId, classCode, domain) {
    personalNextHwTarget = { studentId, classCode, domain };
    const rec = dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    const personalVal = personalNextHw[pKey];
    const classVal = (classNextHw[classCode]?.domains?.[domain] || '').trim();

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

function savePersonalNextHwFromModal() {
    const { studentId, classCode, domain } = personalNextHwTarget;
    if (!studentId || !classCode || !domain) return;

    const text = document.getElementById('next-hw-modal-text').value.trim();
    if (!text) { alert('내용을 입력하세요'); return; }

    const rec = dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    personalNextHw[pKey] = text;

    saveDailyRecord(studentId, { personal_next_hw: personalNextHw });
    document.getElementById('next-hw-modal').style.display = 'none';
    restoreModalHandlers();
    if (selectedStudentId === studentId) renderStudentDetail(studentId);
}

function savePersonalNextHwNone() {
    const { studentId, classCode, domain } = personalNextHwTarget;
    if (!studentId || !classCode || !domain) return;

    const rec = dailyRecords[studentId] || {};
    const personalNextHw = rec.personal_next_hw || {};
    const pKey = `${classCode}_${domain}`;
    personalNextHw[pKey] = '없음';

    saveDailyRecord(studentId, { personal_next_hw: personalNextHw });
    document.getElementById('next-hw-modal').style.display = 'none';
    restoreModalHandlers();
    if (selectedStudentId === studentId) renderStudentDetail(studentId);
}

// 모달 핸들러를 반별 용으로 복원
function restoreModalHandlers() {
    document.getElementById('next-hw-modal-save').onclick = saveNextHwFromModal;
    document.getElementById('next-hw-modal-none').onclick = saveNextHwNone;
}

function refreshNextHwViews(classCode) {
    // 반별 다음숙제 뷰가 열려있으면 리렌더
    if (currentCategory === 'homework' && currentSubFilter.has('hw_next')) {
        renderNextHwClassList();
        if (selectedNextHwClass === classCode) renderNextHwClassDetail(classCode);
    }
    // 학생 상세가 열려있으면 리렌더
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
}

function renderNextHwClassDetail(classCode) {
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const domains = getClassDomains(classCode);
    const data = classNextHw[classCode]?.domains || {};

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
    const dayName = getDayName(selectedDate);
    let classStudents = allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === classCode)
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


// ─── Checklist Status ────────────────────────────────────────────────────────

function getStudentChecklistStatus(studentId) {
    const rec = dailyRecords[studentId] || {};
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

    const rec = dailyRecords[studentId] || {};
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

async function confirmDeparture(studentId) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const rec = dailyRecords[studentId] || {};
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
            confirmed_by: (currentUser?.email || '').split('@')[0],
            confirmed_at: new Date().toISOString()
        };
        if (reason) {
            departure.incomplete_reason = reason.trim();
            departure.incomplete_items = pendingItems.map(i => i.label);
        }

        await saveImmediately(studentId, { departure });
        if (!dailyRecords[studentId]) {
            dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
        }
        dailyRecords[studentId].departure = departure;

        renderStudentDetail(studentId);
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('귀가 확인 실패:', err);
        showSaveIndicator('error');
    }
}

window.confirmDeparture = confirmDeparture;

// ─── Temp Attendance Detail Panel ────────────────────────────────────────────

function renderTempAttendanceDetail(docId) {
    const ta = tempAttendances.find(t => t.docId === docId);
    if (!ta) return;

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    // 프로필 헤더
    document.getElementById('profile-avatar').textContent = (ta.name || '?')[0];
    document.getElementById('detail-name').textContent = ta.name || '';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag" style="background:#7c3aed;color:#fff;">진단평가</span>
        <span class="tag tag-pending">비등록</span>
    `;

    // 카드들
    const cardsContainer = document.getElementById('detail-cards');
    if (!cardsContainer) return;

    // 입력일시 포맷
    let createdAtStr = '';
    if (ta.created_at) {
        const ts = ta.created_at.toDate ? ta.created_at.toDate() : new Date(ta.created_at);
        createdAtStr = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
    }

    // 이메일에서 아이디만 추출 (@gw.impact7.kr, @impact7.kr 제거)
    const createdById = (ta.created_by || '').replace(/@(gw\.)?impact7\.kr$/, '');

    const infoRows = [
        { icon: 'apartment', label: '소속', value: ta.branch },
        { icon: 'school', label: '학교', value: ta.school },
        { icon: 'bar_chart', label: '학부', value: ta.level },
        { icon: 'grade', label: '학년', value: ta.grade },
        { icon: 'phone_android', label: '학생 전화', value: ta.student_phone },
        { icon: 'phone', label: '학부모 전화', value: ta.parent_phone_1 },
        { icon: 'calendar_today', label: '예정 날짜', value: ta.temp_date },
        { icon: 'schedule', label: '예정 시간', value: ta.temp_time ? formatTime12h(ta.temp_time) : '' },
        { icon: 'edit_calendar', label: '입력일시', value: createdAtStr },
        { icon: 'person', label: '입력', value: createdById },
    ].filter(r => r.value);

    const memoHtml = ta.memo ? `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);">sticky_note_2</span> 메모
            </div>
            <div style="padding:8px 0;color:var(--text-pri);white-space:pre-wrap;font-size:14px;">${esc(ta.memo)}</div>
        </div>
    ` : '';

    // 수정 이력 카드
    let editHistoryHtml = '';
    if (ta.edit_history && ta.edit_history.length) {
        const sorted = [...ta.edit_history].sort((a, b) => (b.edited_at || '').localeCompare(a.edited_at || ''));
        editHistoryHtml = `
            <div class="detail-card">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:var(--warning);">history</span> 수정 이력 (${sorted.length}건)
                </div>
                ${sorted.map(h => {
                    const dt = h.edited_at ? new Date(h.edited_at) : null;
                    const dateStr = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}` : '';
                    const editor = (h.edited_by || '').replace(/@(gw\.)?impact7\.kr$/, '');
                    const changes = Object.keys(h.after || {}).map(key => {
                        const label = TEMP_FIELD_LABELS[key] || key;
                        const before = (h.before && h.before[key]) || '(없음)';
                        const after = h.after[key] || '(없음)';
                        return `<div style="font-size:13px;padding:2px 0;"><span style="font-weight:500;color:var(--primary);">${label}</span>: ${esc(before)} → ${esc(after)}</div>`;
                    }).join('');
                    return `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
                        <div style="font-size:12px;color:var(--text-sec);margin-bottom:2px;">${dateStr} · ${esc(editor)}</div>
                        ${changes}
                    </div>`;
                }).join('')}
            </div>
        `;
    }

    cardsContainer.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
            <button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="openTempAttendanceForEdit('${docId}')">
                <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">edit</span> 수정
            </button>
        </div>
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:#7c3aed;">info</span> 진단평가 정보
            </div>
            ${infoRows.map(r => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
                    <span class="material-symbols-outlined" style="font-size:18px;color:var(--text-sec);">${r.icon}</span>
                    <span style="font-size:13px;color:var(--text-sec);min-width:80px;">${esc(r.label)}</span>
                    <span style="font-size:14px;color:var(--text-pri);font-weight:500;">${esc(r.value)}</span>
                </div>
            `).join('')}
        </div>
        ${memoHtml}
        ${editHistoryHtml}
    `;
}
window.renderTempAttendanceDetail = renderTempAttendanceDetail;

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
        const start = new Date(firstDate);
        const now = new Date();
        const totalMonths = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
        const years = Math.floor(totalMonths / 12);
        const months = totalMonths % 12;
        const duration = totalMonths <= 0 ? '등원예정'
            : years > 0 ? `${years}년${months > 0 ? ' ' + months + '개월' : ''}`
            : `${totalMonths}개월`;
        periodHtml = `${firstDate} 부터 &nbsp;&middot;&nbsp; <strong>${duration}</strong>`;
    }

    // 현재 활성 enrollment 구하기 (class_type별 가장 최근 시작된 enrollment)
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
function switchDetailTab(tab) {
    detailTab = tab;
    document.querySelectorAll('.detail-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.getElementById('detail-cards').style.display = tab === 'daily' ? '' : 'none';
    document.getElementById('report-tab').style.display = tab === 'report' ? '' : 'none';
}
window.switchDetailTab = switchDetailTab;

async function loadReportCard() {
    const studentId = selectedStudentId;
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
window.loadReportCard = loadReportCard;

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

// ─── 결석대장 카드 (학생 상세) ───────────────────────────────────────────────

function renderAbsenceRecordCard(studentId) {
    const records = absenceRecords.filter(r => r.student_id === studentId);
    if (records.length === 0) return '';

    const rows = records.map((r, idx) => {
        const group = _getAbsenceStatusGroup(r);
        const validityBadge = _renderValidityBadge(r.reason_valid);

        // 상담 메모
        const consultChecked = r.consultation_done ? 'checked' : '';
        const consultMemoHtml = `
            <textarea class="field-input" style="width:100%;min-height:40px;resize:vertical;font-size:12px;margin-bottom:6px;"
                placeholder="상담 내용..."
                onchange="updateAbsenceField('${escAttr(r.docId)}', 'consultation_note', this.value, '${escAttr(studentId)}')">${esc(r.consultation_note || '')}</textarea>`;

        // 사유 + 정당/부당
        const reasonHtml = `
            <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">
                <input type="text" class="field-input" style="flex:1;font-size:12px;" placeholder="결석 사유"
                    value="${escAttr(r.reason || '')}"
                    onchange="updateAbsenceField('${escAttr(r.docId)}', 'reason', this.value, '${escAttr(studentId)}')" />
                <button class="hw-fail-type-btn ${r.reason_valid === '정당' ? 'active' : ''}" style="font-size:11px;${r.reason_valid === '정당' ? 'background:#16a34a;border-color:#16a34a;color:#fff;' : ''}"
                    onclick="updateAbsenceField('${escAttr(r.docId)}', 'reason_valid', '${r.reason_valid === '정당' ? '' : '정당'}', '${escAttr(studentId)}')">정당</button>
                <button class="hw-fail-type-btn ${r.reason_valid === '부당' ? 'active' : ''}" style="font-size:11px;${r.reason_valid === '부당' ? 'background:#dc2626;border-color:#dc2626;color:#fff;' : ''}"
                    onclick="updateAbsenceField('${escAttr(r.docId)}', 'reason_valid', '${r.reason_valid === '부당' ? '' : '부당'}', '${escAttr(studentId)}')">부당</button>
            </div>`;

        // 상담완료 + 처리방법 (한 줄)
        const resolutionHtml = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap;">
                    <input type="checkbox" ${consultChecked} onchange="toggleConsultation('${escAttr(r.docId)}', '${escAttr(studentId)}')" />
                    상담완료
                </label>
                <span style="width:1px;height:16px;background:var(--border);margin:0 2px;"></span>
                <span style="font-size:11px;color:var(--text-sec);white-space:nowrap;">처리방법:</span>
                <button class="hw-fail-type-btn ${r.resolution === '보충' ? 'active' : ''}" style="font-size:11px;${r.resolution === '보충' ? 'background:#2563eb;border-color:#2563eb;color:#fff;' : ''}"
                    onclick="setAbsenceResolution('${escAttr(r.docId)}', '보충', '${escAttr(studentId)}')">보충</button>
                <button class="hw-fail-type-btn ${r.resolution === '정산' ? 'active' : ''}" style="font-size:11px;${r.resolution === '정산' ? 'background:#7c3aed;border-color:#7c3aed;color:#fff;' : ''}"
                    onclick="setAbsenceResolution('${escAttr(r.docId)}', '정산', '${escAttr(studentId)}')">정산</button>
            </div>`;

        // 보충 세부 (보충 선택 시)
        let makeupHtml = '';
        if (r.resolution === '보충') {
            const makeupDateVal = r.makeup_date || '';
            const makeupTimeVal = r.makeup_time || '16:00';
            let makeupActions = '';
            if (r.makeup_status === 'pending') {
                makeupActions = `
                    <button class="hw-fail-type-btn active" style="background:var(--success);border-color:var(--success);font-size:11px;"
                        onclick="completeAbsenceMakeup('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">check_circle</span>보충완료
                    </button>
                    <button class="hw-fail-type-btn" style="font-size:11px;background:#dc2626;border-color:#dc2626;color:#fff;"
                        onclick="markAbsenceNoShow('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">person_off</span>미등원
                    </button>`;
            } else if (r.makeup_status === '미등원') {
                makeupActions = `
                    <button class="hw-fail-type-btn" style="font-size:11px;background:#7c3aed;border-color:#7c3aed;color:#fff;"
                        onclick="openAbsenceRescheduleModal('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined" style="font-size:13px;">event</span>재예약
                    </button>
                    <button class="hw-fail-type-btn" style="font-size:11px;"
                        onclick="switchToSettlement('${escAttr(r.docId)}', '${escAttr(studentId)}')">정산전환</button>`;
            } else if (r.makeup_status === '완료') {
                makeupActions = `<span style="font-size:11px;color:var(--success);font-weight:600;">보충 완료됨</span>`;
            }
            makeupHtml = `
                <div style="background:#eff6ff;border-radius:6px;padding:8px;margin-bottom:6px;">
                    <div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;">
                        <input type="date" class="field-input" style="font-size:12px;width:130px;" value="${escAttr(makeupDateVal)}"
                            onchange="updateAbsenceField('${escAttr(r.docId)}', 'makeup_date', this.value, '${escAttr(studentId)}')" />
                        <input type="time" class="field-input" style="font-size:12px;width:100px;" value="${escAttr(makeupTimeVal)}"
                            onchange="updateAbsenceField('${escAttr(r.docId)}', 'makeup_time', this.value, '${escAttr(studentId)}')" />
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;">${makeupActions}</div>
                </div>`;
        }

        // 정산 세부
        let settlementHtml = '';
        if (r.resolution === '정산') {
            settlementHtml = `
                <div style="background:#f5f3ff;border-radius:6px;padding:8px;margin-bottom:6px;">
                    <textarea class="field-input" style="width:100%;min-height:36px;resize:vertical;font-size:12px;"
                        placeholder="정산 메모..."
                        onchange="updateAbsenceField('${escAttr(r.docId)}', 'settlement_memo', this.value, '${escAttr(studentId)}')">${esc(r.settlement_memo || '')}</textarea>
                </div>`;
        }

        // 재지정 이력
        const historyHtml = _renderRescheduleHistory(r.reschedule_history);

        // 입력자 + 타임스탬프
        const createdBy = getTeacherName(r.created_by);
        const updatedBy = getTeacherName(r.updated_by);
        const metaHtml = `
            <div style="font-size:10px;color:var(--text-sec);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
                ${createdBy ? `<span>등록: ${esc(createdBy)} ${_fmtTs(r.created_at, true)}</span>` : ''}
                ${updatedBy && updatedBy !== createdBy ? `<span>수정: ${esc(updatedBy)} ${_fmtTs(r.updated_at, true)}</span>` : ''}
            </div>`;

        // 수정 + 행정완료 버튼
        const closeBtn = `
            ${metaHtml}
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">
                <button class="hw-fail-type-btn" style="font-size:11px;"
                    onclick="event.preventDefault(); showSaveIndicator('saved');">
                    <span class="material-symbols-outlined" style="font-size:13px;">edit</span>수정
                </button>
                <button class="hw-fail-type-btn" style="font-size:11px;background:#6b7280;border-color:#6b7280;color:#fff;"
                    onclick="closeAbsenceRecord('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                    <span class="material-symbols-outlined" style="font-size:13px;">archive</span>행정완료
                </button>
            </div>`;

        return `
            <div class="pending-task-row" data-absence-idx="${idx}" style="background:#fef2f2;">
                <div class="pending-task-summary" onclick="this.parentElement.classList.toggle('expanded')">
                    <span style="display:flex;align-items:center;gap:4px;">
                        <span class="absence-status-badge ${group.badgeClass}">${esc(group.label)}</span>
                        ${esc(r.class_code || '')} · ${esc(_stripYear(r.absence_date))}
                        ${validityBadge}
                    </span>
                    <span class="pending-task-arrow material-symbols-outlined" style="font-size:16px;color:var(--text-sec);">expand_more</span>
                </div>
                <div class="pending-task-expand">
                    ${consultMemoHtml}
                    ${reasonHtml}
                    ${resolutionHtml}
                    ${makeupHtml}
                    ${settlementHtml}
                    ${historyHtml}
                    ${closeBtn}
                </div>
            </div>`;
    }).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:#dc2626;font-size:18px;">event_busy</span>
                결석대장 <span style="font-size:12px;color:var(--text-sec);">(${records.length}건)</span>
            </div>
            ${rows}
        </div>`;
}

// ─── 휴퇴원요청서 카드 (학생 상세) ──────────────────────────────────────────

// ─── 복귀상담 전용 카드 (복귀예정 뷰에서만 표시) ─────────────────────────

function renderReturnConsultCard(studentId) {
    if (!currentSubFilter.has('return_upcoming')) return '';
    const student = allStudents.find(s => s.docId === studentId);
    if (!student || !LEAVE_STATUSES.includes(student.status) || !student.pause_end_date) return '';

    // D-day 계산
    const now = new Date(); now.setHours(0,0,0,0);
    const end = new Date(student.pause_end_date); end.setHours(0,0,0,0);
    const daysLeft = Math.ceil((end - now) / 86400000);
    const ddayLabel = daysLeft === 0 ? 'D-Day' : daysLeft > 0 ? `D-${daysLeft}` : `D+${Math.abs(daysLeft)}`;
    const ddayCls = daysLeft <= 7 ? 'urgent' : 'soon';

    // 휴원 정보
    const pauseInfo = `${student.pause_start_date || '?'} ~ ${student.pause_end_date || '?'}`;
    const statusBadge = _leaveTypeBadgeOrFallback(null, student.status);

    // 상담 상태 (학생 문서 기반)
    const consultDone = student.return_consult_done || false;
    const consultNote = student.return_consult_note || '';
    const consultBy = student.return_consult_done_by ? getTeacherName(student.return_consult_done_by) : '';
    const consultAt = student.return_consult_done_at ? _fmtTs(student.return_consult_done_at, true) : '';

    const checkboxHtml = `<div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="toggleReturnConsult('${escAttr(studentId)}')">
        <span class="material-symbols-outlined" style="font-size:22px;color:${consultDone ? '#22c55e' : '#9ca3af'};">${consultDone ? 'check_circle' : 'radio_button_unchecked'}</span>
        <span style="font-size:13px;font-weight:600;color:${consultDone ? '#22c55e' : 'var(--text-pri)'};">${consultDone ? '상담 완료' : '상담 미완료'}</span>
    </div>`;

    const metaHtml = consultDone && (consultBy || consultAt)
        ? `<div style="font-size:11px;color:var(--text-sec);margin-top:4px;margin-left:30px;">${consultBy ? esc(consultBy) : ''} ${consultAt ? esc(consultAt) : ''}</div>`
        : '';

    const noteHtml = `<textarea style="width:100%;min-height:60px;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:13px;resize:vertical;box-sizing:border-box;margin-top:8px;"
        placeholder="복귀상담 내용을 입력하세요..."
        onchange="updateReturnConsultNote('${escAttr(studentId)}',this.value)">${esc(consultNote)}</textarea>`;

    return `
        <div class="detail-card" style="border-left:3px solid ${daysLeft <= 7 ? '#dc2626' : '#f59e0b'};">
            <div class="detail-card-title" style="display:flex;align-items:center;gap:8px;">
                <span class="material-symbols-outlined" style="color:#2563eb;font-size:18px;">phone_callback</span>
                복귀상담
                <span class="return-dday ${ddayCls}" style="margin-left:auto;">${ddayLabel}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
                ${statusBadge}
                <span style="font-size:12px;color:var(--text-sec);">${esc(pauseInfo)}</span>
            </div>
            ${checkboxHtml}
            ${metaHtml}
            ${noteHtml}
        </div>`;
}

function renderLeaveRequestCard(studentId) {
    const records = leaveRequests.filter(r => r.student_id === studentId);
    if (records.length === 0) return '';

    const rows = records.map((r, idx) => {
        const typeBadge = _leaveRequestTypeBadge(r);
        const statusBadge = _leaveRequestStatusBadge(r.status);

        // 날짜 요약
        let dateStr = '';
        if (r.withdrawal_date) dateStr = `퇴원일: ${r.withdrawal_date}`;
        else if (r.leave_start_date) dateStr = `${r.leave_start_date} ~ ${r.leave_end_date || ''}`;

        // 메타
        const reqBy = getTeacherName(r.requested_by);
        const appBy = getTeacherName(r.approved_by);
        let metaHtml = `<div style="font-size:10px;color:var(--text-sec);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
            ${reqBy ? `<span>요청: ${esc(reqBy)} ${_fmtTs(r.requested_at, true)}</span>` : ''}
            ${appBy ? `<span>승인: ${esc(appBy)} ${_fmtTs(r.approved_at, true)}</span>` : ''}
        </div>`;

        // 상담내용
        const noteHtml = r.consultation_note
            ? `<div style="font-size:12px;margin-top:4px;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;">${esc(r.consultation_note)}</div>`
            : '';

        // 버튼
        let actionsHtml = '';
        if (r.status === 'requested') {
            actionsHtml = `
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
                    <button class="lr-btn lr-btn-outlined"
                        onclick="cancelLeaveRequest('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined">close</span>요청 취소
                    </button>
                    <button class="lr-btn lr-btn-filled"
                        onclick="approveLeaveRequest('${escAttr(r.docId)}', '${escAttr(studentId)}')">
                        <span class="material-symbols-outlined">check</span>승인
                    </button>
                </div>`;
        }

        // 복귀상담 메모 (승인 완료 건만, 학생 문서 기반)
        let returnConsultHtml = '';
        if (r.status === 'approved') {
            const stu = allStudents.find(x => x.docId === studentId);
            const consultDone = stu?.return_consult_done;
            const consultChecked = consultDone ? 'check_circle' : 'phone_in_talk';
            const consultColor = consultDone ? '#22c55e' : '#f59e0b';
            returnConsultHtml = `
                <div style="margin-top:8px;padding:8px;background:var(--bg-secondary);border-radius:6px;">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                        <span class="return-consult-icon material-symbols-outlined" style="color:${consultColor};font-size:18px;cursor:pointer;"
                            onclick="toggleReturnConsult('${escAttr(studentId)}')">${consultChecked}</span>
                        <span style="font-size:12px;font-weight:600;color:var(--text-sec);">복귀유도 상담</span>
                    </div>
                    <textarea style="width:100%;min-height:48px;border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:12px;resize:vertical;box-sizing:border-box;"
                        placeholder="복귀상담 메모..."
                        onchange="updateReturnConsultNote('${escAttr(studentId)}',this.value)">${esc(stu?.return_consult_note || '')}</textarea>
                </div>`;
        }

        return `
            <div class="pending-task-row" data-lr-idx="${idx}" style="background:#f0f5ff;">
                <div class="pending-task-summary" onclick="this.parentElement.classList.toggle('expanded')">
                    <span>${typeBadge} ${statusBadge} <span style="font-size:12px;color:var(--text-sec);margin-left:4px;">${esc(dateStr)}</span></span>
                    <span class="pending-task-arrow material-symbols-outlined" style="font-size:16px;color:var(--text-sec);">expand_more</span>
                </div>
                <div class="pending-task-expand">
                    ${noteHtml}
                    ${metaHtml}
                    ${actionsHtml}
                    ${returnConsultHtml}
                </div>
            </div>`;
    }).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:#2563eb;font-size:18px;">description</span>
                휴퇴원요청서 <span style="font-size:12px;color:var(--text-sec);">(${records.length}건)</span>
            </div>
            ${rows}
        </div>`;
}

function renderStudentDetail(studentId) {
    if (!studentId) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
    }

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const student = allStudents.find(s => s.docId === studentId);
    if (!student) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
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

    const rec = dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const arrivalTime = rec?.arrival_time || '';
    const isLeaveStudent = LEAVE_STATUSES.includes(student.status);

    let tagClass, tagText;
    if (isLeaveStudent) {
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

    const hasSibling = siblingMap[studentId]?.size > 0;
    const siblingNames = hasSibling ? [...new Set([...siblingMap[studentId]].map(sid => allStudents.find(x => x.docId === sid)?.name).filter(Boolean))].join(', ') : '';
    const siblingHtml = hasSibling ? `<span class="tag tag-sibling"><span class="material-symbols-outlined" style="font-size:13px;">group</span> ${esc(siblingNames)}</span>` : '';

    document.getElementById('profile-tags').innerHTML = `
        <span class="tag tag-status ${tagClass}">${esc(tagText)}</span>
        ${siblingHtml}
    `;

    // 재원현황 (프로필 내 표시)
    const stayStatsEl = document.getElementById('profile-stay-stats');
    if (stayStatsEl) stayStatsEl.innerHTML = buildStayStatsHtml(student);

    // 카드들 렌더링
    const cardsContainer = document.getElementById('detail-cards');
    const studentHwTasks = hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const studentTestTasks = testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');

    // 등원 일정 카드 — 요일 + 시간 표시 (휴원 학생 미표시)
    const semesterEnrollments = student.enrollments.filter(e =>
        !selectedSemester || e.semester === selectedSemester
    );
    const dayNameForDetail = getDayName(selectedDate);
    const arrivalTimeHtml = isLeaveStudent ? '' : semesterEnrollments.length > 0 ? `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">schedule</span>
                등원 일정
            </div>
            ${semesterEnrollments.map(e => {
                const code = enrollmentCode(e);
                const days = (e.day || []).join('·');
                const classDefault = classSettings[code]?.default_time || '';
                const individual = e.start_time || '';
                const isDefault = !individual || individual === classDefault;
                const displayTime = isDefault ? classDefault : individual;
                const isToday = (e.day || []).includes(dayNameForDetail);
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;${isToday ? 'font-weight:600;' : 'opacity:0.7;'}">
                    <span style="font-size:13px;min-width:40px;">${esc(code)}</span>
                    <span style="font-size:12px;min-width:50px;color:var(--text-sec);">${esc(days)}</span>
                    <span style="font-size:13px;">${displayTime ? esc(formatTime12h(displayTime)) : '-'}</span>
                    ${isToday ? '<span style="font-size:10px;color:var(--primary);font-weight:600;">오늘</span>' : ''}
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
                            ${detailDomains.map(d => {
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
                                const hasAny = items.some(t => data[t]);
                                if (!hasAny) return '';
                                return `<div style="margin-bottom:6px;">
                                    <span style="font-size:10px;color:var(--text-sec);">${esc(secName)}</span>
                                    <div class="hw-domain-group" style="margin-bottom:2px;">
                                        ${items.map(t => {
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
    const dayName2 = getDayName(selectedDate);
    const studentClasses = student.enrollments
        .filter(e => e.day.includes(dayName2) && (!selectedSemester || e.semester === selectedSemester))
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
                const classData = classNextHw[cc]?.domains || {};
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
    const hasClinic = !!extraVisit.date;
    const isPastDate = selectedDate < todayStr();
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
            ${hasClinic ? `<div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;gap:6px;">
                    <input type="date" class="field-input" style="flex:1;padding:4px 8px;font-size:12px;"
                        value="${escAttr(extraVisit.date || '')}"
                        placeholder="날짜"
                        ${isPastDate ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'date', this.value)"`}>
                    <input type="time" class="field-input" style="width:100px;padding:4px 8px;font-size:12px;"
                        value="${escAttr(extraVisit.time || '')}"
                        ${isPastDate ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'time', this.value)"`}>
                </div>
                <input type="text" class="field-input" style="width:100%;padding:4px 8px;font-size:12px;"
                    placeholder="사유 (예: 보충수업, 재시험 등)"
                    value="${escAttr(extraVisit.reason || '')}"
                    ${isPastDate ? 'readonly' : `onchange="saveExtraVisit('${escAttr(studentId)}', 'reason', this.value)"`}>
            </div>` : ''}
        </div>
    `;

    cardsContainer.innerHTML = `
        <!-- 복귀상담 카드 (복귀예정 뷰) -->
        ${renderReturnConsultCard(studentId)}

        ${renderChecklistCard(studentId)}
        ${reasonHtml}

        <!-- 개별 등원시간 카드 -->
        ${arrivalTimeHtml}

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

    // 탭 상태 복원
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) {
        tabsEl.querySelectorAll('.detail-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === detailTab);
        });
    }
    document.getElementById('detail-cards').style.display = detailTab === 'daily' ? '' : 'none';
    const reportTabEl = document.getElementById('report-tab');
    if (reportTabEl) reportTabEl.style.display = detailTab === 'report' ? '' : 'none';

    // 모바일에서 패널 보이기
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

// ─── 클리닉 저장 ────────────────────────────────────────────────────────────

async function saveExtraVisit(studentId, field, value) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const rec = dailyRecords[studentId] || {};
    const extraVisit = { ...(rec.extra_visit || {}) };
    extraVisit[field] = value;

    // 로컬 캐시 업데이트
    if (!dailyRecords[studentId]) {
        dailyRecords[studentId] = { student_id: studentId, date: selectedDate };
    }
    dailyRecords[studentId].extra_visit = extraVisit;

    // 현재 날짜 레코드에 저장 (상세 패널 표시용)
    saveDailyRecord(studentId, { extra_visit: extraVisit });

    // 타겟 날짜가 다르면 타겟 날짜 레코드에도 저장 (등원예정 목록 표시용)
    const targetDate = extraVisit.date;
    if (targetDate && targetDate !== selectedDate) {
        const docId = makeDailyRecordId(studentId, targetDate);
        const student = allStudents.find(s => s.docId === studentId);
        try {
            await setDoc(doc(db, 'daily_records', docId), {
                student_id: studentId,
                date: targetDate,
                branch: branchFromStudent(student || {}),
                extra_visit: extraVisit,
                updated_by: currentUser.email,
                updated_at: serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.error('클리닉 미래 날짜 저장 실패:', err);
        }
    }
}

// + 버튼 클릭 → 오늘 날짜로 초기화 + 상세패널 리렌더
async function addExtraVisit(studentId) {
    await saveExtraVisit(studentId, 'date', selectedDate);
    renderStudentDetail(studentId);
}

// × 버튼 클릭 → extra_visit 삭제 + 리렌더
async function clearExtraVisit(studentId) {
    if (selectedDate < todayStr()) { alert('과거 기록은 삭제할 수 없습니다.'); return; }
    const rec = dailyRecords[studentId];
    if (rec) delete rec.extra_visit;
    await saveImmediately(studentId, { extra_visit: deleteField() });
    renderStudentDetail(studentId);
    renderSubFilters();
    renderListPanel();
}

// ─── Toggle handlers (immediate save) ──────────────────────────────────────

async function cycleTempArrival(docId) {
    const ta = tempAttendances.find(t => t.docId === docId);
    if (!ta) return;
    const cycle = ['', '등원', '미등원'];
    const current = ta.temp_arrival || '';
    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
    const next = cycle[nextIdx];
    showSaveIndicator('saving');
    try {
        const update = next ? { temp_arrival: next } : { temp_arrival: deleteField() };
        await updateDoc(doc(db, 'temp_attendance', docId), update);
        ta.temp_arrival = next || undefined;
        _scheduledVisitsCache = null;
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 등원 상태 변경 실패:', err);
        showSaveIndicator('error');
    }
}
window.cycleTempArrival = cycleTempArrival;

function cycleVisitAttendance(studentId) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const cycle = ['등원전', '출석', '지각', '결석'];
    const rec = dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const currentDisplay = attStatus === '미확인' ? '등원전' : attStatus;
    const nextIdx = (cycle.indexOf(currentDisplay) + 1) % cycle.length;
    const nextDisplay = cycle[nextIdx];
    const nextVal = nextDisplay === '등원전' ? '정규' : nextDisplay;
    applyAttendance(studentId, nextVal, true);
    renderListPanel();
}

function toggleAttendance(studentId, displayStatus) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    if (bulkMode && selectedStudentIds.size >= 2 && selectedStudentIds.has(studentId)) {
        openBulkModal('attendance');
        return;
    }
    applyAttendance(studentId, displayStatus);
}

async function autoCreateAbsenceRecord(studentId, overrides) {
    // 중복 체크
    const exists = absenceRecords.some(r => r.student_id === studentId && r.absence_date === selectedDate);
    if (exists) return;

    const student = allStudents.find(s => s.docId === studentId);

    let name, branch, classCode, reason;
    if (student) {
        const dayName = getDayName(selectedDate);
        const classCodes = (student.enrollments || [])
            .filter(e => e.day && e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester))
            .map(e => enrollmentCode(e))
            .filter(Boolean);
        name = student.name || '';
        branch = branchFromStudent(student);
        classCode = classCodes.join(', ');
        reason = '';
    } else if (overrides) {
        name = overrides.student_name || studentId.replace(/_\d+$/, '');
        branch = overrides.branch || '';
        classCode = overrides.class_code || '';
        reason = overrides.reason || '';
    } else {
        return;
    }

    try {
        const record = {
            student_id: studentId,
            student_name: name,
            branch,
            class_code: classCode,
            absence_date: selectedDate,
            consultation_done: false,
            consultation_note: '',
            reason,
            reason_valid: '',
            resolution: 'pending',
            settlement_memo: '',
            makeup_date: '',
            makeup_time: '',
            makeup_status: 'pending',
            makeup_completed_by: '',
            makeup_completed_at: '',
            reschedule_history: [],
            status: 'open',
            created_by: currentUser?.email || '',
            updated_by: currentUser?.email || ''
        };
        const docRef = await addDoc(collection(db, 'absence_records'), {
            ...record,
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });
        absenceRecords.push({
            ...record,
            docId: docRef.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (err) {
        console.error('결석대장 자동 생성 실패:', err);
    }
}

async function autoRemoveAbsenceRecord(studentId) {
    const idx = absenceRecords.findIndex(r => r.student_id === studentId && r.absence_date === selectedDate);
    if (idx === -1) return;
    const record = absenceRecords[idx];
    try {
        await deleteDoc(doc(db, 'absence_records', record.docId));
        absenceRecords.splice(idx, 1);
        renderSubFilters();
    } catch (err) {
        console.error('결석대장 자동 삭제 실패:', err);
    }
}

// Self-healing: dailyRecords에서 결석인데 absence_records에 없는 건 자동 보충
async function syncAbsenceRecords() {
    const absentEntries = Object.entries(dailyRecords)
        .filter(([, v]) => v?.attendance?.status === '결석');

    const tasks = absentEntries
        .filter(([studentId]) =>
            allStudents.some(s => s.docId === studentId) &&
            !absenceRecords.some(r => r.student_id === studentId && r.absence_date === selectedDate)
        )
        .map(([studentId]) => autoCreateAbsenceRecord(studentId));

    await Promise.all(tasks);
}

function applyAttendance(studentId, displayStatus, force = false, silent = false) {
    // 정규 → 미확인으로 매핑
    const firestoreStatus = displayStatus === '정규' ? '미확인' : displayStatus;

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
    Object.assign(dailyRecords[studentId], updates);

    // 결석 시 결석대장 자동 생성, 결석 아닌 상태로 변경 시 자동 삭제
    if (newStatus === '결석') {
        autoCreateAbsenceRecord(studentId);
    } else if (currentStatus === '결석' && newStatus !== '결석') {
        autoRemoveAbsenceRecord(studentId);
    }

    if (silent) return;

    const row = document.querySelector(`.list-item[data-id="${CSS.escape(studentId)}"]`);
    if (row) {
        const newDisplay = newStatus === '미확인' ? '정규' : newStatus;
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

const LEAVE_STATUSES = ['가휴원', '실휴원'];
const NEW_STUDENT_DAYS = 14;

function isNewStudent(student, todayDate) {
    return (student.enrollments || []).some(e => {
        if (!e.start_date) return false;
        const diff = (todayDate - new Date(e.start_date)) / (1000 * 60 * 60 * 24);
        return diff >= 0 && diff <= NEW_STUDENT_DAYS;
    });
}

function isAttendedStatus(status) {
    return status === '출석' || status === '지각' || status === '조퇴';
}

function checkCanEditGrading(studentId) {
    const rec = dailyRecords[studentId] || {};
    if (isAttendedStatus(rec?.attendance?.status)) return true;
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
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    if (!checkCanEditGrading(studentId)) return;
    if (bulkMode && selectedStudentIds.size >= 2 && selectedStudentIds.has(studentId)) {
        openBulkModal('ox', field, domain);
        return;
    }
    applyHwDomainOX(studentId, field, domain);
    renderSubFilters();
    if (selectedStudentId === studentId) renderStudentDetail(studentId);
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
    const btn = document.querySelector(`.hw-domain-ox[data-student="${CSS.escape(studentId)}"][data-field="${CSS.escape(field)}"][data-domain="${CSS.escape(domain)}"]`);
    if (btn) {
        btn.classList.remove('ox-green', 'ox-red', 'ox-yellow', 'ox-empty');
        btn.classList.add(oxDisplayClass(newVal));
        btn.textContent = newVal || '—';
    }
}

// ─── Field change handlers ──────────────────────────────────────────────────

function handleAttendanceChange(studentId, field, value) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
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

// ─── Date navigation ────────────────────────────────────────────────────────

function updateDateDisplay() {
    const dayName = getDayName(selectedDate);
    document.getElementById('date-text').textContent = `${selectedDate} (${dayName})`;
    const picker = document.getElementById('date-picker');
    if (picker) picker.value = selectedDate;
}

async function reloadForDate() {
    _visitStatusPending = {};

    await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(selectedDate), loadAbsenceRecords(), loadRoleMemos(), loadClassNextHw(selectedDate), loadClassSettings(), loadTeachers()]);
    await syncAbsenceRecords();
    selectedNextHwClass = null;
    updateDateDisplay();
    updateReadonlyBanner();
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
    initHelpGuide();

    // 탭 복귀 시 자동 데이터 갱신 (5분 이상 비활성 후 돌아오면)
    let lastActiveTime = Date.now();
    const AUTO_RELOAD_THRESHOLD = 5 * 60 * 1000; // 5분

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            lastActiveTime = Date.now();
        } else if (currentUser && Date.now() - lastActiveTime >= AUTO_RELOAD_THRESHOLD) {
            reloadForDate();
            showToast('데이터를 자동 갱신했습니다');
        }
    });
});

// ─── Retake actions ─────────────────────────────────────────────────────────

async function completeRetake(retakeDocId) {
    if (!confirm('이 일정을 완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'retake_schedule', retakeDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString(),
            updated_at: serverTimestamp()
        });
        const r = retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) { r.status = '완료'; r.completed_by = completedBy; }
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
        const cancelledBy = (currentUser?.email || '').split('@')[0];
        await updateDoc(doc(db, 'retake_schedule', retakeDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString(),
            updated_at: serverTimestamp()
        });
        const r = retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) { r.status = '취소'; r.cancelled_by = cancelledBy; }
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
    if (!event || event.target === event.currentTarget) {
        document.getElementById(id).style.display = 'none';
    }
}

// ─── 휴퇴원요청서 모달 로직 ─────────────────────────────────────────────────

const _isWithdrawalType = (t) => t === '퇴원요청' || t === '휴원→퇴원';
const _isLeaveSubType = (t) => t === '휴원요청' || t === '퇴원→휴원';
const _isLeaveExtension = (t) => t === '휴원연장';

let _leaveRequestStudentId = null;
let _leaveRequestStudentData = null;

function openLeaveRequestModal() {
    document.getElementById('lr-request-type').value = '휴원요청';
    document.getElementById('lr-sub-type').value = '실휴원';
    document.getElementById('lr-consultation-note').value = '';
    onLeaveRequestTypeChange(); // resets student state + date fields
    document.getElementById('leave-request-modal').style.display = 'flex';
}

function onLeaveRequestTypeChange() {
    const type = document.getElementById('lr-request-type').value;
    const subWrap = document.getElementById('lr-sub-type-wrap');
    subWrap.style.display = _isLeaveSubType(type) ? '' : 'none';
    _renderLeaveRequestDateFields(type);
    // 퇴원→휴원 선택 시 퇴원 학생 lazy-load
    if (type === '퇴원→휴원' && withdrawnStudents.length === 0) {
        loadWithdrawnStudents();
    }
    // 검색 초기화
    _leaveRequestStudentId = null;
    _leaveRequestStudentData = null;
    document.getElementById('lr-student-search').value = '';
    document.getElementById('lr-student-results').innerHTML = '';
    document.getElementById('lr-student-info').style.display = 'none';
}

function _renderLeaveRequestDateFields(type) {
    const container = document.getElementById('lr-date-fields');
    if (_isWithdrawalType(type)) {
        container.innerHTML = `
            <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">퇴원시작일</label>
            <input type="date" id="lr-withdrawal-date" class="field-input" style="width:100%;">`;
    } else if (_isLeaveExtension(type)) {
        container.innerHTML = `
            <div>
                <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">연장 종료일</label>
                <input type="date" id="lr-leave-end" class="field-input" style="width:100%;">
            </div>`;
    } else {
        container.innerHTML = `
            <div style="display:flex;gap:8px;">
                <div style="flex:1;">
                    <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">휴원시작일</label>
                    <input type="date" id="lr-leave-start" class="field-input" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">휴원종료일</label>
                    <input type="date" id="lr-leave-end" class="field-input" style="width:100%;">
                </div>
            </div>`;
    }
}

function searchLeaveRequestStudent(term) {
    const results = document.getElementById('lr-student-results');
    if (!term || term.length < 1) { results.innerHTML = ''; return; }

    const type = document.getElementById('lr-request-type').value;
    let pool;
    if (type === '퇴원→휴원') {
        pool = withdrawnStudents;
    } else if (type === '휴원→퇴원') {
        pool = allStudents.filter(s => LEAVE_STATUSES.includes(s.status));
    } else {
        pool = allStudents.filter(s => s.status === '재원' || s.status === '등원예정');
    }

    const isChosung = isChosungOnly(term);
    const matched = pool.filter(s => {
        if (isChosung) return matchChosung(s.name, term);
        return s.name.includes(term);
    }).slice(0, 10);

    if (matched.length === 0) {
        results.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-sec);">결과 없음</div>';
        return;
    }

    results.innerHTML = matched.map(s => {
        const codes = allClassCodes(s).join(', ');
        return `<div class="list-item" style="padding:6px 10px;cursor:pointer;" onclick="selectLeaveRequestStudentById('${escAttr(s.docId)}')">
            <span style="font-weight:600;font-size:13px;">${esc(s.name)}</span>
            <span style="font-size:11px;color:var(--text-sec);margin-left:6px;">${esc(codes)} · ${esc(s.status || '')}</span>
        </div>`;
    }).join('');
}

function selectLeaveRequestStudentById(id) {
    const type = document.getElementById('lr-request-type').value;
    const pool = type === '퇴원→휴원' ? withdrawnStudents : allStudents;
    const s = pool.find(st => st.docId === id);
    if (!s) return;

    _leaveRequestStudentId = id;
    _leaveRequestStudentData = s;

    document.getElementById('lr-student-search').value = s.name;
    document.getElementById('lr-student-results').innerHTML = '';
    document.getElementById('lr-student-info').style.display = '';
    document.getElementById('lr-student-name').textContent = s.name;
    document.getElementById('lr-student-class').textContent = allClassCodes(s).join(', ');
    document.getElementById('lr-student-status').textContent = s.status || '';
    document.getElementById('lr-student-phone').textContent = s.student_phone || '—';
    document.getElementById('lr-parent-phone').textContent = s.parent_phone_1 || '—';
}

async function submitLeaveRequest() {
    if (!_leaveRequestStudentId || !_leaveRequestStudentData) {
        alert('학생을 선택해주세요.');
        return;
    }

    const type = document.getElementById('lr-request-type').value;
    const s = _leaveRequestStudentData;
    const isWithdrawal = _isWithdrawalType(type);
    const showSub = _isLeaveSubType(type);

    const data = {
        student_id: _leaveRequestStudentId,
        student_name: s.name,
        branch: branchFromStudent(s),
        class_codes: allClassCodes(s),
        request_type: type,
        student_phone: s.student_phone || '',
        parent_phone_1: s.parent_phone_1 || '',
        consultation_note: document.getElementById('lr-consultation-note').value.trim(),
        status: 'requested',
        previous_status: s.status || '',
        requested_by: currentUser?.email || '',
        requested_at: serverTimestamp(),
        created_at: serverTimestamp(),
        updated_at: serverTimestamp()
    };

    if (showSub) {
        data.leave_sub_type = document.getElementById('lr-sub-type').value;
    }

    if (isWithdrawal) {
        const wd = document.getElementById('lr-withdrawal-date')?.value;
        if (!wd) { alert('퇴원시작일을 입력해주세요.'); return; }
        data.withdrawal_date = wd;
    } else if (_isLeaveExtension(type)) {
        const le = document.getElementById('lr-leave-end')?.value;
        if (!le) { alert('연장 종료일을 입력해주세요.'); return; }
        data.leave_end_date = le;
    } else {
        const ls = document.getElementById('lr-leave-start')?.value;
        const le = document.getElementById('lr-leave-end')?.value;
        if (!ls || !le) { alert('휴원 시작일과 종료일을 입력해주세요.'); return; }
        if (le < ls) { alert('종료일이 시작일보다 앞섭니다.'); return; }
        data.leave_start_date = ls;
        data.leave_end_date = le;
    }

    try {
        const docRef = await addDoc(collection(db, 'leave_requests'), data);
        leaveRequests.push({ docId: docRef.id, ...data, requested_at: new Date(), created_at: new Date() });
        document.getElementById('leave-request-modal').style.display = 'none';
        showSaveIndicator('saved');
        renderSubFilters();
        renderLeaveRequestList();
    } catch (err) {
        alert('요청 저장 실패: ' + err.message);
        console.error(err);
    }
}

// ─── 휴퇴원 승인/취소 ───────────────────────────────────────────────────────

async function approveLeaveRequest(docId, studentId) {
    const r = leaveRequests.find(lr => lr.docId === docId);
    if (!r) return;

    const typeLabel = `${r.request_type}${r.leave_sub_type ? ' (' + r.leave_sub_type + ')' : ''}`;
    if (!confirm(`${r.student_name} — ${typeLabel}\n승인하시겠습니까?`)) return;

    try {
        // 1. 학생 현재 상태 가져오기
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        const beforeData = studentSnap.exists() ? studentSnap.data() : {};
        const beforeStatus = beforeData.status || '';

        // 2. 요청 승인 처리
        await updateDoc(doc(db, 'leave_requests', docId), {
            status: 'approved',
            approved_by: currentUser?.email || '',
            approved_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });

        // 3. 학생 status 변경
        const studentUpdate = {};
        const isWithdrawal = _isWithdrawalType(r.request_type);

        if (isWithdrawal) {
            studentUpdate.status = '퇴원';
            studentUpdate.pause_start_date = deleteField();
            studentUpdate.pause_end_date = deleteField();
        } else if (_isLeaveExtension(r.request_type)) {
            // 휴원연장: 종료일만 변경, 시작일과 status 유지
            studentUpdate.pause_end_date = r.leave_end_date || '';
        } else {
            // 휴원요청 or 퇴원→휴원
            studentUpdate.status = r.leave_sub_type || '실휴원';
            studentUpdate.pause_start_date = r.leave_start_date || '';
            studentUpdate.pause_end_date = r.leave_end_date || '';
        }

        // 3-4. 학생 status 변경 + history_logs 기록 (병렬)
        const changeType = isWithdrawal ? 'WITHDRAW' : 'UPDATE';
        await Promise.all([
            updateDoc(doc(db, 'students', studentId), studentUpdate),
            addDoc(collection(db, 'history_logs'), {
                doc_id: studentId,
                change_type: changeType,
                before: JSON.stringify({ status: beforeStatus, pause_start_date: beforeData.pause_start_date || '', pause_end_date: beforeData.pause_end_date || '' }),
                after: JSON.stringify({ status: studentUpdate.status || beforeStatus, pause_start_date: studentUpdate.pause_start_date || beforeData.pause_start_date || '', pause_end_date: studentUpdate.pause_end_date || beforeData.pause_end_date || '' }),
                google_login_id: currentUser?.email || 'system',
                timestamp: serverTimestamp()
            })
        ]);

        // 5. 로컬 캐시 업데이트
        const lrIdx = leaveRequests.findIndex(lr => lr.docId === docId);
        if (lrIdx >= 0) leaveRequests[lrIdx].status = 'approved';

        const sIdx = allStudents.findIndex(s => s.docId === studentId);
        if (isWithdrawal) {
            // 퇴원: allStudents에서 제거, withdrawnStudents에 추가
            if (sIdx >= 0) {
                const removed = allStudents.splice(sIdx, 1)[0];
                removed.status = '퇴원';
                delete removed.pause_start_date;
                delete removed.pause_end_date;
                withdrawnStudents.push(removed);
            }
        } else if (r.request_type === '퇴원→휴원') {
            // 퇴원→휴원: withdrawnStudents에서 제거, allStudents에 추가
            const wIdx = withdrawnStudents.findIndex(s => s.docId === studentId);
            if (wIdx >= 0) {
                const restored = withdrawnStudents.splice(wIdx, 1)[0];
                restored.status = studentUpdate.status;
                restored.pause_start_date = studentUpdate.pause_start_date;
                restored.pause_end_date = studentUpdate.pause_end_date;
                allStudents.push(restored);
            }
        } else if (_isLeaveExtension(r.request_type)) {
            // 휴원연장: 종료일만 변경
            if (sIdx >= 0) {
                allStudents[sIdx].pause_end_date = studentUpdate.pause_end_date;
            }
        } else {
            // 휴원: allStudents에서 status만 변경
            if (sIdx >= 0) {
                allStudents[sIdx].status = studentUpdate.status;
                allStudents[sIdx].pause_start_date = studentUpdate.pause_start_date;
                allStudents[sIdx].pause_end_date = studentUpdate.pause_end_date;
            }
        }

        showSaveIndicator('saved');
        renderSubFilters();
        if (currentCategory === 'admin' && currentSubFilter.has('leave_request')) {
            renderLeaveRequestList();
        }
        renderStudentDetail(studentId);
    } catch (err) {
        alert('승인 처리 실패: ' + err.message);
        console.error(err);
    }
}

async function cancelLeaveRequest(docId, studentId) {
    if (!confirm('요청을 취소하시겠습니까?')) return;
    try {
        await updateDoc(doc(db, 'leave_requests', docId), {
            status: 'cancelled',
            updated_at: serverTimestamp()
        });
        leaveRequests = leaveRequests.filter(lr => lr.docId !== docId);
        showSaveIndicator('saved');
        renderSubFilters();
        if (currentCategory === 'admin' && currentSubFilter.has('leave_request')) {
            renderLeaveRequestList();
        }
        renderStudentDetail(studentId);
    } catch (err) {
        alert('취소 실패: ' + err.message);
        console.error(err);
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
        await Promise.all(_scheduleTargetIds.map(studentId =>
            saveRetakeSchedule({
                student_id: studentId,
                type,
                subject,
                title,
                original_date: selectedDate,
                scheduled_date: scheduledDate,
                status: '예정',
                result_score: null
            })
        ));
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

// ─── 등원예정시간 (학생 상세 패널에서 사용, students 컬렉션에 영구 저장) ──────

async function saveStudentScheduledTime(studentId, classCode, time) {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const dayName = getDayName(selectedDate);
    const enrollments = [...student.enrollments];
    const idx = enrollments.findIndex(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === classCode);
    if (idx === -1) return;

    // 반 기본시간과 동일하거나 빈값이면 개별시간 제거 (fallback 사용)
    const classDefault = classSettings[classCode]?.default_time || '';
    if (!time || time === classDefault) {
        const { start_time, ...rest } = enrollments[idx];
        enrollments[idx] = rest;
    } else {
        enrollments[idx] = { ...enrollments[idx], start_time: time };
    }

    showSaveIndicator('saving');
    try {
        await updateDoc(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        showSaveIndicator('saved');
        renderStudentDetail(studentId);
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
    const icon = document.getElementById('memo-expand-icon');

    // 이미 열려있으면 닫기
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        icon.textContent = 'expand_more';
        return;
    }

    // 사이드바가 모바일에서 닫혀있으면 열기
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.add('mobile-open');
        overlay.classList.add('visible');
    }

    // 패널 열기
    panel.style.display = '';
    icon.textContent = 'expand_less';
    renderMemoPanel();
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
    const newCode = `${levelSymbol}${classNumber}`;
    const newSemester = enrollments[enrollIdx]?.semester || '';

    // 중복 반코드 체크 (같은 학기 내 다른 enrollment에 동일 코드가 있는지)
    const isDuplicate = enrollments.some((e, i) =>
        i !== enrollIdx &&
        enrollmentCode(e) === newCode &&
        (e.semester || '') === newSemester
    );
    if (isDuplicate) {
        alert(`이미 같은 반(${newCode})이 등록되어 있습니다.`);
        return;
    }

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
        buildSiblingMap();
        await loadSemesterSettings();
        getCurrentSemester();
        buildSemesterFilter();
        await trackTeacherLogin(user);
        await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadUserRole(), loadClassSettings(), loadClassNextHw(selectedDate), loadTeachers(), loadContacts()]);
        await syncAbsenceRecords();
        await loadRoleMemos().catch(() => {});
        updateDateDisplay();
        updateReadonlyBanner();
        renderBranchFilter();
        renderSubFilters();
        updateL1ExpandIcons();
        renderListPanel();

        // Restore group view button state
        if (groupViewMode !== 'none') {
            const btn = document.getElementById('group-view-btn');
            const labels = { none: 'view_agenda', branch: 'location_city', class: 'school' };
            const titles = { none: '그룹 뷰 (소속별)', branch: '그룹 뷰: 소속별 → 반별로 전환', class: '그룹 뷰: 반별 → 해제' };
            if (btn) {
                btn.querySelector('.material-symbols-outlined').textContent = labels[groupViewMode];
                btn.title = titles[groupViewMode];
                btn.classList.add('active');
            }
        }
    } else {
        currentUser = null;
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

// ─── Keyboard shortcut: ESC closes modals ───────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['schedule-modal', 'homework-modal', 'test-modal', 'enrollment-modal', 'memo-modal', 'next-hw-modal', 'parent-msg-modal', 'temp-attendance-modal', 'bulk-confirm-modal', 'bulk-memo-modal', 'bulk-notify-modal', 'leave-request-modal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal?.style.display !== 'none') {
                modal.style.display = 'none';
            }
        });
    }
});

// ─── 일일현황표 구글시트 다운로드 ─────────────────────────────────────────────

let _pickerApiLoaded = false;
function loadPickerApi() {
    return new Promise((resolve) => {
        if (_pickerApiLoaded) { resolve(); return; }
        gapi.load('picker', () => { _pickerApiLoaded = true; resolve(); });
    });
}

function pickDriveFolder() {
    return new Promise((resolve) => {
        const token = getGoogleAccessToken();
        // 내 드라이브 폴더
        const myDriveView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setOwnedByMe(true)
            .setParent('root');
        // 공유 드라이브
        const sharedDriveView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setEnableDrives(true);
        const picker = new google.picker.PickerBuilder()
            .setTitle('저장할 폴더를 선택하세요')
            .addView(myDriveView)
            .addView(sharedDriveView)
            .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
            .setOAuthToken(token)
            .setCallback((data) => {
                if (data.action === google.picker.Action.PICKED) {
                    resolve(data.docs[0].id);
                } else if (data.action === google.picker.Action.CANCEL) {
                    resolve(null);
                }
            })
            .build();
        picker.setVisible(true);
    });
}

async function exportDailyReport() {
    let token = getGoogleAccessToken();
    if (!token) {
        if (!confirm('구글 드라이브 접근 토큰이 만료되었습니다.\n다시 로그인하시겠습니까?')) return;
        try {
            await signInWithGoogle();
            token = getGoogleAccessToken();
        } catch { return; }
        if (!token) { alert('로그인에 실패했습니다. 다시 시도해주세요.'); return; }
    }

    const dayName = getDayName(selectedDate);
    let students = allStudents.filter(s =>
        s.status !== '퇴원' &&
        s.enrollments.some(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester))
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (selectedClassCode) {
        students = students.filter(s =>
            s.enrollments.some(e =>
                e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester) && enrollmentCode(e) === selectedClassCode
            )
        );
    }

    if (students.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 폴더 선택
    await loadPickerApi();
    const folderId = await pickDriveFolder();
    if (!folderId) return; // 취소

    // 반별 정렬
    students.sort((a, b) => {
        const cA = allClassCodes(a)[0] || '';
        const cB = allClassCodes(b)[0] || '';
        return cA.localeCompare(cB, 'ko') || a.name.localeCompare(b.name, 'ko');
    });

    const HEADERS = [
        '반', '담당', '이름', '소속', '학교', '학년', '상태',
        '예정시간', '출결', '실제등원', '출결사유',
        '숙제1차', '숙제2차', '테스트1차', '테스트2차',
        '후속조치', '다음숙제',
        '귀가', '귀가시간',
        '수업→자습 전달', '학부모 전달'
    ];

    const formatOxMap = (domainData, domains) => {
        if (!domains?.length) return '';
        const parts = domains.map(d => domainData[d] ? `${d}:${domainData[d]}` : '').filter(Boolean);
        return parts.join(', ');
    };

    const formatActions = (hwAction, testAction, domains, testItems) => {
        const parts = [];
        const pushAction = (key, actionMap) => {
            const a = actionMap[key];
            if (!a?.type) return;
            if (a.type === '등원') parts.push(`${key}:등원 ${a.scheduled_date || ''} ${a.scheduled_time ? formatTime12h(a.scheduled_time) : ''}`);
            else if (a.type === '대체숙제') parts.push(`${key}:대체숙제 "${a.alt_hw || ''}"`);
            else parts.push(`${key}:${a.type}`);
        };
        domains.forEach(d => pushAction(d, hwAction));
        testItems.forEach(t => pushAction(t, testAction));
        return parts.join(', ');
    };

    const dataRows = students.map(s => {
        const todayEnroll = s.enrollments.find(e => e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester));
        const code = todayEnroll ? enrollmentCode(todayEnroll) : '';
        const rec = dailyRecords[s.docId] || {};
        const teacher = classSettings[code]?.teacher ? getTeacherName(classSettings[code].teacher) : '';
        const domains = getStudentDomains(s.docId);
        const { flat: testItems } = getStudentTestItems(s.docId);

        // 출결
        const attStatus = rec?.attendance?.status || '미확인';
        const displayAtt = attStatus === '미확인' ? '정규' : attStatus;
        const arrTime = rec?.arrival_time ? formatTime12h(rec.arrival_time) : '';
        const attReason = rec?.attendance?.reason || '';

        // 상태 (휴원이면 기간 포함)
        let statusText = s.status || '재원';
        if (LEAVE_STATUSES.includes(s.status)) {
            const p1 = s.pause_start_date || '';
            const p2 = s.pause_end_date || '';
            if (p1 || p2) statusText += ` (${p1}~${p2})`;
        }

        // 숙제/테스트 OX
        const hw1st = formatOxMap(rec.hw_domains_1st || {}, domains);
        const hw2nd = formatOxMap(rec.hw_domains_2nd || {}, domains);
        const test1st = formatOxMap(rec.test_domains_1st || {}, testItems);
        const test2nd = formatOxMap(rec.test_domains_2nd || {}, testItems);

        // 후속조치
        const actions = formatActions(rec.hw_fail_action || {}, rec.test_fail_action || {}, domains, testItems);

        // 다음숙제
        const classData = classNextHw[code]?.domains || {};
        const personalNh = rec.personal_next_hw || {};
        const nextHwParts = domains.map(d => {
            const pKey = `${code}_${d}`;
            const val = personalNh[pKey] != null && personalNh[pKey] !== '' ? personalNh[pKey] : (classData[d] || '');
            return val ? `${d}:${val}` : '';
        }).filter(Boolean);
        const nextHw = nextHwParts.join(', ');

        // 귀가
        const dep = rec.departure || {};
        const depStatus = dep.status === '귀가' ? '귀가' : '';
        const depTime = dep.time ? formatTime12h(dep.time) : '';

        // 전달사항
        const noteClass = rec.note_class_to_study || '';
        const noteParent = rec.note_to_parent || '';

        const startTime = getStudentStartTime(todayEnroll);
        return [
            code, teacher, s.name, branchFromStudent(s), s.school || '', s.grade || '', statusText,
            startTime ? formatTime12h(startTime) : '', displayAtt, arrTime, attReason,
            hw1st, hw2nd, test1st, test2nd,
            actions, nextHw,
            depStatus, depTime,
            noteClass, noteParent
        ];
    });

    showSaveIndicator('saving');
    try {
        const headerRow = {
            values: HEADERS.map(h => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: {
                    textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                    backgroundColorStyle: { rgbColor: { red: 0.263, green: 0.522, blue: 0.957 } }
                }
            }))
        };
        const bodyRows = dataRows.map(row => ({
            values: row.map(cell => ({ userEnteredValue: { stringValue: String(cell) } }))
        }));

        // 1. 구글시트 생성
        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title: `일일현황표_${selectedDate}` },
                sheets: [{
                    properties: { title: '일일현황', gridProperties: { frozenRowCount: 1 } },
                    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow, ...bodyRows] }]
                }]
            })
        });

        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const fileId = created.spreadsheetId;
        const sid = created.sheets[0].properties.sheetId;

        // 2. 선택한 폴더로 이동
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}&removeParents=root&supportsAllDrives=true&fields=id`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        }).catch(e => console.warn('폴더 이동 실패:', e));

        // 3. 필터 + 열 자동 맞춤
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                { setBasicFilter: { filter: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: dataRows.length + 1, startColumnIndex: 0, endColumnIndex: HEADERS.length } } } },
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: HEADERS.length } } }
            ]})
        }).catch(e => console.warn('서식 설정 실패:', e));

        showSaveIndicator('saved');
        window.open(created.spreadsheetUrl, '_blank');
    } catch (e) {
        showSaveIndicator('error');
        alert('구글시트 생성 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
    }
}
window.exportDailyReport = exportDailyReport;

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
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = value ? 'flex' : 'none';
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => renderListPanel(), 150);
};
window.clearSearch = () => {
    searchQuery = '';
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    renderListPanel();
};

// ─── Bulk Mode (일괄 선택) ──────────────────────────────────────────────────
window.toggleBulkMode = () => {
    if (bulkMode) exitBulkMode();
    else enterBulkMode();
};

function enterBulkMode() {
    bulkMode = true;
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) btn.classList.add('active');
    document.getElementById('bulk-action-bar').style.display = 'flex';
    document.querySelectorAll('.list-item').forEach(el => el.classList.add('bulk-mode'));
    updateBulkBar();
}

function exitBulkMode() {
    bulkMode = false;
    selectedStudentIds.clear();
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) btn.classList.remove('active');
    document.getElementById('bulk-action-bar').style.display = 'none';
    document.querySelectorAll('.list-item').forEach(el => el.classList.remove('bulk-mode', 'bulk-selected'));
    document.querySelectorAll('.list-item-checkbox').forEach(cb => cb.checked = false);
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (selectAllCb) selectAllCb.checked = false;
    // 벌크 요약 패널 숨기고 기존 상세 패널 복원
    const summaryEl = document.getElementById('bulk-summary');
    if (summaryEl) summaryEl.style.display = 'none';
    if (selectedStudentId) {
        document.getElementById('detail-empty').style.display = 'none';
        document.getElementById('detail-content').style.display = '';
        renderStudentDetail(selectedStudentId);
    } else {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
    }
}
window.exitBulkMode = exitBulkMode;

function updateBulkBar() {
    const count = selectedStudentIds.size;
    const countEl = document.getElementById('bulk-selected-count');
    if (countEl) countEl.textContent = `${count}명 선택`;
    const visibleCbs = document.querySelectorAll('.list-item-checkbox');
    const allChecked = visibleCbs.length > 0 && [...visibleCbs].every(cb => cb.checked);
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (selectAllCb) selectAllCb.checked = allChecked;
    renderBulkSummary();
}

function renderBulkSummary() {
    const summaryEl = document.getElementById('bulk-summary');
    if (!summaryEl) return;

    if (!bulkMode || selectedStudentIds.size < 2) {
        summaryEl.style.display = 'none';
        // 기존 상세 패널 복원
        if (selectedStudentId) {
            document.getElementById('detail-empty').style.display = 'none';
            document.getElementById('detail-content').style.display = '';
        } else {
            document.getElementById('detail-empty').style.display = '';
            document.getElementById('detail-content').style.display = 'none';
        }
        return;
    }

    // 벌크 요약 표시, 기존 패널 숨김
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = 'none';
    summaryEl.style.display = '';

    const ids = [...selectedStudentIds];
    const students = ids.map(id => allStudents.find(s => s.docId === id)).filter(Boolean);
    const count = students.length;

    // 이름 목록 (최대 10명)
    const nameList = count <= 10
        ? students.map(s => esc(s.name)).join(', ')
        : students.slice(0, 10).map(s => esc(s.name)).join(', ') + ` 외 ${count - 10}명`;

    // 공통 소속
    const branches = [...new Set(students.map(s => branchFromStudent(s)).filter(Boolean))];
    const commonBranch = branches.length === 1 ? branches[0] : null;

    summaryEl.innerHTML = `
        <div class="bulk-summary-header">
            <div class="bulk-summary-avatar">
                <span class="material-symbols-outlined">groups</span>
            </div>
            <div class="bulk-summary-info">
                <h2 class="bulk-summary-title">${count}명 선택됨</h2>
                ${commonBranch ? `<span class="tag">${esc(commonBranch)}</span>` : ''}
            </div>
            <button class="icon-btn detail-close-btn" onclick="exitBulkMode()" title="벌크 모드 종료" aria-label="벌크 모드 종료">
                <span class="material-symbols-outlined">close</span>
            </button>
        </div>
        <div class="bulk-summary-names">${nameList}</div>
        <div class="bulk-summary-actions">
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkAttendanceFromSummary()">
                <span class="material-symbols-outlined" style="font-size:18px;">event_available</span>
                일괄 출결
            </button>
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkOXFromSummary('hw')">
                <span class="material-symbols-outlined" style="font-size:18px;">menu_book</span>
                일괄 숙제OX
            </button>
            <button class="btn btn-secondary bulk-summary-action-btn" onclick="openBulkOXFromSummary('test')">
                <span class="material-symbols-outlined" style="font-size:18px;">quiz</span>
                일괄 테스트OX
            </button>
        </div>`;
}

window.openBulkAttendanceFromSummary = () => {
    if (selectedStudentIds.size < 2) return;
    openBulkModal('attendance');
};

window.openBulkOXFromSummary = (type) => {
    if (selectedStudentIds.size < 2) return;
    const field = type === 'test'
        ? (currentSubFilter.has('test_2nd') ? 'test_domains_2nd' : 'test_domains_1st')
        : (currentSubFilter.has('hw_2nd') ? 'hw_domains_2nd' : 'hw_domains_1st');
    // 도메인 선택 없이 모달 열기 - 사용자가 목록에서 OX 버튼을 눌러 도메인 지정
    // 여기서는 첫 번째 학생의 도메인 목록을 보여주는 선택 UI 표시
    const firstId = [...selectedStudentIds][0];
    let domains = [];
    if (type === 'test') {
        const { sections } = getStudentTestItems(firstId);
        domains = Object.values(sections).flat();
    } else {
        domains = getStudentDomains(firstId);
    }
    if (domains.length === 0) {
        showToast('해당 항목이 없습니다.');
        return;
    }
    if (domains.length === 1) {
        openBulkModal('ox', field, domains[0]);
        return;
    }
    // 여러 도메인: 도메인 선택 모달 표시
    openBulkDomainPicker(type, field, domains);
};

function openBulkDomainPicker(type, field, domains) {
    const modal = document.getElementById('bulk-confirm-modal');
    const titleEl = document.getElementById('bulk-confirm-title');
    const descEl = document.getElementById('bulk-confirm-desc');
    const namesEl = document.getElementById('bulk-confirm-names');
    const bodyEl = document.getElementById('bulk-modal-body');
    const saveBtn = document.getElementById('bulk-modal-save-btn');

    titleEl.textContent = type === 'test' ? '테스트 영역 선택' : '숙제 영역 선택';
    descEl.textContent = 'OX를 변경할 영역을 선택하세요.';
    namesEl.textContent = '';
    saveBtn.style.display = 'none';

    bodyEl.innerHTML = `<div class="bulk-domain-picker">${domains.map(d =>
        `<button class="btn btn-secondary bulk-domain-pick-btn" onclick="pickBulkDomain('${escAttr(field)}', '${escAttr(d)}')">${esc(d)}</button>`
    ).join('')}</div>`;

    // 임시로 취소 버튼만 활성화
    _bulkModalType = 'domain-picker';
    modal.style.display = 'flex';
}

window.pickBulkDomain = (field, domain) => {
    document.getElementById('bulk-confirm-modal').style.display = 'none';
    document.getElementById('bulk-modal-save-btn').style.display = '';
    _bulkModalType = null;
    openBulkModal('ox', field, domain);
};

window.toggleSelectAll = (checked) => {
    if (!bulkMode) enterBulkMode();
    document.querySelectorAll('.list-item-checkbox').forEach(cb => {
        cb.checked = checked;
        const item = cb.closest('.list-item');
        const id = item?.dataset.id;
        if (id) {
            if (checked) { selectedStudentIds.add(id); item.classList.add('bulk-selected'); }
            else { selectedStudentIds.delete(id); item.classList.remove('bulk-selected'); }
        }
    });
    updateBulkBar();
};

window.toggleStudentCheckbox = (docId, checked) => {
    if (checked) selectedStudentIds.add(docId);
    else selectedStudentIds.delete(docId);
    const item = document.querySelector(`.list-item[data-id="${docId}"]`);
    if (item) item.classList.toggle('bulk-selected', checked);
    updateBulkBar();
};

// ─── Toast Notification ─────────────────────────────────────────────────────
function showToast(message) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3000);
}

// ─── Group View ──────────────────────────────────────────────────────────────
window.toggleGroupView = () => {
    const modes = ['none', 'branch', 'class'];
    const labels = { none: 'view_agenda', branch: 'location_city', class: 'school' };
    const titles = { none: '그룹 뷰 (소속별)', branch: '그룹 뷰: 소속별 → 반별로 전환', class: '그룹 뷰: 반별 → 해제' };
    const idx = modes.indexOf(groupViewMode);
    groupViewMode = modes[(idx + 1) % modes.length];
    localStorage.setItem('dsc_groupViewMode', groupViewMode);
    const btn = document.getElementById('group-view-btn');
    if (btn) {
        btn.querySelector('.material-symbols-outlined').textContent = labels[groupViewMode];
        btn.title = titles[groupViewMode];
        btn.classList.toggle('active', groupViewMode !== 'none');
    }
    renderListPanel();
};

// ─── Bulk Action Modal ───────────────────────────────────────────────────────
let _bulkModalType = null;   // 'attendance' | 'ox'
let _bulkModalField = null;  // hw_domains_1st etc.
let _bulkModalDomain = null; // 'Gr' etc.
let _bulkModalValue = null;  // 선택된 값

function openBulkModal(type, field, domain) {
    _bulkModalType = type;
    _bulkModalField = field;
    _bulkModalDomain = domain;
    _bulkModalValue = null;

    const count = selectedStudentIds.size;
    const names = [...selectedStudentIds].map(id => allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;

    const modal = document.getElementById('bulk-confirm-modal');
    const titleEl = document.getElementById('bulk-confirm-title');
    const descEl = document.getElementById('bulk-confirm-desc');
    const namesEl = document.getElementById('bulk-confirm-names');
    const bodyEl = document.getElementById('bulk-modal-body');

    descEl.textContent = `선택된 ${count}명에게 동일하게 적용합니다.`;
    namesEl.textContent = nameList;

    if (type === 'attendance') {
        titleEl.textContent = '일괄 출결 변경';
        const statuses = ['정규', '출석', '지각', '결석', '조퇴', '기타'];
        bodyEl.innerHTML = `<div class="bulk-modal-toggle-group">${statuses.map(st =>
            `<button class="bulk-modal-toggle-btn" data-value="${esc(st)}" onclick="selectBulkValue(this, '${esc(st)}')">${esc(st)}</button>`
        ).join('')}</div>`;
    } else if (type === 'ox') {
        const label = oxFieldLabel(field);
        titleEl.textContent = `일괄 ${label} 변경`;
        const values = ['O', '△', 'X', ''];
        bodyEl.innerHTML = `<div class="bulk-modal-domain-label">${esc(domain)}</div>
            <div class="bulk-modal-toggle-group">${values.map(v =>
                `<button class="bulk-modal-toggle-btn ${oxDisplayClass(v)}" data-value="${v}" onclick="selectBulkValue(this, '${v}')">${v || '—'}</button>`
            ).join('')}</div>`;
    }

    document.getElementById('bulk-modal-save-btn').disabled = true;
    modal.style.display = 'flex';
}

window.selectBulkValue = (btn, value) => {
    _bulkModalValue = value;
    btn.closest('.bulk-modal-toggle-group').querySelectorAll('.bulk-modal-toggle-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('bulk-modal-save-btn').disabled = false;
};

function bulkApplyOxToAttended(value) {
    const attendedIds = [...selectedStudentIds].filter(id => isAttendedStatus(dailyRecords[id]?.attendance?.status));
    attendedIds.forEach(id => applyHwDomainOX(id, _bulkModalField, _bulkModalDomain, value));
    const skipped = selectedStudentIds.size - attendedIds.length;
    if (skipped > 0) showToast(`미출석 ${skipped}명 제외`);
}

window.resetBulkModal = () => {
    const modal = document.getElementById('bulk-confirm-modal');
    modal.style.display = 'none';

    if (_bulkModalType === 'attendance') {
        [...selectedStudentIds].forEach(id => applyAttendance(id, '정규', true, true));
    } else if (_bulkModalType === 'ox') {
        bulkApplyOxToAttended('');
    }
    renderSubFilters();
    renderListPanel();
    showToast(`${selectedStudentIds.size}명 초기화 완료`);
    _bulkModalType = null;
};

window.confirmBulkAction = () => {
    if (_bulkModalValue === null) return;
    const modal = document.getElementById('bulk-confirm-modal');
    modal.style.display = 'none';

    if (_bulkModalType === 'attendance') {
        [...selectedStudentIds].forEach(id => applyAttendance(id, _bulkModalValue, true, true));
        renderSubFilters();
        renderListPanel();
    } else if (_bulkModalType === 'ox') {
        bulkApplyOxToAttended(_bulkModalValue);
        renderSubFilters();
        renderListPanel();
    }
    showToast(`${selectedStudentIds.size}명 일괄 처리 완료`);
    _bulkModalType = null;
};

window.cancelBulkAction = () => {
    document.getElementById('bulk-confirm-modal').style.display = 'none';
    _bulkModalType = null;
};

window.handleListItemClick = (e, docId) => {
    if (bulkMode) {
        const cb = e.currentTarget.querySelector('.list-item-checkbox');
        if (cb && e.target !== cb) {
            cb.checked = !cb.checked;
            window.toggleStudentCheckbox(docId, cb.checked);
        }
        return;
    }
    selectStudent(docId);
};

window.changeDate = changeDate;
window.openDatePicker = openDatePicker;
window.goToday = goToday;
window.setCategory = setCategory;
if (import.meta.env?.DEV) { window._debug = { get absenceRecords() { return absenceRecords; }, get dailyRecords() { return dailyRecords; }, get selectedDate() { return selectedDate; }, set selectedDate(v) { selectedDate = v; }, get allStudents() { return allStudents; } }; }
window.setSubFilter = setSubFilter;
window.setBranch = setBranch;
window.setBranchLevel = setBranchLevel;
window.toggleAttendance = toggleAttendance;
window.cycleVisitAttendance = cycleVisitAttendance;
window.toggleHomework = toggleHomework;
window.toggleHwDomainOX = toggleHwDomainOX;
window.setClassCode = setClassCode;
window.closeSidebar = closeSidebar;
window.closeDetail = closeDetail;
window.renderStudentDetail = renderStudentDetail;

window.refreshData = async () => {
    showSaveIndicator('saving');
    await loadStudents();
    await loadSemesterSettings();
    getCurrentSemester();
    buildSemesterFilter();
    await Promise.allSettled([loadDailyRecords(selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadRoleMemos(), loadClassSettings(), loadClassNextHw(selectedDate), loadTeachers()]);
    await syncAbsenceRecords();
    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    if (selectedStudentId) renderStudentDetail(selectedStudentId);
    showSaveIndicator('saved');
};

window.selectStudent = (id) => {
    selectedStudentId = id;
    renderListPanel();
    renderStudentDetail(id);
};

window.openFollowUpAction = (studentId, category) => {
    selectStudent(studentId);
    requestAnimationFrame(() => {
        const cards = document.querySelectorAll('.hw-fail-card');
        const card = category === 'test' ? (cards[1] || cards[0]) : cards[0];
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('highlight-pulse');
            setTimeout(() => card.classList.remove('highlight-pulse'), 2000);
        }
    });
};

window.closeModal = closeModal;
window.saveSchedule = saveScheduleFromModal;
window.saveHomework = saveHomeworkFromModal;
window.saveTest = saveTestFromModal;
window.saveDailyRecord = saveDailyRecord;
window.handleAttendanceChange = handleAttendanceChange;
window.handleHomeworkStatusChange = handleHomeworkStatusChange;
window.openScheduleModal = openScheduleModal;
window.openHomeworkModal = openHomeworkModal;
window.openTestModal = openTestModal;
window.completeRetake = completeRetake;
window.cancelRetake = cancelRetake;
window.openEnrollmentModal = openEnrollmentModal;
window.saveEnrollment = saveEnrollment;
window.saveStudentScheduledTime = saveStudentScheduledTime;
window.selectNextHwClass = selectNextHwClass;
window.openNextHwModal = openNextHwModal;
window.saveNextHwFromModal = saveNextHwFromModal;
window.saveNextHwNone = saveNextHwNone;
window.openPersonalNextHwModal = openPersonalNextHwModal;
window.saveExtraVisit = saveExtraVisit;
window.addExtraVisit = addExtraVisit;
window.clearExtraVisit = clearExtraVisit;
window.addClassDomain = addClassDomain;
window.removeClassDomain = removeClassDomain;
window.resetClassDomains = resetClassDomains;
window.addTestToSection = addTestToSection;
window.removeTestFromSection = removeTestFromSection;
window.addTestSection = addTestSection;
window.removeTestSection = removeTestSection;
window.resetTestSections = resetTestSections;
window.resetTestSection = resetTestSection;
window.saveClassDefaultTime = saveClassDefaultTime;

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

// 휴퇴원요청서
window.openLeaveRequestModal = openLeaveRequestModal;
window.onLeaveRequestTypeChange = onLeaveRequestTypeChange;
window.searchLeaveRequestStudent = searchLeaveRequestStudent;
window.selectLeaveRequestStudentById = selectLeaveRequestStudentById;
window.submitLeaveRequest = submitLeaveRequest;
window.selectLeaveRequest = selectLeaveRequest;
window.selectReturnUpcomingStudent = selectReturnUpcomingStudent;
window.approveLeaveRequest = approveLeaveRequest;
window.cancelLeaveRequest = cancelLeaveRequest;

// ─── 학부모 알림 메시지 생성 ────────────────────────────────────────────────

let parentMsgStudentId = null;
let parentMsgMode = 'ai'; // 'ai' | 'manual'

const DEFAULT_PARENT_MSG_PROMPT = `영어학원 "임팩트7" 담당 선생님이 학부모님께 보내는 총평 코멘트를 작성하세요.

규칙:
- 존댓말, 따뜻한 톤. 이모지 금지
- O=통과, X=미통과, △=부분통과
- 잘한 점 칭찬, 미통과는 부드럽게 응원
- 선생님 메모가 있으면 반영
- "안녕하세요, {name} 학부모님." 으로 시작
- 개별 항목명 나열 금지 (데이터는 별도 첨부됨)
- 3-4문장, 150자 내외로 간결하게
- "감사합니다. 임팩트7"로 끝낼 것

절대 금지:
- 데이터에 없는 내용을 지어내거나 추측하지 말 것 (발표, 태도, 수업참여 등 데이터에 없으면 언급 금지)
- 숙제 데이터가 비어있으면 숙제에 대해 언급하지 말 것
- 테스트 데이터가 비어있으면 테스트에 대해 언급하지 말 것
- 출결이 "결석"이면 절대로 출석했다거나 수업을 잘 들었다고 쓰지 말 것. 결석 사실을 정확히 반영할 것
- 출결이 "지각"이면 정상 출석처럼 쓰지 말 것
- 재시, 보충, 등원 예약, 대체숙제, 후속 조치에 대해 절대 언급하지 말 것 (별도 안내됨)
- 날짜, 시간, 일정을 절대 지어내지 말 것
- 오직 제공된 학생 데이터에 존재하는 항목만 근거로 작성할 것`;

function getCustomPrompt() {
    try {
        return localStorage.getItem('parent_msg_prompt') || DEFAULT_PARENT_MSG_PROMPT;
    } catch { return DEFAULT_PARENT_MSG_PROMPT; }
}

function saveCustomPrompt() {
    const textarea = document.getElementById('parent-msg-prompt');
    if (textarea) {
        localStorage.setItem('parent_msg_prompt', textarea.value);
        showSaveIndicator('saved');
    }
}

function resetPromptToDefault() {
    const textarea = document.getElementById('parent-msg-prompt');
    if (textarea) {
        textarea.value = DEFAULT_PARENT_MSG_PROMPT;
        localStorage.removeItem('parent_msg_prompt');
        showSaveIndicator('saved');
    }
}

function togglePromptEditor() {
    const editor = document.getElementById('parent-msg-prompt-editor');
    const arrow = document.getElementById('prompt-arrow');
    if (!editor) return;
    const isHidden = editor.style.display === 'none';
    editor.style.display = isHidden ? '' : 'none';
    arrow?.classList.toggle('expanded', isHidden);
    if (isHidden) {
        const textarea = document.getElementById('parent-msg-prompt');
        if (textarea) textarea.value = getCustomPrompt();
    }
}

function collectStudentDaySummary(studentId) {
    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return null;

    const rec = dailyRecords[studentId] || {};
    const domains = getStudentDomains(studentId);
    const { flat: testItems } = getStudentTestItems(studentId);
    const checklist = getStudentChecklistStatus(studentId);

    const summary = {
        name: student.name,
        date: selectedDate,
        attendance: rec?.attendance?.status || '미확인',
        arrival_time: rec?.arrival_time || '',
        departure: rec?.departure || {},
        homework_1st: {},
        homework_2nd: {},
        test_1st: {},
        test_2nd: {},
        hw_fail_actions: {},
        test_fail_actions: {},
        extra_visit: rec.extra_visit || {},
        note: rec.note || '',
        checklist: checklist.map(c => `${c.label}: ${c.done ? '완료' : '미완료'}`).join(', ')
    };

    const hw1st = rec.hw_domains_1st || {};
    const hw2nd = rec.hw_domains_2nd || {};
    domains.forEach(d => {
        if (hw1st[d]) summary.homework_1st[d] = hw1st[d];
        if (hw2nd[d]) summary.homework_2nd[d] = hw2nd[d];
    });

    const t1st = rec.test_domains_1st || {};
    const t2nd = rec.test_domains_2nd || {};
    testItems.forEach(t => {
        if (t1st[t]) summary.test_1st[t] = t1st[t];
        if (t2nd[t]) summary.test_2nd[t] = t2nd[t];
    });

    // 1차 미통과 + 2차 미입력 → 자동 후속조치 항목 추가
    const chkHw1 = rec.hw_domains_1st || {};
    const chkHw2 = rec.hw_domains_2nd || {};
    domains.forEach(d => {
        if (chkHw1[d] && chkHw1[d] !== 'O' && chkHw2[d] !== 'O') {
            if (!summary.hw_fail_actions[d]) {
                summary.hw_fail_actions[d] = { type: '미통과', auto: true };
            }
        }
    });
    const chkT1 = rec.test_domains_1st || {};
    const chkT2 = rec.test_domains_2nd || {};
    testItems.forEach(t => {
        if (chkT1[t] && chkT1[t] !== 'O' && chkT2[t] !== 'O') {
            if (!summary.test_fail_actions[t]) {
                summary.test_fail_actions[t] = { type: '미통과', auto: true };
            }
        }
    });

    const hwAction = rec.hw_fail_action || {};
    Object.entries(hwAction).forEach(([d, a]) => {
        if (a.type) summary.hw_fail_actions[d] = { type: a.type, scheduled_date: a.scheduled_date, alt_hw: a.alt_hw };
    });

    const testAction = rec.test_fail_action || {};
    Object.entries(testAction).forEach(([t, a]) => {
        if (a.type) summary.test_fail_actions[t] = { type: a.type, scheduled_date: a.scheduled_date, alt_hw: a.alt_hw };
    });

    // hw_fail_tasks / test_fail_tasks 컬렉션에서 pending 태스크 보완
    // source_date(미통과 발생일) 또는 scheduled_date(등원 예정일)가 오늘인 태스크 포함
    const matchedHwTasks = hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const matchedTestTasks = testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    matchedHwTasks.filter(t => t.source_date === selectedDate || t.scheduled_date === selectedDate).forEach(t => {
        const key = t.domain || t.type || 'etc';
        if (!summary.hw_fail_actions[key]) {
            summary.hw_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, alt_hw: t.alt_hw };
        }
    });
    matchedTestTasks.filter(t => t.source_date === selectedDate || t.scheduled_date === selectedDate).forEach(t => {
        const key = t.domain || t.type || 'etc';
        if (!summary.test_fail_actions[key]) {
            summary.test_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, alt_hw: t.alt_hw };
        }
    });

    return summary;
}

async function generateParentMessage(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '학생 정보를 찾을 수 없습니다.';

    // PII 제거 + 후속 조치는 데이터 템플릿에서만 표시 (AI 서술에서 제외)
    const safeSummary = { ...summary };
    delete safeSummary.student_phone;
    delete safeSummary.parent_phone_1;
    delete safeSummary.parent_phone_2;
    delete safeSummary.hw_fail_actions;
    delete safeSummary.test_fail_actions;
    delete safeSummary.extra_visit;

    const customPrompt = getCustomPrompt().replace('{name}', summary.name);
    const noteSection = summary.note ? `\n\n선생님 메모:\n${summary.note}` : '';
    const teacherNote = document.getElementById('parent-msg-note')?.value?.trim();
    const teacherNoteSection = teacherNote ? `\n\n선생님 특이사항:\n${teacherNote}` : '';
    const fullPrompt = `${customPrompt}${noteSection}${teacherNoteSection}\n\n학생 데이터:\n${JSON.stringify(safeSummary, null, 2)}`;

    const result = await geminiModel.generateContent(fullPrompt);
    const aiComment = result.response.text().trim();

    // AI 코멘트 + 구분선 + 데이터 합치기
    const dataTemplate = generateDataTemplate(studentId);
    return decodeHtmlEntities(`${aiComment}\n\n────────────────\n${dataTemplate}`);
}

// 약어 → 학부모용 풀네임 변환
const DOMAIN_FULL_NAMES = {
    'Gr': 'Grammar', 'A/G': 'Applied Grammar', 'R/C': 'Reading Comprehension',
    'Vo': 'Vocabulary', 'Id': 'Idiom', 'V3': 'Verb 3형식',
    'L/C': 'Listening and Comprehension'
};
function domainFullName(abbr) { return DOMAIN_FULL_NAMES[abbr] || abbr; }

function generateDataTemplate(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '';

    // 날짜 포맷: "3/4(화)" (연도 제외, 요일 포함)
    const fmtDate = (dateStr) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const day = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
        return `${d.getMonth() + 1}/${d.getDate()}(${day})`;
    };

    const lines = [];
    lines.push(`[${fmtDate(summary.date)}] 수업 결과`);

    // 출결
    const att = summary.attendance === '미확인' ? '정규' : summary.attendance;
    lines.push(`>출결: ${att}`);

    // 영역별 흐름 생성 헬퍼 (1차 → 2차 → 후속조치)
    const formatActionStep = (action) => {
        if (!action?.type) return null;
        if (action.type === '등원') {
            const time = action.scheduled_time ? ` ${formatTime12h(action.scheduled_time)}` : '';
            return `${fmtDate(action.scheduled_date)}${time} 등원`;
        }
        if (action.type === '대체숙제') return `대체숙제 "${action.alt_hw || ''}"`;
        if (action.type === '미통과') return '보충 예정';
        return null;
    };

    const buildDomainFlow = (data1st, data2nd, actions, label) => {
        const domains = [...new Set([...Object.keys(data1st), ...Object.keys(data2nd)])];
        domains.forEach(d => {
            const steps = [];
            if (data1st[d]) steps.push(data1st[d]);
            if (data2nd[d]) steps.push(data2nd[d]);
            const step = formatActionStep(actions[d]);
            if (step) steps.push(step);
            lines.push(`>${domainFullName(d)} ${label}: ${steps.join(' → ')}`);
        });
    };

    // 숙제
    buildDomainFlow(summary.homework_1st, summary.homework_2nd, summary.hw_fail_actions, '숙제');

    // 테스트
    buildDomainFlow(summary.test_1st, summary.test_2nd, summary.test_fail_actions, '테스트');

    // 클리닉
    const ev = summary.extra_visit;
    if (ev.date) {
        const evTime = ev.time ? ` ${formatTime12h(ev.time)}` : '';
        const evReason = ev.reason ? ` (${ev.reason})` : '';
        lines.push(`>클리닉: ${fmtDate(ev.date)}${evTime}${evReason}`);
    }

    // 다음 숙제
    const student = allStudents.find(s => s.docId === studentId);
    if (student) {
        const dayName = getDayName(selectedDate);
        const todayEnrolls = student.enrollments.filter(e =>
            e.day.includes(dayName) && (!selectedSemester || e.semester === selectedSemester)
        );
        const NEXT_HW_NAMES = {
            'Gr': '문법', 'A/G': '실전문법', 'R/C': '독해',
            'Vo': 'Vocabulary', 'Id': 'Idiom', 'V3': 'Verb 3형식',
            'L/C': '청해', 'Su': '써머리', 'Sm': '써머리'
        };
        const DOMAIN_ALIASES = { '듣기': '청해', '실전': '실전문법' };
        const nextHwName = (abbr) => {
            const name = NEXT_HW_NAMES[abbr] || abbr;
            return DOMAIN_ALIASES[name] || name;
        };
        const nextHwEntries = [];
        const seenHw = new Set();
        todayEnrolls.forEach(e => {
            const code = enrollmentCode(e);
            const data = classNextHw[code]?.domains || {};
            Object.entries(data).forEach(([d, v]) => {
                if (!v) return;
                const content = v.trim();
                if (!content || content === '없음') return;
                const display = nextHwName(d);
                const key = `${display}::${content}`;
                if (!seenHw.has(key)) {
                    seenHw.add(key);
                    nextHwEntries.push(`${display}: ${content}`);
                }
            });
        });
        if (nextHwEntries.length > 0) {
            lines.push('');
            lines.push('> 다음 숙제:');
            nextHwEntries.forEach(entry => lines.push(`  - ${entry}`));
        }
    }

    return lines.join('\n');
}

function generateManualTemplate(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '';

    const header = `안녕하세요, ${summary.name} 학부모님.\n`;
    const data = generateDataTemplate(studentId);
    const footer = '\n\n감사합니다. 임팩트7';

    return decodeHtmlEntities(header + data + footer);
}

function switchParentMsgTab(mode) {
    parentMsgMode = mode;
    document.getElementById('parent-msg-tab-ai').classList.toggle('active', mode === 'ai');
    document.getElementById('parent-msg-tab-manual').classList.toggle('active', mode === 'manual');
    document.getElementById('parent-msg-ai-panel').style.display = mode === 'ai' ? '' : 'none';
    document.getElementById('parent-msg-manual-panel').style.display = mode === 'manual' ? '' : 'none';

    if (mode === 'manual' && parentMsgStudentId) {
        const manualText = document.getElementById('parent-msg-manual-text');
        if (manualText && !manualText.value) {
            manualText.value = generateManualTemplate(parentMsgStudentId);
        }
    }
}

function openParentMessageModal(studentId) {
    parentMsgStudentId = studentId;
    parentMsgMode = 'ai';

    document.getElementById('parent-msg-modal').style.display = '';
    document.getElementById('parent-msg-tab-ai').classList.add('active');
    document.getElementById('parent-msg-tab-manual').classList.remove('active');
    document.getElementById('parent-msg-ai-panel').style.display = '';
    document.getElementById('parent-msg-manual-panel').style.display = 'none';
    document.getElementById('parent-msg-loading').style.display = 'none';
    document.getElementById('parent-msg-text').style.display = '';
    document.getElementById('parent-msg-text').value = '';
    document.getElementById('parent-msg-copied').style.display = 'none';

    // 프롬프트 에디터 접기
    const editor = document.getElementById('parent-msg-prompt-editor');
    if (editor) editor.style.display = 'none';
    const arrow = document.getElementById('prompt-arrow');
    if (arrow) arrow.classList.remove('expanded');

    // 특이사항 & Manual 초기화
    const noteInput = document.getElementById('parent-msg-note');
    if (noteInput) noteInput.value = '';
    const manualText = document.getElementById('parent-msg-manual-text');
    if (manualText) manualText.value = '';
}

async function regenerateParentMessage() {
    if (!parentMsgStudentId) return;
    if (parentMsgMode === 'ai') {
        const loadingEl = document.getElementById('parent-msg-loading');
        const msgTextEl = document.getElementById('parent-msg-text');
        if (loadingEl) {
            loadingEl.style.display = '';
            loadingEl.innerHTML = `<div class="spinner"></div>
            Gemini가 알림 메시지를 작성하고 있습니다...`;
        }
        if (msgTextEl) msgTextEl.style.display = 'none';
        try {
            const message = await generateParentMessage(parentMsgStudentId);
            if (msgTextEl) { msgTextEl.value = message; msgTextEl.style.display = ''; }
            if (loadingEl) loadingEl.style.display = 'none';
        } catch (err) {
            console.error('메시지 재생성 실패:', err);
            if (loadingEl) loadingEl.innerHTML = `
                <span class="material-symbols-outlined" style="font-size:28px;color:var(--danger);">error</span>
                메시지 생성에 실패했습니다.<br><span style="font-size:11px;">${esc(err.message)}</span>`;
        }
    } else {
        const manualText = document.getElementById('parent-msg-manual-text');
        if (manualText) manualText.value = generateManualTemplate(parentMsgStudentId);
    }
}

function copyParentMessage() {
    const textEl = parentMsgMode === 'ai'
        ? document.getElementById('parent-msg-text')
        : document.getElementById('parent-msg-manual-text');
    if (!textEl) return;
    navigator.clipboard.writeText(textEl.value).then(() => {
        const copied = document.getElementById('parent-msg-copied');
        if (copied) {
            copied.style.display = '';
            setTimeout(() => { copied.style.display = 'none'; }, 2000);
        }
    }).catch(err => {
        console.error('클립보드 복사 실패:', err);
        alert('클립보드 복사에 실패했습니다.');
    });
}

window.openParentMessageModal = openParentMessageModal;
window.regenerateParentMessage = regenerateParentMessage;
window.copyParentMessage = copyParentMessage;
window.switchParentMsgTab = switchParentMsgTab;
window.togglePromptEditor = togglePromptEditor;
window.saveCustomPrompt = saveCustomPrompt;
window.resetPromptToDefault = resetPromptToDefault;

// ─── 비정규 완료 처리 ─────────────────────────────────────────────────────

async function completeScheduledVisit(source, docId, studentId) {
    showSaveIndicator('saving');
    try {
        const completedBy = (currentUser?.email || '').split('@')[0];

        const completedAt = new Date().toISOString();

        if (source === 'temp') {
            await updateDoc(doc(db, 'temp_attendance', docId), { visit_status: '완료', completed_by: completedBy, completed_at: completedAt });
            const ta = tempAttendances.find(t => t.docId === docId);
            if (ta) { ta.visit_status = '완료'; ta.completed_by = completedBy; ta.completed_at = completedAt; }
        } else if (source === 'hw_fail') {
            await updateDoc(doc(db, 'hw_fail_tasks', docId), {
                status: '완료',
                completed_by: completedBy,
                completed_at: completedAt
            });
            const t = hwFailTasks.find(t => t.docId === docId);
            if (t) { t.status = '완료'; t.completed_by = completedBy; t.completed_at = completedAt; }
        } else if (source === 'test_fail') {
            await updateDoc(doc(db, 'test_fail_tasks', docId), {
                status: '완료',
                completed_by: completedBy,
                completed_at: completedAt
            });
            const t = testFailTasks.find(t => t.docId === docId);
            if (t) { t.status = '완료'; t.completed_by = completedBy; t.completed_at = completedAt; }
        } else if (source === 'extra') {
            // docId is studentId for extra_visit
            const rec = dailyRecords[docId] || {};
            const ev = rec.extra_visit || {};
            ev.visit_status = '완료';
            ev.completed_by = completedBy;
            ev.completed_at = completedAt;
            await saveImmediately(docId, { extra_visit: ev });
            if (dailyRecords[docId]) dailyRecords[docId].extra_visit = ev;
        }

        renderSubFilters();
        renderListPanel();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('비정규 완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

async function resetScheduledVisit(source, docId, studentId) {
    showSaveIndicator('saving');
    try {
        if (source === 'temp') {
            await updateDoc(doc(db, 'temp_attendance', docId), { visit_status: 'pending', completed_by: deleteField(), completed_at: deleteField() });
            const ta = tempAttendances.find(t => t.docId === docId);
            if (ta) { ta.visit_status = 'pending'; delete ta.completed_by; delete ta.completed_at; }
        } else if (source === 'hw_fail') {
            await updateDoc(doc(db, 'hw_fail_tasks', docId), {
                status: 'pending',
                completed_by: deleteField(),
                completed_at: deleteField()
            });
            const t = hwFailTasks.find(t => t.docId === docId);
            if (t) { t.status = 'pending'; delete t.completed_by; delete t.completed_at; }
        } else if (source === 'test_fail') {
            await updateDoc(doc(db, 'test_fail_tasks', docId), {
                status: 'pending',
                completed_by: deleteField(),
                completed_at: deleteField()
            });
            const t = testFailTasks.find(t => t.docId === docId);
            if (t) { t.status = 'pending'; delete t.completed_by; delete t.completed_at; }
        } else if (source === 'extra') {
            const rec = dailyRecords[docId] || {};
            const ev = rec.extra_visit || {};
            ev.visit_status = 'pending';
            delete ev.completed_by;
            delete ev.completed_at;
            await saveImmediately(docId, { extra_visit: ev });
            if (dailyRecords[docId]) dailyRecords[docId].extra_visit = ev;
        }

        renderSubFilters();
        renderListPanel();
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('비정규 초기화 실패:', err);
        showSaveIndicator('error');
    }
}

function cycleVisitStatus(source, docId, studentId) {
    // 현재 상태
    let currentStatus;
    if (_visitStatusPending[docId]) {
        currentStatus = _visitStatusPending[docId].nextStatus;
    } else if (source === 'temp') {
        currentStatus = tempAttendances.find(t => t.docId === docId)?.visit_status || 'pending';
    } else if (source === 'hw_fail') {
        currentStatus = hwFailTasks.find(t => t.docId === docId)?.status || 'pending';
    } else if (source === 'test_fail') {
        currentStatus = testFailTasks.find(t => t.docId === docId)?.status || 'pending';
    } else if (source === 'extra') {
        currentStatus = dailyRecords[docId]?.extra_visit?.visit_status || 'pending';
    }

    // 다음 상태로 토글
    const nextIdx = (VISIT_STATUS_CYCLE.indexOf(currentStatus) + 1) % VISIT_STATUS_CYCLE.length;
    const nextStatus = VISIT_STATUS_CYCLE[nextIdx];
    // 이전 pending 상태 모두 클리어 (마지막 토글만 유지)
    for (const key of Object.keys(_visitStatusPending)) {
        if (key !== docId) {
            // 이전 항목 UI 원복
            const oldBtn = document.querySelector(`[data-visit-id="${key}"]`);
            if (oldBtn) {
                const old = _visitStatusPending[key];
                // 원래 상태로 되돌리기: nextStatus의 이전 상태
                const prevIdx = (VISIT_STATUS_CYCLE.indexOf(old.nextStatus) - 1 + VISIT_STATUS_CYCLE.length) % VISIT_STATUS_CYCLE.length;
                const prevStatus = VISIT_STATUS_CYCLE[prevIdx];
                const label = prevStatus === 'pending' ? '미완료' : prevStatus;
                const { cls, sty } = _visitBtnStyles(prevStatus);
                oldBtn.textContent = label;
                oldBtn.className = `toggle-btn ${cls}`.trim();
                oldBtn.style.cssText = sty;
            }
        }
    }
    _visitStatusPending = {};
    _visitStatusPending[docId] = { source, nextStatus, studentId };

    // 버튼 텍스트+스타일 즉시 변경
    const btn = document.querySelector(`[data-visit-id="${docId}"]`);
    if (btn) {
        const label = nextStatus === 'pending' ? '미완료' : nextStatus;
        const { cls, sty } = _visitBtnStyles(nextStatus);
        btn.textContent = label;
        btn.className = `toggle-btn ${cls}`.trim();
        btn.style.cssText = sty;
    }
}

async function confirmVisitStatus(docId) {
    let pending = _visitStatusPending[docId];
    if (!pending) {
        // 토글 안 했으면 현재 상태 그대로 '완료' 처리
        const visits = getScheduledVisits();
        const v = visits.find(vi => vi.docId === docId);
        if (!v) return;
        pending = { source: v.source, nextStatus: '완료', studentId: v.studentId };
    }
    delete _visitStatusPending[docId];

    const { source, nextStatus, studentId } = pending;

    if (nextStatus === 'pending') {
        await resetScheduledVisit(source, docId, studentId);
    } else if (nextStatus === '완료') {
        await completeScheduledVisit(source, docId, studentId);
    } else {
        // '기타'
        showSaveIndicator('saving');
        try {
            const completedBy = (currentUser?.email || '').split('@')[0];
            const completedAt = new Date().toISOString();
            const statusPayload = { completed_by: completedBy, completed_at: completedAt };

            if (source === 'temp') {
                await updateDoc(doc(db, 'temp_attendance', docId), { visit_status: '기타', ...statusPayload });
                const ta = tempAttendances.find(t => t.docId === docId);
                if (ta) Object.assign(ta, { visit_status: '기타', ...statusPayload });
            } else if (source === 'hw_fail') {
                await updateDoc(doc(db, 'hw_fail_tasks', docId), { status: '기타', ...statusPayload });
                const t = hwFailTasks.find(t => t.docId === docId);
                if (t) Object.assign(t, { status: '기타', ...statusPayload });
            } else if (source === 'test_fail') {
                await updateDoc(doc(db, 'test_fail_tasks', docId), { status: '기타', ...statusPayload });
                const t = testFailTasks.find(t => t.docId === docId);
                if (t) Object.assign(t, { status: '기타', ...statusPayload });
            } else if (source === 'extra') {
                const ev = dailyRecords[docId]?.extra_visit || {};
                Object.assign(ev, { visit_status: '기타', ...statusPayload });
                await saveImmediately(docId, { extra_visit: ev });
                if (dailyRecords[docId]) dailyRecords[docId].extra_visit = ev;
            }

            renderSubFilters();
            renderListPanel();
            if (selectedStudentId) renderStudentDetail(selectedStudentId);
            showSaveIndicator('saved');
        } catch (err) {
            console.error('비정규 기타 처리 실패:', err);
            showSaveIndicator('error');
        }
    }
}

window.completeScheduledVisit = completeScheduledVisit;
window.resetScheduledVisit = resetScheduledVisit;
window.cycleVisitStatus = cycleVisitStatus;
window.confirmVisitStatus = confirmVisitStatus;

// ─── contacts 로딩 ────────────────────────────────────────────────────────

async function loadContacts() {
    try {
        const snapshot = await getDocs(collection(db, 'contacts'));
        allContacts = [];
        snapshot.forEach((docSnap) => {
            allContacts.push({ id: docSnap.id, ...docSnap.data() });
        });
        allContacts.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    } catch (error) {
        console.error('[FIRESTORE ERROR] Failed to load contacts:', error);
    }
}

// ─── 진단평가 ──────────────────────────────────────────────────────────────

function _makeContactDocId(name, phone) {
    let p = (phone || '').replace(/\D/g, '');
    if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
    return `${name}_${p}`.replace(/\s+/g, '_');
}

let _lastTempAutofillId = null;

function _tryTempContactAutofill() {
    const name = document.getElementById('temp-att-name')?.value.trim();
    const phone = document.getElementById('temp-att-parent-phone')?.value.trim();
    if (!name || !phone) return;

    const docId = _makeContactDocId(name, phone);
    if (docId === _lastTempAutofillId) return;

    const contact = allContacts.find(c => c.id === docId);
    if (!contact) return;

    _lastTempAutofillId = docId;

    const setIfEmpty = (id, val) => {
        const el = document.getElementById(id);
        if (el && !el.value && val) el.value = val;
    };

    // level/branch는 빈 값이면 채움
    const levelEl = document.getElementById('temp-att-level');
    if (levelEl && !levelEl.value && contact.level) levelEl.value = contact.level;
    const branchEl = document.getElementById('temp-att-branch');
    if (branchEl && !branchEl.value && contact.branch) branchEl.value = contact.branch;

    setIfEmpty('temp-att-school', contact.school);
    setIfEmpty('temp-att-grade', contact.grade);
    setIfEmpty('temp-att-student-phone', contact.student_phone);

    // 자동채움 알림
    const hint = document.getElementById('temp-att-autofill-hint');
    if (hint) {
        hint.textContent = `연락처에서 "${contact.name}" 정보를 불러왔습니다`;
        hint.style.display = 'block';
        setTimeout(() => { hint.style.display = 'none'; }, 3000);
    }
}

function openTempAttendanceModal() {
    _editingTempDocId = null;
    _lastTempAutofillId = null;
    document.getElementById('temp-att-modal-title').textContent = '첫데이터 및 진단평가입력';
    document.getElementById('temp-att-save-btn').textContent = '저장';
    document.getElementById('temp-att-edit-history').innerHTML = '';
    document.getElementById('temp-att-name').value = '';
    document.getElementById('temp-att-branch').value = '';
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

async function _syncContactsForTemp(data) {
    if (!data.parent_phone_1) return;
    try {
        let phone = data.parent_phone_1.replace(/\D/g, '');
        if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
        const contactDocId = `${data.name}_${phone}`.replace(/\s+/g, '_');
        await setDoc(doc(db, 'contacts', contactDocId), {
            name: data.name,
            level: data.level || '',
            school: data.school || '',
            grade: data.grade || '',
            student_phone: data.student_phone || '',
            parent_phone_1: data.parent_phone_1,
            first_registered: data.temp_date,
            updated_at: serverTimestamp(),
        }, { merge: true });
    } catch (contactErr) {
        console.warn('[CONTACTS SYNC]', contactErr);
    }
}

async function saveTempAttendance() {
    const name = document.getElementById('temp-att-name').value.trim();
    if (!name) { alert('이름을 입력하세요.'); return; }

    const data = {
        name,
        branch: document.getElementById('temp-att-branch').value,
        school: document.getElementById('temp-att-school').value.trim(),
        level: document.getElementById('temp-att-level').value,
        grade: document.getElementById('temp-att-grade').value.trim(),
        student_phone: document.getElementById('temp-att-student-phone').value.trim(),
        parent_phone_1: document.getElementById('temp-att-parent-phone').value.trim(),
        memo: document.getElementById('temp-att-memo').value.trim(),
        temp_date: document.getElementById('temp-att-date').value,
        temp_time: document.getElementById('temp-att-time').value,
    };

    try {
        if (_editingTempDocId) {
            // ── 수정 모드 ──
            const existing = tempAttendances.find(t => t.docId === _editingTempDocId);
            if (!existing) { alert('원본 데이터를 찾을 수 없습니다.'); return; }

            const editableFields = Object.keys(TEMP_FIELD_LABELS);
            const before = {};
            const after = {};
            for (const key of editableFields) {
                const oldVal = (existing[key] || '').toString();
                const newVal = (data[key] || '').toString();
                if (oldVal !== newVal) {
                    before[key] = oldVal;
                    after[key] = newVal;
                }
            }

            if (Object.keys(after).length === 0) {
                alert('변경된 내용이 없습니다.');
                return;
            }

            const historyEntry = {
                before,
                after,
                edited_by: currentUser?.email || '',
                edited_at: new Date().toISOString()
            };

            await Promise.all([
                updateDoc(doc(db, 'temp_attendance', _editingTempDocId), {
                    ...data,
                    updated_by: currentUser?.email || '',
                    updated_at: serverTimestamp(),
                    edit_history: arrayUnion(historyEntry)
                }),
                _syncContactsForTemp(data)
            ]);

            // 로컬 캐시 업데이트
            Object.assign(existing, data);
            existing.updated_by = currentUser?.email || '';
            if (!existing.edit_history) existing.edit_history = [];
            existing.edit_history.push(historyEntry);

            document.getElementById('temp-attendance-modal').style.display = 'none';

            renderSubFilters();
            renderListPanel();
            renderTempAttendanceDetail(_editingTempDocId);
            showSaveIndicator('saved');
        } else {
            // ── 생성 모드 ──
            data.created_at = serverTimestamp();
            data.created_by = currentUser?.email || '';

            await Promise.all([
                addDoc(collection(db, 'temp_attendance'), data),
                _syncContactsForTemp(data)
            ]);
            document.getElementById('temp-attendance-modal').style.display = 'none';

            const savedDate = data.temp_date;
            if (savedDate === selectedDate) {
                await loadTempAttendances(selectedDate);
                renderSubFilters();
                renderListPanel();
            }
            showSaveIndicator('saved');
        }
    } catch (err) {
        console.error('진단평가 저장 실패:', err);
        alert(`저장에 실패했습니다.\n${err.message || err}`);
    }
}

function openTempAttendanceForEdit(docId) {
    const ta = tempAttendances.find(t => t.docId === docId);
    if (!ta) return;

    _editingTempDocId = docId;
    _lastTempAutofillId = null;

    document.getElementById('temp-att-modal-title').textContent = '첫데이터 및 진단평가 수정';
    document.getElementById('temp-att-save-btn').textContent = '수정';

    document.getElementById('temp-att-name').value = ta.name || '';
    document.getElementById('temp-att-branch').value = ta.branch || '';
    document.getElementById('temp-att-school').value = ta.school || '';
    document.getElementById('temp-att-level').value = ta.level || '';
    document.getElementById('temp-att-grade').value = ta.grade || '';
    document.getElementById('temp-att-student-phone').value = ta.student_phone || '';
    document.getElementById('temp-att-parent-phone').value = ta.parent_phone_1 || '';
    document.getElementById('temp-att-memo').value = ta.memo || '';
    document.getElementById('temp-att-date').value = ta.temp_date || selectedDate;
    document.getElementById('temp-att-time').value = ta.temp_time || '';

    renderTempEditHistory(ta.edit_history);

    document.getElementById('temp-attendance-modal').style.display = '';
}

function renderTempEditHistory(history) {
    const container = document.getElementById('temp-att-edit-history');
    if (!container) return;
    if (!history || !history.length) { container.innerHTML = ''; return; }

    const sorted = [...history].sort((a, b) => (b.edited_at || '').localeCompare(a.edited_at || ''));
    container.innerHTML = `
        <div class="temp-edit-history">
            <div class="temp-edit-history-title">수정 이력 (${sorted.length}건)</div>
            ${sorted.map(h => {
                const dt = h.edited_at ? new Date(h.edited_at) : null;
                const dateStr = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}` : '';
                const editor = (h.edited_by || '').replace(/@(gw\.)?impact7\.kr$/, '');
                const changes = Object.keys(h.after || {}).map(key => {
                    const label = TEMP_FIELD_LABELS[key] || key;
                    const before = (h.before && h.before[key]) || '(없음)';
                    const after = h.after[key] || '(없음)';
                    return `<div class="temp-edit-history-change"><span class="field-name">${esc(label)}</span>: ${esc(before)} → ${esc(after)}</div>`;
                }).join('');
                return `<div class="temp-edit-history-item">
                    <div class="temp-edit-history-meta">${dateStr} · ${esc(editor)}</div>
                    ${changes}
                </div>`;
            }).join('')}
        </div>
    `;
}

window.openTempAttendanceModal = openTempAttendanceModal;
window.openTempAttendanceForEdit = openTempAttendanceForEdit;
window.saveTempAttendance = saveTempAttendance;

// 과거 연락처 클릭 → 진단평가 모달 열기 + 자동채움
window.openContactAsTemp = function(contactId) {
    const c = allContacts.find(ct => ct.id === contactId);
    if (!c) return;
    openTempAttendanceModal();
    document.getElementById('temp-att-name').value = c.name || '';
    document.getElementById('temp-att-branch').value = c.branch || '';
    document.getElementById('temp-att-school').value = c.school || '';
    document.getElementById('temp-att-level').value = c.level || '';
    document.getElementById('temp-att-grade').value = c.grade || '';
    document.getElementById('temp-att-student-phone').value = c.student_phone || '';
    document.getElementById('temp-att-parent-phone').value = c.parent_phone_1 || '';
};

// 이름·학부모전화 입력 후 contacts 자동채움 이벤트
document.getElementById('temp-att-parent-phone')?.addEventListener('change', _tryTempContactAutofill);
document.getElementById('temp-att-parent-phone')?.addEventListener('blur', _tryTempContactAutofill);
document.getElementById('temp-att-name')?.addEventListener('change', _tryTempContactAutofill);

// ─── 일괄 메모 ──────────────────────────────────────────────────────────────

function openBulkMemo() {
    if (selectedStudentIds.size === 0) { alert('학생을 선택하세요.'); return; }
    const count = selectedStudentIds.size;
    const names = [...selectedStudentIds].map(id => allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;
    document.getElementById('bulk-memo-desc').textContent = `${count}명 선택: ${nameList}`;
    document.getElementById('bulk-memo-text').value = '';
    document.getElementById('bulk-memo-modal').style.display = 'flex';
}

async function saveBulkMemo() {
    const text = document.getElementById('bulk-memo-text').value.trim();
    if (!text) { alert('메모 내용을 입력하세요.'); return; }

    showSaveIndicator('saving');
    try {
        const ids = [...selectedStudentIds];
        for (const studentId of ids) {
            const rec = dailyRecords[studentId] || {};
            const existing = rec.note || '';
            const newNote = existing ? `${existing}\n${text}` : text;
            await saveImmediately(studentId, { note: newNote });
        }
        document.getElementById('bulk-memo-modal').style.display = 'none';
        showSaveIndicator('saved');
        if (selectedStudentId) renderStudentDetail(selectedStudentId);
    } catch (err) {
        console.error('일괄 메모 저장 실패:', err);
        showSaveIndicator('error');
    }
}

window.openBulkMemo = openBulkMemo;
window.saveBulkMemo = saveBulkMemo;

// ─── 일괄 학부모 알림 ───────────────────────────────────────────────────────

function openBulkNotify() {
    if (selectedStudentIds.size === 0) { alert('학생을 선택하세요.'); return; }
    const count = selectedStudentIds.size;
    const names = [...selectedStudentIds].map(id => allStudents.find(s => s.docId === id)?.name).filter(Boolean);
    const nameList = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + ` 외 ${names.length - 5}명`;
    document.getElementById('bulk-notify-desc').textContent = `${count}명 선택: ${nameList}`;
    document.getElementById('bulk-notify-text').value = '';
    document.getElementById('bulk-notify-modal').style.display = 'flex';
}

async function saveBulkNotify() {
    const text = document.getElementById('bulk-notify-text').value.trim();
    if (!text) { alert('알림 메시지를 입력하세요.'); return; }

    const ids = [...selectedStudentIds];
    const lines = [];
    for (const studentId of ids) {
        const student = allStudents.find(s => s.docId === studentId);
        if (!student) continue;
        lines.push(`[${student.name}] ${text}`);
    }
    const fullMessage = lines.join('\n');

    try {
        await navigator.clipboard.writeText(fullMessage);
        document.getElementById('bulk-notify-modal').style.display = 'none';
        alert(`${ids.length}명의 알림 메시지가 클립보드에 복사되었습니다.`);
    } catch (err) {
        console.error('클립보드 복사 실패:', err);
        alert('클립보드 복사에 실패했습니다. 직접 복사해주세요.\n\n' + fullMessage);
    }
}

window.openBulkNotify = openBulkNotify;
window.saveBulkNotify = saveBulkNotify;

console.log('[DailyOps] App initialized.');

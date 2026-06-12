import {
    collection, getDocs, query, where
} from 'firebase/firestore';
import {
    currentSchool,
    normalizeRealLevelGrade,
    studentFullLabel,
    LEVEL_SHORT,
} from '@impact7/shared/student-label';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { db } from '../../firebase-config.js';
import { enrollmentCode, branchFromStudent } from '../../student-core.js';

// 학부별 학기 정의 (impact7db.web.app 설정과 동일하게 유지)
export const LEVEL_SEMESTERS = {
    '초등': ['winter', 'spring1', 'spring2', 'summer', 'autumn'],
    '중등': ['winter', 'spring', 'summer', 'autumn'],
    '고등': ['winter', 'spring', 'autumn'],
};

// semester_settings 전체 로드
export async function fetchSemesterSettings() {
    const snap = await getDocs(collection(db, 'semester_settings'));
    const map = {};
    snap.forEach(d => { map[d.id] = d.data(); });
    return map;
}

// 특정 날짜 + 레벨에 해당하는 학기 반환
// key 형식: `{level}-{year}-{name}` (신규) 또는 `{year}-{Name}` (구형)
export function getSemesterForDate(dateStr, level, semesterSettings) {
    const entries = Object.entries(semesterSettings)
        .filter(([key]) => key.startsWith(`${level}-`))
        .filter(([, v]) => v.start_date)
        .sort((a, b) => a[1].start_date.localeCompare(b[1].start_date));

    let result = null;
    for (const [key, { start_date }] of entries) {
        if (start_date <= dateStr) result = key;
    }
    return result; // e.g. "초등-2026-spring1"
}

// 날짜 기준 전체 레벨 학기 맵 반환
export function getSemestersForDate(dateStr, semesterSettings) {
    return Object.fromEntries(
        Object.keys(LEVEL_SEMESTERS).map(level => [
            level,
            getSemesterForDate(dateStr, level, semesterSettings),
        ])
    );
}

// 학생 전체 목록 (재원 학생만 — 퇴원 제외, 상담 포함)
export async function fetchStudents() {
    const [activeSnap, specialSnap] = await Promise.all([
        getDocs(query(
            collection(db, 'students'),
            where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원', '상담'])
        )),
        getDocs(query(
            collection(db, 'students'),
            where('status2', '==', '특강')
        )),
    ]);
    const list = [];
    const seenIds = new Set();
    const addDoc = (docSnap) => {
        if (seenIds.has(docSnap.id)) return;
        seenIds.add(docSnap.id);
        const data = { id: docSnap.id, ...docSnap.data() };
        data.enrollments = normalizeEnrollments(data);
        list.push(data);
    };
    activeSnap.forEach(addDoc);
    specialSnap.forEach(addDoc);
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    return list;
}

// 특정 날짜의 daily_checks
export async function fetchDailyChecks(date) {
    const q = query(
        collection(db, 'daily_checks'),
        where('date', '==', date)
    );
    const snap = await getDocs(q);
    const map = {};
    snap.forEach(docSnap => {
        map[docSnap.id] = docSnap.data();
    });
    return map;
}

// 기간별 daily_checks (startDate ~ endDate 포함)
export async function fetchDailyChecksRange(startDate, endDate) {
    const q = query(
        collection(db, 'daily_checks'),
        where('date', '>=', startDate),
        where('date', '<=', endDate)
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

// 특정 날짜의 pending 연기 작업
export async function fetchPostponedTasks(date) {
    const q = query(
        collection(db, 'postponed_tasks'),
        where('scheduled_date', '==', date),
        where('status', '==', 'pending')
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

// 기간별 연기 작업 (전체 상태)
export async function fetchPostponedTasksRange(startDate, endDate) {
    const q = query(
        collection(db, 'postponed_tasks'),
        where('scheduled_date', '>=', startDate),
        where('scheduled_date', '<=', endDate)
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

export async function fetchClassSettingsMap() {
    const snap = await getDocs(collection(db, 'class_settings'));
    const map = {};
    snap.forEach(docSnap => {
        map[docSnap.id] = docSnap.data();
    });
    return map;
}

export async function fetchDailyRecordsForDate(date) {
    const q = query(
        collection(db, 'daily_records'),
        where('date', '==', date)
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

export async function fetchDailyRecordsRange(startDate, endDate) {
    const q = query(
        collection(db, 'daily_records'),
        where('date', '>=', startDate),
        where('date', '<=', endDate)
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

export async function fetchTempAttendancesForDate(date) {
    const q = query(
        collection(db, 'temp_attendance'),
        where('temp_date', '==', date)
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list;
}

async function fetchScheduledTaskRows(collectionName, date) {
    const scheduledQ = query(
        collection(db, collectionName),
        where('scheduled_date', '==', date)
    );
    const sourceQ = query(
        collection(db, collectionName),
        where('source_date', '==', date)
    );
    const [scheduledSnap, sourceSnap] = await Promise.all([
        getDocs(scheduledQ),
        getDocs(sourceQ),
    ]);
    const map = new Map();
    const add = (docSnap) => map.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    scheduledSnap.forEach(add);
    sourceSnap.forEach(add);
    return [...map.values()];
}

export async function fetchAbsenceRecordsForDailyLog(date) {
    const absenceQ = query(
        collection(db, 'absence_records'),
        where('absence_date', '==', date)
    );
    const makeupQ = query(
        collection(db, 'absence_records'),
        where('makeup_date', '==', date)
    );
    const [absenceSnap, makeupSnap] = await Promise.all([
        getDocs(absenceQ),
        getDocs(makeupQ),
    ]);
    const map = new Map();
    const add = (docSnap) => map.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    absenceSnap.forEach(add);
    makeupSnap.forEach(add);
    return [...map.values()];
}

const dateFromFirestoreValue = (value) => {
    if (!value) return null;
    if (value.toDate) return value.toDate();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const finalApprovalDate = (request) => {
    const dates = [request.approved_at, request.teacher_approved_at]
        .map(dateFromFirestoreValue)
        .filter(Boolean);
    if (!dates.length) return null;
    return new Date(Math.max(...dates.map(date => date.getTime())));
};

export async function fetchApprovedLeaveRequestsForDate(date) {
    const q = query(
        collection(db, 'leave_requests'),
        where('status', '==', 'approved')
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        const data = { id: docSnap.id, ...docSnap.data() };
        const approvedDate = finalApprovalDate(data);
        if (approvedDate && toDateStrKST(approvedDate) === date) {
            list.push({ ...data, final_approved_at: approvedDate });
        }
    });
    return list;
}

export async function fetchDashboardDailyLogData(date) {
    const [
        dailyRecords,
        tempAttendances,
        hwFailTasks,
        testFailTasks,
        absenceRecords,
        leaveRequests,
        classSettings,
    ] = await Promise.all([
        fetchDailyRecordsForDate(date),
        fetchTempAttendancesForDate(date),
        fetchScheduledTaskRows('hw_fail_tasks', date),
        fetchScheduledTaskRows('test_fail_tasks', date),
        fetchAbsenceRecordsForDailyLog(date),
        fetchApprovedLeaveRequestsForDate(date),
        fetchClassSettingsMap(),
    ]);
    return {
        dailyRecords,
        tempAttendances,
        hwFailTasks,
        testFailTasks,
        absenceRecords,
        leaveRequests,
        classSettings,
    };
}

// 참고: 발송 현황은 message_queue 직접 read를 쓰지 않는다 — 평문 번호 노출 차단을 위해
// getMessageDeliveryStatus callable(서버 집계+마스킹)을 useMessageDelivery에서 호출한다.

// ─── 유틸 ───

function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

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
    // 레거시 반배정 정보가 전혀 없으면(상담생 등 enrollments=[]) 합성하지 않는다 — class_type '정규' 둔갑 방지
    if (!levelSymbol && !classNumber && !s.class_type && !day.length) return [];
    const ct = s.class_type || '정규';
    const e = { class_type: ct, level_symbol: levelSymbol, class_number: classNumber, day, start_date: s.start_date || '' };
    if (ct === '특강') e.end_date = s.special_end_date || '';
    return [e];
}

export { enrollmentCode };

export const branchFromClassNumber = (num) => {
    const first = (num || '').trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
};

export { branchFromStudent };

export { normalizeDays };

// ─── 학생 상태 ───

// 상담은 비원이지만 진단평가 등으로 반 배정·표시 대상이 될 수 있어 포함 (재원 판정에는 사용 금지).
export const ACTIVE_STUDENT_STATUSES = new Set([...ENROLLABLE_STATUSES, '상담']);

export const PAST_STUDENT_STATUSES = new Set(['퇴원', '종강']);

// ─── 학생 표시명 ───
// DB와 동일한 예측 학부 기준 라벨을 재노출. 소비처 8곳은 이 이름으로 계속 import.
export const studentShortLabel = studentFullLabel;
export { currentSchool, normalizeRealLevelGrade };

export function studentLevel(student) {
    return normalizeRealLevelGrade(student || {}).level || '';
}

export function studentGrade(student) {
    const grade = normalizeRealLevelGrade(student || {}).grade;
    return grade ? String(grade) : '';
}

export function studentGradeKey(student) {
    const { level, grade } = normalizeRealLevelGrade(student || {});
    return `${LEVEL_SHORT[level] || ''}${grade || ''}`;
}

// ─── 날짜 유틸 ───

const pad2 = (value) => String(value).padStart(2, '0');

export const toDateStrKST = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}`;
};
export const parseDateKST = (dateStr) => {
    const raw = String(dateStr || '').trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) - 9 * 60 * 60 * 1000);
    const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) return new Date(Date.UTC(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2])) - 9 * 60 * 60 * 1000);
    return new Date(raw);
};

export function todayStr() {
    return toDateStrKST(new Date());
}

export function getDayName(dateStr) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return days[parseDateKST(dateStr).getDay()];
}

export function addDays(dateStr, days) {
    const d = parseDateKST(dateStr);
    d.setDate(d.getDate() + days);
    return toDateStrKST(d);
}

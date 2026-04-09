import {
    collection, getDocs, query, where
} from 'firebase/firestore';
import { db } from '../../firebase-config.js';

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
    const q = query(
        collection(db, 'students'),
        where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원', '상담'])
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(docSnap => {
        const data = { id: docSnap.id, ...docSnap.data() };
        data.enrollments = normalizeEnrollments(data);
        list.push(data);
    });
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
    const ct = s.class_type || '정규';
    const e = { class_type: ct, level_symbol: levelSymbol, class_number: classNumber, day, start_date: s.start_date || '' };
    if (ct === '특강') e.end_date = s.special_end_date || '';
    return [e];
}

export const enrollmentCode = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;

export const branchFromClassNumber = (num) => {
    const first = (num || '').trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
};

export const branchFromStudent = (s) =>
    s.branch || (s.enrollments?.[0] ? branchFromClassNumber(s.enrollments[0].class_number) : '');

export { normalizeDays };

// ─── 학생 상태 ───

// 활성 상태 집합 (등록/검색/목록에서 '실제 학원 등록되어있는' 학생 판정용)
// 특강만 수강하는 퇴원/종강 학생은 status2='특강'로 별도 식별.
export const ACTIVE_STUDENT_STATUSES = new Set([
    '재원', '등원예정', '실휴원', '가휴원', '상담'
]);

// ─── 학생 표시명 ───
// 학교 + 학부(초/중/고) + 학년을 하나로 합친 축약 라벨
// 예: (신목, 중등, 2) → "신목중2"
//     (진명여자고등학교, 고등, 1) → "진명여고1"
//     (신목중, 중등, 3) → "신목중3"  (중복 '중' 방지)
//     (신목중학교, 중등, 3) → "신목중3"
export function studentShortLabel(s) {
    if (!s) return '';
    let school = (s.school || '').replace('여자', '여');
    const level = s.level || '';
    const grade = s.grade != null ? String(s.grade) : '';
    if (!school) return '';

    // 학부 접미어 축약: 초등→초, 중등→중, 고등→고
    const levelShort = level === '초등' ? '초'
                     : level === '중등' ? '중'
                     : level === '고등' ? '고'
                     : (level[0] || '');

    // 학교명이 이미 '초/중/고'로 끝나거나 긴 형식이면 접미어 중복 방지
    school = school.replace(/초등학교$/, '초')
                   .replace(/중학교$/, '중')
                   .replace(/고등학교$/, '고');
    const endsWithLevel = /[초중고]$/.test(school);
    const suffix = endsWithLevel ? '' : levelShort;
    return school + suffix + grade;
}

// ─── 날짜 유틸 ───

export const toDateStrKST = (date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
export const parseDateKST = (dateStr) => new Date(dateStr + 'T00:00:00+09:00');

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

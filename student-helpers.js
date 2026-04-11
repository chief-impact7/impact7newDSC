// ─── Student Helpers ───────────────────────────────────────────────────────
// daily-ops.js에서 추출한 학생 관련 유틸리티 함수들

import { todayStr } from './src/shared/firestore-helpers.js';
import { state, LEVEL_SHORT } from './state.js';

// ─── 기본 유틸 ─────────────────────────────────────────────────────────────
export function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

export function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const cn = s.enrollments?.[0]?.class_number || '';
    const first = cn.trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

export function matchesBranchFilter(s) {
    if (state.selectedBranch && branchFromStudent(s) !== state.selectedBranch) return false;
    if (state.selectedBranch && state.selectedBranchLevel && (s.level || '') !== state.selectedBranchLevel) return false;
    return true;
}

// ─── Enrollment Helpers ────────────────────────────────────────────────────
export function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`;
}

export const allClassCodes = (s) => (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);
export const activeClassCodes = (s, date) => [...new Set(getActiveEnrollments(s, date).map(e => enrollmentCode(e)).filter(Boolean))];
export const _enrollCodeList = (enrolls) => {
    const codes = enrolls.flatMap(e => e.class_type === '내신' ? [enrollmentCode(e), '내신'] : [enrollmentCode(e)]);
    return [...new Set(codes)].join(', ');
};

// 내신 반코드 유도: 학생의 school + level + grade + A/B
// A/B 판별: 정규반 class_number 끝자리 홀수=A, 짝수=B
export function deriveNaesinCode(student, enrollment) {
    const school = student.school || '';
    const levelShort = LEVEL_SHORT[student.level] || '';
    const grade = student.grade || '';
    if (!school || !grade) return '';

    // 내신 enrollment의 class_number에서 A/B 판별
    const cn = enrollment.class_number || '';
    const lastChar = cn.slice(-1).toUpperCase();

    let group = '';
    if (lastChar === 'A' || lastChar === 'B') {
        // 이미 새 형식 (고1A, 중2B)
        group = lastChar;
    } else {
        // 옛 형식: 정규 반번호(103, 202 등)의 끝자리로 판별
        const lastDigit = parseInt(lastChar);
        if (!isNaN(lastDigit)) group = lastDigit % 2 === 1 ? 'A' : 'B';
    }

    // A/B를 알 수 없으면 정규 enrollment에서 추론
    if (!group) {
        const regularEnroll = (student.enrollments || []).find(e => e.class_type !== '내신' && e.class_number);
        if (regularEnroll) {
            const regLast = parseInt((regularEnroll.class_number || '').slice(-1));
            if (!isNaN(regLast)) group = regLast % 2 === 1 ? 'A' : 'B';
        }
    }

    return `${school}${levelShort}${grade}${group}`;
}

// 활성 enrollment만 반환.
// - end_date가 지난 enrollment(내신/특강)은 제외
// - 내신이 활성 기간이면 정규를 숨김 (내신 종료 후 정규 복귀)
export function getActiveEnrollments(s, dateStr) {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];
    const today = dateStr || todayStr();
    const validDate = (d) => d && /^\d{4}-/.test(d);

    // 1) end_date가 지난 enrollment 제외 (정규는 end_date 없으므로 항상 유지)
    const current = enrollments.filter(e => {
        if (!validDate(e.end_date)) return true; // end_date 없으면 유지
        return e.end_date >= today;
    });

    // 2) 내신이 활성 기간이면 정규를 숨김
    // - 기존: class_type='내신' enrollment
    // - 신규: class_settings의 naesin_start~naesin_end 자동 감지
    const hasActiveNaesin = (() => {
        if (current.some(e =>
            e.class_type === '내신' &&
            validDate(e.start_date) && e.start_date <= today
        )) return true;
        const regularEnroll = current.find(e => e.class_type !== '내신' && e.class_number);
        if (!regularEnroll) return false;
        const nCode = deriveNaesinCode(s, regularEnroll);
        if (!nCode) return false;
        const cs = state.classSettings[branchFromStudent(s) + nCode];
        if (!cs?.naesin_start || !cs?.naesin_end) return false;
        return cs.naesin_start <= today && cs.naesin_end >= today;
    })();
    if (hasActiveNaesin) {
        return current.filter(e => e.class_type !== '정규');
    }

    // 3) 자유학기가 활성 기간이면 같은 반코드의 정규 숨김
    const activeFreeEnrolls = current.filter(e =>
        e.class_type === '자유학기' &&
        validDate(e.start_date) && e.start_date <= today
    );
    if (activeFreeEnrolls.length > 0) {
        const freeCodes = new Set(activeFreeEnrolls.map(enrollmentCode));
        return current.filter(e =>
            e.class_type !== '정규' || !freeCodes.has(enrollmentCode(e))
        );
    }

    return current;
}

// 학생 등원시간: 개별 시간 → 반 기본 시간 fallback (내신/자유학기: 요일별 schedule 지원)
export function getStudentStartTime(enrollment, dayName) {
    if (!enrollment) return '';
    if (dayName) {
        const studentTime = enrollment.schedule?.[dayName];
        if (studentTime) return studentTime;
        // 자유학기: free_schedule 조회
        if (enrollment.class_type === '자유학기') {
            const freeSchedule = state.classSettings[enrollmentCode(enrollment)]?.free_schedule;
            if (freeSchedule?.[dayName]) return freeSchedule[dayName];
        }
        const classSchedule = state.classSettings[enrollmentCode(enrollment)]?.schedule;
        if (classSchedule?.[dayName]) return classSchedule[dayName];
    }
    return enrollment.start_time || enrollment.time || state.classSettings[enrollmentCode(enrollment)]?.default_time || '';
}

// ─── ID & 검색 ─────────────────────────────────────────────────────────────
export function makeDailyRecordId(studentDocId, date) {
    return `${studentDocId}_${date}`;
}

export function findStudent(studentId) {
    return state.allStudents.find(s => s.docId === studentId)
        || state.withdrawnStudents.find(s => s.docId === studentId);
}

// ─── 형제 맵 빌드 ──────────────────────────────────────────────────────────
export function buildSiblingMap() {
    state.siblingMap = {};
    const idToStudent = new Map(state.allStudents.map(s => [s.docId, s]));
    const phoneToIds = {};
    state.allStudents.forEach(s => {
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
                if (!state.siblingMap[id]) state.siblingMap[id] = new Set();
                siblings.forEach(sid => state.siblingMap[id].add(sid));
            }
        });
    });
}

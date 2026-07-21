// student-core.js — Firebase/DOM/state 의존 없는 순수 함수 모음. node:test 가능.
// state가 필요한 함수는 student-helpers.js에 둔다.

import { ENROLLABLE_STATUSES, NON_ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';

export function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

export const isValidDateStr = (d) => d && /^\d{4}-/.test(d);

export function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`.trim();
}

// 지점(단지) 파생은 shared가 SSoT. 로컬 재구현은 '10단지…' 접두를 첫 글자 '1'→2단지로
// 오분류했다(shared는 접두를 먼저 판정 → 10단지). F-03 drift 제거.
export { branchFromStudent } from '@impact7/shared/branch';

export const allClassCodes = (s) =>
    (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);

export function summarizeEnrollmentClasses(enrollments) {
    const regular = new Set();
    const other = new Set();
    for (const enrollment of enrollments || []) {
        const code = enrollmentCode(enrollment);
        if (!code) continue;
        const type = enrollment.class_type || '정규';
        if (type === '정규') regular.add(code);
        else other.add(`${type} ${code}`);
    }
    return {
        regular: [...regular].join(' · '),
        other: [...other].join(' · '),
    };
}

export function makeDailyRecordId(studentDocId, date) {
    return `${studentDocId}_${date}`;
}

export function isNewTenureStart(start, today, days) {
    if (!(start instanceof Date) || isNaN(start.getTime())) return false;
    const diff = (today - start) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= days;
}

export function isCurrentNewTenure(tenure, status, today, days) {
    return ENROLLABLE_STATUSES.has(status)
        && !tenure?.end
        && isNewTenureStart(tenure?.start, today, days);
}

export function isPotentialNewStudent(enrollments, today, days, attendedWithinWindow = false) {
    if (attendedWithinWindow) return true;
    return (enrollments || []).some(enrollment => enrollment.start_date && enrollmentCode(enrollment)
        && isNewTenureStart(new Date(`${enrollment.start_date}T00:00:00+09:00`), today, days));
}

export function studentMatchesSearchTerms(student, query, extraTerms = []) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return false;
    const phones = [student.student_phone, student.parent_phone_1, student.parent_phone_2].filter(Boolean);
    const textTerms = [student.name, ...phones, ...extraTerms].filter(Boolean);
    if (textTerms.some(term => String(term).toLowerCase().includes(needle))) return true;
    const digits = needle.replace(/\D/g, '');
    return digits.length >= 3 && phones.some(phone => phone.replace(/\D/g, '').includes(digits));
}

export function siblingStatusSuffix(status) {
    return NON_ENROLLABLE_STATUSES.has(status) ? ` (${status})` : '';
}

export function createSiblingMap(students) {
    const siblingMap = {};
    const idToStudent = new Map(students.map(s => [s.docId, s]));
    const phoneToIds = {};
    students.forEach(s => {
        const phones = [...new Set([s.parent_phone_1, s.parent_phone_2]
            .map(p => (p || '').replace(/\D/g, '')).filter(p => p.length >= 9))];
        phones.forEach(phone => {
            if (!phoneToIds[phone]) phoneToIds[phone] = [];
            phoneToIds[phone].push(s.docId);
        });
    });
    Object.values(phoneToIds).forEach(ids => {
        const uniqueIds = [...new Set(ids)];
        uniqueIds.forEach(id => {
            const student = idToStudent.get(id);
            const siblings = uniqueIds.filter(siblingId => {
                const sibling = idToStudent.get(siblingId);
                return siblingId !== id && sibling?.name !== student?.name;
            });
            if (siblings.length) siblingMap[id] = new Set(siblings);
        });
    });
    return siblingMap;
}

export function buildNaesinCsKey({ branch, school, level, grade, group }) {
    return `${branch || ''}${school || ''}${level || ''}${grade || ''}${group || ''}`;
}

export const NAESIN_OVERRIDE_EXCLUDE = '';

export function resolveNaesinCsKey(_student, regularEnroll) {
    if (!regularEnroll) return null;
    const override = regularEnroll.naesin_class_override;
    if (typeof override !== 'string') return null;
    return override === NAESIN_OVERRIDE_EXCLUDE ? null : override;
}

export function displayCodeFromCsKey(csKey, branch) {
    if (!csKey) return '';
    return branch && csKey.startsWith(branch) ? csKey.slice(branch.length) : csKey;
}

// '상담'은 비원이지만 퇴원은 아님 — isWithdrawnAt 판정은 "재원취급" 여부가 아닌 "퇴원 여부"이므로 상담 포함이 의미상 옳다.
const STATUS_IMPLIES_NOT_WITHDRAWN = new Set([...ENROLLABLE_STATUSES, '상담']);

export function isWithdrawnAt(s, dateStr) {
    if (s.status === '퇴원') return true;
    if (STATUS_IMPLIES_NOT_WITHDRAWN.has(s.status)) return false;
    if (s.withdrawal_date) return s.withdrawal_date <= dateStr;
    return false;
}

export function isScheduledWithdrawalDue(student, dateStr) {
    return Boolean(student.pre_withdrawal_status
        && student.withdrawal_date
        && student.withdrawal_date <= dateStr);
}

const LEAVE_STATUSES_CORE = ['가휴원', '실휴원'];
const NON_LEAVE_ACTIVE = new Set(['재원', '등원예정', '상담']);

export function isOnLeaveAt(s, dateStr) {
    if (LEAVE_STATUSES_CORE.includes(s.status)) {
        if (s.pause_start_date && s.pause_end_date) {
            return dateStr >= s.pause_start_date && dateStr <= s.pause_end_date;
        }
        return true;
    }
    if (NON_LEAVE_ACTIVE.has(s.status)) return false;
    if (LEAVE_STATUSES_CORE.includes(s.scheduled_leave_status)) {
        if (s.pause_start_date && s.pause_end_date) {
            return dateStr >= s.pause_start_date && dateStr <= s.pause_end_date;
        }
        return true;
    }
    return false;
}

// ─── 분리 등원 특강 판정 ─────────────────────────────────────────────────────
// 정규계열과 특강은 수업료가 다르므로 같은 날이면 시간 간격과 무관하게 출결을 분리한다.
export function findSeparateTeukangVisit(dayEnrollments, getTime) {
    if (!dayEnrollments.some(e => ['정규', '내신', '자유학기'].includes(e.class_type || '정규'))) return null;
    const teukang = dayEnrollments
        .filter(e => e.class_type === '특강')
        .map(enrollment => ({ enrollment, time: getTime(enrollment) || '' }))
        .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    return teukang[0] || null;
}

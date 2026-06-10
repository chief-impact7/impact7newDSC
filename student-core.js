// student-core.js — Firebase/DOM/state 의존 없는 순수 함수 모음. node:test 가능.
// state가 필요한 함수는 student-helpers.js에 둔다.

import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';

export function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

export function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`.trim();
}

export function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const cn = s.enrollments?.[0]?.class_number || '';
    const first = cn.trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

export const allClassCodes = (s) =>
    (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);

export function makeDailyRecordId(studentDocId, date) {
    return `${studentDocId}_${date}`;
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

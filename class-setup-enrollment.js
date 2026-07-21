import { enrollmentCode } from './student-core.js';
export { enrollmentCode };

export function uniquePlanningEnrollments(enrollments, today) {
    const byCode = new Map();
    for (const enrollment of enrollments || []) {
        if (enrollment.class_type !== '정규' && enrollment.class_type !== '자유학기') continue;
        if (enrollment.end_date && enrollment.end_date < today) continue;
        const code = enrollmentCode(enrollment);
        if (!byCode.has(code)) byCode.set(code, enrollment);
    }
    return [...byCode.values()];
}

export function hasActiveRegularClass(enrollments, classCode, date) {
    return (enrollments || []).some(enrollment =>
        enrollment.class_type === '정규'
        && enrollmentCode(enrollment) === classCode
        && (!enrollment.end_date || enrollment.end_date >= date)
    );
}

export function buildClassTimeFields(classType, days, schedule, defaultTime) {
    if (classType === '정규') {
        return { default_days: [...days], default_time: defaultTime || '16:00' };
    }
    if (classType === '자유학기') return { free_schedule: { ...schedule } };
    if (classType === '내신' || classType === '특강') return { schedule: { ...schedule } };
    return {};
}

export function resolveRegularDefaultTime(inputTime, edited, existingTime) {
    return edited ? inputTime : (existingTime || inputTime);
}

const REACTIVATION_CLEANUP_FIELDS = [
    'pause_start_date',
    'pause_end_date',
    'scheduled_leave_status',
    'withdrawal_date',
    'pre_withdrawal_status',
];

export function buildReactivationCleanupFields(deleteValue) {
    return Object.fromEntries(REACTIVATION_CLEANUP_FIELDS.map(field => [field, deleteValue]));
}

export function clearLocalReactivationFields(student) {
    for (const field of REACTIVATION_CLEANUP_FIELDS) delete student[field];
}

export function buildReactivationHistoryBefore(student) {
    return Object.fromEntries([
        ['status', student.status || ''],
        ...REACTIVATION_CLEANUP_FIELDS.map(field => [field, student[field] || '']),
    ]);
}

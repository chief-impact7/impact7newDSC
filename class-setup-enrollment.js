import { enrollmentCode } from './student-core.js';
import {
    accountTypeOf,
    activeEnrollmentsAt,
    closeAccount,
    deriveStudentStatusAfterAccountChange,
    groupEnrollmentAccounts,
    openAccounts,
} from '@impact7/shared/enrollment-status';
import { branchFromClassNumber, branchFromStudent } from '@impact7/shared/branch';
export { enrollmentCode };

export const CLASS_TYPES = ['정규', '내신', '자유학기', '특강', '기타'];

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

export function hasActiveAccountClass(enrollments, accountType, classCode, date) {
    return activeEnrollmentsAt(enrollments, date).some(enrollment =>
        accountTypeOf(enrollment) === accountType
        && enrollmentCode(enrollment) === classCode
    );
}

export function hasActiveRegularClass(enrollments, classCode, date) {
    return hasActiveAccountClass(enrollments, '정규', classCode, date);
}

export function buildClassTimeFields(classType, days, schedule, defaultTime) {
    if (classType === '정규') {
        return { default_days: [...days], default_time: defaultTime || '16:00' };
    }
    if (classType === '자유학기') return { free_schedule: { ...schedule } };
    if (classType === '내신' || classType === '특강' || classType === '기타') {
        return { schedule: { ...schedule } };
    }
    throw new Error(`알 수 없는 반 유형(${classType || '없음'})입니다.`);
}

const CLASS_TYPE_SETTING_FIELDS = [
    'class_type',
    'account_type',
    'branch',
    'default_days',
    'default_time',
    'schedule',
    'naesin_start',
    'naesin_end',
    'free_schedule',
    'free_start',
    'free_end',
    'special_start',
    'special_end',
    'fee_type',
];

export function buildClassSettingsData(existingSettings, classType, fields) {
    if (!CLASS_TYPES.includes(classType)) {
        throw new Error(`알 수 없는 반 유형(${classType || '없음'})입니다.`);
    }
    const retained = Object.fromEntries(
        Object.entries(existingSettings || {}).filter(([field]) =>
            !CLASS_TYPE_SETTING_FIELDS.includes(field)
            && !field.startsWith('naesin_')
            && !field.startsWith('free_')
            && !field.startsWith('special_')
        )
    );
    return {
        ...retained,
        ...fields,
        class_type: classType,
        account_type: accountTypeOf({ class_type: classType }),
    };
}

export function hasClassSettingsTypeConflict(existingSettings, classType) {
    return !!existingSettings?.class_type && existingSettings.class_type !== classType;
}

export function buildEnrollmentAccountFields(classType, accountId = crypto.randomUUID()) {
    if (!CLASS_TYPES.includes(classType)) {
        throw new Error(`알 수 없는 반 유형(${classType || '없음'})입니다.`);
    }
    return {
        account_id: accountId,
        account_type: accountTypeOf({ class_type: classType }),
    };
}

export function accountLabel(account) {
    const accountType = account?.accountType || accountTypeOf(account?.items?.[0]);
    const codes = [...new Set((account?.items || []).map(enrollmentCode).filter(Boolean))];
    return `${accountType} ${codes.join(' · ') || '반 미지정'}`;
}

export function buildAccountTarget(account, branch = '') {
    const accountId = account?.accountId || account?.key;
    if (!accountId) return null;
    const classCodes = [...new Set((account.items || []).map(enrollmentCode).filter(Boolean))];
    return {
        account_id: accountId,
        account_type: account.accountType,
        class_code: classCodes[0] || '',
        class_types: [...new Set((account.items || []).map(item => item?.class_type).filter(Boolean))],
        branch,
        label: accountLabel(account),
    };
}

export function buildSelectedAccountTarget(student, date, accountId, { force = false } = {}) {
    const accounts = openAccounts(student?.enrollments, date);
    if (!accountId || (!force && accounts.length < 2)) return null;
    return buildAccountTarget(
        accounts.find(account => account.key === accountId),
        branchFromStudent(student),
    );
}

export function mergeEnrollmentEdit(enrollment, changes) {
    return { ...(enrollment || {}), ...changes };
}

const targetComparable = target => target && ({
    account_id: target.account_id,
    account_type: target.account_type,
    class_code: target.class_code,
    class_types: target.class_types,
    branch: target.branch,
    label: target.label,
});

export function sameAccountTarget(left, right) {
    return JSON.stringify(targetComparable(left)) === JSON.stringify(targetComparable(right));
}

export function accountTargetExists(student, target) {
    return !!target?.account_id
        && groupEnrollmentAccounts(student?.enrollments)
            .some(account => account.key === target.account_id);
}

export function resolveRegularBaseAccountId(baseEnrollments, createId = () => crypto.randomUUID()) {
    return (baseEnrollments || []).find(enrollment => enrollment?.account_id)?.account_id || createId();
}

export function findEnrollmentAccount(enrollments, accountType, classCode) {
    return groupEnrollmentAccounts(enrollments).find(account =>
        account.accountType === accountType
        && account.items.some(item => enrollmentCode(item) === classCode)
    ) || null;
}

export function closeStudentAccount(student, account, endDate, endReason) {
    const original = student?.enrollments || [];
    let result;
    if (account?.accountId) {
        result = closeAccount(original, account.accountId, { endDate, endReason });
    } else if (account?.items?.length) {
        const target = new Set(account.items);
        result = {
            updatedEnrollments: original.filter(item => !target.has(item)),
            removed: original
                .filter(item => target.has(item))
                .map(item => ({ ...item, end_date: endDate, end_reason: endReason })),
            skipped: false,
        };
    } else {
        return null;
    }

    if (result.skipped) return null;
    const status = deriveStudentStatusAfterAccountChange(result.updatedEnrollments, endDate, {
        fallbackReason: endReason,
        currentStatus: student?.status,
    });
    const snapshot = (items) => JSON.stringify({
        account_id: account.accountId,
        account_type: account.accountType,
        account_key: account.key,
        items,
        end_reason: endReason,
        student_status_before: student?.status || '',
        student_status_after: status,
    });
    return {
        accountId: account.accountId,
        accountType: account.accountType,
        accountKey: account.key,
        updatedEnrollments: result.updatedEnrollments,
        removed: result.removed,
        status,
        history: {
            before: snapshot(account.items),
            after: snapshot(result.removed),
        },
        lastAccountClosed: openAccounts(result.updatedEnrollments, endDate).length === 0,
    };
}

export function resolveClassBranch({ classType, classNumber, naesinBranch, students }) {
    if (classType === '내신') return naesinBranch || '';
    if (classType === '정규' || classType === '자유학기') {
        return branchFromClassNumber(classNumber);
    }
    if (classType === '특강' || classType === '기타') {
        const branches = new Set((students || []).map(s => branchFromStudent(s)).filter(Boolean));
        return branches.size === 1 ? [...branches][0] : '';
    }
    throw new Error(`알 수 없는 반 유형(${classType || '없음'})입니다.`);
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

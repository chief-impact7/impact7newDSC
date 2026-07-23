import test from 'node:test';
import assert from 'node:assert/strict';
import {
    accountLabel,
    accountTargetExists,
    buildAccountTarget,
    buildClassSettingsData,
    buildClassTimeFields,
    buildEnrollmentAccountFields,
    buildSelectedAccountTarget,
    buildReactivationCleanupFields,
    buildReactivationHistoryBefore,
    clearLocalReactivationFields,
    closeStudentAccount,
    findEnrollmentAccount,
    hasClassSettingsTypeConflict,
    hasActiveAccountClass,
    hasActiveRegularClass,
    mergeEnrollmentEdit,
    resolveClassBranch,
    resolveRegularBaseAccountId,
    resolveRegularDefaultTime,
    sameAccountTarget,
    uniquePlanningEnrollments,
} from './class-setup-enrollment.js';
import { computeExpectedArrival, startTime } from '@impact7/shared/expected-arrival';

test('정규반 분석은 같은 학생의 동일 반코드를 한 번만 반환한다', () => {
    const enrollments = [
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-01' },
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-06' },
        { class_type: '자유학기', level_symbol: 'FA', class_number: '201', start_date: '2026-06-09' },
    ];

    const result = uniquePlanningEnrollments(enrollments, '2026-06-06');

    assert.deepEqual(
        result.map(enrollment => `${enrollment.level_symbol}${enrollment.class_number}`),
        ['I201', 'FA201'],
    );
});

test('같은 활성 정규반은 중복 등록으로 판정한다', () => {
    const enrollments = [
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-01' },
    ];

    assert.equal(hasActiveRegularClass(enrollments, 'I201', '2026-06-06'), true);
    assert.equal(hasActiveRegularClass(enrollments, 'I202', '2026-06-06'), false);
});

test('이미 종료된 동일 정규반은 신규 등록을 막지 않는다', () => {
    const enrollments = [
        {
            class_type: '정규',
            level_symbol: 'I',
            class_number: '201',
            start_date: '2025-06-01',
            end_date: '2025-12-31',
        },
    ];

    assert.equal(hasActiveRegularClass(enrollments, 'I201', '2026-06-06'), false);
});

test('반 유형별 시간 필드를 분리 저장한다', () => {
    const schedule = { 월: '16:00' };
    assert.deepEqual(
        buildClassTimeFields('정규', ['화', '목'], {}, '19:10'),
        { default_days: ['화', '목'], default_time: '19:10' },
    );
    assert.deepEqual(buildClassTimeFields('내신', ['월'], schedule), { schedule });
    assert.deepEqual(buildClassTimeFields('자유학기', ['월'], schedule), { free_schedule: schedule });
    assert.deepEqual(buildClassTimeFields('특강', ['월'], schedule), { schedule });
    assert.deepEqual(buildClassTimeFields('기타', ['월'], schedule), { schedule });
    assert.throws(() => buildClassTimeFields('알수없음', ['월'], schedule), /알 수 없는 반 유형/);
});

test('기타 class_settings는 계정 유형과 시간 스키마를 저장하고 이전 유형 필드를 제거한다', () => {
    const settings = buildClassSettingsData({
        domains: ['Gr'],
        default_days: ['월'],
        default_time: '16:00',
        naesin_start: '2026-01-01',
        naesin_end: '2026-02-01',
        naesin_custom: true,
        free_schedule: { 화: '17:00' },
        free_start: '2026-03-01',
        free_end: '2026-04-01',
        special_start: '2026-05-01',
        special_end: '2026-06-01',
        special_custom: true,
        fee_type: '유료',
    }, '기타', {
        teacher: 'teacher@impact7.kr',
        branch: '2단지',
        schedule: { 수: '18:00' },
    });

    assert.deepEqual(settings, {
        domains: ['Gr'],
        teacher: 'teacher@impact7.kr',
        branch: '2단지',
        schedule: { 수: '18:00' },
        class_type: '기타',
        account_type: '기타',
    });
});

test('기존 class_settings와 신규 반 유형이 다르면 병합을 차단한다', () => {
    assert.equal(hasClassSettingsTypeConflict({ class_type: '특강' }, '기타'), true);
    assert.equal(hasClassSettingsTypeConflict({ class_type: '특강' }, '특강'), false);
    assert.equal(hasClassSettingsTypeConflict({}, '정규'), false);
});

test('기타 계정은 정규 중복·교체 판정과 분리되고 같은 활성 기타반만 중복이다', () => {
    const enrollments = [
        { account_id: 'regular', account_type: '정규', class_type: '정규', level_symbol: 'A', class_number: '101' },
        { account_id: 'other', account_type: '기타', class_type: '기타', level_symbol: '', class_number: '보강클리닉' },
    ];

    assert.equal(hasActiveRegularClass(enrollments, '보강클리닉', '2026-07-23'), false);
    assert.equal(hasActiveAccountClass(enrollments, '기타', '보강클리닉', '2026-07-23'), true);
    assert.equal(hasActiveAccountClass(enrollments, '기타', '다른반', '2026-07-23'), false);
});

test('신규 enrollment에 유형별 account_id와 account_type을 부여한다', () => {
    assert.deepEqual(buildEnrollmentAccountFields('정규', 'regular-id'), {
        account_id: 'regular-id',
        account_type: '정규',
    });
    assert.deepEqual(buildEnrollmentAccountFields('내신', 'regular-id'), {
        account_id: 'regular-id',
        account_type: '정규',
    });
    assert.deepEqual(buildEnrollmentAccountFields('자유학기', 'regular-id'), {
        account_id: 'regular-id',
        account_type: '정규',
    });
    assert.deepEqual(buildEnrollmentAccountFields('특강', 'special-id'), {
        account_id: 'special-id',
        account_type: '특강',
    });
    assert.deepEqual(buildEnrollmentAccountFields('기타', 'other-id'), {
        account_id: 'other-id',
        account_type: '기타',
    });
});

test('복수 계정 요청은 account_target 스냅샷을 만들고 단일 계정은 기존처럼 생략한다', () => {
    const regular = {
        account_id: 'regular-id',
        account_type: '정규',
        class_type: '정규',
        level_symbol: 'A',
        class_number: '101',
        day: ['월'],
    };
    const special = {
        account_id: 'special-id',
        account_type: '특강',
        class_type: '특강',
        class_number: '여름특강',
        day: ['화'],
    };
    const student = { branch: '2단지', enrollments: [regular, special] };

    assert.deepEqual(buildSelectedAccountTarget(student, '2026-07-23', 'special-id'), {
        account_id: 'special-id',
        account_type: '특강',
        class_code: '여름특강',
        class_types: ['특강'],
        branch: '2단지',
        label: '특강 여름특강',
    });
    assert.equal(buildSelectedAccountTarget({ ...student, enrollments: [regular] }, '2026-07-23', 'regular-id'), null);
    assert.equal(accountLabel({ accountType: '정규', items: [regular] }), '정규 A101');
    assert.deepEqual(buildAccountTarget({ accountId: 'regular-id', accountType: '정규', items: [regular] }, '2단지'), {
        account_id: 'regular-id',
        account_type: '정규',
        class_code: 'A101',
        class_types: ['정규'],
        branch: '2단지',
        label: '정규 A101',
    });
});

test('단일 레거시 계정 종강요청은 shared key를 account_id로 사용한다', () => {
    const legacy = {
        class_type: '정규',
        level_symbol: 'A',
        class_number: '101',
        day: ['월'],
    };

    const student = { branch: '2단지', enrollments: [legacy] };
    const target = buildSelectedAccountTarget(
        student,
        '2026-07-23',
        'legacy:정규:A101',
        { force: true },
    );

    assert.deepEqual(target, {
        account_id: 'legacy:정규:A101',
        account_type: '정규',
        class_code: 'A101',
        class_types: ['정규'],
        branch: '2단지',
        label: '정규 A101',
    });
    assert.equal(accountTargetExists(student, target), true);
    assert.equal(sameAccountTarget(target, structuredClone(target)), true);
});

test('계정 종료 후 남은 활성 계정이 있으면 재원 상태를 유지한다', () => {
    const student = {
        status: '재원',
        enrollments: [
            { account_id: 'regular-id', account_type: '정규', class_type: '정규', level_symbol: 'A', class_number: '101' },
            { account_id: 'special-id', account_type: '특강', class_type: '특강', class_number: '여름특강' },
        ],
    };
    const account = findEnrollmentAccount(student.enrollments, '특강', '여름특강');
    const result = closeStudentAccount(student, account, '2026-07-23', '종강');

    assert.equal(result.status, '재원');
    assert.equal(result.lastAccountClosed, false);
    assert.deepEqual(result.updatedEnrollments, [student.enrollments[0]]);
    assert.equal(result.removed[0].end_reason, '종강');
});

test('계정 종료 후 활성 계정이 남으면 기존 실휴원 status를 보존한다', () => {
    const student = {
        status: '실휴원',
        enrollments: [
            { account_id: 'regular-id', account_type: '정규', class_type: '정규', level_symbol: 'A', class_number: '101' },
            { account_id: 'special-id', account_type: '특강', class_type: '특강', class_number: '여름특강' },
        ],
    };
    const account = findEnrollmentAccount(student.enrollments, '특강', '여름특강');

    assert.equal(closeStudentAccount(student, account, '2026-07-23', '종강').status, '실휴원');
});

test('마지막 계정 종료 시 선택 사유로 비재원 전환한다', () => {
    const enrollment = {
        account_id: 'other-id',
        account_type: '기타',
        class_type: '기타',
        class_number: '자습실',
    };
    const student = { status: '재원', enrollments: [enrollment] };
    const account = findEnrollmentAccount(student.enrollments, '기타', '자습실');

    const ended = closeStudentAccount(student, account, '2026-07-23', '종강');
    const withdrawn = closeStudentAccount(student, account, '2026-07-23', '퇴원');

    assert.equal(ended.status, '종강');
    assert.equal(withdrawn.status, '퇴원');
    assert.equal(ended.lastAccountClosed, true);
    assert.deepEqual(ended.updatedEnrollments, []);
    assert.deepEqual(Object.keys(JSON.parse(ended.history.before)), [
        'account_id',
        'account_type',
        'account_key',
        'items',
        'end_reason',
        'student_status_before',
        'student_status_after',
    ]);
    assert.equal(JSON.parse(ended.history.after).items[0].end_reason, '종강');
});

test('수강 편집 최종 payload는 기존 계정·휴원 필드와 변경값을 함께 보존한다', () => {
    const original = {
        account_id: 'regular-id',
        account_type: '정규',
        pause_start_date: '2026-07-01',
        pause_end_date: '2026-07-31',
        leave_sub_type: '가휴원',
        class_type: '정규',
        level_symbol: 'A',
        class_number: '101',
        day: ['월'],
    };
    const edited = mergeEnrollmentEdit(original, { class_number: '102', day: ['화'] });

    assert.deepEqual(edited, {
        ...original,
        class_number: '102',
        day: ['화'],
    });
});

test('레거시 정규·자유학기 base는 UUID를 한 번만 생성해 공유한다', () => {
    let calls = 0;
    const accountId = resolveRegularBaseAccountId([
        { class_type: '정규', class_number: '101' },
        { class_type: '자유학기', class_number: '101' },
    ], () => {
        calls += 1;
        return 'regular-id';
    });
    const updated = ['정규', '자유학기'].map(class_type => ({
        class_type,
        ...buildEnrollmentAccountFields(class_type, accountId),
    }));

    assert.equal(calls, 1);
    assert.deepEqual(updated.map(enrollment => enrollment.account_id), ['regular-id', 'regular-id']);
});

test('기타·특강 지점은 선택 학생의 단일 소속으로 결정한다', () => {
    assert.equal(resolveClassBranch({
        classType: '기타',
        students: [{ branch: '10단지' }, { branch: '10단지' }],
    }), '10단지');
    assert.equal(resolveClassBranch({
        classType: '특강',
        students: [{ branch: '2단지' }, { branch: '10단지' }],
    }), '');
    assert.equal(resolveClassBranch({
        classType: '정규',
        classNumber: '101',
        students: [],
    }), '2단지');
    assert.throws(() => resolveClassBranch({
        classType: '알수없음',
        students: [],
    }), /알 수 없는 반 유형/);
});

test('기존 정규반 시간은 직접 수정하지 않으면 보존한다', () => {
    assert.equal(resolveRegularDefaultTime('16:00', false, '19:10'), '19:10');
    assert.equal(resolveRegularDefaultTime('16:00', true, '19:10'), '16:00');
    assert.equal(resolveRegularDefaultTime('16:00', false, ''), '16:00');
});

test('퇴원 학생 특강 재활성화 시 이전 휴·퇴원 예약 필드를 모두 제거한다', () => {
    const deleted = Symbol('deleted');

    assert.deepEqual(buildReactivationCleanupFields(deleted), {
        pause_start_date: deleted,
        pause_end_date: deleted,
        scheduled_leave_status: deleted,
        withdrawal_date: deleted,
        pre_withdrawal_status: deleted,
    });

    const student = {
        name: '김범준',
        status: '퇴원',
        pause_start_date: '2026-05-01',
        pause_end_date: '2026-05-31',
        scheduled_leave_status: '가휴원',
        withdrawal_date: '2026-06-01',
        pre_withdrawal_status: '가휴원',
    };
    assert.deepEqual(buildReactivationHistoryBefore(student), {
        status: '퇴원',
        pause_start_date: '2026-05-01',
        pause_end_date: '2026-05-31',
        scheduled_leave_status: '가휴원',
        withdrawal_date: '2026-06-01',
        pre_withdrawal_status: '가휴원',
    });
    clearLocalReactivationFields(student);
    assert.deepEqual(student, { name: '김범준', status: '퇴원' });
});

test('shared 시간 해석은 정규 기본시간과 기간 override를 구분한다', () => {
    const regular = { class_type: '정규', level_symbol: 'HA', class_number: '104' };
    const derivedFree = { ...regular, class_type: '자유학기', schedule: { 화: '18:00' } };
    const settings = {
        HA104: {
            default_time: '19:10',
            schedule: { 화: '17:10' },
            free_schedule: { 화: '18:00' },
        },
    };

    assert.equal(startTime(regular, '화', settings), '19:10');
    assert.equal(startTime(derivedFree, '화', settings), '18:00');
});

test('기간 override 종료 후 정규 기본시간으로 복귀한다', () => {
    const enrollments = [{
        class_type: '정규', level_symbol: 'HA', class_number: '104', day: ['화'],
        start_date: '2026-01-01', naesin_class_override: 'NAESIN1',
    }];
    const classSettings = {
        HA104: {
            default_time: '19:10', schedule: { 화: '17:10' },
            free_start: '2026-08-10', free_end: '2026-08-16', free_schedule: { 화: '18:00' },
        },
        NAESIN1: {
            naesin_start: '2026-07-14', naesin_end: '2026-07-20', schedule: { 화: '17:30' },
        },
    };
    const expectedAt = date => computeExpectedArrival({ enrollments, classSettings, date });

    assert.equal(expectedAt('2026-07-14'), '17:30');
    assert.equal(expectedAt('2026-07-21'), '19:10');
    assert.equal(expectedAt('2026-08-11'), '18:00');
    assert.equal(expectedAt('2026-08-18'), '19:10');
});

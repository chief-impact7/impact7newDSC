import React, { useMemo } from 'react';
import { getDayName, studentGradeKey, studentShortLabel } from '../../shared/firestore-helpers.js';
import { branchFromStudent, resolveNaesinCsKey } from '../../../student-helpers.js';
import { staffLabel } from '@impact7/shared/staff-label';

const ACTIVE_STATUSES = new Set(['재원', '등원예정', '실휴원', '가휴원', '상담']);
const ATTENDED_STATUSES = new Set(['출석', '지각', '조퇴']);
const DEFAULT_ATTENDANCE_LABELS = new Set(['정규', '특강', '내신', '자유', '자유학기', '비정규', '미확인']);
const REGULAR_CLASS_TYPES = new Set(['정규', '자유학기', undefined, null, '']);
const WITHDRAW_REQUEST_TYPES = new Set(['퇴원요청', '휴원→퇴원']);
const LEAVE_REQUEST_TYPES = new Set(['휴원요청', '퇴원→휴원', '휴원연장']);
const GROUP_ORDER = ['diagnostic', 'regular', 'irregular', 'naesin', 'free', 'special'];
const OPTIONAL_GROUPS = GROUP_ORDER.filter(key => !['diagnostic', 'regular'].includes(key));
const GROUP_LABELS = {
    diagnostic: '진단평가',
    regular: '정규',
    irregular: '비정규',
    naesin: '내신',
    free: '자유학기',
    special: '특강',
};

const classCode = (enrollment) => `${enrollment?.level_symbol || ''}${enrollment?.class_number || ''}`;
const normalizedDays = (day) => {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => String(d).replace('요일', '').trim()).filter(Boolean);
    return String(day).split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
};
const validDate = (value) => value && /^\d{4}-/.test(value);
const text = (value) => (value == null ? '' : String(value).trim());
const fmtDate = (value) => {
    const raw = text(value);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1].slice(2)}-${match[2]}-${match[3]}` : raw;
};
const fmtTime = (value) => {
    const raw = text(value);
    const match = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return raw || '-';
    const hour = Number(match[1]);
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${match[2]}`;
};
const shortEmailName = (value) => staffLabel(text(value));
const teacherNameForClass = (classSettings, code) => shortEmailName(classSettings?.[code]?.teacher);
const teacherNamesForClasses = (classSettings, codes) => {
    const names = codes.map(code => teacherNameForClass(classSettings, code)).filter(Boolean);
    return [...new Set(names)].join(', ');
};

function isWithdrawnAt(student, date) {
    if (student.status === '퇴원' || student.status === '종강') return true;
    if (ACTIVE_STATUSES.has(student.status || '')) return false;
    return student.withdrawal_date ? student.withdrawal_date <= date : false;
}

function currentEnrollments(student, date) {
    return (student.enrollments || []).filter(e => !validDate(e.end_date) || e.end_date >= date);
}

function regularEnrollment(enrollments) {
    return enrollments.find(e => REGULAR_CLASS_TYPES.has(e.class_type) && e.class_number);
}

function resolveNaesinKey(student, enrollment) {
    return resolveNaesinCsKey(student, enrollment) || '';
}

function hasExplicitNaesin(enrollments, date) {
    return enrollments.some(e => e.class_type === '내신' && (!validDate(e.start_date) || e.start_date <= date));
}

function hasAutoNaesin(student, enrollment, date, classSettings) {
    const key = resolveNaesinKey(student, enrollment);
    const cs = key ? classSettings[key] : null;
    return !!(cs?.naesin_start && cs?.naesin_end && cs.naesin_start <= date && cs.naesin_end >= date);
}

function virtualNaesinEnrollment(student, enrollment, date, classSettings) {
    const key = resolveNaesinKey(student, enrollment);
    const cs = key ? classSettings[key] : null;
    if (!cs?.naesin_start || !cs?.naesin_end || cs.naesin_start > date || cs.naesin_end < date) return null;
    return {
        class_type: '내신',
        level_symbol: '',
        class_number: key,
        day: Object.keys(cs.schedule || {}),
        schedule: cs.schedule || {},
    };
}

function virtualFreeEnrollment(enrollment, date, classSettings) {
    const code = classCode(enrollment);
    const cs = code ? classSettings[code] : null;
    if (!cs?.free_start || !cs?.free_end || cs.free_start > date || cs.free_end < date) return null;
    return {
        class_type: '자유학기',
        level_symbol: enrollment?.level_symbol || '',
        class_number: enrollment?.class_number || '',
        day: Object.keys(cs.free_schedule || {}),
        schedule: cs.free_schedule || {},
    };
}

function activeEnrollments(student, date, classSettings) {
    const current = currentEnrollments(student, date);
    if (!current.length) return [];

    const regular = regularEnrollment(current);
    const virtualNaesin = virtualNaesinEnrollment(student, regular, date, classSettings);
    if (hasExplicitNaesin(current, date) || virtualNaesin) {
        const nonRegular = current.filter(e => (e.class_type || '정규') !== '정규');
        return virtualNaesin ? [virtualNaesin, ...nonRegular] : nonRegular;
    }

    const virtualFree = virtualFreeEnrollment(regular, date, classSettings);
    if (virtualFree) {
        const code = classCode(virtualFree);
        return [
            virtualFree,
            ...current.filter(e => !['정규', '자유학기'].includes(e.class_type || '정규') || classCode(e) !== code)
                .filter(e => e !== virtualFree),
        ];
    }

    const activeFreeCodes = new Set(current
        .filter(e => e.class_type === '자유학기' && (!validDate(e.start_date) || e.start_date <= date))
        .map(classCode));
    if (activeFreeCodes.size) {
        return current.filter(e => (e.class_type || '정규') !== '정규' || !activeFreeCodes.has(classCode(e)));
    }
    return current;
}

function isNaesinActive(student, date, classSettings) {
    const current = currentEnrollments(student, date);
    return hasExplicitNaesin(current, date)
        || hasAutoNaesin(student, regularEnrollment(current), date, classSettings);
}

function isFreeActive(student, date, classSettings) {
    const current = currentEnrollments(student, date);
    return current.some(e => {
        const code = classCode(e);
        const cs = classSettings[code];
        if (e.class_type === '자유학기' && (!validDate(e.start_date) || e.start_date <= date)) return true;
        return !!(cs?.free_start && cs?.free_end && cs.free_start <= date && cs.free_end >= date);
    });
}

function startTime(enrollment, dayName, classSettings) {
    const code = classCode(enrollment);
    return enrollment?.schedule?.[dayName]
        || (enrollment?.class_type === '자유학기' ? classSettings[code]?.free_schedule?.[dayName] : '')
        || classSettings[code]?.schedule?.[dayName]
        || enrollment?.start_time
        || enrollment?.time
        || classSettings[code]?.default_time
        || '';
}

function earliestExpectedTime({ enrollments, dayName, classSettings, rec, hwTasks, testTasks, absences, date }) {
    const times = [];
    enrollments.forEach(enrollment => {
        const time = startTime(enrollment, dayName, classSettings);
        if (time) times.push(time);
    });
    hwTasks.forEach(task => {
        if (task.type === '등원' && task.scheduled_date === date && task.scheduled_time) times.push(task.scheduled_time);
    });
    testTasks.forEach(task => {
        if (task.type === '등원' && task.scheduled_date === date && task.scheduled_time) times.push(task.scheduled_time);
    });
    [rec.hw_fail_action, rec.test_fail_action].forEach(actionMap => {
        Object.values(actionMap || {}).forEach(action => {
            if (action.type === '등원' && action.scheduled_date === date && action.scheduled_time) times.push(action.scheduled_time);
        });
    });
    if (rec.extra_visit?.date === date && rec.extra_visit.time) times.push(rec.extra_visit.time);
    absences.forEach(absence => {
        if (
            absence.resolution === '보충'
            && absence.makeup_date === date
            && absence.status !== 'closed'
            && absence.makeup_status !== '미등원'
            && absence.makeup_time
        ) {
            times.push(absence.makeup_time);
        }
    });
    return times.sort()[0] || '';
}

function mapByStudent(rows) {
    const map = new Map();
    rows.forEach(row => {
        const id = row.student_id || row.studentId;
        if (!id) return;
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(row);
    });
    return map;
}

function oxChips(map, label) {
    return Object.entries(map || {})
        .filter(([, value]) => text(value))
        .map(([key, value]) => ({ label: `${label} ${key} ${value}`, issue: value !== 'O' }));
}

function actionChips(map, tasks = []) {
    const taskKeys = new Set(tasks.map(task => task.domain || task.item || task.content || '').filter(Boolean));
    return Object.entries(map || {})
        .filter(([, action]) => action?.type)
        .filter(([key]) => !taskKeys.has(key))
        .map(([key, action]) => {
            return {
                label: `${key} ${action.type}`,
                issue: action.type === '등원',
            };
        });
}

function taskChips(tasks, label) {
    return tasks.map(task => {
        const key = task.domain || task.item || task.content || '';
        const when = fmtDate(task.source_date || task.original_date || task.created_date);
        return {
            label: `${label}${key ? ` ${key}` : ''}${when ? ` ${when}` : ''}`,
            issue: task.status === 'pending' || task.status === '예정',
        };
    });
}

function nextHomeworkText(rec) {
    const personal = rec.personal_next_hw || {};
    const values = Object.entries(personal)
        .filter(([, value]) => text(value) && value !== '없음')
        .map(([key, value]) => `${key}: ${value}`);
    return values.join(' / ');
}

function buildLogData({ students, dailyLog, branchFilter, classFilter, gradeFilter, date }) {
    const {
        dailyRecords = [],
        tempAttendances = [],
        hwFailTasks = [],
        testFailTasks = [],
        absenceRecords = [],
        leaveRequests = [],
        classSettings = {},
    } = dailyLog || {};
    const records = new Map(dailyRecords.map(rec => [rec.student_id, rec]));
    const hwTasks = mapByStudent(hwFailTasks);
    const testTasks = mapByStudent(testFailTasks);
    const absenceByStudent = mapByStudent(absenceRecords);
    const dayName = getDayName(date);
    const studentById = new Map(students.map(student => [student.id, student]));

    const groups = {
        diagnostic: tempAttendances
            .filter(item => !branchFilter || item.branch === branchFilter)
            .map(item => ({
                id: `temp-${item.id}`,
                name: item.name || '(이름 없음)',
                meta: [studentShortLabel(item), item.branch].filter(Boolean).join(' · '),
                time: item.temp_time || '',
                attendance: item.visit_status === '완료' ? '완료' : '예정',
                attendanceMeta: fmtDate(item.temp_date || date),
                homework: [{ label: '진단평가', issue: false }],
                tests: [],
                notes: (item.memo || '').split('\n').filter(l => !l.includes('자동등록') && !l.includes('접수번호')).join('\n').trim(),
                next: '결과 입력 후 반배정',
                classCode: '진단평가',
                groupKey: 'diagnostic',
            })),
        regular: {},
        irregular: [],
        naesin: [],
        free: [],
        special: [],
    };

    students.forEach(student => {
        const id = student.id;
        if (!id || isWithdrawnAt(student, date)) return;
        if (branchFilter && branchFromStudent(student) !== branchFilter) return;
        if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(student))) return;

        const enrolls = activeEnrollments(student, date, classSettings);
        const todayEnrolls = enrolls.filter(e => normalizedDays(e.day).includes(dayName));
        const rec = records.get(id) || {};
        const studentHwTasks = hwTasks.get(id) || [];
        const studentTestTasks = testTasks.get(id) || [];
        const studentAbsences = absenceByStudent.get(id) || [];
        const hasExtraVisit = rec.extra_visit?.date === date;
        const hasVisitTask = hasExtraVisit
            || studentHwTasks.some(t => t.type === '등원' && t.scheduled_date === date)
            || studentTestTasks.some(t => t.type === '등원' && t.scheduled_date === date)
            || studentAbsences.some(a => a.resolution === '보충' && a.makeup_date === date && a.status !== 'closed' && a.makeup_status !== '미등원');
        if (!todayEnrolls.length && !hasVisitTask) return;

        const naesin = isNaesinActive(student, date, classSettings);
        const free = isFreeActive(student, date, classSettings);
        const special = todayEnrolls.length > 0 && todayEnrolls.every(e => e.class_type === '특강');
        let groupKey = 'regular';
        if (!todayEnrolls.length && hasVisitTask) groupKey = 'irregular';
        else if (naesin) groupKey = 'naesin';
        else if (free) groupKey = 'free';
        else if (special) groupKey = 'special';

        const primaryEnroll = todayEnrolls[0] || enrolls[0] || {};
        const code = groupKey === 'naesin'
            ? (classCode(primaryEnroll) || resolveNaesinKey(student, regularEnrollment(currentEnrollments(student, date))) || '내신')
            : (classCode(primaryEnroll) || (groupKey === 'irregular' ? '비정규' : '미지정'));
        if (classFilter && code !== classFilter && groupKey !== 'diagnostic') return;

        const attendance = rec.attendance || {};
        const attStatus = attendance.status && !DEFAULT_ATTENDANCE_LABELS.has(attendance.status)
            ? attendance.status
            : (todayEnrolls.length ? GROUP_LABELS[groupKey] : '예정');
        const chips = [
            ...oxChips(rec.hw_domains_1st, '숙제1차'),
            ...oxChips(rec.hw_domains_2nd, '숙제2차'),
            ...actionChips(rec.hw_fail_action, studentHwTasks),
            ...taskChips(studentHwTasks, '숙제미통과'),
        ];
        const tests = [
            ...oxChips(rec.test_domains_1st, '테스트1차'),
            ...oxChips(rec.test_domains_2nd, '테스트2차'),
            ...actionChips(rec.test_fail_action, studentTestTasks),
            ...taskChips(studentTestTasks, '테스트미통과'),
        ];
        const notes = [
            rec.note,
            rec.note_class_to_study && `강의실→학습실: ${rec.note_class_to_study}`,
            rec.note_to_parent && `학원→부모님: ${rec.note_to_parent}`,
            rec.naesin_memo,
            attendance.reason,
            ...studentAbsences.map(a => a.consultation_note || a.reason || '').filter(Boolean),
        ].filter(Boolean).join(' / ');
        const next = [
            nextHomeworkText(rec),
            rec.departure?.status ? `귀가: ${rec.departure.status}${rec.departure.time ? ` ${fmtTime(rec.departure.time)}` : ''}` : '',
            rec.extra_visit?.date === date ? `비정규: ${rec.extra_visit.reason || '클리닉'} ${fmtTime(rec.extra_visit.time)}` : '',
        ].filter(Boolean).join(' / ');
        const expectedTime = earliestExpectedTime({
            enrollments: todayEnrolls,
            dayName,
            classSettings,
            rec,
            hwTasks: studentHwTasks,
            testTasks: studentTestTasks,
            absences: studentAbsences,
            date,
        });
        const arrivalTime = attendance.time || rec.arrival_time || '';
        const classTeacher = teacherNameForClass(classSettings, code);

        const row = {
            id,
            name: student.name || id,
            meta: [studentShortLabel(student), code, branchFromStudent(student)].filter(Boolean).join(' · '),
            time: expectedTime,
            attendance: attStatus,
            attendanceMeta: fmtTime(arrivalTime),
            sideMeta: attStatus === '지각'
                ? `${fmtTime(arrivalTime)}/${fmtTime(expectedTime)}`
                : attStatus === '결석'
                    ? (classTeacher || '미지정')
                    : '',
            homework: chips,
            tests,
            notes,
            next,
            classCode: code,
            groupKey,
        };

        if (groupKey === 'regular') {
            if (!groups.regular[code]) groups.regular[code] = [];
            groups.regular[code].push(row);
        } else {
            groups[groupKey].push(row);
        }
    });

    Object.values(groups.regular).forEach(rows => rows.sort(sortRows));
    ['irregular', 'naesin', 'free', 'special'].forEach(key => groups[key].sort(sortRows));

    const withdrawalRows = buildLeaveRows({
        requests: leaveRequests,
        students: studentById,
        branchFilter,
        classFilter,
        gradeFilter,
        gradeKey: studentGradeKey,
        typeSet: WITHDRAW_REQUEST_TYPES,
        rowType: 'withdrawal',
        classSettings,
    });
    const leaveRows = buildLeaveRows({
        requests: leaveRequests,
        students: studentById,
        branchFilter,
        classFilter,
        gradeFilter,
        gradeKey: studentGradeKey,
        typeSet: LEAVE_REQUEST_TYPES,
        rowType: 'leave',
        classSettings,
    });

    return {
        groups,
        lateRows: allRows(groups).filter(row => row.attendance === '지각'),
        absentRows: allRows(groups).filter(row => row.attendance === '결석'),
        withdrawalRows,
        leaveRows,
        summary: {
            ...buildSummary(groups),
            withdrawals: withdrawalRows.length,
            leaves: leaveRows.length,
        },
    };
}

function normalizeClassCodes(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (!value) return [];
    return String(value).split(/[,·\s]+/).map(v => v.trim()).filter(Boolean);
}

function buildLeaveRows({ requests, students, branchFilter, classFilter, gradeFilter, gradeKey, typeSet, rowType, classSettings }) {
    return requests
        .filter(request => request.status === 'approved' && typeSet.has(request.request_type))
        .map(request => {
            const student = students.get(request.student_id) || null;
            const classCodes = normalizeClassCodes(request.class_codes);
            return { request, student, classCodes };
        })
        .filter(({ request, student, classCodes }) => {
            const branch = request.branch || (student ? branchFromStudent(student) : '');
            if (branchFilter && branch !== branchFilter) return false;
            if (classFilter && !classCodes.includes(classFilter)) return false;
            if (gradeFilter?.size && student && !gradeFilter.has(gradeKey(student))) return false;
            return true;
        })
        .map(({ request, student, classCodes }) => {
            const period = rowType === 'withdrawal'
                ? `퇴원일 ${fmtDate(request.withdrawal_date)}`
                : request.request_type === '휴원연장'
                    ? `연장 종료 ${fmtDate(request.leave_end_date)}`
                    : `${fmtDate(request.leave_start_date)} ~ ${fmtDate(request.leave_end_date)}`;
            const classText = classCodes.length ? classCodes.join(', ') : '미지정';
            const note = [
                period,
                request.leave_sub_type,
                request.consultation_note,
            ].filter(Boolean).join(' / ');
            return {
                id: request.id || request.docId || `${request.student_id}-${request.request_type}`,
                name: request.student_name || student?.name || request.student_id || '(이름 없음)',
                meta: [student ? studentShortLabel(student) : '', request.branch].filter(Boolean).join(' · '),
                classCode: classText,
                sideMeta: teacherNamesForClasses(classSettings, classCodes) || '미지정',
                notes: note,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function sortRows(a, b) {
    return (a.time || '99:99').localeCompare(b.time || '99:99') || a.name.localeCompare(b.name, 'ko');
}

function allRows(groups) {
    return [
        ...Object.values(groups.regular || {}).flat(),
        ...(groups.irregular || []),
        ...(groups.naesin || []),
        ...(groups.free || []),
        ...(groups.special || []),
    ];
}

function buildSummary(groups) {
    const rows = allRows(groups);
    const attended = rows.filter(row => ATTENDED_STATUSES.has(row.attendance)).length;
    const late = rows.filter(row => row.attendance === '지각').length;
    const absent = rows.filter(row => row.attendance === '결석').length;
    const issues = rows.reduce((sum, row) =>
        sum + row.homework.filter(c => c.issue).length + row.tests.filter(c => c.issue).length,
    0);
    const regular = Object.values(groups.regular || {}).flat().length;
    const total = rows.length;
    return {
        total,
        diagnostic: groups.diagnostic.length,
        attended,
        late,
        absent,
        pending: total - attended - absent,
        issues,
        regular,
        irregular: groups.irregular.length,
        naesin: groups.naesin.length,
        free: groups.free.length,
        special: groups.special.length,
    };
}

function rowIssueCount(row) {
    return row.homework.filter(c => c.issue).length + row.tests.filter(c => c.issue).length;
}

function countRows(rows, attendance) {
    return rows.filter(row => row.attendance === attendance).length;
}

function groupRowsByClass(rows) {
    const map = new Map();
    rows.forEach(row => {
        const code = row.classCode || '미지정';
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(row);
    });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'ko'));
}

function classGroupTitle(groupKey, code) {
    const label = GROUP_LABELS[groupKey] || '';
    if (!label || code === label) return code;
    return `${code} ${label}`;
}

function attendanceClass(status) {
    if (status === '출석' || status === '조퇴' || status === '완료') return 'ok';
    if (status === '결석') return 'bad';
    if (status === '지각') return 'warn';
    if (status === '진단평가') return 'dark';
    return 'info';
}

function SummaryCard({ icon, label, value, note }) {
    return (
        <div className="daily-log-metric">
            <div className="daily-log-metric-label">
                <span className="material-symbols-outlined">{icon}</span>
                {label}
            </div>
            <div className="daily-log-metric-value">{value}</div>
            {note && <div className="daily-log-metric-note">{note}</div>}
        </div>
    );
}

function ChipList({ chips, empty = '-' }) {
    if (!chips.length) return <span className="daily-log-empty-inline">{empty}</span>;
    return (
        <div className="daily-log-chips">
            {chips.map((chip, idx) => (
                <span key={`${chip.label}-${idx}`} className={`daily-log-chip${chip.issue ? ' issue' : ''}`}>
                    {chip.label}
                </span>
            ))}
        </div>
    );
}

function LogTable({ rows, diagnostic = false }) {
    if (!rows.length) return <div className="daily-log-empty">해당 학생 없음</div>;
    return (
        <div className="daily-log-table-wrap">
            <table className="daily-log-table">
                <colgroup>
                    <col className="dlc-student" />
                    <col className="dlc-time" />
                    <col className="dlc-att" />
                    <col className="dlc-hw" />
                    <col className="dlc-test" />
                    <col className="dlc-note" />
                    <col className="dlc-next" />
                </colgroup>
                <thead>
                    <tr>
                        <th>학생</th>
                        <th>시간</th>
                        <th>{diagnostic ? '상태' : '출결'}</th>
                        {diagnostic ? (
                            <>
                                <th colSpan={2}>전달/상담</th>
                                <th colSpan={2}>상담결과</th>
                            </>
                        ) : (
                            <>
                                <th>숙제/리뷰</th>
                                <th>테스트/재시</th>
                                <th>전달/상담</th>
                                <th>다음 숙제/후속</th>
                            </>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr key={row.id}>
                            <td>
                                <span className="daily-log-student">{row.name}</span>
                                <span className="daily-log-sub">{row.meta}</span>
                            </td>
                            <td>{fmtTime(row.time)}</td>
                            <td>
                                <span className={`daily-log-pill ${attendanceClass(row.attendance)}`}>{row.attendance}</span>
                                {row.attendanceMeta && <span className="daily-log-sub">{row.attendanceMeta}</span>}
                            </td>
                            {diagnostic ? (
                                <>
                                    <td colSpan={2}>{row.notes || '-'}</td>
                                    <td colSpan={2}>{row.next || '-'}</td>
                                </>
                            ) : (
                                <>
                                    <td><ChipList chips={row.homework} /></td>
                                    <td><ChipList chips={row.tests} /></td>
                                    <td>{row.notes || '-'}</td>
                                    <td>{row.next || '-'}</td>
                                </>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ClassGroup({ groupKey, classCode, rows, open = false }) {
    const late = countRows(rows, '지각');
    const absent = countRows(rows, '결석');
    const issues = rows.reduce((sum, row) => sum + rowIssueCount(row), 0);
    return (
        <details className="daily-log-class-details" open={open}>
            <summary>
                <span className="material-symbols-outlined daily-log-class-chev">chevron_right</span>
                <strong>{classGroupTitle(groupKey, classCode)}</strong>
                <span>{rows.length}명 · 지각 {late} · 결석 {absent} · 이슈 {issues}</span>
            </summary>
            <LogTable rows={rows} />
        </details>
    );
}

function ClassGroupedRows({ groupKey, rows, entries, empty }) {
    const groupedEntries = entries || groupRowsByClass(rows);
    if (groupedEntries.length === 0) return <div className="daily-log-empty">{empty || '해당 학생 없음'}</div>;
    return (
        <div className="daily-log-class-list">
            {groupedEntries.map(([code, classRows]) => (
                <ClassGroup key={`${groupKey}-${code}`} groupKey={groupKey} classCode={code} rows={classRows} />
            ))}
        </div>
    );
}

function AccordionGroup({ groupKey, rows, children, open = false }) {
    if (groupKey !== 'regular' && rows.length === 0) return null;
    const late = countRows(rows, '지각');
    const absent = countRows(rows, '결석');
    const issueCount = rows.reduce((sum, row) => sum + rowIssueCount(row), 0);
    return (
        <details className="daily-log-details" open={open}>
            <summary>
                <span className="material-symbols-outlined daily-log-chev">chevron_right</span>
                <div className="daily-log-group-title">
                    <strong>{GROUP_LABELS[groupKey]}</strong>
                </div>
                <div className="daily-log-counts">
                    <span className="daily-log-pill info">{rows.length}명</span>
                    {late > 0 && <span className="daily-log-pill count-late">지각 {late}</span>}
                    {absent > 0 && <span className="daily-log-pill count-absent">결석 {absent}</span>}
                    {issueCount > 0 && <span className="daily-log-pill gold">이슈 {issueCount}</span>}
                </div>
            </summary>
            {children || (groupKey === 'diagnostic'
                ? <LogTable rows={rows} diagnostic />
                : <ClassGroupedRows groupKey={groupKey} rows={rows} />)}
        </details>
    );
}

function SideList({ title, icon, rows, type, hideEmptyBody = false }) {
    return (
        <div className={`daily-log-side-card ${type}`}>
            <div className={`daily-log-side-head ${type}`}>
                <div>
                    <span className="material-symbols-outlined">{icon}</span>
                    {title}
                </div>
                <span>{rows.length}명</span>
            </div>
            {!(hideEmptyBody && rows.length === 0) && (
                <div className="daily-log-side-list">
                    {rows.length === 0 ? (
                        <div className="daily-log-empty">명단 없음</div>
                    ) : rows.map(row => (
                        <div key={`${type}-${row.id}`} className="daily-log-side-item">
                            <div className="daily-log-side-top">
                                <strong>{row.name}</strong>
                                <span>{[row.classCode, row.sideMeta || row.attendanceMeta || fmtTime(row.time)].filter(Boolean).join(' · ')}</span>
                            </div>
                            <div className="daily-log-side-note">
                                {row.notes || row.next || ''}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function DailyLogBoard({ students, dailyLog, branchFilter, classFilter, gradeFilter, date }) {
    const data = useMemo(() =>
        buildLogData({ students, dailyLog, branchFilter, classFilter, gradeFilter, date }),
    [students, dailyLog, branchFilter, classFilter, gradeFilter, date]);
    const regularEntries = Object.entries(data.groups.regular).sort(([a], [b]) => a.localeCompare(b, 'ko'));
    const regularRows = regularEntries.flatMap(([, rows]) => rows);

    return (
        <div className="daily-log-page">
            <div className="daily-log-summary">
                <SummaryCard icon="groups" label="전체 예정" value={data.summary.total} note={`정규 ${data.summary.regular} / 비정규 ${data.summary.irregular} / 내신 ${data.summary.naesin} / 자유학기 ${data.summary.free} / 특강 ${data.summary.special}`} />
                <SummaryCard icon="science" label="진단평가" value={data.summary.diagnostic} />
                <SummaryCard icon="how_to_reg" label="출석" value={data.summary.attended} note="출석/지각/조퇴 포함" />
                <SummaryCard icon="schedule" label="지각" value={data.summary.late} note="우측 명단 표시" />
                <SummaryCard icon="person_off" label="결석" value={data.summary.absent} note="결석대장/사유 함께 표시" />
                <SummaryCard icon="pending_actions" label="미입력" value={data.summary.pending} note="출결 미기록 학생" />
                <SummaryCard icon="assignment_late" label="학습 이슈" value={data.summary.issues} note="숙제/테스트/후속조치" />
                <SummaryCard icon="logout" label="퇴원" value={data.summary.withdrawals} note="승인일 기준" />
                <SummaryCard icon="pause_circle" label="휴원" value={data.summary.leaves} note="승인일 기준" />
            </div>

            <div className="daily-log-work-area">
                <div className="daily-log-main-card">
                    <div className="daily-log-main-head">
                        <div>
                            <span className="material-symbols-outlined">view_list</span>
                            학생별 일일 로그
                        </div>
                        <span>{fmtDate(date)} ({getDayName(date)})</span>
                    </div>
                    <div className="daily-log-accordion">
                        <AccordionGroup groupKey="diagnostic" rows={data.groups.diagnostic} />
                        <AccordionGroup groupKey="regular" rows={regularRows}>
                            <ClassGroupedRows groupKey="regular" rows={regularRows} entries={regularEntries} empty="정규 학생 없음" />
                        </AccordionGroup>
                        {OPTIONAL_GROUPS.map(key => (
                            <AccordionGroup key={key} groupKey={key} rows={data.groups[key]} />
                        ))}
                    </div>
                </div>

                <aside className="daily-log-side-stack">
                    <SideList title="퇴원 명단" icon="logout" rows={data.withdrawalRows} type="withdrawal" hideEmptyBody />
                    <SideList title="휴원 명단" icon="pause_circle" rows={data.leaveRows} type="leave" hideEmptyBody />
                    <SideList title="결석 명단" icon="person_off" rows={data.absentRows} type="absent" hideEmptyBody />
                    <SideList title="지각 명단" icon="schedule" rows={data.lateRows} type="late" hideEmptyBody />
                </aside>
            </div>
        </div>
    );
}

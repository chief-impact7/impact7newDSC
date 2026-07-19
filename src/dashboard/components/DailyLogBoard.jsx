import React, { useMemo, useState, useEffect } from 'react';
import { Icon } from '@impact7/ui';
import { ICON_NAME } from '../icon-map.js';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import { getDayName, studentGradeKey, studentShortLabel, normalizeAttendanceLabel } from '../../shared/firestore-helpers.js';
import { branchFromStudent, resolveNaesinCsKey, displayCodeFromCsKey, isOnLeaveAt, isWithdrawnAt } from '../../../student-helpers.js';
import { applyNaesinFreeDerivation } from '@impact7/shared/enrollment-derivation';
import { computeExpectedArrival, isLate } from '@impact7/shared/expected-arrival';
import { staffLabel } from '@impact7/shared/staff-label';
import { formatPhone } from '@impact7/shared/phone';
import { sortByProcessed, arrivalOrder, departureOrder, groupByState } from '@impact7/shared/attendance-log';

const ATTENDED_STATUSES = new Set(['출석', '지각', '조퇴']);
const ALT_VIEW_STATUSES = new Set(['재원', '실휴원', '가휴원']);
const DEFAULT_ATTENDANCE_LABELS = new Set(['정규', '특강', '내신', '자유', '자유학기', '비정규', '미확인']);
const WITHDRAW_REQUEST_TYPES = new Set(['퇴원요청', '휴원→퇴원']);
const LEAVE_REQUEST_TYPES = new Set(['휴원요청', '퇴원→휴원', '휴원연장']);
const GROUP_ORDER = ['diagnostic', 'regular', 'irregular', 'naesin', 'free', 'special', 'leave'];
const OPTIONAL_GROUPS = GROUP_ORDER.filter(key => !['diagnostic', 'regular'].includes(key));
const GROUP_LABELS = {
    diagnostic: '진단평가',
    regular: '정규',
    irregular: '비정규',
    naesin: '내신',
    free: '자유학기',
    special: '특강',
    leave: '휴원중',
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
const isoToHHMM = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
};
const teacherNamesForClasses = (classSettings, codes) => {
    const names = codes.map(code => teacherNameForClass(classSettings, code)).filter(Boolean);
    return [...new Set(names)].join(', ');
};
// 약속시간에 오지 않아 따로 연락해야 하는 그룹 — 렌더에서 연락처 상세를 펼쳐 보여준다.
const CONTACT_GROUP = '미도착(연락)';
// 연락은 학부모 우선(parent_phone_1 → parent_phone_2 → student_phone).
const contactPhone = (s) => s.parent_phone_1 || s.parent_phone_2 || s.student_phone || '';

// 상태별 뷰의 '미등원'을 등원전/미도착으로 세분. 지각 판정은 shared isLate(예정+유예 초과)를 재사용하되
// 실제 등원시각 대신 '현재 시각'을 넘겨 "지금이 예정+유예를 지났는가"로 판정한다.
// 실제로 오늘 올 학생만 대상 — 오늘 등원예정 아님·휴원, 그리고 출결이 이미 기록된
// (결석·기타 등 비등원 처리 포함) 학생은 연락 대상이 아니므로 두 그룹 모두에서 제외한다.
function splitPendingGroup(groups, { arrivalByStudent, dailyByStudent, nowHHMM, date, enabled }) {
    if (!enabled) return groups;
    const { 미등원: pending = [], ...rest } = groups;
    const before = [];
    const contact = [];
    for (const s of pending) {
        const expected = arrivalByStudent?.[s.student_id];
        if (!expected) continue;
        if (isOnLeaveAt(s, date)) continue;
        // status가 실제 출결값(출석/지각/조퇴/결석/기타…)이면 이미 처리됨 — 반유형 기본라벨은 미처리로 통과.
        const st = dailyByStudent?.[s.student_id]?.attendance?.status;
        if (st && !DEFAULT_ATTENDANCE_LABELS.has(st)) continue;
        (isLate(nowHHMM, expected) ? contact : before).push(s);
    }
    return { 등원전: before, [CONTACT_GROUP]: contact, ...rest };
}

// 등원 예정시각 계산은 @impact7/shared/expected-arrival(computeExpectedArrival)로 이관.

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
        leave: [],
    };

    students.forEach(student => {
        const id = student.id;
        if (!id || isWithdrawnAt(student, date)) return;
        if (branchFilter && branchFromStudent(student) !== branchFilter) return;
        if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(student))) return;

        // 내신/자유학기 파생은 DSC·shared와 동일한 SSoT(applyNaesinFreeDerivation)로만 — 자체 재구현 금지(drift 방지).
        // 반환 [0]이 대표(내신 > 자유학기 > 정규 순). 분류·대표코드 모두 이 결과로 결정한다.
        const current = (student.enrollments || []).filter(e => {
            if (validDate(e.start_date) && e.start_date > date) return false;
            if (validDate(e.end_date) && e.end_date < date) return false;
            return true;
        });
        const enrolls = applyNaesinFreeDerivation(current, {
            classSettings,
            dateStr: date,
            resolveNaesinCsKey: (re) => resolveNaesinCsKey(student, re),
            enrollmentCode: classCode,
        });
        const todayEnrolls = enrolls.filter(e => normalizedDays(e.day).includes(dayName));

        // 휴원중: 정규/자유 등에 섞이지 않게 별도 '휴원중' 그룹으로 분리
        if (isOnLeaveAt(student, date)) {
            const primary = todayEnrolls[0] || enrolls[0] || {};
            const leaveCode = classCode(primary) || '미지정';
            if (classFilter && leaveCode !== classFilter) return; // 반 필터 시 사이드 휴원명단과 동작 일치
            groups.leave.push({
                id,
                name: student.name || id,
                meta: [studentShortLabel(student), branchFromStudent(student)].filter(Boolean).join(' · '),
                time: '',
                attendance: student.status,
                attendanceMeta: (student.pause_start_date && student.pause_end_date)
                    ? `${fmtDate(student.pause_start_date)} ~ ${fmtDate(student.pause_end_date)}` : '',
                homework: [],
                tests: [],
                notes: student.scheduled_leave_status ? `예약 ${student.scheduled_leave_status}` : '',
                next: '',
                classCode: leaveCode,
                classLabel: leaveCode,
                groupKey: 'leave',
            });
            return;
        }

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

        const primaryEnroll = todayEnrolls[0] || enrolls[0] || {};
        const ct = primaryEnroll.class_type;
        let groupKey = 'regular';
        if (!todayEnrolls.length && hasVisitTask) groupKey = 'irregular';
        else if (ct === '내신') groupKey = 'naesin';
        else if (ct === '자유학기') groupKey = 'free';
        else if (todayEnrolls.length > 0 && todayEnrolls.every(e => e.class_type === '특강')) groupKey = 'special';

        const code = groupKey === 'naesin'
            ? (classCode(primaryEnroll) || '내신')
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
            ...(Array.isArray(student.memo) ? student.memo.filter(m => m?.date === date).map(m => m.text) : []),
            attendance.reason,
            ...studentAbsences.map(a => a.consultation_note || a.reason || '').filter(Boolean),
        ].filter(Boolean).join(' / ');
        const next = [
            nextHomeworkText(rec),
            rec.departure?.status ? `${normalizeAttendanceLabel(rec.departure.status)}${rec.departure.time ? ` ${fmtTime(rec.departure.time)}` : ''}` : '',
            rec.extra_visit?.date === date ? `비정규: ${rec.extra_visit.reason || '클리닉'} ${fmtTime(rec.extra_visit.time)}` : '',
        ].filter(Boolean).join(' / ');
        const expectedTime = computeExpectedArrival({
            enrollments: student.enrollments,
            classSettings,
            rec,
            hwTasks: studentHwTasks,
            testTasks: studentTestTasks,
            absences: studentAbsences,
            date,
        });
        const arrivalTime = attendance.time || rec.arrival_time || '';
        const classTeacher = teacherNameForClass(classSettings, code);

        const classLabel = groupKey === 'naesin' && code !== '내신'
            ? displayCodeFromCsKey(code, classSettings[code]?.branch)
            : code;
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
            classLabel,
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
    ['irregular', 'naesin', 'free', 'special', 'leave'].forEach(key => groups[key].sort(sortRows));

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
        leave: groups.leave.length,
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
                <Icon name={ICON_NAME[icon]} size={19} className="i7-icon" aria-hidden="true" />
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
    const displayCode = rows[0]?.classLabel ?? classCode;
    return (
        <details className="daily-log-class-details" open={open}>
            <summary>
                <Icon name={ICON_NAME.chevron_right} size={20} className="daily-log-class-chev" aria-hidden="true" />
                <strong>{classGroupTitle(groupKey, displayCode)}</strong>
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
                <Icon name={ICON_NAME.chevron_right} size={24} className="daily-log-chev" aria-hidden="true" />
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
                    <Icon name={ICON_NAME[icon]} size={24} aria-hidden="true" />
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

// 미등원 알림톡 발송 상태 배지 — delivery_status(message_queue 최종 결과가 absence_notices에
// 반영된 값)별 표시. pending/processing/failed_retryable은 아직 결과 미확정이라 묶어서 보여준다
// (새로고침 시에만 갱신 — 실시간 리스너 아님. impact7DB syncAbsenceNoticeDeliveryStatus 참고).
const ABSENCE_STATUS_META = {
    pending: { label: '발송 처리중…', cls: 'pending' },
    processing: { label: '발송 처리중…', cls: 'pending' },
    failed_retryable: { label: '재시도 중…', cls: 'pending' },
    sent: { label: '알림톡 발송됨', cls: 'sent', icon: 'check-circle' },
    failed_permanent: { label: '발송 최종 실패', cls: 'failed', icon: 'warning' },
};

// 미도착(연락) 그룹 — 연락처(tel 링크)·예정시각과 함께, 사람이 확인 후 누르는 미등원 알림톡 발송
// 버튼을 노출한다(발송 완료/실패 학생은 상태 배지). 자동 스윕 대신 수동 발송으로 오탐을 줄인다.
function ContactList({ rows, arrivalByStudent, statusById, sending, onSend }) {
    if (!rows.length) return <div className="daily-log-empty">연락할 학생 없음</div>;
    return (
        <div className="daily-log-side-list">
            {rows.map((s, i) => {
                const phone = contactPhone(s);
                const sid = s.student_id;
                const status = statusById?.get(sid);
                const meta = status ? (ABSENCE_STATUS_META[status] ?? { label: status, cls: 'pending' }) : null;
                return (
                    <div key={sid ?? i} className="daily-log-side-item">
                        <div className="daily-log-side-top">
                            <strong>{s.student_name ?? s.name}</strong>
                            <span>{[studentShortLabel(s), `예정 ${fmtTime(arrivalByStudent[sid])}`].filter(Boolean).join(' · ')}</span>
                        </div>
                        <div className="daily-log-side-note">
                            {phone
                                ? <a href={`tel:${String(phone).replace(/[^0-9+]/g, '')}`}>{formatPhone(phone)}</a>
                                : '연락처 없음'}
                            {phone && onSend && (meta
                                ? <span className={`absence-sent-badge ${meta.cls}`}>
                                    {meta.icon && <Icon name={meta.icon} size={14} aria-hidden="true" />}
                                    {meta.label}
                                </span>
                                : <button
                                    type="button"
                                    className="absence-send-btn"
                                    disabled={!!sending}
                                    onClick={() => onSend(sid, arrivalByStudent[sid])}
                                >
                                    {sending === sid ? '발송 중…' : '미등원 알림톡'}
                                </button>)}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export default function DailyLogBoard({ students, dailyLog, branchFilter, classFilter, gradeFilter, date }) {
    const [viewMode, setViewMode] = useState('classes');

    // 미등원 안내 수동 발송(미도착 연락). 상태 = 서버 absence_notices(dailyLog.absenceNoticeStatus,
    // 발송 결과 delivery_status 반영) + 이번 세션 로컬 발송분(optimistic, 결과 미확정이라 'pending')을
    // 합쳐 배지로 표시한다(자동 스윕과 멱등 컬렉션 공유). 실시간 리스너가 아니라 새로고침 시에만 갱신.
    const sendAbsenceCallable = useMemo(() => httpsCallable(functions, 'sendAbsenceNotice'), []);
    const [absenceSentLocal, setAbsenceSentLocal] = useState(() => new Set());
    const [absenceSending, setAbsenceSending] = useState(null);
    // 조회일이 바뀌면 optimistic 발송분을 초기화 — 어제 발송이 오늘 화면에 거짓 배지로 새지 않게.
    useEffect(() => { setAbsenceSentLocal(new Set()); }, [date]);
    const absenceStatusById = useMemo(() => {
        const m = new Map(Object.entries(dailyLog?.absenceNoticeStatus ?? {}));
        absenceSentLocal.forEach((id) => { if (!m.has(id)) m.set(id, 'pending'); });
        return m;
    }, [dailyLog, absenceSentLocal]);
    const handleSendAbsence = async (studentId, expectedTime) => {
        if (!studentId || absenceSending) return;
        setAbsenceSending(studentId);
        try {
            await sendAbsenceCallable({ studentId, expectedTime: expectedTime ?? '' });
            setAbsenceSentLocal((prev) => new Set(prev).add(studentId));
        } catch (e) {
            alert('미등원 알림톡 발송 실패: ' + (e?.message || e));
        } finally {
            setAbsenceSending(null);
        }
    };
    const data = useMemo(() =>
        buildLogData({ students, dailyLog, branchFilter, classFilter, gradeFilter, date }),
    [students, dailyLog, branchFilter, classFilter, gradeFilter, date]);
    const regularEntries = Object.entries(data.groups.regular).sort(([a], [b]) => a.localeCompare(b, 'ko'));
    const regularRows = regularEntries.flatMap(([, rows]) => rows);

    const { attendanceEvents, dailyByStudent, stateStudents, arrivalByStudent } = useMemo(() => {
        // 대체 뷰(처리순/등원순/귀가순/상태별) 모집단: 재원·실휴원·가휴원 + 활성 branch/grade 필터, 퇴원 제외
        const altStudents = students.filter(s =>
            ALT_VIEW_STATUSES.has(s.status) &&
            !isWithdrawnAt(s, date) &&
            (!branchFilter || branchFromStudent(s) === branchFilter) &&
            (!gradeFilter?.size || gradeFilter.has(studentGradeKey(s)))
        );
        const altStudentIds = new Set(altStudents.map(s => s.id));
        const events = (dailyLog?.attendanceEvents ?? []).filter(e => altStudentIds.has(e.student_id));
        const byStudent = {};
        (dailyLog?.dailyRecords ?? []).forEach(r => {
            byStudent[r.student_id] = {
                day_state: r.day_state,
                attendance: { status: r.attendance?.status }
            };
        });
        // 미등원 세분(등원전/미도착)용 학생별 등원 예정시각 — computeExpectedArrival이 오늘요일 필터까지 처리('' = 오늘 등원예정 아님)
        const classSettings = dailyLog?.classSettings ?? {};
        const recMap = new Map((dailyLog?.dailyRecords ?? []).map(r => [r.student_id, r]));
        const hwMap = mapByStudent(dailyLog?.hwFailTasks ?? []);
        const testMap = mapByStudent(dailyLog?.testFailTasks ?? []);
        const absMap = mapByStudent(dailyLog?.absenceRecords ?? []);
        const arrival = {};
        altStudents.forEach(s => {
            arrival[s.id] = computeExpectedArrival({
                enrollments: s.enrollments,
                classSettings,
                rec: recMap.get(s.id) || {},
                hwTasks: hwMap.get(s.id) || [],
                testTasks: testMap.get(s.id) || [],
                absences: absMap.get(s.id) || [],
                date,
            });
        });
        // groupByState는 s.student_id로 조회하나 students 원소는 .id만 가짐 → student_id 키 부여 필수(정렬 아님)
        return {
            attendanceEvents: events,
            dailyByStudent: byStudent,
            stateStudents: altStudents.map(s => ({ ...s, student_id: s.id })),
            arrivalByStudent: arrival,
        };
    }, [students, dailyLog, branchFilter, gradeFilter, date]);

    // '미등원' → 등원전/미도착 세분은 오늘 조회일 때만(과거·미래는 현재시각 비교가 무의미).
    const nowKST = new Date();
    const isTodayView = date === nowKST.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const nowHHMM = nowKST.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });

    return (
        <div className="daily-log-page">
            <div className="daily-log-view-toggle">
                {[
                    { key: 'classes', label: '반별' },
                    { key: 'processed', label: '처리순' },
                    { key: 'arrival', label: '등원순' },
                    { key: 'departure', label: '귀가순' },
                    { key: 'state', label: '상태별' },
                ].map(({ key, label }) => (
                    <button
                        key={key}
                        className={`daily-log-toggle-btn${viewMode === key ? ' active' : ''}`}
                        onClick={() => setViewMode(key)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="daily-log-summary">
                <SummaryCard icon="groups" label="전체 예정" value={data.summary.total} note={`정규 ${data.summary.regular} / 비정규 ${data.summary.irregular} / 내신 ${data.summary.naesin} / 자유학기 ${data.summary.free} / 특강 ${data.summary.special}`} />
                <SummaryCard icon="science" label="진단평가" value={data.summary.diagnostic} />
                <SummaryCard icon="how_to_reg" label="출석" value={data.summary.attended} note="출석/지각/조퇴 포함" />
                <SummaryCard icon="schedule" label="지각" value={data.summary.late} note="우측 명단 표시" />
                <SummaryCard icon="person_off" label="결석" value={data.summary.absent} note="결석대장/사유 함께 표시" />
                <SummaryCard icon="pending_actions" label="미입력" value={data.summary.pending} note="출결 미기록 학생" />
                <SummaryCard icon="assignment_late" label="학습 이슈" value={data.summary.issues} note="숙제/테스트/후속조치" />
                <SummaryCard icon="logout" label="퇴원" value={data.summary.withdrawals} note="승인일 기준" />
                <SummaryCard icon="pause_circle" label="휴원중" value={data.summary.leave} note="현재 휴원(가/실휴원) 학생 수" />
            </div>

            {viewMode === 'classes' ? (
                <div className="daily-log-work-area">
                    <div className="daily-log-main-card">
                        <div className="daily-log-main-head">
                            <div>
                                <Icon name={ICON_NAME.view_list} size={24} aria-hidden="true" />
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
            ) : viewMode === 'processed' ? (
                <div className="daily-log-alt-view">
                    {sortByProcessed(attendanceEvents).map((e, i) => (
                        <div key={i} className="daily-log-event-row">
                            <span className="evt-time">{isoToHHMM(e.occurred_at)}</span>
                            <span className="evt-name">{e.student_name}</span>
                            <span className="evt-type">{e.type}</span>
                        </div>
                    ))}
                </div>
            ) : viewMode === 'arrival' ? (
                <div className="daily-log-alt-view">
                    {arrivalOrder(attendanceEvents, dailyByStudent).map((e, i) => (
                        <div key={i} className="daily-log-event-row">
                            <span className="evt-time">{isoToHHMM(e.occurred_at)}</span>
                            <span className="evt-name">{e.student_name}</span>
                            <span className="evt-type">{e.late ? '지각' : '등원'}</span>
                        </div>
                    ))}
                </div>
            ) : viewMode === 'departure' ? (
                <div className="daily-log-alt-view">
                    {departureOrder(attendanceEvents).map((e, i) => (
                        <div key={i} className="daily-log-event-row">
                            <span className="evt-time">{isoToHHMM(e.occurred_at)}</span>
                            <span className="evt-name">{e.student_name}</span>
                            <span className="evt-type">하원</span>
                        </div>
                    ))}
                </div>
            ) : viewMode === 'state' ? (
                <div className="daily-log-main-card">
                    <div className="daily-log-accordion">
                        {Object.entries(splitPendingGroup(
                            groupByState(stateStudents, dailyByStudent),
                            { arrivalByStudent, dailyByStudent, nowHHMM, date, enabled: isTodayView },
                        )).map(([group, list]) => {
                            const isContact = group === CONTACT_GROUP;
                            return (
                                <details key={group} className={`daily-log-details${isContact ? ' contact' : ''}`} open={isContact && list.length > 0 ? true : undefined}>
                                    <summary>
                                        <Icon name={ICON_NAME.chevron_right} size={24} className="daily-log-chev" aria-hidden="true" />
                                        <div className="daily-log-group-title">
                                            <strong>{group}</strong>
                                        </div>
                                        <div className="daily-log-counts">
                                            <span className={`daily-log-pill ${isContact ? 'warn' : 'info'}`}>{list.length}명</span>
                                        </div>
                                    </summary>
                                    {isContact ? (
                                        <ContactList rows={list} arrivalByStudent={arrivalByStudent} statusById={absenceStatusById} sending={absenceSending} onSend={handleSendAbsence} />
                                    ) : (
                                        <div className="daily-log-state-names">
                                            {list.map((s, i) => (
                                                <span key={s.student_id ?? i} className="daily-log-name-chip">{s.student_name ?? s.name}</span>
                                            ))}
                                        </div>
                                    )}
                                </details>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

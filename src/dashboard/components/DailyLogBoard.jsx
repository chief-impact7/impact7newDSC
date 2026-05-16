import React, { useMemo } from 'react';
import { getDayName, studentShortLabel } from '../../shared/firestore-helpers.js';

const ACTIVE_STATUSES = new Set(['재원', '등원예정', '실휴원', '가휴원', '상담']);
const ATTENDED_STATUSES = new Set(['출석', '지각', '조퇴']);
const DEFAULT_ATTENDANCE_LABELS = new Set(['정규', '특강', '내신', '자유', '자유학기', '비정규', '미확인']);
const REGULAR_CLASS_TYPES = new Set(['정규', '자유학기', undefined, null, '']);
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
const GROUP_DESCRIPTIONS = {
    diagnostic: '진단평가 때문에 등원하는 학생만 분리 표시',
    regular: '항상 표시, 반별로 묶어서 확인',
    irregular: '보강/클리닉/미통과 등 비정규 등원',
    naesin: '내신 기간 학생',
    free: '자유학기 수업 학생',
    special: '특강 학생',
};

const classCode = (enrollment) => `${enrollment?.level_symbol || ''}${enrollment?.class_number || ''}`;
const normalizedDays = (day) => {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => String(d).replace('요일', '').trim()).filter(Boolean);
    return String(day).split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
};
const validDate = (value) => value && /^\d{4}-/.test(value);
const text = (value) => (value == null ? '' : String(value).trim());
const fmtTime = (value) => text(value) || '-';

function getBranch(student) {
    if (student?.branch) return student.branch;
    const num = student?.enrollments?.[0]?.class_number || '';
    const first = String(num).trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

function isWithdrawnAt(student, date) {
    if (student.status === '퇴원' || student.status === '종강') return true;
    if (ACTIVE_STATUSES.has(student.status || '')) return false;
    return student.withdrawal_date ? student.withdrawal_date <= date : false;
}

function buildNaesinKey(student, enrollment) {
    const levelShortMap = { '초등': '초', '중등': '중', '고등': '고' };
    const levelShort = levelShortMap[student.level] || '';
    const school = student.school || '';
    const grade = student.grade || '';
    const cn = String(enrollment?.class_number || '');
    let group = '';
    const last = cn.slice(-1).toUpperCase();
    if (last === 'A' || last === 'B') group = last;
    else {
        const n = Number.parseInt(last, 10);
        if (!Number.isNaN(n)) group = n % 2 === 1 ? 'A' : 'B';
    }
    if (!school || !grade || !group) return '';
    return `${getBranch(student)}${school}${levelShort}${grade}${group}`;
}

function currentEnrollments(student, date) {
    return (student.enrollments || []).filter(e => !validDate(e.end_date) || e.end_date >= date);
}

function regularEnrollment(enrollments) {
    return enrollments.find(e => REGULAR_CLASS_TYPES.has(e.class_type) && e.class_number);
}

function hasExplicitNaesin(enrollments, date) {
    return enrollments.some(e => e.class_type === '내신' && (!validDate(e.start_date) || e.start_date <= date));
}

function hasAutoNaesin(student, enrollment, date, classSettings) {
    const key = enrollment ? buildNaesinKey(student, enrollment) : '';
    const cs = key ? classSettings[key] : null;
    return !!(cs?.naesin_start && cs?.naesin_end && cs.naesin_start <= date && cs.naesin_end >= date);
}

function activeEnrollments(student, date, classSettings) {
    const current = currentEnrollments(student, date);
    if (!current.length) return [];

    const regular = regularEnrollment(current);
    if (hasExplicitNaesin(current, date) || hasAutoNaesin(student, regular, date, classSettings)) {
        return current.filter(e => (e.class_type || '정규') !== '정규');
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

function actionChips(map) {
    return Object.entries(map || {})
        .filter(([, action]) => action?.type)
        .map(([key, action]) => {
            const dateTime = [action.scheduled_date, action.scheduled_time].filter(Boolean).join(' ');
            return {
                label: `${key} ${action.type}${dateTime ? ` ${dateTime}` : ''}`,
                issue: action.type === '등원',
            };
        });
}

function taskChips(tasks, label, date) {
    return tasks.map(task => {
        const key = task.domain || task.item || task.content || '';
        const when = task.scheduled_date === date
            ? [task.scheduled_date, task.scheduled_time].filter(Boolean).join(' ')
            : task.source_date || '';
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

function buildLogData({ students, dailyLog, branchFilter, classFilter, date }) {
    const {
        dailyRecords = [],
        tempAttendances = [],
        hwFailTasks = [],
        testFailTasks = [],
        absenceRecords = [],
        classSettings = {},
    } = dailyLog || {};
    const records = new Map(dailyRecords.map(rec => [rec.student_id, rec]));
    const hwTasks = mapByStudent(hwFailTasks);
    const testTasks = mapByStudent(testFailTasks);
    const absenceByStudent = mapByStudent(absenceRecords);
    const dayName = getDayName(date);

    const groups = {
        diagnostic: tempAttendances
            .filter(item => !branchFilter || item.branch === branchFilter)
            .map(item => ({
                id: `temp-${item.id}`,
                name: item.name || '(이름 없음)',
                meta: [studentShortLabel(item), item.branch].filter(Boolean).join(' · '),
                time: item.temp_time || '',
                attendance: item.visit_status === '완료' ? '완료' : '예정',
                attendanceMeta: item.temp_date || date,
                homework: [{ label: '진단평가', issue: false }],
                tests: [],
                notes: item.memo || '',
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
        if (branchFilter && getBranch(student) !== branchFilter) return;

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
            || studentAbsences.some(a => a.resolution === '보충' && a.makeup_date === date && a.status === 'open');
        if (!todayEnrolls.length && !hasVisitTask && !records.has(id)) return;

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
            ? (buildNaesinKey(student, primaryEnroll) || classCode(primaryEnroll) || '내신')
            : (classCode(primaryEnroll) || (groupKey === 'irregular' ? '비정규' : '미지정'));
        if (classFilter && code !== classFilter && groupKey !== 'diagnostic') return;

        const attendance = rec.attendance || {};
        const attStatus = attendance.status && !DEFAULT_ATTENDANCE_LABELS.has(attendance.status)
            ? attendance.status
            : (todayEnrolls.length ? GROUP_LABELS[groupKey] : '예정');
        const chips = [
            ...oxChips(rec.hw_domains_1st, '숙제1차'),
            ...oxChips(rec.hw_domains_2nd, '숙제2차'),
            ...actionChips(rec.hw_fail_action),
            ...taskChips(studentHwTasks, '숙제미통과', date),
        ];
        const tests = [
            ...oxChips(rec.test_domains_1st, '테스트1차'),
            ...oxChips(rec.test_domains_2nd, '테스트2차'),
            ...actionChips(rec.test_fail_action),
            ...taskChips(studentTestTasks, '테스트미통과', date),
        ];
        const notes = [
            rec.note,
            rec.note_class_to_study && `강의실→학습실: ${rec.note_class_to_study}`,
            rec.note_to_parent && `학원→부모님: ${rec.note_to_parent}`,
            rec.naesin_memo,
            attendance.reason && `출결사유: ${attendance.reason}`,
            ...studentAbsences.map(a => a.consultation_note || a.reason || '').filter(Boolean),
        ].filter(Boolean).join(' / ');
        const next = [
            nextHomeworkText(rec),
            rec.departure?.status ? `귀가: ${rec.departure.status}${rec.departure.time ? ` ${rec.departure.time}` : ''}` : '',
            rec.extra_visit?.date === date ? `비정규: ${rec.extra_visit.reason || '클리닉'} ${rec.extra_visit.time || ''}` : '',
        ].filter(Boolean).join(' / ');

        const row = {
            id,
            name: student.name || id,
            meta: [studentShortLabel(student), code, getBranch(student)].filter(Boolean).join(' · '),
            time: startTime(primaryEnroll, dayName, classSettings) || rec.extra_visit?.time || '',
            attendance: attStatus,
            attendanceMeta: attendance.time || rec.arrival_time || '',
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

    return {
        groups,
        lateRows: allRows(groups).filter(row => row.attendance === '지각'),
        absentRows: allRows(groups).filter(row => row.attendance === '결석'),
        summary: buildSummary(groups),
    };
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
    return {
        total: rows.length,
        diagnostic: groups.diagnostic.length,
        attended,
        late,
        absent,
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
            <div className="daily-log-metric-note">{note}</div>
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
                <thead>
                    <tr>
                        <th>학생</th>
                        <th>{diagnostic ? '예정' : '시간'}</th>
                        <th>{diagnostic ? '상태' : '출결'}</th>
                        <th>{diagnostic ? '진단평가/준비' : '숙제/리뷰'}</th>
                        {!diagnostic && <th>테스트/재시</th>}
                        <th>전달/상담</th>
                        <th>다음 숙제/후속</th>
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
                            <td><ChipList chips={row.homework} /></td>
                            {!diagnostic && <td><ChipList chips={row.tests} /></td>}
                            <td>{row.notes || '-'}</td>
                            <td>{row.next || '-'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RegularGroup({ classCode, rows }) {
    const late = countRows(rows, '지각');
    const absent = countRows(rows, '결석');
    const issues = rows.reduce((sum, row) => sum + rowIssueCount(row), 0);
    return (
        <div className="daily-log-class-block">
            <div className="daily-log-class-head">
                <strong>{classCode} 정규</strong>
                <span>{rows.length}명 · 지각 {late} · 결석 {absent} · 이슈 {issues}</span>
            </div>
            <LogTable rows={rows} />
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
                    <span>{GROUP_DESCRIPTIONS[groupKey]}</span>
                </div>
                <div className="daily-log-counts">
                    <span className="daily-log-pill info">{rows.length}명</span>
                    {late > 0 && <span className="daily-log-pill warn">지각 {late}</span>}
                    {absent > 0 && <span className="daily-log-pill bad">결석 {absent}</span>}
                    {issueCount > 0 && <span className="daily-log-pill gold">이슈 {issueCount}</span>}
                </div>
            </summary>
            {children || <LogTable rows={rows} diagnostic={groupKey === 'diagnostic'} />}
        </details>
    );
}

function SideList({ title, icon, rows, type }) {
    return (
        <div className="daily-log-side-card">
            <div className="daily-log-side-head">
                <div>
                    <span className="material-symbols-outlined">{icon}</span>
                    {title}
                </div>
                <span>{rows.length}명</span>
            </div>
            <div className="daily-log-side-list">
                {rows.length === 0 ? (
                    <div className="daily-log-empty">명단 없음</div>
                ) : rows.map(row => (
                    <div key={`${type}-${row.id}`} className="daily-log-side-item">
                        <div className="daily-log-side-top">
                            <strong>{row.name}</strong>
                            <span>{row.classCode} · {row.attendanceMeta || fmtTime(row.time)}</span>
                        </div>
                        <div className="daily-log-side-note">
                            {row.notes || row.next || (type === 'late' ? '지각 사유 미입력' : '결석 사유 미입력')}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function DailyLogBoard({ students, dailyLog, branchFilter, classFilter, date }) {
    const data = useMemo(() =>
        buildLogData({ students, dailyLog, branchFilter, classFilter, date }),
    [students, dailyLog, branchFilter, classFilter, date]);
    const regularEntries = Object.entries(data.groups.regular).sort(([a], [b]) => a.localeCompare(b, 'ko'));
    const regularRows = regularEntries.flatMap(([, rows]) => rows);

    return (
        <div className="daily-log-page">
            <div className="daily-log-summary">
                <SummaryCard icon="groups" label="전체 예정" value={data.summary.total} note={`정규 ${data.summary.regular} / 비정규 ${data.summary.irregular} / 내신 ${data.summary.naesin} / 자유학기 ${data.summary.free} / 특강 ${data.summary.special}`} />
                <SummaryCard icon="science" label="진단평가" value={data.summary.diagnostic} note="있을 때만 최상단 표시" />
                <SummaryCard icon="how_to_reg" label="출석" value={data.summary.attended} note="출석/지각/조퇴 포함" />
                <SummaryCard icon="schedule" label="지각" value={data.summary.late} note="우측 명단 표시" />
                <SummaryCard icon="person_off" label="결석" value={data.summary.absent} note="결석대장/사유 함께 표시" />
                <SummaryCard icon="assignment_late" label="학습 이슈" value={data.summary.issues} note="숙제/테스트/후속조치" />
            </div>

            <div className="daily-log-work-area">
                <div className="daily-log-main-card">
                    <div className="daily-log-main-head">
                        <div>
                            <span className="material-symbols-outlined">view_list</span>
                            학생별 일일 로그
                        </div>
                        <span>{date} ({getDayName(date)})</span>
                    </div>
                    <div className="daily-log-accordion">
                        <AccordionGroup groupKey="diagnostic" rows={data.groups.diagnostic} open />
                        <AccordionGroup groupKey="regular" rows={regularRows} open>
                            {regularEntries.length === 0 ? (
                                <div className="daily-log-empty">정규 학생 없음</div>
                            ) : regularEntries.map(([code, rows]) => (
                                <RegularGroup key={code} classCode={code} rows={rows} />
                            ))}
                        </AccordionGroup>
                        {OPTIONAL_GROUPS.map(key => (
                            <AccordionGroup key={key} groupKey={key} rows={data.groups[key]} />
                        ))}
                    </div>
                </div>

                <aside className="daily-log-side-stack">
                    <SideList title="지각 명단" icon="schedule" rows={data.lateRows} type="late" />
                    <SideList title="결석 명단" icon="person_off" rows={data.absentRows} type="absent" />
                </aside>
            </div>
        </div>
    );
}

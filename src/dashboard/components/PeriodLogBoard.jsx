import React, { useMemo, useState } from 'react';
import { Icon } from '@impact7/ui';
import { ICON_SVG } from '../icon-map.js';
import ReactECharts from '../echarts.jsx';
import { HW_FIELDS, TEST_FIELDS } from '../constants.js';

const ATTENDANCE_KEYS = ['출석', '지각', '조퇴', '결석'];
const ATTENDANCE_COLORS = {
    출석: '#188038',
    지각: '#f9ab00',
    조퇴: '#e67e22',
    결석: '#d93025',
};
const LOW_TEST_SCORE = 70;
const DOMAIN_LABELS = {
    Gr: '문법',
    'A/G': '어법',
    'R/C': '독해',
    LC: '청해',
    Voca: '어휘',
    Reading: '독해',
    Grammar: '문법',
    Listening: '청해',
};

const shortDate = (value) => (value || '').slice(5);
const pct = (num, den) => den > 0 ? Math.round((num / den) * 100) : 0;
const num = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const classCode = (enrollment) => `${enrollment?.level_symbol || ''}${enrollment?.class_number || ''}`;
const primaryClassCode = (student) => {
    const enrollment = (student?.enrollments || []).find(e => e.class_number) || student?.enrollments?.[0];
    return classCode(enrollment) || '미지정';
};
const mapDomainLabel = (key) => DOMAIN_LABELS[key] || key;

function normalizeDailyRecord(rec, student) {
    const homework = {};
    const tests = {};
    let homeworkIssueCount = 0;
    let testIssueCount = 0;

    Object.entries(rec.hw_domains_1st || {}).forEach(([key, value]) => {
        if (!['O', 'X', '△'].includes(value)) return;
        homework[key] = value;
        if (value !== 'O') homeworkIssueCount++;
    });
    Object.entries(rec.hw_domains_2nd || {}).forEach(([key, value]) => {
        if (!['O', 'X', '△'].includes(value)) return;
        homework[key] = value;
        if (value !== 'O') homeworkIssueCount++;
    });
    Object.entries(rec.test_domains_1st || {}).forEach(([key, value]) => {
        if (!['O', 'X', '△'].includes(value)) return;
        tests[key] = value;
        if (value !== 'O') testIssueCount++;
    });
    Object.entries(rec.test_domains_2nd || {}).forEach(([key, value]) => {
        if (!['O', 'X', '△'].includes(value)) return;
        tests[key] = value;
        if (value !== 'O') testIssueCount++;
    });

    return {
        id: rec.id,
        date: rec.date || '',
        student_id: rec.student_id || '',
        student_name: student?.name || rec.student_name || rec.student_id || '',
        class_code: rec.class_code || primaryClassCode(student),
        branch: rec.branch || student?.branch || '',
        attendance: rec.attendance?.status || '',
        homework,
        tests,
        homeworkIssueCount,
        testIssueCount,
    };
}

function normalizeDailyCheck(check) {
    const homework = {};
    const tests = {};
    let testIssueCount = 0;
    HW_FIELDS.forEach(field => {
        const value = check[field.key]?.trim?.() || '';
        if (['O', 'X', '△'].includes(value)) homework[field.label] = value;
    });
    TEST_FIELDS.forEach(field => {
        const value = check[field.key];
        const score = num(value);
        if (score != null) {
            tests[field.label] = score;
            if (score < LOW_TEST_SCORE) testIssueCount++;
        }
    });
    return {
        ...check,
        homework,
        tests,
        homeworkIssueCount: Object.values(homework).filter(value => value !== 'O').length,
        testIssueCount,
    };
}

function addStudentIssue(map, key, row) {
    const safeKey = key || `${row.date || 'unknown'}-${row.class_code || '미지정'}-${row.student_name || '(이름 없음)'}`;
    if (!map.has(safeKey)) {
        map.set(safeKey, {
            studentId: row.student_id || '',
            name: row.student_name || '(이름 없음)',
            classCode: row.class_code || '미지정',
            branch: row.branch || '',
            count: 0,
            details: [],
        });
    }
    return map.get(safeKey);
}

function buildSeriesOption({ labels, dates, dailyAttendance }) {
    return {
        color: [...ATTENDANCE_KEYS.map(key => ATTENDANCE_COLORS[key]), '#1a73e8'],
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        grid: { top: 34, right: 42, bottom: 30, left: 34 },
        xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11 } },
        yAxis: [
            { type: 'value', axisLabel: { fontSize: 11 } },
            { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 11, formatter: '{value}%' } },
        ],
        series: [
            ...ATTENDANCE_KEYS.map(key => ({
                name: key,
                type: 'bar',
                stack: 'attendance',
                emphasis: { focus: 'series' },
                data: dates.map(date => dailyAttendance[date]?.[key] || 0),
            })),
            {
                name: '출석률',
                type: 'line',
                yAxisIndex: 1,
                smooth: true,
                symbolSize: 6,
                lineStyle: { width: 2 },
                data: dates.map(date => dailyAttendance[date]?.rate || 0),
            },
        ],
    };
}

function Metric({ icon, label, value, note }) {
    return (
        <div className="period-metric">
            <div className="period-metric-label">
                <Icon svg={ICON_SVG[icon]} size={18} className="i7-icon" aria-hidden="true" />
                {label}
            </div>
            <div className="period-metric-value">{value}</div>
            {note && <div className="period-metric-note">{note}</div>}
        </div>
    );
}

function IssueDetails({ title, rows, empty, defaultOpen = false }) {
    return (
        <details className="period-details" open={defaultOpen}>
            <summary>
                <strong>{title}</strong>
                <span>{rows.length}명</span>
            </summary>
            {rows.length === 0 ? (
                <div className="dash-empty">{empty}</div>
            ) : (
                <div className="dash-table-scroll">
                    <table className="dash-table">
                        <thead>
                            <tr>
                                <th>학생</th>
                                <th>반</th>
                                <th>횟수</th>
                                <th>상세</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => (
                                <tr key={`${title}-${row.studentId || row.name}`}>
                                    <td>{row.name}</td>
                                    <td>{row.classCode}</td>
                                    <td>{row.count}</td>
                                    <td>{row.details.slice(0, 8).join(' / ')}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </details>
    );
}

function ClassTable({ rows }) {
    const [sortKey, setSortKey] = useState('issues');
    const sortedRows = useMemo(() => {
        return [...rows].sort((a, b) => {
            if (sortKey === 'classCode') return a.classCode.localeCompare(b.classCode, 'ko');
            return (b[sortKey] || 0) - (a[sortKey] || 0) || a.classCode.localeCompare(b.classCode, 'ko');
        });
    }, [rows, sortKey]);

    if (!rows.length) return <div className="dash-empty">반별 데이터 없음</div>;

    return (
        <div className="dash-table-scroll">
            <table className="dash-table period-class-table">
                <thead>
                    <tr>
                        <th aria-sort={sortKey === 'classCode' ? 'ascending' : 'none'}><button type="button" onClick={() => setSortKey('classCode')}>반</button></th>
                        <th aria-sort={sortKey === 'total' ? 'descending' : 'none'}><button type="button" onClick={() => setSortKey('total')}>수업</button></th>
                        <th aria-sort={sortKey === 'attendanceRate' ? 'descending' : 'none'}><button type="button" onClick={() => setSortKey('attendanceRate')}>출석률</button></th>
                        <th aria-sort={sortKey === 'homeworkRate' ? 'descending' : 'none'}><button type="button" onClick={() => setSortKey('homeworkRate')}>숙제완료</button></th>
                        <th aria-sort={sortKey === 'issues' ? 'descending' : 'none'}><button type="button" onClick={() => setSortKey('issues')}>이슈</button></th>
                    </tr>
                </thead>
                <tbody>
                    {sortedRows.map(row => (
                        <tr key={row.classCode}>
                            <td>{row.classCode}</td>
                            <td>{row.total}</td>
                            <td>{row.attendanceRate}%</td>
                            <td>{row.homeworkRate}%</td>
                            <td>{row.issues}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function PeriodLogBoard({ checks, dailyRecords = [], students = [], postponed, startDate, endDate }) {
    const data = useMemo(() => {
        const studentById = new Map(students.map(student => [student.id, student]));
        const rows = dailyRecords.length
            ? dailyRecords.map(rec => normalizeDailyRecord(rec, studentById.get(rec.student_id)))
            : checks.map(normalizeDailyCheck);
        const dates = [...new Set(rows.map(c => c.date).filter(Boolean))].sort();
        const labels = dates.map(shortDate);
        const attendanceCounts = { 출석: 0, 지각: 0, 조퇴: 0, 결석: 0 };
        const dailyAttendance = {};
        const homeworkByField = {};
        const testByField = {};
        const lateStudents = new Map();
        const absentStudents = new Map();
        const homeworkStudents = new Map();
        const lowTestStudents = new Map();
        const classStats = new Map();
        let attendanceTotal = 0;
        let attendancePresent = 0;
        let homeworkDone = 0;
        let homeworkTotal = 0;
        let homeworkIncomplete = 0;
        let testSum = 0;
        let testCount = 0;
        let lowTestCount = 0;

        HW_FIELDS.forEach(field => { homeworkByField[field.key] = { ...field, done: 0, total: 0, incomplete: 0 }; });
        TEST_FIELDS.forEach(field => { testByField[field.key] = { ...field, sum: 0, count: 0, low: 0 }; });

        rows.forEach(check => {
            const date = check.date || '';
            if (!dailyAttendance[date]) {
                dailyAttendance[date] = { 출석: 0, 지각: 0, 조퇴: 0, 결석: 0, rate: 0 };
            }

            const classCode = check.class_code || '미지정';
            if (!classStats.has(classCode)) {
                classStats.set(classCode, {
                    classCode,
                    total: 0,
                    attendanceTotal: 0,
                    attendancePresent: 0,
                    homeworkDone: 0,
                    homeworkTotal: 0,
                    issues: 0,
                });
            }
            const classRow = classStats.get(classCode);
            classRow.total++;

            const attendance = check.attendance || '';
            if (ATTENDANCE_KEYS.includes(attendance)) {
                attendanceCounts[attendance]++;
                dailyAttendance[date][attendance]++;
                attendanceTotal++;
                classRow.attendanceTotal++;
                if (attendance === '출석') {
                    attendancePresent++;
                    classRow.attendancePresent++;
                }
                if (attendance === '지각') {
                    const row = addStudentIssue(lateStudents, check.student_id || check.student_name, check);
                    row.count++;
                    row.details.push(`${shortDate(date)} 지각`);
                    classRow.issues++;
                }
                if (attendance === '결석') {
                    const row = addStudentIssue(absentStudents, check.student_id || check.student_name, check);
                    row.count++;
                    row.details.push(`${shortDate(date)} 결석`);
                    classRow.issues++;
                }
            }

            Object.entries(check.homework || {}).forEach(([key, value]) => {
                const label = mapDomainLabel(key);
                if (!homeworkByField[key]) homeworkByField[key] = { key, label, done: 0, total: 0, incomplete: 0 };
                homeworkTotal++;
                homeworkByField[key].total++;
                classRow.homeworkTotal++;
                if (value === 'O') {
                    homeworkDone++;
                    homeworkByField[key].done++;
                    classRow.homeworkDone++;
                    return;
                }
                homeworkIncomplete++;
                homeworkByField[key].incomplete++;
                classRow.issues++;
                const row = addStudentIssue(homeworkStudents, check.student_id || check.student_name, check);
                row.count++;
                row.details.push(`${shortDate(date)} ${label} ${value}`);
            });

            Object.entries(check.tests || {}).forEach(([key, value]) => {
                const label = mapDomainLabel(key);
                if (!testByField[key]) testByField[key] = { key, label, sum: 0, count: 0, low: 0, issue: 0 };
                const score = num(value);
                if (score != null) {
                    testSum += score;
                    testCount++;
                    testByField[key].sum += score;
                    testByField[key].count++;
                }
                const isIssue = score != null ? score < LOW_TEST_SCORE : value !== 'O';
                if (isIssue) {
                    lowTestCount++;
                    testByField[key].low++;
                    testByField[key].issue++;
                    classRow.issues++;
                    const row = addStudentIssue(lowTestStudents, check.student_id || check.student_name, check);
                    row.count++;
                    row.details.push(`${shortDate(date)} ${label} ${value}`);
                }
            });
        });

        dates.forEach(date => {
            const row = dailyAttendance[date];
            const total = ATTENDANCE_KEYS.reduce((sum, key) => sum + row[key], 0);
            row.rate = pct(row.출석, total);
        });

        const pendingTasks = postponed.filter(task => (task.status || 'pending') !== 'done');
        const tasksByStatus = [
            { name: '대기', value: postponed.filter(task => !task.status || task.status === 'pending').length },
            { name: '완료', value: postponed.filter(task => task.status === 'done').length },
            { name: '결석', value: postponed.filter(task => task.status === 'absent').length },
        ].filter(row => row.value > 0);
        const tasksByHandler = Object.entries(pendingTasks.reduce((acc, task) => {
            const key = task.handler || '미지정';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);

        const summary = {
            totalChecks: rows.length,
            attendanceRate: pct(attendancePresent, attendanceTotal),
            late: attendanceCounts.지각,
            absent: attendanceCounts.결석,
            homeworkIncomplete,
            lowTestCount,
            pendingTasks: pendingTasks.length,
            testAvg: testCount > 0 ? Math.round((testSum / testCount) * 10) / 10 : '-',
            homeworkRate: pct(homeworkDone, homeworkTotal),
        };

        const homeworkRows = Object.values(homeworkByField).map(row => {
            return {
                label: row.label,
                완료율: pct(row.done, row.total),
                미완료: row.incomplete,
                total: row.total,
            };
        }).filter(row => row.total > 0);
        const testRows = Object.values(testByField).map(row => {
            return {
                label: row.label,
                평균: row.count > 0 ? Math.round((row.sum / row.count) * 10) / 10 : 0,
                저점: row.low,
                count: row.count || row.issue || 0,
            };
        }).filter(row => row.count > 0);
        const classRows = [...classStats.values()].map(row => ({
            ...row,
            attendanceRate: pct(row.attendancePresent, row.attendanceTotal),
            homeworkRate: pct(row.homeworkDone, row.homeworkTotal),
        }));

        return {
            dates,
            labels,
            dailyAttendance,
            summary,
            homeworkRows,
            testRows,
            tasksByStatus,
            tasksByHandler,
            classRows,
            lateRows: [...lateStudents.values()].filter(row => row.count >= 2).sort((a, b) => b.count - a.count),
            absentRows: [...absentStudents.values()].filter(row => row.count >= 2).sort((a, b) => b.count - a.count),
            homeworkIssueRows: [...homeworkStudents.values()].sort((a, b) => b.count - a.count).slice(0, 20),
            lowTestRows: [...lowTestStudents.values()].sort((a, b) => b.count - a.count).slice(0, 20),
            pendingTaskRows: pendingTasks.sort((a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || '')),
        };
    }, [checks, dailyRecords, students, postponed]);

    const attendanceOption = useMemo(() => buildSeriesOption(data), [data]);
    const homeworkOption = useMemo(() => ({
        color: ['#188038', '#d93025'],
        tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        grid: { top: 34, right: 24, bottom: 24, left: 54 },
        xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', fontSize: 11 } },
        yAxis: { type: 'category', data: data.homeworkRows.map(row => row.label), axisLabel: { fontSize: 11 } },
        series: [{
            name: '완료율',
            type: 'bar',
            barMaxWidth: 18,
            itemStyle: { borderRadius: [0, 4, 4, 0] },
            data: data.homeworkRows.map(row => row.완료율),
        }],
    }), [data.homeworkRows]);
    const testOption = useMemo(() => ({
        color: ['#1a73e8', '#d93025'],
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        grid: { top: 34, right: 36, bottom: 28, left: 34 },
        xAxis: { type: 'category', data: data.testRows.map(row => row.label), axisLabel: { fontSize: 11 } },
        yAxis: [
            { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 11 } },
            { type: 'value', axisLabel: { fontSize: 11 } },
        ],
        series: [
            { name: '평균', type: 'bar', barMaxWidth: 28, data: data.testRows.map(row => row.평균) },
            { name: '이슈 수', type: 'line', yAxisIndex: 1, smooth: true, data: data.testRows.map(row => row.저점) },
        ],
    }), [data.testRows]);
    const taskOption = useMemo(() => ({
        color: ['#f9ab00', '#188038', '#d93025'],
        tooltip: { trigger: 'item', confine: true },
        series: [{
            name: '후속조치',
            type: 'pie',
            radius: ['46%', '74%'],
            data: data.tasksByStatus,
            label: { fontSize: 11, color: '#202124' },
        }],
    }), [data.tasksByStatus]);
    const handlerOption = useMemo(() => ({
        color: ['#f9ab00'],
        tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
        grid: { top: 18, right: 16, bottom: 24, left: 64 },
        xAxis: { type: 'value', axisLabel: { fontSize: 11 } },
        yAxis: { type: 'category', data: data.tasksByHandler.map(([name]) => name), axisLabel: { fontSize: 11 } },
        series: [{ name: '대기', type: 'bar', barMaxWidth: 18, data: data.tasksByHandler.map(([, count]) => count) }],
    }), [data.tasksByHandler]);

    const rangeText = startDate === endDate ? startDate : `${startDate} ~ ${endDate}`;

    return (
        <div className="period-log-board">
            <div className="period-board-head">
                <div>
                    <Icon svg={ICON_SVG.monitoring} size={24} className="i7-icon" aria-hidden="true" />
                    기간 로그북
                </div>
                <span>{rangeText}</span>
            </div>

            <div className="period-metrics">
                <Metric icon="fact_check" label="수업 기록" value={data.summary.totalChecks} />
                <Metric icon="event_available" label="출석률" value={`${data.summary.attendanceRate}%`} />
                <Metric icon="schedule" label="지각/결석" value={`${data.summary.late}/${data.summary.absent}`} />
                <Metric icon="menu_book" label="숙제 미완료" value={data.summary.homeworkIncomplete} note={`완료율 ${data.summary.homeworkRate}%`} />
                <Metric icon="quiz" label="테스트 이슈" value={data.summary.lowTestCount} note={`평균 ${data.summary.testAvg}`} />
                <Metric icon="pending_actions" label="후속 미처리" value={data.summary.pendingTasks} />
            </div>

            <section className="period-section period-section-wide">
                <div className="period-section-head">
                    <strong>출결 흐름</strong>
                    <span>날짜별 출결 분포와 출석률</span>
                </div>
                {data.dates.length === 0 ? (
                    <div className="dash-empty">출결 데이터 없음</div>
                ) : (
                    <div className="period-chart period-chart-wide">
                        <ReactECharts option={attendanceOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
                    </div>
                )}
                <div className="period-detail-grid">
                    <IssueDetails title="지각 2회 이상" rows={data.lateRows} empty="반복 지각 학생 없음" />
                    <IssueDetails title="결석 2회 이상" rows={data.absentRows} empty="반복 결석 학생 없음" />
                </div>
            </section>

            <section className="period-section">
                <div className="period-section-head">
                    <strong>숙제 반복 이슈</strong>
                    <span>과목별 완료율과 반복 미완료</span>
                </div>
                {data.homeworkRows.length === 0 ? (
                    <div className="dash-empty">숙제 데이터 없음</div>
                ) : (
                    <div className="period-chart">
                        <ReactECharts option={homeworkOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
                    </div>
                )}
                <IssueDetails title="숙제 X/△ 반복 학생" rows={data.homeworkIssueRows} empty="숙제 반복 이슈 없음" />
            </section>

            <section className="period-section">
                <div className="period-section-head">
                    <strong>테스트 반복 이슈</strong>
                    <span>과목별 평균과 미통과/저점 기록</span>
                </div>
                {data.testRows.length === 0 ? (
                    <div className="dash-empty">테스트 데이터 없음</div>
                ) : (
                    <div className="period-chart">
                        <ReactECharts option={testOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
                    </div>
                )}
                <IssueDetails title="테스트 이슈 반복 학생" rows={data.lowTestRows} empty="테스트 반복 이슈 없음" />
            </section>

            <section className="period-section">
                <div className="period-section-head">
                    <strong>후속조치</strong>
                    <span>밀린과업 상태와 담당자별 대기</span>
                </div>
                <div className="period-split-charts">
                    {data.tasksByStatus.length === 0 ? (
                        <div className="dash-empty">후속조치 데이터 없음</div>
                    ) : (
                        <ReactECharts option={taskOption} style={{ width: '100%', height: 180 }} notMerge lazyUpdate />
                    )}
                    {data.tasksByHandler.length === 0 ? (
                        <div className="dash-empty">담당자별 대기 없음</div>
                    ) : (
                        <ReactECharts option={handlerOption} style={{ width: '100%', height: 180 }} notMerge lazyUpdate />
                    )}
                </div>
                <details className="period-details">
                    <summary>
                        <strong>미처리 후속조치</strong>
                        <span>{data.pendingTaskRows.length}건</span>
                    </summary>
                    {data.pendingTaskRows.length === 0 ? (
                        <div className="dash-empty">미처리 후속조치 없음</div>
                    ) : (
                        <div className="dash-table-scroll">
                            <table className="dash-table">
                                <thead>
                                    <tr>
                                        <th>예정일</th>
                                        <th>학생</th>
                                        <th>내용</th>
                                        <th>담당</th>
                                        <th>상태</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.pendingTaskRows.map(task => (
                                        <tr key={task.id}>
                                            <td>{shortDate(task.scheduled_date)}</td>
                                            <td>{task.student_name || ''}</td>
                                            <td>{task.content || ''}</td>
                                            <td>{task.handler || '미지정'}</td>
                                            <td>{task.status || 'pending'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </details>
            </section>

            <section className="period-section">
                <div className="period-section-head">
                    <strong>반별 비교</strong>
                    <span>문제가 많은 반을 우선 확인</span>
                </div>
                <ClassTable rows={data.classRows} />
            </section>
        </div>
    );
}

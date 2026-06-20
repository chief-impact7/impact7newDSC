import React, { useMemo, useState } from 'react';
import ReactECharts from '../echarts.jsx';
import { TEST_FIELDS } from '../constants.js';

const BAR_COLORS = ['#1a73e8', '#188038', '#f9ab00', '#d93025'];

function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function TestSummary({ checks }) {
    const [showStudents, setShowStudents] = useState(false);

    const { fieldStats, chartOption, studentRows } = useMemo(() => {
        const stats = {};
        TEST_FIELDS.forEach(f => {
            stats[f.key] = { label: f.label, scores: [], sum: 0, count: 0 };
        });

        // 학생별 점수 집계
        const studentScores = {};

        checks.forEach(c => {
            const name = c.student_name || '이름 없음';

            TEST_FIELDS.forEach(f => {
                const raw = c[f.key];
                if (!raw) return;
                const num = parseFloat(raw);
                if (isNaN(num)) return;
                stats[f.key].scores.push(num);
                stats[f.key].sum += num;
                stats[f.key].count++;

                if (!studentScores[name]) studentScores[name] = {};
                if (!studentScores[name][f.key]) studentScores[name][f.key] = [];
                studentScores[name][f.key].push(num);
            });
        });

        // 과목별 평균 차트
        const chart = TEST_FIELDS.map(f => {
            const s = stats[f.key];
            return {
                label: s.label,
                평균: s.count > 0 ? Math.round((s.sum / s.count) * 10) / 10 : 0,
                응시: s.count,
            };
        });
        const option = {
            color: BAR_COLORS,
            tooltip: {
                trigger: 'axis',
                confine: true,
                axisPointer: { type: 'shadow' },
            },
            grid: { top: 18, right: 12, bottom: 28, left: 34 },
            xAxis: { type: 'category', data: chart.map(d => d.label), axisLabel: { fontSize: 12 } },
            yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 11 } },
            series: [{
                name: '평균',
                type: 'bar',
                barMaxWidth: 36,
                itemStyle: {
                    borderRadius: [4, 4, 0, 0],
                    color: ({ dataIndex }) => BAR_COLORS[dataIndex % BAR_COLORS.length],
                },
                data: chart.map(d => d.평균),
            }],
        };

        // 학생별 행
        const rows = Object.keys(studentScores).sort().map(name => {
            const row = { name };
            TEST_FIELDS.forEach(f => {
                const scores = studentScores[name][f.key];
                row[f.key] = scores ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
            });
            return row;
        });

        return { fieldStats: stats, chartOption: option, studentRows: rows };
    }, [checks]);

    const hasData = TEST_FIELDS.some(f => fieldStats[f.key].count > 0);

    return (
        <div className="dash-card test">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">quiz</span>
                    리뷰테스트 현황
                </span>
            </div>
            <div className="dash-card-body">
                {!hasData ? (
                    <div className="dash-empty">데이터 없음</div>
                ) : (
                    <>
                        <div className="dash-stats">
                            {TEST_FIELDS.map(f => {
                                const s = fieldStats[f.key];
                                const avg = s.count > 0 ? Math.round((s.sum / s.count) * 10) / 10 : '-';
                                const max = s.scores.length > 0 ? Math.max(...s.scores) : '-';
                                const min = s.scores.length > 0 ? Math.min(...s.scores) : '-';
                                const med = s.scores.length > 0 ? median(s.scores) : '-';
                                return (
                                    <div className="dash-stat" key={f.key}>
                                        <div className="dash-stat-value" style={{ color: 'var(--primary)' }}>{avg}</div>
                                        <div className="dash-stat-label">{s.label} (n={s.count})</div>
                                        <div className="dash-stat-inline" style={{ marginTop: 4, fontSize: 11, color: 'var(--text-sec)' }}>
                                            <span>최고 {max}</span>
                                            <span>중앙 {med}</span>
                                            <span>최저 {min}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="dash-chart">
                            <ReactECharts option={chartOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
                        </div>

                        {studentRows.length > 0 && (
                            <div style={{ marginTop: 12 }}>
                                <button
                                    className="dash-expand-btn"
                                    onClick={() => setShowStudents(v => !v)}
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                                        {showStudents ? 'expand_less' : 'expand_more'}
                                    </span>
                                    학생별 점수 ({studentRows.length}명)
                                </button>
                                {showStudents && (
                                    <table className="dash-table" style={{ marginTop: 8 }}>
                                        <thead>
                                            <tr>
                                                <th>학생</th>
                                                {TEST_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {studentRows.map(row => (
                                                <tr key={row.name}>
                                                    <td>{row.name}</td>
                                                    {TEST_FIELDS.map(f => (
                                                        <td key={f.key}>{row[f.key] !== null ? row[f.key] : '-'}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default React.memo(TestSummary);

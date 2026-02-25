import React, { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const HW_FIELDS = [
    { key: 'hw_reading', label: '독해' },
    { key: 'hw_grammar', label: '문법' },
    { key: 'hw_practice', label: '실전' },
    { key: 'hw_listening', label: '청해' },
    { key: 'hw_extra', label: '추가' },
    { key: 'hw_vocab', label: '어휘' },
    { key: 'hw_idiom', label: '숙어' },
    { key: 'hw_verb3', label: '3단' },
];

const PIE_COLORS = ['#188038', '#d93025', '#f9ab00', '#dadce0'];

const RADIAN = Math.PI / 180;
function renderPieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }) {
    if (percent < 0.05) return null;
    const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
        <text x={x} y={y} fill="var(--text-pri)" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={11}>
            {`${(percent * 100).toFixed(0)}%`}
        </text>
    );
}

function HomeworkSummary({ checks }) {
    const [showIncomplete, setShowIncomplete] = useState(false);

    const { fieldStats, totalO, totalX, totalTri, totalEmpty, overallRate, incompleteByStudent } = useMemo(() => {
        const stats = {};
        let tO = 0, tX = 0, tTri = 0, tEmpty = 0;

        HW_FIELDS.forEach(f => {
            stats[f.key] = { label: f.label, O: 0, X: 0, tri: 0, empty: 0, total: 0 };
        });

        // 미완료 학생 집계
        const incomplete = {};

        checks.forEach(c => {
            const studentName = c.student_name || '이름 없음';

            HW_FIELDS.forEach(f => {
                const val = c[f.key] || '';
                stats[f.key].total++;
                if (val === 'O') { stats[f.key].O++; tO++; }
                else if (val === 'X') { stats[f.key].X++; tX++; }
                else if (val === '△') { stats[f.key].tri++; tTri++; }
                else { stats[f.key].empty++; tEmpty++; }

                if (val === 'X' || val === '△') {
                    if (!incomplete[studentName]) incomplete[studentName] = [];
                    incomplete[studentName].push({ subject: f.label, mark: val });
                }
            });
        });

        const totalAnswered = tO + tX + tTri;
        const rate = totalAnswered > 0 ? Math.round((tO / totalAnswered) * 100) : 0;

        return {
            fieldStats: stats, totalO: tO, totalX: tX, totalTri: tTri, totalEmpty: tEmpty,
            overallRate: rate, incompleteByStudent: incomplete,
        };
    }, [checks]);

    const pieData = [
        { name: 'O (완료)', value: totalO },
        { name: 'X (미완)', value: totalX },
        { name: '△ (부분)', value: totalTri },
    ].filter(d => d.value > 0);

    const rateColor = overallRate >= 80 ? 'var(--success)' : overallRate >= 50 ? 'var(--warning)' : 'var(--danger)';
    const incompleteStudents = Object.keys(incompleteByStudent).sort();

    return (
        <div className="dash-card homework">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">menu_book</span>
                    숙제 현황
                </span>
                <span className="dash-card-header-meta" style={{ fontWeight: 700, color: rateColor }}>
                    완료율 {overallRate}%
                </span>
            </div>
            <div className="dash-card-body">
                {checks.length === 0 ? (
                    <div className="dash-empty">데이터 없음</div>
                ) : (
                    <>
                        <div className="dash-flex-row">
                            {pieData.length > 0 && (
                                <div className="dash-donut-wrap">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie
                                                data={pieData}
                                                dataKey="value"
                                                cx="50%"
                                                cy="50%"
                                                innerRadius={30}
                                                outerRadius={50}
                                                label={renderPieLabel}
                                            >
                                                {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                                            </Pie>
                                            <Tooltip />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            )}
                            <div className="dash-stats" style={{ flex: 1, marginBottom: 0 }}>
                                <div className="dash-stat">
                                    <div className="dash-stat-value present">{totalO}</div>
                                    <div className="dash-stat-label">O</div>
                                </div>
                                <div className="dash-stat">
                                    <div className="dash-stat-value absent">{totalX}</div>
                                    <div className="dash-stat-label">X</div>
                                </div>
                                <div className="dash-stat">
                                    <div className="dash-stat-value late">{totalTri}</div>
                                    <div className="dash-stat-label">△</div>
                                </div>
                            </div>
                        </div>

                        <table className="dash-table">
                            <thead>
                                <tr>
                                    <th>과목</th>
                                    <th>O</th>
                                    <th>X</th>
                                    <th>△</th>
                                    <th>완료율</th>
                                </tr>
                            </thead>
                            <tbody>
                                {HW_FIELDS.map(f => {
                                    const s = fieldStats[f.key];
                                    const answered = s.O + s.X + s.tri;
                                    const rate = answered > 0 ? Math.round((s.O / answered) * 100) : 0;
                                    return (
                                        <tr key={f.key}>
                                            <td>{s.label}</td>
                                            <td><span className="ox-badge o">{s.O}</span></td>
                                            <td><span className="ox-badge x">{s.X}</span></td>
                                            <td><span className="ox-badge tri">{s.tri}</span></td>
                                            <td>
                                                <div className="dash-stat-inline">
                                                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 36 }}>{rate}%</span>
                                                    <div className="progress-bar" style={{ flex: 1 }}>
                                                        <div className="progress-fill green" style={{ width: `${rate}%` }} />
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>

                        {incompleteStudents.length > 0 && (
                            <div style={{ marginTop: 12 }}>
                                <button
                                    className="dash-expand-btn"
                                    onClick={() => setShowIncomplete(v => !v)}
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                                        {showIncomplete ? 'expand_less' : 'expand_more'}
                                    </span>
                                    미완료 학생 ({incompleteStudents.length}명)
                                </button>
                                {showIncomplete && (
                                    <table className="dash-table" style={{ marginTop: 8 }}>
                                        <thead>
                                            <tr>
                                                <th>학생</th>
                                                <th>미완료 과목</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {incompleteStudents.map(name => (
                                                <tr key={name}>
                                                    <td>{name}</td>
                                                    <td>
                                                        {incompleteByStudent[name].map((item, i) => (
                                                            <span key={i} className={`ox-badge ${item.mark === 'X' ? 'x' : 'tri'}`} style={{ marginRight: 4 }}>
                                                                {item.subject}({item.mark})
                                                            </span>
                                                        ))}
                                                    </td>
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

export default React.memo(HomeworkSummary);

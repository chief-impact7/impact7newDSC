import React, { useMemo, useState, useCallback } from 'react';
import { NEXT_HW_FIELDS } from '../constants.js';

const INITIAL_ROWS = 5;

export default function ScheduleSummary({ checks }) {
    const [expandedClasses, setExpandedClasses] = useState({});

    const toggleClass = useCallback((cls) => {
        setExpandedClasses(prev => ({ ...prev, [cls]: !prev[cls] }));
    }, []);

    const records = useMemo(() => {
        const recs = [];
        checks.forEach(c => {
            const hasNext = NEXT_HW_FIELDS.some(f => c[f.key]?.trim?.());
            if (!hasNext) return;

            const rec = {
                name: c.student_name || '',
                classCode: c.class_code || '',
                date: c.date || '',
            };
            NEXT_HW_FIELDS.forEach(f => { rec[f.key] = c[f.key]?.trim?.() || ''; });
            recs.push(rec);
        });
        recs.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
        return recs;
    }, [checks]);

    // 반별 그룹핑
    const byClass = useMemo(() => {
        const map = {};
        records.forEach(r => {
            const cls = r.classCode || '기타';
            if (!map[cls]) map[cls] = [];
            map[cls].push(r);
        });
        return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
    }, [records]);

    return (
        <div className="dash-card schedule">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">event_note</span>
                    다음 숙제/일정
                </span>
                <span className="dash-card-header-meta">
                    {records.length}건
                </span>
            </div>
            <div className="dash-card-body">
                {records.length === 0 ? (
                    <div className="dash-empty">데이터 없음</div>
                ) : (
                    byClass.map(([cls, recs]) => {
                        const isExpanded = !!expandedClasses[cls];
                        const visibleRecs = isExpanded ? recs : recs.slice(0, INITIAL_ROWS);
                        const hasMore = recs.length > INITIAL_ROWS;

                        return (
                            <div key={cls} className="dash-class-group">
                                <div className="dash-class-group-header">
                                    {cls}반
                                </div>
                                <div className="dash-table-scroll">
                                    <table className="dash-table">
                                        <thead>
                                            <tr>
                                                <th>이름</th>
                                                {NEXT_HW_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {visibleRecs.map((rec, i) => (
                                                <tr key={i}>
                                                    <td>{rec.name || ''}</td>
                                                    {NEXT_HW_FIELDS.map(f => (
                                                        <td key={f.key} className="dash-td-truncate">
                                                            {rec[f.key] || '-'}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {hasMore && (
                                    <button
                                        className="dash-expand-btn"
                                        onClick={() => toggleClass(cls)}
                                    >
                                        {isExpanded ? '접기' : `더 보기 (${recs.length - INITIAL_ROWS}건)`}
                                    </button>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

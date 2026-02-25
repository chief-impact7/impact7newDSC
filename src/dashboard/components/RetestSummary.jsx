import React, { useMemo, useState } from 'react';

const RETEST_FIELDS = [
    { key: 'retest_isc', label: 'ISC' },
    { key: 'retest_reading', label: '독해' },
    { key: 'retest_grammar', label: '문법' },
    { key: 'retest_practice', label: '실전' },
    { key: 'retest_listening', label: '청해' },
    { key: 'retest_grading', label: '채점' },
];

const INITIAL_ROWS = 10;

export default function RetestSummary({ checks }) {
    const [expanded, setExpanded] = useState(false);

    const { records, fieldCounts } = useMemo(() => {
        const recs = [];
        const counts = {};
        RETEST_FIELDS.forEach(f => { counts[f.key] = 0; });

        checks.forEach(c => {
            const hasRetest = RETEST_FIELDS.some(f => c[f.key]?.trim?.());
            if (!hasRetest) return;

            const rec = {
                name: c.student_name || '',
                classCode: c.class_code || '',
                date: c.date || '',
            };
            RETEST_FIELDS.forEach(f => {
                rec[f.key] = c[f.key]?.trim?.() || '';
                if (rec[f.key]) counts[f.key]++;
            });
            recs.push(rec);
        });

        recs.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
        return { records: recs, fieldCounts: counts };
    }, [checks]);

    const visibleRecords = expanded ? records : records.slice(0, INITIAL_ROWS);
    const hasMore = records.length > INITIAL_ROWS;

    return (
        <div className="dash-card retest">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">replay</span>
                    재시 현황
                </span>
                <span className="dash-card-header-meta">
                    {records.length}건
                </span>
            </div>
            <div className="dash-card-body">
                {records.length === 0 ? (
                    <div className="dash-empty">재시 데이터 없음</div>
                ) : (
                    <>
                        <div className="dash-table-scroll">
                            <table className="dash-table">
                                <thead>
                                    <tr>
                                        <th>날짜</th>
                                        <th>이름</th>
                                        <th>반</th>
                                        {RETEST_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleRecords.map((rec, i) => (
                                        <tr key={i}>
                                            <td style={{ whiteSpace: 'nowrap' }}>{(rec.date || '').slice(5)}</td>
                                            <td>{rec.name || ''}</td>
                                            <td>{rec.classCode || ''}</td>
                                            {RETEST_FIELDS.map(f => (
                                                <td key={f.key}>{rec[f.key] || '-'}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {hasMore && (
                            <button
                                className="dash-expand-btn"
                                onClick={() => setExpanded(v => !v)}
                            >
                                {expanded ? '접기' : `더 보기 (${records.length - INITIAL_ROWS}건)`}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

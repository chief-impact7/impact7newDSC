import React, { useMemo, useState } from 'react';

const STATUS_MAP = {
    '전체': null,
    '대기': 'pending',
    '완료': 'done',
    '결석': 'absent',
};

const TABS = ['전체', '대기', '완료', '결석'];

export default function PostponedTasks({ tasks }) {
    const [activeTab, setActiveTab] = useState('전체');

    const { pending, done, absent } = useMemo(() => {
        const p = [], d = [], a = [];
        tasks.forEach(t => {
            const status = t.status || '';
            if (status === 'done') d.push(t);
            else if (status === 'absent') a.push(t);
            else p.push(t);
        });
        const sort = (arr) => arr.sort((a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || ''));
        return { pending: sort(p), done: sort(d), absent: sort(a) };
    }, [tasks]);

    const allTasks = useMemo(() => [...pending, ...done, ...absent], [pending, done, absent]);

    const filteredTasks = useMemo(() => {
        const statusKey = STATUS_MAP[activeTab];
        if (statusKey === null) return allTasks;
        if (statusKey === 'pending') return pending;
        if (statusKey === 'done') return done;
        if (statusKey === 'absent') return absent;
        return allTasks;
    }, [activeTab, allTasks, pending, done, absent]);

    const tabCounts = useMemo(() => ({
        '전체': allTasks.length,
        '대기': pending.length,
        '완료': done.length,
        '결석': absent.length,
    }), [allTasks, pending, done, absent]);

    return (
        <div className="dash-card postponed">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">pending_actions</span>
                    밀린과업
                </span>
                <span className="dash-card-header-meta">
                    대기 {pending.length} / 완료 {done.length} / 결석 {absent.length}
                </span>
            </div>
            <div className="dash-card-body">
                {tasks.length === 0 ? (
                    <div className="dash-empty">밀린과업 없음</div>
                ) : (
                    <>
                        <div className="dash-filter-tabs">
                            {TABS.map(tab => (
                                <button
                                    key={tab}
                                    className={activeTab === tab ? 'active' : ''}
                                    onClick={() => setActiveTab(tab)}
                                >
                                    {tab} ({tabCounts[tab]})
                                </button>
                            ))}
                        </div>
                        <table className="dash-table">
                            <thead>
                                <tr>
                                    <th>상태</th>
                                    <th>날짜</th>
                                    <th>이름</th>
                                    <th>내용</th>
                                    <th>담당</th>
                                    <th>원래</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredTasks.map(t => (
                                    <tr key={t.id}>
                                        <td>
                                            <span className={`status-badge ${(t.status || '') === 'done' ? 'done' : (t.status || '') === 'absent' ? 'absent-badge' : 'pending'}`}>
                                                {(t.status || '') === 'done' ? '완료' : (t.status || '') === 'absent' ? '결석' : '대기'}
                                            </span>
                                        </td>
                                        <td style={{ whiteSpace: 'nowrap' }}>{(t.scheduled_date || '').slice(5)}</td>
                                        <td>{t.student_name || ''}</td>
                                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {t.content || ''}
                                        </td>
                                        <td>{t.handler || ''}</td>
                                        <td style={{ whiteSpace: 'nowrap' }}>{(t.original_date || '').slice(5)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </div>
        </div>
    );
}

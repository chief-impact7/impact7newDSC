import React, { useMemo } from 'react';
import { HW_FIELDS } from '../constants.js';

function OverviewCard({ checks, students }) {
    const stats = useMemo(() => {
        const totalStudents = students.length;
        const totalChecks = checks.length;

        // 출석률: 출석 필드가 있는 것 중 '출석'인 비율
        let attendTotal = 0;
        let attendPresent = 0;
        checks.forEach(c => {
            const v = c.attendance?.trim?.();
            if (v) {
                attendTotal++;
                if (v === '출석') attendPresent++;
            }
        });
        const attendRate = attendTotal > 0
            ? Math.round((attendPresent / attendTotal) * 100)
            : 0;

        // 숙제 완료율: O / (O + X + △)
        let hwDone = 0;
        let hwTotal = 0;
        checks.forEach(c => {
            HW_FIELDS.forEach(f => {
                const v = c[f.key]?.trim?.();
                if (v === 'O' || v === 'X' || v === '△') {
                    hwTotal++;
                    if (v === 'O') hwDone++;
                }
            });
        });
        const hwRate = hwTotal > 0
            ? Math.round((hwDone / hwTotal) * 100)
            : 0;

        return { totalStudents, totalChecks, attendRate, hwRate };
    }, [checks, students]);

    return (
        <div className="dash-card overview">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">dashboard</span>
                    전체 요약
                </span>
            </div>
            <div className="dash-card-body">
                <div className="dash-stats">
                    <div className="dash-stat-box">
                        <span className="material-symbols-outlined">group</span>
                        <div className="dash-stat-value">{stats.totalStudents}</div>
                        <div className="dash-stat-label">전체 학생</div>
                    </div>
                    <div className="dash-stat-box">
                        <span className="material-symbols-outlined">fact_check</span>
                        <div className="dash-stat-value">{stats.totalChecks}</div>
                        <div className="dash-stat-label">수업 수</div>
                    </div>
                    <div className="dash-stat-box">
                        <span className="material-symbols-outlined">event_available</span>
                        <div className="dash-stat-value">{stats.attendRate}%</div>
                        <div className="dash-stat-label">출석률</div>
                    </div>
                    <div className="dash-stat-box">
                        <span className="material-symbols-outlined">task_alt</span>
                        <div className="dash-stat-value">{stats.hwRate}%</div>
                        <div className="dash-stat-label">숙제 완료율</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default React.memo(OverviewCard);

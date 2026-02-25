import React, { useMemo } from 'react';
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
    LineChart, Line,
} from 'recharts';

const COLORS = { 출석: '#188038', 결석: '#d93025', 지각: '#f9ab00', 조퇴: '#e67e22' };

function AttendanceSummary({ checks, startDate, endDate }) {
    const { counts, rate, dailyData, rateData, summaryText } = useMemo(() => {
        const cnt = { 출석: 0, 결석: 0, 지각: 0, 조퇴: 0 };
        const byDate = {};

        checks.forEach(c => {
            const att = c.attendance;
            if (att && cnt.hasOwnProperty(att)) {
                cnt[att]++;
            }
            // 날짜별 집계
            if (att && cnt.hasOwnProperty(att)) {
                if (!byDate[c.date]) byDate[c.date] = { date: c.date, 출석: 0, 결석: 0, 지각: 0, 조퇴: 0 };
                byDate[c.date][att]++;
            }
        });

        const total = cnt.출석 + cnt.결석 + cnt.지각 + cnt.조퇴;
        const r = total > 0 ? Math.round((cnt.출석 / total) * 100) : 0;

        const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
        // 날짜 라벨 축약 (MM-DD)
        daily.forEach(d => { d.label = d.date.slice(5); });

        // 일별 출석률 데이터
        const rData = daily.map(d => {
            const dayTotal = d.출석 + d.결석 + d.지각 + d.조퇴;
            return {
                label: d.label,
                출석률: dayTotal > 0 ? Math.round((d.출석 / dayTotal) * 100) : 0,
            };
        });

        // 평균 출석률 & 최다 결석일
        const avgRate = rData.length > 0
            ? Math.round(rData.reduce((s, d) => s + d.출석률, 0) / rData.length)
            : r;
        let worstDay = '';
        let maxAbsent = 0;
        daily.forEach(d => {
            if (d.결석 > maxAbsent) {
                maxAbsent = d.결석;
                worstDay = d.label;
            }
        });
        const summary = maxAbsent > 0
            ? `평균 출석률 ${avgRate}%, 최다 결석일: ${worstDay}`
            : `평균 출석률 ${avgRate}%`;

        return { counts: cnt, rate: r, dailyData: daily, rateData: rData, summaryText: summary };
    }, [checks]);

    return (
        <div className="dash-card attendance">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined">groups</span>
                    출결 현황
                </span>
                <span className="dash-card-header-meta">
                    {startDate === endDate ? startDate : `${startDate} ~ ${endDate}`}
                </span>
            </div>
            <div className="dash-card-body">
                <div className="dash-stats">
                    <div className="dash-stat">
                        <div className="dash-stat-value rate">{rate}%</div>
                        <div className="dash-stat-label">출석률</div>
                    </div>
                    <div className="dash-stat">
                        <div className="dash-stat-value present">{counts.출석}</div>
                        <div className="dash-stat-label">출석</div>
                    </div>
                    <div className="dash-stat">
                        <div className="dash-stat-value absent">{counts.결석}</div>
                        <div className="dash-stat-label">결석</div>
                    </div>
                    <div className="dash-stat">
                        <div className="dash-stat-value late">{counts.지각}</div>
                        <div className="dash-stat-label">지각</div>
                    </div>
                    <div className="dash-stat">
                        <div className="dash-stat-value early">{counts.조퇴}</div>
                        <div className="dash-stat-label">조퇴</div>
                    </div>
                </div>

                {dailyData.length > 1 && (
                    <>
                        <div className="dash-chart">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={dailyData} barGap={0} barCategoryGap="20%">
                                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                                    <YAxis tick={{ fontSize: 11 }} width={30} />
                                    <Tooltip />
                                    <Bar dataKey="출석" stackId="a" fill={COLORS.출석} />
                                    <Bar dataKey="지각" stackId="a" fill={COLORS.지각} />
                                    <Bar dataKey="조퇴" stackId="a" fill={COLORS.조퇴} />
                                    <Bar dataKey="결석" stackId="a" fill={COLORS.결석} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>

                        <div className="dash-chart">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={rateData}>
                                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                                    <YAxis tick={{ fontSize: 11 }} width={30} domain={[0, 100]} unit="%" />
                                    <Tooltip formatter={(v) => `${v}%`} />
                                    <Line
                                        type="monotone"
                                        dataKey="출석률"
                                        stroke="#1a73e8"
                                        strokeWidth={2}
                                        dot={{ r: 3 }}
                                        activeDot={{ r: 5 }}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>

                        <p className="dash-card-header-meta" style={{ marginTop: 4, textAlign: 'center' }}>
                            {summaryText}
                        </p>
                    </>
                )}

                {checks.length === 0 && <div className="dash-empty">데이터 없음</div>}
            </div>
        </div>
    );
}

export default React.memo(AttendanceSummary);

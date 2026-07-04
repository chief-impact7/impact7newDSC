import React, { useMemo } from 'react';
import { Icon } from '@impact7/ui';
import { ICON_NAME } from '../icon-map.js';
import ReactECharts from '../echarts.jsx';

const COLORS = { 출석: '#188038', 결석: '#d93025', 지각: '#f9ab00', 조퇴: '#e67e22' };

function AttendanceSummary({ checks, startDate, endDate }) {
    const { counts, rate, dailyData, summaryText, dailyOption, rateOption } = useMemo(() => {
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

        const commonGrid = { top: 18, right: 12, bottom: 28, left: 34 };
        const commonTooltip = { trigger: 'axis', confine: true };
        const dailyChart = {
            color: [COLORS.출석, COLORS.지각, COLORS.조퇴, COLORS.결석],
            tooltip: commonTooltip,
            grid: commonGrid,
            xAxis: { type: 'category', data: daily.map(d => d.label), axisLabel: { fontSize: 11 } },
            yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
            series: ['출석', '지각', '조퇴', '결석'].map(key => ({
                name: key,
                type: 'bar',
                stack: 'attendance',
                emphasis: { focus: 'series' },
                data: daily.map(d => d[key]),
            })),
        };
        const rateChart = {
            color: ['#1a73e8'],
            tooltip: { ...commonTooltip, valueFormatter: value => `${value}%` },
            grid: commonGrid,
            xAxis: { type: 'category', data: rData.map(d => d.label), axisLabel: { fontSize: 11 } },
            yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 11, formatter: '{value}%' } },
            series: [{
                name: '출석률',
                type: 'line',
                smooth: true,
                symbolSize: 7,
                lineStyle: { width: 2 },
                data: rData.map(d => d.출석률),
            }],
        };

        return {
            counts: cnt,
            rate: r,
            dailyData: daily,
            summaryText: summary,
            dailyOption: dailyChart,
            rateOption: rateChart,
        };
    }, [checks]);

    return (
        <div className="dash-card attendance">
            <div className="dash-card-header">
                <span>
                    <Icon name={ICON_NAME.groups} size={20} className="material-symbols-outlined" />
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
                            <ReactECharts option={dailyOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
                        </div>

                        <div className="dash-chart">
                            <ReactECharts option={rateOption} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate />
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

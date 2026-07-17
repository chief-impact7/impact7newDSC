import React, { useEffect, useMemo, useState } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_NAME } from '../icon-map.js';
import { SOLAPI_ERROR_LABELS } from '../message-error-labels.js';
import ReactECharts from '../echarts.jsx';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import { formatDateKST, formatDateTimeKST } from '@impact7/shared/datetime';
import { formatPhone } from '@impact7/shared/phone';
import { dateInputToKstMs, kstDayRangeParams, kstDayStartMs, kstMonthStartMs } from '../message-period.js';

const retryCallable = httpsCallable(functions, 'retryMessageDelivery');
const manageCallable = httpsCallable(functions, 'manageMessageFailure');

// 큐 상태 표시 메타 (계약 §2.4).
const QUEUE_STATUS = [
    { key: 'pending', keys: ['pending'], label: '대기', cls: 'pending' },
    { key: 'processing', keys: ['processing', 'awaiting_delivery_result'], label: '처리중', cls: 'processing' },
    { key: 'failed_retryable', keys: ['failed_retryable'], label: '재시도 대기', cls: 'retry' },
    { key: 'failed_permanent', keys: ['failed_permanent'], label: '최종 실패', cls: 'failed' },
    { key: 'sent', keys: ['sent'], label: '발송완료', cls: 'sent' },
];
const CHANNEL_META = {
    kakao: { label: '카카오 알림톡', color: '#FAE100' },
    sms: { label: '문자(SMS/LMS)', color: '#1a73e8' },
    mms: { label: '사진 문자(MMS)', color: '#7b61c9' },
};
const RECIPIENT_ROLE_LABEL = {
    student: '본인',
    parent_1: '학부모1',
    parent_2: '학부모2',
    other: '기타',
};
// 자동충전 꺼진 상태에서 이 금액 밑이면 경고색 — 잔액 고갈은 전 채널 발송 실패.
const LOW_BALANCE_WARN = 10000;

const PERIODS = [
    { key: 'today', label: '오늘' },
    { key: 'week', label: '최근 7일' },
    { key: 'month', label: '이번 달' },
    { key: 'all', label: '전체' },
    { key: 'custom', label: '기간 지정' },
];
const RETRY_INELIGIBLE = (f) => f.piiPurged || f.kind === 'promo' || f.kind === 'promo_sms';
// 보관/삭제 자격 — 행 버튼과 일괄 버튼이 같은 술어를 써야 두 UI가 어긋나지 않는다.
const MANAGE_ELIGIBLE = (f) => f.status === 'failed_permanent';

// 일괄 재처리 동시 callable 호출 상한. 무제한 Promise.all은 대량 선택 시 서버에 순간 부하. F-04
const BULK_CONCURRENCY = 5;
const STATUS_PAGE_SIZE = 10;
// Promise.allSettled와 동일한 형태({status, value|reason})를 인덱스 순서대로 반환하되,
// 동시 실행은 concurrency로 제한한다.
async function runWithConcurrency(items, worker, concurrency) {
    const results = new Array(items.length);
    let next = 0;
    async function runner() {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = { status: 'fulfilled', value: await worker(items[i]) };
            } catch (reason) {
                results[i] = { status: 'rejected', reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
    return results;
}

// data는 권한 확인을 거친 getMessageDeliveryStatus callable 집계 결과다.
function MessageDeliverySummary({ data, students, loading, onReload }) {
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null); // { kind: 'error'|'info', text }
    const [expandedId, setExpandedId] = useState(null); // 본문 펼침 상태(한 번에 하나)
    const [period, setPeriod] = useState('today');
    const [dayOffset, setDayOffset] = useState(0);
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [selectedStatus, setSelectedStatus] = useState(null);
    const [selectedStatusPage, setSelectedStatusPage] = useState(1);

    // 이름은 fetchStudents 범위(재원생)로만 해석된다. 퇴원생 등 범위 밖이면 doc id 원문을
    // 노출하지 않고 마스킹된 수신자 또는 '(이름 미확인)'으로 표시.
    const nameById = useMemo(() => new Map(students.map(s => [s.id, s.name])), [students]);
    const failureName = (f) => nameById.get(f.studentId) || f.recipientMasked || '(이름 미확인)';

    const queueCounts = data.queueCounts ?? {};
    const channelCounts = data.channelCounts ?? { kakao: 0, sms: 0, mms: 0 };
    const failures = data.failures ?? [];
    const queueDetails = data.queueDetails ?? {};
    const channelTotal = (channelCounts.kakao ?? 0) + (channelCounts.sms ?? 0) + (channelCounts.mms ?? 0);
    const queueCount = (status) => status.keys.reduce((sum, key) => sum + (queueCounts[key] ?? 0), 0);
    const selectedStatusMeta = QUEUE_STATUS.find((status) => status.key === selectedStatus);
    const selectedStatusRows = selectedStatusMeta
        ? selectedStatusMeta.keys.flatMap((key) => queueDetails[key] ?? [])
        : [];
    const selectedStatusCount = selectedStatusMeta ? queueCount(selectedStatusMeta) : 0;
    const selectedStatusPageCount = Math.max(1, Math.ceil(selectedStatusRows.length / STATUS_PAGE_SIZE));
    const currentStatusPage = Math.min(selectedStatusPage, selectedStatusPageCount);
    const pagedStatusRows = selectedStatusRows.slice(
        (currentStatusPage - 1) * STATUS_PAGE_SIZE,
        currentStatusPage * STATUS_PAGE_SIZE,
    );
    const dayLabel = period === 'today' && dayOffset < 0
        ? formatDateKST(new Date(kstDayStartMs(dayOffset)))
        : '오늘';

    // 새로고침 후 목록에서 사라진 항목은 선택에서도 제거.
    useEffect(() => {
        setSelectedIds(prev => {
            const alive = new Set(failures.map(f => f.id));
            const next = new Set([...prev].filter(id => alive.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [failures]);

    useEffect(() => {
        setSelectedStatusPage(1);
    }, [queueDetails]);

    const selected = failures.filter(f => selectedIds.has(f.id));
    const allSelected = failures.length > 0 && selected.length === failures.length;
    // 일괄 버튼은 실행 가능한 건수를 라벨에 보여주고 0건이면 비활성화한다 —
    // 누른 뒤에야 "가능한 항목이 없습니다" 에러가 뜨는 상황을 만들지 않는다.
    const retryEligible = selected.filter(f => !RETRY_INELIGIBLE(f));
    const manageEligible = selected.filter(MANAGE_ELIGIBLE);

    function rangeParams(p = period) {
        if (p === 'today') return kstDayRangeParams(dayOffset);
        if (p === 'week') return { fromMs: kstDayStartMs(-6) };
        if (p === 'month') return { fromMs: kstMonthStartMs() };
        if (p === 'custom') {
            const fromMs = dateInputToKstMs(customFrom, false);
            const toMs = dateInputToKstMs(customTo, true);
            const params = {};
            if (fromMs != null) params.fromMs = fromMs;
            if (toMs != null) params.toMs = toMs;
            return params;
        }
        return {};
    }
    function selectPeriod(p) {
        setPeriod(p);
        if (p === 'today') {
            setDayOffset(0);
            onReload(kstDayRangeParams());
            return;
        }
        if (p !== 'custom') onReload(rangeParams(p));
    }
    function moveDay(delta) {
        const base = period === 'today' ? dayOffset : 0;
        const next = Math.min(0, base + delta);
        setDayOffset(next);
        setPeriod('today');
        onReload(kstDayRangeParams(next));
    }
    const refresh = () => {
        if (period === 'custom' && customFrom && customTo && customFrom > customTo) {
            setNotice({ kind: 'error', text: '기간이 올바르지 않습니다 — 시작일이 종료일보다 늦습니다.' });
            return;
        }
        onReload(rangeParams());
    };

    const donutOption = useMemo(() => ({
        tooltip: { trigger: 'item', confine: true },
        legend: { bottom: 0, textStyle: { fontSize: 11 } },
        series: [{
            type: 'pie',
            radius: ['45%', '70%'],
            center: ['50%', '42%'],
            avoidLabelOverlap: true,
            itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
            label: { show: false },
            data: Object.entries(channelCounts)
                .filter(([k, v]) => v > 0 && CHANNEL_META[k])
                .map(([k, v]) => ({ name: CHANNEL_META[k].label, value: v, itemStyle: { color: CHANNEL_META[k].color } })),
        }],
    }), [channelCounts]);

    function toggleSelect(id) {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }
    function toggleSelectAll() {
        setSelectedIds(allSelected ? new Set() : new Set(failures.map(f => f.id)));
    }

    // 일괄 처리 — 기존 단건 callable을 병렬 호출하고 성공/실패/제외를 집계한다.
    function failHint(err) {
        const code = err?.code || '';
        if (code.includes('permission-denied')) return '권한 부족 (재발송은 원장)';
        if (code.includes('resource-exhausted')) return '수동 재발송 한도 초과';
        if (code.includes('failed-precondition')) return '상태·쿨다운·보존기간 제한';
        return '잠시 후 다시 시도해주세요';
    }
    async function runBulk(rows, run, label, skipped) {
        setBusy(true);
        setNotice(null);
        try {
            const results = await runWithConcurrency(rows, run, BULK_CONCURRENCY);
            const ok = results.filter(r => r.status === 'fulfilled').length;
            const fail = results.length - ok;
            const parts = [`${label} ${ok}건 완료`];
            if (fail) {
                const firstErr = results.find(r => r.status === 'rejected')?.reason;
                console.error(`[${label}]`, firstErr);
                parts.push(`${fail}건 실패 — ${failHint(firstErr)}`);
            }
            if (skipped) parts.push(`${skipped}건 제외`);
            setNotice({ kind: fail ? 'error' : 'info', text: parts.join(' · ') });
            setSelectedIds(new Set());
            onReload(rangeParams());
        } finally {
            setBusy(false);
        }
    }
    function bulkRetry() {
        if (!retryEligible.length) return;
        runBulk(retryEligible, f => retryCallable({ queueId: f.id }), '재발송 요청', selected.length - retryEligible.length);
    }
    function bulkManage(action) {
        if (!manageEligible.length) return;
        const label = action === 'delete' ? '삭제' : '보관';
        if (action === 'delete' && !window.confirm(`선택한 ${manageEligible.length}건을 삭제할까요?\n발송 로그(이력)와 삭제 기록은 남습니다.`)) return;
        runBulk(manageEligible, f => manageCallable({ queueId: f.id, action }), label, selected.length - manageEligible.length);
    }
    function singleRetry(f) {
        runBulk([f], x => retryCallable({ queueId: x.id }), '재발송 요청', 0);
    }
    function singleManage(f, action) {
        const label = action === 'delete' ? '삭제' : '보관';
        if (action === 'delete' && !window.confirm(`${failureName(f)}의 실패 항목을 삭제할까요?\n발송 로그(이력)와 삭제 기록은 남습니다.`)) return;
        runBulk([f], x => manageCallable({ queueId: x.id, action }), label, 0);
    }

    return (
        <div className="dash-card msg-delivery">
            <div className="dash-card-header">
                <span>
                    <Icon name={ICON_NAME.send} size={20} className="i7-icon" aria-hidden="true" />
                    발송 현황
                </span>
                <span className="msg-header-actions">
                    {data.solapiBalance && (
                        <span
                            className={`msg-balance${data.solapiBalance.balance < LOW_BALANCE_WARN && !(data.solapiBalance.autoRecharge > 0) ? ' low' : ''}`}
                            title={`포인트 ${data.solapiBalance.point ?? 0}P · 자동충전 ${data.solapiBalance.autoRecharge > 0 ? `${(data.solapiBalance.rechargeTo ?? 0).toLocaleString()}원까지` : '꺼짐'}`}
                        >
                            잔액 {Math.round(data.solapiBalance.balance).toLocaleString()}원
                            {!(data.solapiBalance.autoRecharge > 0) && ' · 자동충전 꺼짐'}
                        </span>
                    )}
                    <a
                        className="msg-pricing-btn"
                        href={`${import.meta.env.BASE_URL}docs/Pricing.html`}
                        target="_blank"
                        rel="noreferrer"
                        title="가격정책"
                        aria-label="가격정책"
                    >
                        <Icon name={ICON_NAME.payments} size={16} className="i7-icon" aria-hidden="true" />
                    </a>
                    <button className={`msg-refresh-btn${loading ? ' loading' : ''}`} onClick={refresh} disabled={loading} title="새로고침" aria-label="새로고침">
                        <Icon name={ICON_NAME.refresh} size={16} className="i7-icon" aria-hidden="true" />
                    </button>
                </span>
            </div>
            <div className="dash-card-body">
                <div className="dash-stats">
                    {QUEUE_STATUS.map(s => (
                        <button
                            type="button"
                            className={`dash-stat msg-stat-button${selectedStatus === s.key ? ' active' : ''}`}
                            key={s.key}
                            aria-pressed={selectedStatus === s.key}
                            onClick={() => {
                                setSelectedStatus(selectedStatus === s.key ? null : s.key);
                                setSelectedStatusPage(1);
                            }}
                        >
                            <div className={`dash-stat-value msg-${s.cls}`}>{queueCount(s)}</div>
                            <div className="dash-stat-label">{s.label}</div>
                        </button>
                    ))}
                </div>

                {selectedStatusMeta && (
                    <div className="msg-status-details">
                        <div className="msg-status-details-head">
                            <strong>{selectedStatusMeta.label} 내역</strong>
                            <span className="msg-status-details-actions">
                                {selectedStatusCount}건
                                {selectedStatusCount > selectedStatusRows.length && ` · 최근 ${selectedStatusRows.length}건 표시`}
                                <IconButton icon="chevronUp" label="접기" onClick={() => setSelectedStatus(null)} />
                            </span>
                        </div>
                        {selectedStatusRows.length ? (
                            <ul>
                                {pagedStatusRows.map((row) => (
                                    <li key={row.id}>
                                        <strong>
                                            {failureName(row)}
                                            {row.recipientRole && ` · ${RECIPIENT_ROLE_LABEL[row.recipientRole] || row.recipientRole}`}
                                        </strong>
                                        <span>{row.recipientPhone ? formatPhone(row.recipientPhone) : row.recipientMasked || '-'}</span>
                                        <span>{SOLAPI_ERROR_LABELS[row.lastErrorCode] || row.lastErrorCode || selectedStatusMeta.label}</span>
                                        <span>{formatDateTimeKST(row.updatedAt || row.createdAt)}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <div className="dash-empty">해당 기간에 표시할 내역이 없습니다.</div>
                        )}
                        {selectedStatusPageCount > 1 && (
                            <div className="msg-status-pagination" role="navigation" aria-label={`${selectedStatusMeta.label} 내역 페이지`}>
                                <button
                                    type="button"
                                    className="msg-status-page"
                                    aria-label="이전 페이지"
                                    disabled={currentStatusPage === 1}
                                    onClick={() => setSelectedStatusPage(currentStatusPage - 1)}
                                >&lt;</button>
                                {Array.from({ length: selectedStatusPageCount }, (_, index) => index + 1).map((page) => (
                                    <button
                                        type="button"
                                        className={`msg-status-page${page === currentStatusPage ? ' active' : ''}`}
                                        key={page}
                                        aria-current={page === currentStatusPage ? 'page' : undefined}
                                        disabled={page === currentStatusPage}
                                        onClick={() => setSelectedStatusPage(page)}
                                    >{page}</button>
                                ))}
                                <button
                                    type="button"
                                    className="msg-status-page"
                                    aria-label="다음 페이지"
                                    disabled={currentStatusPage === selectedStatusPageCount}
                                    onClick={() => setSelectedStatusPage(currentStatusPage + 1)}
                                >&gt;</button>
                            </div>
                        )}
                        {data.queueLimitReached && <p className="msg-period-note">최근 항목 표시 상한에 도달했습니다. 기간을 좁혀주세요.</p>}
                    </div>
                )}

                <div className="msg-period-bar" role="group" aria-label="발송 통계 기간">
                    <span className="msg-period-label">발송 통계</span>
                    {PERIODS.map(p => p.key === 'today' ? (
                        <React.Fragment key={p.key}>
                            <button type="button" className="msg-period-chip" onClick={() => moveDay(-1)} aria-label="이전 날짜">&lt;</button>
                            <button
                                type="button"
                                className={`msg-period-chip${period === p.key ? ' active' : ''}`}
                                onClick={() => selectPeriod(p.key)}
                            >
                                {dayLabel}
                            </button>
                            <button
                                type="button"
                                className="msg-period-chip"
                                onClick={() => moveDay(1)}
                                disabled={period === 'today' && dayOffset === 0}
                                aria-label="다음 날짜"
                            >
                                &gt;
                            </button>
                        </React.Fragment>
                    ) : (
                        <button
                            key={p.key}
                            type="button"
                            className={`msg-period-chip${period === p.key ? ' active' : ''}`}
                            onClick={() => selectPeriod(p.key)}
                        >
                            {p.label}
                        </button>
                    ))}
                    {period === 'custom' && (
                        <span className="msg-period-custom">
                            <input type="date" aria-label="시작일" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                            <span>~</span>
                            <input type="date" aria-label="종료일" value={customTo} onChange={e => setCustomTo(e.target.value)} />
                            <IconButton icon="check" label="기간 적용" disabled={!customFrom && !customTo} onClick={refresh} />
                        </span>
                    )}
                    {data.logLimitReached && <span className="msg-period-note">표시 상한 도달 — 기간을 좁히면 정확해집니다</span>}
                </div>

                <div className="msg-delivery-channels">
                    <div className="msg-channel-chart">
                        {channelTotal > 0
                            ? <ReactECharts option={donutOption} style={{ width: '100%', height: 180 }} notMerge lazyUpdate />
                            : <div className="dash-empty">해당 기간 발송 로그 없음</div>}
                    </div>
                    <ul className="msg-channel-legend">
                        {Object.entries(CHANNEL_META).map(([k, m]) => (
                            <li key={k}>
                                <span className="msg-channel-dot" style={{ background: m.color }} />
                                {m.label}
                                <strong>{channelCounts[k] ?? 0}</strong>
                            </li>
                        ))}
                        <li className="msg-channel-total">
                            발송 완료 <strong>{data.sentCount ?? 0}</strong> · 실패 <strong>{data.failedCount ?? 0}</strong>
                            {(data.sentCount ?? 0) + (data.failedCount ?? 0) > 0 && (
                                <> · 성공률 <strong>{(((data.sentCount ?? 0) / ((data.sentCount ?? 0) + (data.failedCount ?? 0))) * 100).toFixed(1)}%</strong></>
                            )}
                        </li>
                        {Object.keys(data.failedCodeCounts ?? {}).length > 0 && (
                            <li className="msg-failed-codes">
                                {Object.entries(data.failedCodeCounts)
                                    .sort((a, b) => b[1] - a[1])
                                    .slice(0, 4)
                                    .map(([code, count]) => (
                                        <span key={code} className="msg-failed-code">{SOLAPI_ERROR_LABELS[code] || `코드 ${code}`} {count}건</span>
                                    ))}
                            </li>
                        )}
                    </ul>
                </div>

                {notice && (
                    <p className={notice.kind === 'error' ? 'msg-retry-error' : 'msg-bulk-notice'} role="status" aria-live="polite">
                        {notice.text}
                    </p>
                )}

                {failures.length > 0 ? (
                    <details className="msg-failure-accordion">
                        <summary>
                            미발송·실패 항목 {failures.length}건
                            {(data.archivedCount ?? 0) > 0 && <span className="msg-archived-count"> · 보관됨 {data.archivedCount}건</span>}
                        </summary>
                    <div className="msg-failure-list">
                        <div className="msg-failure-head">
                            <label className="msg-check">
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={toggleSelectAll}
                                    aria-label="실패 항목 전체 선택"
                                />
                                <span>전체 선택</span>
                            </label>
                            {selected.length > 0 && (
                                <span className="msg-bulk-actions">
                                    <span className="msg-bulk-count">{selected.length}건 선택</span>
                                    <button
                                        type="button"
                                        className="msg-action-btn msg-action-retry"
                                        disabled={busy || !retryEligible.length}
                                        title={retryEligible.length ? undefined : '선택한 항목 중 재발송 가능한 건이 없습니다 (보존기간 경과·홍보성 제외)'}
                                        onClick={bulkRetry}
                                    >
                                        일괄 재발송 ({retryEligible.length})
                                    </button>
                                    <button
                                        type="button"
                                        className="msg-action-btn"
                                        disabled={busy || !manageEligible.length}
                                        title={manageEligible.length ? undefined : '실패 확정 건만 보관할 수 있습니다 — 재시도 대기 건은 자동 재처리가 끝나면 실패 확정으로 바뀝니다'}
                                        onClick={() => bulkManage('archive')}
                                    >
                                        일괄 보관 ({manageEligible.length})
                                    </button>
                                    <button
                                        type="button"
                                        className="msg-action-btn msg-action-danger"
                                        disabled={busy || !manageEligible.length}
                                        title={manageEligible.length ? undefined : '실패 확정 건만 삭제할 수 있습니다 — 재시도 대기 건은 자동 재처리가 끝나면 실패 확정으로 바뀝니다'}
                                        onClick={() => bulkManage('delete')}
                                    >
                                        일괄 삭제 ({manageEligible.length})
                                    </button>
                                </span>
                            )}
                        </div>
                        {failures.map(f => (
                            <div className="msg-failure-row" key={f.id}>
                                <label className="msg-check">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(f.id)}
                                        onChange={() => toggleSelect(f.id)}
                                        aria-label={`${failureName(f)} 선택`}
                                    />
                                </label>
                                <div className="msg-failure-main">
                                    <span className="msg-failure-name">{failureName(f)}</span>
                                    <span className="msg-failure-meta">
                                        {f.recipientMasked || '-'}
                                        {f.lastErrorCode ? ` · ${SOLAPI_ERROR_LABELS[f.lastErrorCode] || f.lastErrorCode}` : ''}
                                        {f.updatedAt ? ` · ${formatDateTimeKST(f.updatedAt)}` : ''}
                                    </span>
                                    {f.content ? (
                                        <button
                                            type="button"
                                            className={`msg-failure-content${expandedId === f.id ? ' expanded' : ''}`}
                                            title={expandedId === f.id ? '접기' : '본문 전체 보기'}
                                            aria-expanded={expandedId === f.id}
                                            onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}
                                        >
                                            {f.content}
                                        </button>
                                    ) : (
                                        <span className="msg-failure-content msg-failure-content-empty">
                                            {f.piiPurged ? '(보존기간 경과로 본문 삭제됨)' : '(본문 없음)'}
                                        </span>
                                    )}
                                </div>
                                <div className="msg-failure-side">
                                    <span className={`msg-badge msg-${f.status === 'failed_permanent' ? 'failed' : 'retry'}`}>
                                        {f.status === 'failed_permanent' ? '최종 실패' : '재시도 대기'}
                                    </span>
                                    {/* 재발송은 원장 권한. failed_permanent도 허용(원인이 추후 해소되는 실패 실재).
                                        단 보존기간 경과(번호 purge)·홍보성(동의 재확인 불가)은 서버가 거부하므로 버튼을 막는다. */}
                                    <IconButton
                                        icon="arrowClockwise"
                                        label={f.piiPurged ? '보존기간이 지나 재발송할 수 없습니다'
                                            : (f.kind === 'promo' || f.kind === 'promo_sms') ? '홍보성 메시지는 수동 재발송할 수 없습니다'
                                            : '재발송'}
                                        onClick={() => singleRetry(f)}
                                        disabled={busy || RETRY_INELIGIBLE(f)}
                                    />
                                    {/* 보관/삭제는 종결 상태(failed_permanent)만 — 재시도 대기는 sweeper가 아직 처리 중. */}
                                    {MANAGE_ELIGIBLE(f) && (
                                        <>
                                            <IconButton
                                                icon="archiveBox"
                                                label="보관 — 목록에서 숨김 (발송 이력은 보존)"
                                                onClick={() => singleManage(f, 'archive')}
                                                disabled={busy}
                                            />
                                            <IconButton
                                                icon="trash"
                                                tone="danger"
                                                label="삭제 (발송 로그·삭제 기록은 보존)"
                                                onClick={() => singleManage(f, 'delete')}
                                                disabled={busy}
                                            />
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    </details>
                ) : (
                    <div className="dash-empty">
                        미발송·실패 항목 없음
                        {(data.archivedCount ?? 0) > 0 && ` (보관됨 ${data.archivedCount}건)`}
                    </div>
                )}
            </div>
        </div>
    );
}

export default React.memo(MessageDeliverySummary);

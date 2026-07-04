import React, { useMemo, useState } from 'react';
import ReactECharts from '../echarts.jsx';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';

const retryCallable = httpsCallable(functions, 'retryMessageDelivery');
const manageCallable = httpsCallable(functions, 'manageMessageFailure');

// 큐 상태 표시 메타 (계약 §2.4).
const QUEUE_STATUS = [
    { key: 'pending', label: '대기', cls: 'pending' },
    { key: 'processing', label: '처리중', cls: 'processing' },
    { key: 'failed_retryable', label: '재시도 대기', cls: 'retry' },
    { key: 'failed_permanent', label: '실패', cls: 'failed' },
    { key: 'sent', label: '발송완료', cls: 'sent' },
];
const CHANNEL_META = {
    kakao: { label: '카카오 알림톡', color: '#FAE100' },
    sms: { label: 'SMS 대체', color: '#1a73e8' },
    lms: { label: 'LMS 대체', color: '#00754A' },
};

// data는 getMessageDeliveryStatus callable 집계 결과(서버에서 카운트+번호 마스킹 완료).
// 평문 번호는 서버를 벗어나지 않으므로 이 컴포넌트는 표시만 한다.
function MessageDeliverySummary({ data, students, loading, onReload }) {
    const [retrying, setRetrying] = useState(null);
    const [retryError, setRetryError] = useState('');
    const [expandedId, setExpandedId] = useState(null); // 본문 펼침 상태(한 번에 하나)

    // 이름은 fetchStudents 범위(재원생)로만 해석된다. 퇴원생 등 범위 밖이면 doc id 원문을
    // 노출하지 않고 마스킹된 수신자 또는 '(이름 미확인)'으로 표시.
    const nameById = useMemo(() => new Map(students.map(s => [s.id, s.name])), [students]);
    const failureName = (f) => nameById.get(f.studentId) || f.recipientMasked || '(이름 미확인)';

    const queueCounts = data.queueCounts ?? {};
    const channelCounts = data.channelCounts ?? { kakao: 0, sms: 0, lms: 0 };
    const failures = data.failures ?? [];
    const channelTotal = (channelCounts.kakao ?? 0) + (channelCounts.sms ?? 0) + (channelCounts.lms ?? 0);

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
                .filter(([, v]) => v > 0)
                .map(([k, v]) => ({ name: CHANNEL_META[k].label, value: v, itemStyle: { color: CHANNEL_META[k].color } })),
        }],
    }), [channelCounts]);

    const handleRetry = async (queueId) => {
        setRetrying(queueId);
        setRetryError('');
        try {
            await retryCallable({ queueId });
            onReload();
        } catch (err) {
            console.error('[retryMessageDelivery]', err);
            const code = err?.code || '';
            if (code.includes('permission-denied')) {
                setRetryError('재발송은 원장 권한이 필요합니다.');
            } else if (code.includes('resource-exhausted')) {
                setRetryError('수동 재발송 한도를 초과했습니다.');
            } else if (code.includes('failed-precondition')) {
                setRetryError('지금은 재발송할 수 없습니다 (상태·쿨다운·보존기간 확인).');
            } else {
                setRetryError('재발송 요청 실패 — 잠시 후 다시 시도해주세요.');
            }
        } finally {
            setRetrying(null);
        }
    };

    // 보관=목록에서 숨김, 삭제=doc 제거(둘 다 직원 가능 — 삭제는 서버가 누가/누구에게/언제를 감사 기록).
    const handleManage = async (queueId, action, name) => {
        if (action === 'delete' && !window.confirm(`${name}의 실패 항목을 삭제할까요?\n발송 로그(이력)와 삭제 기록은 남습니다.`)) return;
        setRetrying(queueId);
        setRetryError('');
        try {
            await manageCallable({ queueId, action });
            onReload();
        } catch (err) {
            console.error('[manageMessageFailure]', err);
            const code = err?.code || '';
            if (code.includes('permission-denied')) {
                setRetryError('권한이 없습니다.');
            } else {
                setRetryError(`${action === 'delete' ? '삭제' : '보관'} 실패 — 잠시 후 다시 시도해주세요.`);
            }
        } finally {
            setRetrying(null);
        }
    };

    return (
        <div className="dash-card msg-delivery">
            <div className="dash-card-header">
                <span>
                    <span className="material-symbols-outlined" aria-hidden="true">send</span>
                    발송 현황 (출결 알림)
                </span>
                <button className="dash-text-btn" onClick={onReload} disabled={loading} title="새로고침">
                    <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
                    {loading ? '불러오는 중' : '새로고침'}
                </button>
            </div>
            <div className="dash-card-body">
                <div className="dash-stats">
                    {QUEUE_STATUS.map(s => (
                        <div className="dash-stat" key={s.key}>
                            <div className={`dash-stat-value msg-${s.cls}`}>{queueCounts[s.key] ?? 0}</div>
                            <div className="dash-stat-label">{s.label}</div>
                        </div>
                    ))}
                </div>

                <div className="msg-delivery-channels">
                    <div className="msg-channel-chart">
                        {channelTotal > 0
                            ? <ReactECharts option={donutOption} style={{ width: '100%', height: 180 }} notMerge lazyUpdate />
                            : <div className="dash-empty">발송 로그 없음</div>}
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
                        </li>
                    </ul>
                </div>

                {retryError && <p className="msg-retry-error" role="status" aria-live="assertive">{retryError}</p>}

                {failures.length > 0 ? (
                    <div className="msg-failure-list">
                        <div className="msg-failure-head">
                            미발송·실패 항목
                            {(data.archivedCount ?? 0) > 0 && <span className="msg-archived-count"> · 보관됨 {data.archivedCount}건</span>}
                        </div>
                        {failures.map(f => (
                            <div className="msg-failure-row" key={f.id}>
                                <div className="msg-failure-main">
                                    <span className="msg-failure-name">{failureName(f)}</span>
                                    <span className="msg-failure-meta">
                                        {f.recipientMasked || '-'}
                                        {f.lastErrorCode ? ` · ${f.lastErrorCode}` : ''}
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
                                        {f.status === 'failed_permanent' ? '실패' : '재시도 대기'}
                                    </span>
                                    {/* 재발송은 원장 권한. failed_permanent도 허용(원인이 추후 해소되는 실패 실재).
                                        단 보존기간 경과(번호 purge)·홍보성(동의 재확인 불가)은 서버가 거부하므로 버튼을 막는다. */}
                                    <button
                                        className="msg-action-btn msg-action-retry"
                                        title={f.piiPurged ? '보존기간이 지나 재발송할 수 없습니다'
                                            : (f.kind === 'promo' || f.kind === 'promo_sms') ? '홍보성 메시지는 수동 재발송할 수 없습니다'
                                            : undefined}
                                        onClick={() => handleRetry(f.id)}
                                        disabled={retrying === f.id || f.piiPurged || f.kind === 'promo' || f.kind === 'promo_sms'}
                                    >
                                        {retrying === f.id ? '요청 중' : '재발송'}
                                    </button>
                                    {/* 보관/삭제는 종결 상태(failed_permanent)만 — 재시도 대기는 sweeper가 아직 처리 중. */}
                                    {f.status === 'failed_permanent' && (
                                        <>
                                            <button
                                                className="msg-action-btn"
                                                title="목록에서 숨깁니다 (발송 이력은 보존)"
                                                onClick={() => handleManage(f.id, 'archive', failureName(f))}
                                                disabled={retrying === f.id}
                                            >
                                                보관
                                            </button>
                                            <button
                                                className="msg-action-btn msg-action-danger"
                                                title="항목을 삭제합니다 (발송 로그·삭제 기록은 보존)"
                                                onClick={() => handleManage(f.id, 'delete', failureName(f))}
                                                disabled={retrying === f.id}
                                            >
                                                삭제
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
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

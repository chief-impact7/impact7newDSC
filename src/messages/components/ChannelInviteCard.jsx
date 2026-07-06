import React, { useCallback, useEffect, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';

// 카카오 채널 가입 유도 대상 — 친구톡이 문자로 전환된(비친구 확정, 3120) 수신자 명단.
// 서버가 전환 확정 시 자동 기록하고, 이후 친구톡 도달(=가입 확인) 시 자동 제거한다.
// 평문 번호는 내려오지 않는다(마스킹 + 불투명 키).

const getTargets = httpsCallable(functions, 'getChannelInviteTargets');
const manageTarget = httpsCallable(functions, 'manageChannelInviteTarget');

const PERIODS = [
  { key: '30', label: '최근 30일', days: 30 },
  { key: '90', label: '최근 90일', days: 90 },
  { key: 'all', label: '전체', days: null },
];

export default function ChannelInviteCard() {
  const [period, setPeriod] = useState('90');
  const [showInactive, setShowInactive] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const loadSeq = useRef(0); // 기간/토글 연타 시 늦게 도착한 이전 응답이 최신 화면을 덮지 않게

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true); setMsg('');
    try {
      const days = PERIODS.find((p) => p.key === period)?.days;
      const payload = { includeInactive: showInactive };
      if (days) payload.sinceMs = Date.now() - days * 86_400_000;
      const res = await getTargets(payload);
      if (seq === loadSeq.current) setData(res.data);
    } catch (e) {
      if (seq === loadSeq.current) setMsg('조회 실패: ' + (e?.message || e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [period, showInactive]);

  useEffect(() => { load(); }, [load]);

  async function act(target, action) {
    if (action === 'exclude' && !window.confirm('이 번호를 앞으로 유도 대상에서 영구 제외할까요?\n(나중에 "숨김·제외 보기"에서 복원할 수 있습니다)')) return;
    setBusy(true); setMsg('');
    try {
      await manageTarget({ key: target.key, action });
      await load();
    } catch (e) {
      setMsg('처리 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const targets = data?.targets ?? [];
  const inactiveTotal = (data?.hiddenCount ?? 0) + (data?.excludedCount ?? 0);

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">💬 채널 가입 유도 대상</div>
        <p className="mc-field-label">
          카카오톡 친구톡이 문자로 전환된(채널 미가입 확정) 수신자입니다.
          채널 가입이 확인되면 자동으로 명단에서 사라집니다.
        </p>

        <div className="ci-toolbar" role="group" aria-label="유도 대상 기간">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`msg-period-chip${period === p.key ? ' active' : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
          <span className="ci-toolbar-right">
            {(showInactive || inactiveTotal > 0) && (
              <button type="button" className="msg-action-btn" onClick={() => setShowInactive(!showInactive)}>
                {showInactive ? '숨김·제외 감추기' : `숨김·제외 보기 (${inactiveTotal})`}
              </button>
            )}
            <button type="button" className="msg-action-btn" disabled={loading} onClick={load}>
              {loading ? '불러오는 중' : '새로고침'}
            </button>
          </span>
        </div>

        {msg && <p className="mc-field-label" role="status" aria-live="polite">{msg}</p>}

        {!loading && targets.length === 0 && (
          <div className="dash-empty">
            대상이 없습니다 — 친구톡이 문자로 전환되면(채널 미가입 확정) 자동으로 쌓입니다.
          </div>
        )}

        {targets.length > 0 && (
          <ul className="ci-list">
            {targets.map((t) => (
              <li key={t.key} className={`ci-row${t.hidden || t.excluded ? ' ci-inactive' : ''}`}>
                <div className="ci-main">
                  <span className="ci-name">{t.name || '(미확인 — 신청자일 수 있음)'}</span>
                  <span className="ci-meta">
                    {t.masked}
                    {t.lastConvertedAt ? ` · 마지막 전환 ${formatDateTimeKST(t.lastConvertedAt)}` : ''}
                    {` · 전환 ${t.count}회`}
                  </span>
                  <span className="ci-badges">
                    {t.invitedAt && <span className="msg-badge msg-sent">유도함 {formatDateTimeKST(t.invitedAt)}</span>}
                    {t.hidden && <span className="msg-badge msg-retry">숨김</span>}
                    {t.excluded && <span className="msg-badge msg-failed">영구 제외</span>}
                  </span>
                </div>
                <div className="ci-side">
                  {t.hidden || t.excluded ? (
                    <button type="button" className="msg-action-btn" disabled={busy} onClick={() => act(t, 'restore')}>
                      복원
                    </button>
                  ) : (
                    <>
                      {!t.invitedAt && (
                        <button
                          type="button"
                          className="msg-action-btn msg-action-retry"
                          title="이 대상에게 채널 가입 유도를 보냈다고 표시합니다 (중복 유도 방지)"
                          disabled={busy}
                          onClick={() => act(t, 'invited')}
                        >
                          유도함 표시
                        </button>
                      )}
                      <button
                        type="button"
                        className="msg-action-btn"
                        title="목록에서 숨깁니다 — 이후 다시 문자 전환이 발생하면 재등장합니다"
                        disabled={busy}
                        onClick={() => act(t, 'hide')}
                      >
                        숨김
                      </button>
                      <button
                        type="button"
                        className="msg-action-btn msg-action-danger"
                        title="앞으로 유도 대상에 올리지 않습니다 (복원 가능)"
                        disabled={busy}
                        onClick={() => act(t, 'exclude')}
                      >
                        제외
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data?.limitReached && <p className="mc-note">표시 상한(200건) 도달 — 기간을 좁히면 정확해집니다.</p>}
      </div>
    </section>
  );
}

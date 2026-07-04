import React, { useState, useEffect, useCallback } from 'react';
import { syncChannelFriends, getChannelFriends } from '../../../data-layer.js';

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const isValid = (d) => d.length >= 9 && d.length <= 11;

// 카카오 채널 친구목록 업로드 동기화.
// 친구 여부를 카카오/솔라피가 사전조회로 주지 않으므로 이 명단은 ①수동 업로드 ②BMS 도달 결과
// 자동 학습으로만 채워진다. 따라서 "명단에 없음 = 채널 미가입"이 아니라 "미확인"이다 —
// 미가입 재원생 명단 표시는 부정확해 제거함(2026-07-04). 가입 유도는 비친구 문자 전환 시 자동 첨부.
export default function ChannelFriendsCard() {
  const [raw, setRaw] = useState('');
  const [total, setTotal] = useState(null); // number | null(로딩)
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const res = await getChannelFriends();
      setTotal((res.phones || []).length);
    } catch (e) {
      setMsg('친구목록 조회 실패: ' + (e?.message || e));
    }
  }, []);
  useEffect(() => { loadCount(); }, [loadCount]);

  async function onUpload() {
    if (busy) return;
    const phones = raw.split(/[\n,]+/).map(onlyDigits).filter(isValid);
    if (!phones.length) { setMsg('유효한 전화번호가 없습니다.'); return; }
    setBusy(true); setMsg('');
    try {
      const res = await syncChannelFriends({ phones });
      setMsg(`동기화 완료 — 추가 ${res.added} · 제거 ${res.removed} · 총 ${res.total}`);
      setRaw('');
      await loadCount();
    } catch (e) {
      setMsg('동기화 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">📡 카카오 채널 친구 관리</div>
        <p className="mc-field-label">
          친구 명단은 카카오톡 발송 결과로 자동 학습됩니다 (현재 {total ?? '…'}건).
          별도 확보한 친구 번호가 있을 때만 아래에 붙여넣어 동기화하세요 — 업로드하면 명단 전체가 입력값으로 교체됩니다.
        </p>
        <textarea aria-label="친구 전화번호 목록" className="mc-textarea" value={raw} onChange={(e) => setRaw(e.target.value)}
          placeholder={'010-1111-2222\n010-3333-4444'} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button className="mc-send" disabled={busy} onClick={onUpload}>{busy ? '동기화 중…' : '친구목록 업로드'}</button>
          {msg && <span className="mc-field-label" role="status" aria-live="polite">{msg}</span>}
        </div>
      </div>
    </section>
  );
}

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { syncChannelFriends, getChannelFriends } from '../../../data-layer.js';
import { downloadCsv } from '../../shared/csv.js';

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const isValid = (d) => d.length >= 9 && d.length <= 11;

// 카카오 채널 친구목록 업로드 동기화 + 미가입 재원생 학부모 명단.
// 친구 여부를 솔라피가 사전조회로 주지 않으므로, 관리자센터 친구목록을 업로드해 DB로 관리한다.
export default function ChannelFriendsCard({ students = [] }) {
  const [raw, setRaw] = useState('');
  const [friends, setFriends] = useState(null); // Set<phone> | null(로딩)
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadFriends = useCallback(async () => {
    try {
      const res = await getChannelFriends();
      setFriends(new Set(res.phones || []));
    } catch (e) {
      setMsg('친구목록 조회 실패: ' + (e?.message || e));
    }
  }, []);
  useEffect(() => { loadFriends(); }, [loadFriends]);

  async function onUpload() {
    if (busy) return;
    const phones = raw.split(/[\n,]+/).map(onlyDigits).filter(isValid);
    if (!phones.length) { setMsg('유효한 전화번호가 없습니다.'); return; }
    setBusy(true); setMsg('');
    try {
      const res = await syncChannelFriends({ phones });
      setMsg(`동기화 완료 — 추가 ${res.added} · 제거 ${res.removed} · 총 ${res.total}`);
      setRaw('');
      await loadFriends();
    } catch (e) {
      setMsg('동기화 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  // 미가입 = 재원생 중 학부모1 번호가 친구목록에 없는 학생.
  const unjoined = useMemo(() => {
    if (!friends) return [];
    return (students || [])
      .filter((s) => isEnrollableStatus(s.status))
      // 서버 resolveRecipientPhone과 동일하게 parent_1 → parent_2 폴백 번호로 대조.
      .map((s) => ({ id: s.id, name: s.name, status: s.status, phone: onlyDigits(s.parent_phone_1) || onlyDigits(s.parent_phone_2) }))
      .filter((s) => s.phone && !friends.has(s.phone));
  }, [students, friends]);

  function onExportCsv() {
    if (!unjoined.length) return;
    // 파일명 날짜는 KST 기준(toISOString의 UTC면 자정 직후 하루 어긋남). sv-SE 로케일이 YYYY-MM-DD를 준다.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    downloadCsv(
      `미가입_재원생학부모_${today}_${unjoined.length}명.csv`,
      ['이름', '상태', '학부모번호'],
      unjoined.map((s) => [s.name, s.status, s.phone]),
    );
  }

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">📡 카카오 채널 친구 관리</div>
        <p className="mc-field-label">친구 전화번호 붙여넣기 (줄바꿈/쉼표 구분)</p>
        <textarea aria-label="친구 전화번호 목록" className="mc-textarea" value={raw} onChange={(e) => setRaw(e.target.value)}
          placeholder={'010-1111-2222\n010-3333-4444'} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button className="mc-send" disabled={busy} onClick={onUpload}>{busy ? '동기화 중…' : '친구목록 업로드'}</button>
          {msg && <span className="mc-field-label" role="status" aria-live="polite">{msg}</span>}
        </div>
        <div className="bulk-cart" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>미가입 재원생 학부모 {friends ? `${unjoined.length}명` : '…'}</span>
          <button type="button" className="mc-var-btn" disabled={!unjoined.length} onClick={onExportCsv}>전체 CSV 내보내기</button>
        </div>
        <ul className="bulk-picked">
          {unjoined.slice(0, 100).map((s) => (
            <li key={s.id}><span>{s.name}</span><span style={{ color: '#7c8a83' }}>{s.phone}</span></li>
          ))}
          {unjoined.length > 100 && <li className="bulk-more">… 외 {unjoined.length - 100}명</li>}
        </ul>
      </div>
    </section>
  );
}

import React, { useEffect, useState } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { formatDateTimeKST, todayKST } from '@impact7/shared/datetime';
import { getManualOptOuts, registerManualOptOut } from '../../../data-layer.js';
import { normalizePhones } from '../message-format.js';
import { ICON_NAME } from '../../dashboard/icon-map.js';

const SYNC_STATUS_LABEL = {
  matched: '일치',
  solapi_only: '솔라피만',
  local_only: 'DSC만',
};

function providerDateLabel(value) {
  return value ? formatDateTimeKST(new Date(value).getTime()) : '';
}

export default function ManualOptOutCard() {
  const [phone, setPhone] = useState('');
  const [memo, setMemo] = useState('');
  const [requestedDate, setRequestedDate] = useState(todayKST());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [registry, setRegistry] = useState(null);
  const [listBusy, setListBusy] = useState(true);

  async function loadRegistry() {
    setListBusy(true);
    try { setRegistry(await getManualOptOuts()); }
    catch (error) { setMsg(`목록 조회 실패: ${error?.message || error}`); }
    finally { setListBusy(false); }
  }

  useEffect(() => { loadRegistry(); }, []);

  async function onRegister() {
    if (busy) return;
    if (normalizePhones(phone).length !== 1) { setMsg('휴대폰 번호 1개를 입력하세요.'); return; }
    setBusy(true); setMsg('');
    try {
      const result = await registerManualOptOut({ phone, memo, requestedDate });
      setMsg(`${result.recipientMasked} 솔라피 발송 차단 등록 완료`);
      setPhone(''); setMemo('');
      await loadRegistry();
    } catch (error) {
      setMsg(`등록 실패: ${error?.message || error}`);
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const header = ['번호(마스킹)', '요청일', '솔라피 등록일시', '메모', '대조 상태'];
    const lines = (registry?.items ?? []).map((item) => [
      item.recipientMasked,
      item.requestedDate,
      providerDateLabel(item.providerCreatedAt),
      item.memo,
      SYNC_STATUS_LABEL[item.syncStatus] || item.syncStatus,
    ].map(quote).join(','));
    const blob = new Blob(['﻿' + [header.map(quote).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `수신거부_대조목록_${todayKST()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="mc-section">
      <details className="mc-card">
        <summary className="mc-section-title"><Icon name={ICON_NAME.phone_opt_out} size={20} aria-hidden="true" /> 수신거부 번호 등록 <span className="mc-tag">솔라피 연동</span><Icon name="chevronDown" size={18} className="mc-disclosure-icon" aria-hidden="true" /></summary>
        <div className="mc-optout-row">
          <input type="tel" aria-label="수신거부 휴대폰 번호" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-1234-5678" />
          <input type="date" aria-label="수신거부 요청일" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
          <input aria-label="수신거부 메모" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="메모 (선택)" maxLength={250} />
          <button className="mc-send" disabled={busy || !requestedDate} onClick={onRegister}>{busy ? '등록 중…' : '솔라피에 등록'}</button>
        </div>
        <p className="mc-field-label" style={{ marginTop: 7 }}>등록된 번호는 솔라피에서 문자·카카오 등 모든 발송 채널이 차단됩니다.</p>
        {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 7 }}>{msg}</p>}
        <details className="mc-optout-details">
          <summary>
            DSC·솔라피 수신거부 목록 {(registry?.items ?? []).length}건
            <span>일치 {registry?.matchedCount ?? 0} · 솔라피만 {registry?.solapiOnlyCount ?? 0} · DSC만 {registry?.localOnlyCount ?? 0}</span>
          </summary>
          <div className="mc-optout-actions">
            <IconButton icon="arrowsRightLeft" label={listBusy ? '조회 중…' : '솔라피와 다시 대조'} disabled={listBusy} onClick={loadRegistry} />
            <IconButton icon="download" label="CSV 다운로드" disabled={listBusy || !(registry?.items ?? []).length} onClick={downloadCsv} />
          </div>
          {!listBusy && (registry?.items ?? []).length === 0 ? (
            <div className="mc-gap-empty">등록된 수신거부 번호가 없습니다.</div>
          ) : (
            <div className="mc-optout-table-wrap">
              <table className="mc-optout-table">
                <thead><tr><th>번호</th><th>요청일</th><th>솔라피 등록일</th><th>메모</th><th>대조</th></tr></thead>
                <tbody>
                  {(registry?.items ?? []).map((item) => (
                    <tr key={item.id}>
                      <td>{item.recipientMasked || '-'}</td>
                      <td>{item.requestedDate || '-'}</td>
                      <td>{providerDateLabel(item.providerCreatedAt) || '-'}</td>
                      <td>{item.memo || '-'}</td>
                      <td><span className={`mc-sync ${item.syncStatus}`}>{SYNC_STATUS_LABEL[item.syncStatus] || item.syncStatus}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {registry?.localLimitReached && <p className="mc-field-label">DSC 이력 최근 500건 기준으로 대조했습니다.</p>}
        </details>
      </details>
    </section>
  );
}

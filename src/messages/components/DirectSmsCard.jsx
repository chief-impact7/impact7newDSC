import React, { useState, useRef, useEffect } from 'react';
import { getManualOptOuts, registerManualOptOut, sendDirectMessage } from '../../../data-layer.js';
import { messageMeta, normalizePhones } from '../message-format.js';
import { parsePhonesFromFile, sampleCsv } from '../message-import.js';
import { getMessageExtras, saveMessageExtras, composeWithExtras, DEFAULT_CHANNEL_INVITE } from '../sms-extras.js';
import TemplateBar from './TemplateBar.jsx';
import { OPT_OUT_LINE } from '../../../promo-compliance.js';
import { formatDateTimeKST, todayKST } from '@impact7/shared/datetime';

const AD_PREFIX = '(광고) [임팩트세븐학원]';
const SYNC_STATUS_LABEL = {
  matched: '일치',
  solapi_only: '솔라피만',
  local_only: 'DSC만',
};

function providerDateLabel(value) {
  return value ? formatDateTimeKST(new Date(value).getTime()) : '';
}

function composePromoText(text, withAdLabel, withOptOut) {
  let result = text.trim();
  if (withAdLabel && !/\(광고\)/.test(result)) result = `${AD_PREFIX}\n${result}`;
  if (withOptOut && !/(무료거부|수신거부|080)/.test(result)) result = `${result}\n${OPT_OUT_LINE}`;
  return result;
}

function newReqId() {
  // 입력 1회분 멱등키. 발송 성공 또는 내용 변경 시 리셋. randomUUID는 secure context 전용이라 LAN http dev용 fallback 유지.
  return 'direct-' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + '-' + performance.now().toString(36));
}

// 클라이언트 1차 방어 상한 — 최종 검증은 서버 callable. F-02
const MAX_RECIPIENTS = 100;

export default function DirectSmsCard() {
  const [recipients, setRecipients] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState('info');
  const [withAdLabel, setWithAdLabel] = useState(true);
  const [withOptOut, setWithOptOut] = useState(true);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [when, setWhen] = useState('now'); // 'now' | 'schedule'
  const [scheduledAt, setScheduledAt] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [footer, setFooter] = useState('');            // 공유 꼬리말(로드된 값)
  const [invite, setInvite] = useState(DEFAULT_CHANNEL_INVITE); // 채널 안내(설정||기본)
  const [inviteCustom, setInviteCustom] = useState(''); // 채널 안내 설정 원본(''=기본 사용)
  const [withInvite, setWithInvite] = useState(false); // ☑ 채널 가입 안내 첨부
  const [withFooter, setWithFooter] = useState(false); // ☑ 학원 꼬리말 첨부
  const [setupOpen, setSetupOpen] = useState(false);    // 문구 설정 패널
  const [footerDraft, setFooterDraft] = useState('');
  const [inviteDraft, setInviteDraft] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const reqIdRef = useRef(newReqId());
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getMessageExtras().then((x) => {
      if (!alive) return;
      setFooter(x.footer); setInvite(x.channelInvite); setInviteCustom(x.channelInviteCustom);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  function resetReqId() { reqIdRef.current = newReqId(); }
  async function onSaveSetup() {
    if (setupBusy) return;
    setSetupBusy(true);
    try {
      await saveMessageExtras({ footer: footerDraft, channelInvite: inviteDraft });
      const nextInviteCustom = inviteDraft.trim();
      setInviteCustom(nextInviteCustom);
      setInvite(nextInviteCustom || DEFAULT_CHANNEL_INVITE);
      setFooter(footerDraft.trim());
      setSetupOpen(false);
      setMsg('문구를 저장했습니다 — 전 직원의 수동 문자 작성에 적용됩니다.');
    } catch (e) {
      setMsg('문구 저장 실패: ' + (e?.message || e));
    } finally {
      setSetupBusy(false);
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const phones = await parsePhonesFromFile(file);
      if (!phones.length) { setMsg('파일에서 유효한 번호를 찾지 못했습니다.'); return; }
      // 기존 입력에 없는 번호만 이어붙인다(중복 제거 — 발송과 동일한 정규화 기준).
      const have = new Set(normalizePhones(recipients));
      const add = phones.filter((p) => !have.has(p));
      setRecipients(recipients.trim() ? recipients.replace(/\s*$/, '') + '\n' + add.join('\n') : add.join('\n'));
      setMsg(`${file.name} — ${phones.length}개 인식 · ${add.length}개 추가`);
      resetReqId();
    } catch (err) {
      setMsg('파일 읽기 실패: ' + (err?.message || err));
    } finally {
      e.target.value = '';
    }
  }

  function downloadSample() {
    const blob = new Blob(['﻿' + sampleCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = '수신번호_양식.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // 체크된 부가 문구를 합성한 실제 발송 본문 — 글자수·SMS/LMS 판정·발송 모두 이 값을 쓴다.
  const baseText = composeWithExtras(text, [withInvite ? invite : '', withFooter ? footer : '']);
  const effectiveText = kind === 'promo'
    ? composePromoText(baseText, withAdLabel, withOptOut)
    : baseText;

  function selectKind(nextKind) {
    setKind(nextKind);
    if (nextKind === 'promo') {
      setWithAdLabel(true);
      setWithOptOut(true);
      setConsentConfirmed(false);
    }
    setMsg('');
    resetReqId();
  }

  async function onSend() {
    if (sending) return;
    if (!baseText.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (!recipients.trim()) { setMsg('수신번호를 입력하세요.'); return; }
    if (kind === 'promo' && (!withAdLabel || !withOptOut)) { setMsg('홍보성 문자는 광고 문구와 무료 수신거부 안내가 모두 필요합니다.'); return; }
    if (kind === 'promo' && !consentConfirmed) { setMsg('광고 수신동의를 확인한 번호인지 체크하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    const phoneCount = new Set(normalizePhones(recipients)).size;
    if (phoneCount > MAX_RECIPIENTS) { setMsg(`한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다 (현재 ${phoneCount}명). 대상을 나눠 보내세요.`); return; }
    setSending(true); setMsg('');
    try {
      const payload = { recipients, text: effectiveText, messageKind: kind, consentConfirmed, requestId: reqIdRef.current };
      if (when === 'schedule') payload.scheduledAt = scheduledAt.slice(0, 16).replace('T', ' ') + ':00';
      const res = await sendDirectMessage(payload);
      if (res.duplicate) {
        setMsg('이미 발송된 요청입니다.');
      } else {
        setMsg(`${res.queued}건 발송 접수${res.invalid?.length ? ` · 무효 번호 ${res.invalid.length}건 제외` : ''}`);
        setRecipients(''); setText(''); setConsentConfirmed(false); resetReqId();
      }
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally {
      setSending(false);
    }
  }

  const meta = messageMeta(effectiveText);
  const count = new Set(normalizePhones(recipients)).size;
  const attachedLines = [withInvite ? invite : '', withFooter ? footer : ''].filter((l) => l && !text.includes(l));

  return (
    <>
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">
          📱 휴대폰 문자 발송
          <div className="mc-seg" role="group" aria-label="문자 종류">
            <button type="button" className={kind === 'info' ? 'on' : ''} aria-pressed={kind === 'info'} onClick={() => selectKind('info')}>정보성</button>
            <button type="button" className={kind === 'promo' ? 'on' : ''} aria-pressed={kind === 'promo'} onClick={() => selectKind('promo')}>홍보성</button>
          </div>
        </div>
        <div className="mc-direct">
          <div>
            <div className="mc-content-head">
              <p className="mc-field-label">수신번호 (줄바꿈/쉼표로 여러 명){count ? ` · ${count}명` : ''}</p>
              <div className="mc-vars">
                <button type="button" className="mc-var-btn" onClick={() => fileRef.current?.click()}>📄 Excel·CSV 업로드</button>
                <button type="button" className="mc-var-btn" onClick={downloadSample}>양식</button>
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" aria-label="번호 파일 업로드" style={{ display: 'none' }} onChange={onFile} />
            <textarea aria-label="수신번호 목록" className="mc-textarea" value={recipients}
              onChange={(e) => { setRecipients(e.target.value); resetReqId(); }}
              placeholder={'010-1234-5678\n010-9876-5432'} />
            <p className="mc-field-label" style={{ marginTop: 6 }}>학생 DB에 없는 번호도 가능 · 발신 02-2649-0509</p>
          </div>
          <div>
            <div className="mc-content-head">
              <p className="mc-field-label">내용</p>
              <TemplateBar content={text} onPick={(c) => { setText(c); resetReqId(); }} />
            </div>
            <textarea aria-label="메시지 내용" className="mc-textarea" value={text}
              onChange={(e) => { setText(e.target.value); resetReqId(); }}
              placeholder="안내 내용을 입력하세요." />
            <div className="mc-vars" style={{ marginTop: 6, alignItems: 'center' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, margin: 0, cursor: 'pointer' }} title={invite}>
                <input type="checkbox" checked={withInvite} onChange={(e) => { setWithInvite(e.target.checked); resetReqId(); }} />
                채널 가입 안내
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, margin: 0, cursor: footer ? 'pointer' : 'default', opacity: footer ? 1 : 0.5 }}
                title={footer || '꼬리말이 아직 없습니다 — 문구 설정에서 등록'}>
                <input type="checkbox" checked={withFooter} disabled={!footer} onChange={(e) => { setWithFooter(e.target.checked); resetReqId(); }} />
                학원 꼬리말
              </label>
              <button type="button" className="mc-var-btn" onClick={() => { setFooterDraft(footer); setInviteDraft(inviteCustom); setSetupOpen(!setupOpen); }}>문구 설정⚙</button>
            </div>
            {kind === 'promo' && (
              <div className="mc-promo-checks">
                <label><input type="checkbox" checked={withAdLabel} onChange={(e) => { setWithAdLabel(e.target.checked); resetReqId(); }} /> 광고 문구</label>
                <label><input type="checkbox" checked={withOptOut} onChange={(e) => { setWithOptOut(e.target.checked); resetReqId(); }} /> 수신거부</label>
                <label><input type="checkbox" checked={consentConfirmed} onChange={(e) => { setConsentConfirmed(e.target.checked); resetReqId(); }} /> 광고 수신동의 번호 확인</label>
              </div>
            )}
            {attachedLines.length > 0 && (
              <div style={{ marginTop: 5, border: '1px dashed #cfd8d2', borderRadius: 8, padding: '6px 9px', background: '#fafcfb', fontSize: 12, color: '#5f6b76', whiteSpace: 'pre-wrap' }}>
                {attachedLines.join('\n\n')}
              </div>
            )}
            {setupOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, border: '1px solid #e3e8e5', borderRadius: 8, padding: '8px 10px', background: '#fafaf7' }}>
                <label className="mc-field-label" style={{ margin: 0 }}>채널 가입 안내 문구 (비우면 기본 문구)</label>
                <textarea aria-label="채널 가입 안내 문구" className="mc-textarea" rows={2} style={{ minHeight: 44 }}
                  value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)}
                  placeholder={DEFAULT_CHANNEL_INVITE} maxLength={280} />
                <label className="mc-field-label" style={{ margin: 0 }}>학원 꼬리말</label>
                <input aria-label="학원 꼬리말" className="mc-tpl-title" value={footerDraft}
                  onChange={(e) => setFooterDraft(e.target.value)} placeholder="예: -임팩트세븐학원 02-2649-0509" maxLength={200} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="mc-var-btn" disabled={setupBusy} onClick={onSaveSetup}>{setupBusy ? '저장 중…' : '저장'}</button>
                  <button type="button" className="mc-var-btn" onClick={() => setSetupOpen(false)}>취소</button>
                </div>
              </div>
            )}
            <div className="mc-meta">
              <span>{meta.chars}자 · {meta.bytes}byte</span>
              <span className={'mc-pill' + (meta.type === 'LMS' ? ' lms' : '')}>{meta.type}</span>
              {count ? <span>· {count}명</span> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <div className="mc-seg">
                <button type="button" className={when === 'now' ? 'on' : ''} aria-pressed={when === 'now'} onClick={() => setWhen('now')}>즉시</button>
                <button type="button" className={when === 'schedule' ? 'on' : ''} aria-pressed={when === 'schedule'} onClick={() => setWhen('schedule')}>예약</button>
              </div>
              {when === 'schedule' && (
                <input aria-label="예약 발송 시각" type="datetime-local" value={scheduledAt} onChange={(e) => { setScheduledAt(e.target.value); resetReqId(); }} />
              )}
              <button className="mc-send" style={{ marginLeft: 'auto' }} disabled={sending} onClick={onSend}>
                {sending ? '발송 중…' : '발송'}
              </button>
            </div>
            {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 8 }}>{msg}</p>}
            <div className="mc-note" style={{ marginTop: 10 }}>
              {kind === 'promo'
                ? '홍보성 문자는 수신동의 번호에만 발송하며, (광고)·무료 수신거부 문구를 서버에서도 다시 검증합니다.'
                : '정보성 안내 전용입니다. 광고성 내용은 홍보성으로 전환해 발송하세요.'}
            </div>
          </div>
        </div>
      </div>
    </section>
    <ManualOptOutCard />
    </>
  );
}

function ManualOptOutCard() {
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
    catch (e) { setMsg('목록 조회 실패: ' + (e?.message || e)); }
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
    } catch (e) {
      setMsg('등록 실패: ' + (e?.message || e));
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
      <div className="mc-card">
        <div className="mc-section-title">🚫 수신거부 번호 등록 <span className="mc-tag">솔라피 연동</span></div>
        <div className="mc-optout-row">
          <input type="tel" aria-label="수신거부 휴대폰 번호" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-1234-5678" />
          <input type="date" aria-label="수신거부 요청일" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
          <input aria-label="수신거부 메모" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="메모 (선택)" maxLength={250} />
          <button className="mc-send" disabled={busy || !requestedDate} onClick={onRegister}>{busy ? '등록 중…' : '솔라피에 등록'}</button>
        </div>
        <p className="mc-field-label" style={{ marginTop: 7 }}>등록된 번호는 솔라피에서 문자·카카오 등 모든 발송 채널이 차단됩니다.</p>
        {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 7 }}>{msg}</p>}
        <details className="mc-optout-details" open>
          <summary>
            DSC·솔라피 수신거부 목록 {(registry?.items ?? []).length}건
            <span>일치 {registry?.matchedCount ?? 0} · 솔라피만 {registry?.solapiOnlyCount ?? 0} · DSC만 {registry?.localOnlyCount ?? 0}</span>
          </summary>
          <div className="mc-optout-actions">
            <button type="button" className="mc-var-btn" disabled={listBusy} onClick={loadRegistry}>{listBusy ? '조회 중…' : '솔라피와 다시 대조'}</button>
            <button type="button" className="mc-var-btn" disabled={listBusy || !(registry?.items ?? []).length} onClick={downloadCsv}>CSV 다운로드</button>
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
      </div>
    </section>
  );
}

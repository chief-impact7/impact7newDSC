import React, { useState, useRef, useEffect } from 'react';
import { sendDirectMessage } from '../../../data-layer.js';
import { messageMeta, normalizePhones } from '../message-format.js';
import { parsePhonesFromFile, sampleCsv } from '../message-import.js';
import { getMessageExtras, saveMessageExtras, composeWithExtras, DEFAULT_CHANNEL_INVITE } from '../sms-extras.js';
import TemplateBar from './TemplateBar.jsx';

function newReqId() {
  // 입력 1회분 멱등키. 발송 성공 또는 내용 변경 시 리셋. randomUUID는 secure context 전용이라 LAN http dev용 fallback 유지.
  return 'direct-' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + '-' + performance.now().toString(36));
}

// 클라이언트 1차 방어 상한 — 최종 검증은 서버 callable. F-02
const MAX_RECIPIENTS = 500;

export default function DirectSmsCard() {
  const [recipients, setRecipients] = useState('');
  const [text, setText] = useState('');
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
      setMsg('문구를 저장했습니다 — 전 직원·자동 전환 문자에 적용됩니다.');
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
  const effectiveText = composeWithExtras(text, [withInvite ? invite : '', withFooter ? footer : '']);

  async function onSend() {
    if (sending) return;
    if (!effectiveText.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (!recipients.trim()) { setMsg('수신번호를 입력하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    const phoneCount = new Set(normalizePhones(recipients)).size;
    if (phoneCount > MAX_RECIPIENTS) { setMsg(`한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다 (현재 ${phoneCount}명). 대상을 나눠 보내세요.`); return; }
    setSending(true); setMsg('');
    try {
      const payload = { recipients, text: effectiveText, requestId: reqIdRef.current };
      if (when === 'schedule') payload.scheduledAt = scheduledAt.slice(0, 16).replace('T', ' ') + ':00';
      const res = await sendDirectMessage(payload);
      if (res.duplicate) {
        setMsg('이미 발송된 요청입니다.');
      } else {
        setMsg(`${res.queued}건 발송 접수${res.invalid?.length ? ` · 무효 번호 ${res.invalid.length}건 제외` : ''}`);
        setRecipients(''); setText(''); resetReqId();
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
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">📱 휴대폰 문자 전송 <span className="mc-tag">정보성 전용</span></div>
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
            {attachedLines.length > 0 && (
              <div style={{ marginTop: 5, border: '1px dashed #cfd8d2', borderRadius: 8, padding: '6px 9px', background: '#fafcfb', fontSize: 12, color: '#5f6b76', whiteSpace: 'pre-wrap' }}>
                {attachedLines.join('\n\n')}
              </div>
            )}
            {setupOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, border: '1px solid #e3e8e5', borderRadius: 8, padding: '8px 10px', background: '#fafaf7' }}>
                <label className="mc-field-label" style={{ margin: 0 }}>채널 가입 안내 문구 — 자동 전환 문자에도 적용 (비우면 기본 문구)</label>
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
            <div className="mc-note" style={{ marginTop: 10 }}>정보성 안내 전용입니다. 광고성 내용은 보낼 수 없습니다(미동의 번호 광고 = 위법).</div>
          </div>
        </div>
      </div>
    </section>
  );
}

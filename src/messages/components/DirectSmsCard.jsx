import React, { useState, useRef } from 'react';
import { sendDirectMessage } from '../../../data-layer.js';

function newReqId() {
  // 입력 1회분 멱등키. 발송 성공 또는 내용 변경 시 리셋.
  return 'direct-' + Math.random().toString(36).slice(2) + '-' + performance.now().toString(36);
}

export default function DirectSmsCard() {
  const [recipients, setRecipients] = useState('');
  const [text, setText] = useState('');
  const [when, setWhen] = useState('now'); // 'now' | 'schedule'
  const [scheduledAt, setScheduledAt] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const reqIdRef = useRef(newReqId());

  function resetReqId() { reqIdRef.current = newReqId(); }

  async function onSend() {
    if (sending) return;
    if (!text.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (!recipients.trim()) { setMsg('수신번호를 입력하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    setSending(true); setMsg('');
    try {
      const payload = { recipients, text, requestId: reqIdRef.current };
      if (when === 'schedule') payload.scheduledAt = scheduledAt.replace('T', ' ') + ':00';
      const res = await sendDirectMessage(payload);
      if (res.duplicate) setMsg('이미 발송된 요청입니다.');
      else setMsg(`${res.queued}건 발송 접수${res.invalid?.length ? ` · 무효 번호 ${res.invalid.length}건 제외` : ''}`);
      setRecipients(''); setText(''); resetReqId();
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="mc-section">
      <div className="mc-section-title">✍️ 임의 번호 즉석 SMS <span className="mc-tag">정보성 전용</span></div>
      <div className="dash-card">
        <div className="mc-direct">
          <div>
            <p className="mc-field-label">수신번호 (줄바꿈/쉼표로 여러 명)</p>
            <textarea className="mc-textarea" value={recipients}
              onChange={(e) => { setRecipients(e.target.value); resetReqId(); }}
              placeholder={'010-1234-5678\n010-9876-5432'} />
            <p className="mc-field-label" style={{ marginTop: 6 }}>학생 DB에 없는 번호도 가능 · 발신 02-2649-0509</p>
          </div>
          <div>
            <p className="mc-field-label">내용</p>
            <textarea className="mc-textarea" value={text}
              onChange={(e) => { setText(e.target.value); resetReqId(); }}
              placeholder="안내 내용을 입력하세요." />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <div className="mc-seg">
                <button className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>즉시</button>
                <button className={when === 'schedule' ? 'on' : ''} onClick={() => setWhen('schedule')}>예약</button>
              </div>
              {when === 'schedule' && (
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              )}
              <button className="mc-send" style={{ marginLeft: 'auto' }} disabled={sending} onClick={onSend}>
                {sending ? '발송 중…' : '발송'}
              </button>
            </div>
            {msg && <p className="mc-field-label" style={{ marginTop: 8 }}>{msg}</p>}
            <div className="mc-note" style={{ marginTop: 10 }}>정보성 안내 전용입니다. 광고성 내용은 보낼 수 없습니다(미동의 번호 광고 = 위법).</div>
          </div>
        </div>
      </div>
    </section>
  );
}

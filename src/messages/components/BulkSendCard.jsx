import React, { useState, useMemo, useRef } from 'react';
import { filterStudents } from '../bulk-select.js';
import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';
import { allClassCodes } from '../../shared/firestore-helpers.js';
import GradeFilter from '../../dashboard/components/GradeFilter.jsx';
import { messageMeta } from '../message-format.js';
import TemplateBar from './TemplateBar.jsx';
import { createBulkMessage, createPromoCampaign } from '../../../data-layer.js';
// 광고 규제 표기(정보통신망법 §50)는 공용 모듈 — 발송 시 자동 보정, 버튼은 미리보기 확인용.
import { OPT_OUT_LINE, ensurePromoCompliance } from '../../../promo-compliance.js';

function newReqId() { return 'bulk-' + Math.random().toString(36).slice(2) + '-' + performance.now().toString(36); }

// 대량 발송 blast radius 제한. 서버가 최종 검증하지만 클라 1차 방어로 오발송 규모를 줄인다. F-02
const BULK_CONFIRM_THRESHOLD = 30; // 이 인원 이상이면 발송 전 확인 단계를 요구
const BULK_MAX_RECIPIENTS = 500; // 클라이언트 상한 — 초과 시 발송 자체를 차단

const RECIPIENT_LABELS = { student: '학생', parent_1: '학부모1', parent_2: '학부모2' };
const STATUS_LABELS = { enrolled: '재원', non: '비원생' };

// 학생의 현재 반코드(첫 수강). enrollmentCode는 enrollment 객체를 받으므로 학생엔 allClassCodes를 쓴다.
function classOf(s) { return allClassCodes(s)[0] || ''; }

const VARS = ['%이름', '%학교', '%학년', '%반'];
// 미리보기용 변수 치환. 실제 발송 시엔 서버가 학생별로 동일 규칙으로 치환한다.
function applyVars(text, s) {
  if (!s) return text;
  return String(text)
    .replaceAll('%이름', s.name || '')
    .replaceAll('%학교', currentSchool(s) || '')
    .replaceAll('%학년', s.grade != null ? String(s.grade) : '')
    .replaceAll('%반', classOf(s));
}

export default function BulkSendCard({ students = [] }) {
  const [branch, setBranch] = useState('');
  const [grades, setGrades] = useState(new Set());
  const [status, setStatus] = useState('enrolled'); // 기본 재원
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map()); // id -> { student, on }
  const [sources, setSources] = useState([]);
  const [recipientFields, setRecipientFields] = useState(() => new Set(['parent_1'])); // 다중 선택
  const [kind, setKind] = useState('info'); // 'info'(정보성) | 'promo'(홍보성)
  const [content, setContent] = useState('');
  const [when, setWhen] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const reqIdRef = useRef(newReqId());
  const resetReqId = () => { reqIdRef.current = newReqId(); setConfirming(false); };

  const matches = useMemo(
    () => filterStudents(students, { branch, grades, status, q }),
    [students, branch, grades, status, q],
  );
  const rows = useMemo(() => [...picked.values()], [picked]);
  const checkedCount = useMemo(() => rows.reduce((n, v) => n + (v.on ? 1 : 0), 0), [rows]);

  function commitSearch() {
    const found = filterStudents(students, { branch, grades, status, q });
    if (!found.length) { setMsg(q.trim() ? `"${q.trim()}" 결과 없음` : '추가할 대상이 없습니다.'); return; }
    setPicked((prev) => {
      const next = new Map(prev);
      for (const s of found) if (!next.has(s.id)) next.set(s.id, { student: s, on: true });
      return next;
    });
    const label = q.trim()
      || [branch, [...grades].join('·'), STATUS_LABELS[status]].filter(Boolean).join(' ')
      || '전체';
    setSources((prev) => (prev.includes(label) ? prev : [...prev, label]));
    setQ(''); setMsg(''); resetReqId();
  }
  function toggle(id) {
    setPicked((prev) => { const n = new Map(prev); const e = n.get(id); if (e) n.set(id, { ...e, on: !e.on }); return n; });
    resetReqId();
  }
  function setAllOn(on) {
    setPicked((prev) => { const n = new Map(); for (const [k, v] of prev) n.set(k, { ...v, on }); return n; });
    resetReqId();
  }
  function clearAll() { setPicked(new Map()); setSources([]); resetReqId(); }
  function toggleRecipient(f) {
    // 홍보(promo)는 서버가 단일 수신 필드만 처리하므로 단일 선택만 허용(미리보기=실제 보장).
    if (kind === 'promo') { setRecipientFields(new Set([f])); resetReqId(); return; }
    setRecipientFields((prev) => {
      const n = new Set(prev);
      if (n.has(f)) { if (n.size > 1) n.delete(f); } else n.add(f);
      return n;
    });
    resetReqId();
  }
  function selectKind(k) {
    setKind(k);
    // 홍보로 전환 시 받는이를 단일로 축소(서버 promo는 단일 필드만 처리).
    if (k === 'promo') setRecipientFields((prev) => new Set([[...prev][0] || 'parent_1']));
    resetReqId();
  }

  function onSendClick() {
    if (sending) return;
    const ids = rows.filter((v) => v.on).map((v) => v.student.id);
    if (!ids.length) { setMsg('대상이 없습니다. 검색으로 추가하세요.'); return; }
    if (!content.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    if (ids.length > BULK_MAX_RECIPIENTS) {
      setMsg(`한 번에 최대 ${BULK_MAX_RECIPIENTS}명까지 발송할 수 있습니다 (현재 ${ids.length}명). 대상을 나눠 보내세요.`);
      return;
    }
    if (ids.length >= BULK_CONFIRM_THRESHOLD && !confirming) { setConfirming(true); setMsg(''); return; }
    doSend(ids);
  }

  async function doSend(ids) {
    setConfirming(false);
    setSending(true); setMsg('');
    try {
      const fields = [...recipientFields];
      // 홍보는 (광고)·080 표기를 발송 직전 자동 보정 — 깜빡해도 법적 표기가 빠지지 않는다.
      const body = kind === 'promo' ? ensurePromoCompliance(content) : content;
      const payload = { title: '카카오 발송', content: body, studentIds: ids, recipientFields: fields, recipientField: fields[0], requestId: reqIdRef.current };
      if (when === 'schedule') payload.scheduledAt = scheduledAt.slice(0, 16).replace('T', ' ') + ':00';
      let res;
      if (kind === 'promo') { payload.targeting = 'M'; res = await createPromoCampaign(payload); }
      else { res = await createBulkMessage(payload); }
      if (res.duplicate) setMsg('이미 발송된 요청입니다.');
      else {
        const s = res.stats || {};
        const parts = [];
        if (s.friend_bms != null || s.ad_sms != null) { // 홍보 분기 결과
          parts.push(`카카오 ${s.friend_bms || 0}`, `문자광고 ${s.ad_sms || 0}`);
          if (s.skipped_no_consent) parts.push(`미동의 제외 ${s.skipped_no_consent}`);
        } else {
          parts.push(`${s.queued ?? ids.length}건`);
          if (s.deduped) parts.push(`중복번호 ${s.deduped} 합침`);
        }
        if (s.skipped_no_phone) parts.push(`번호없음 ${s.skipped_no_phone}`);
        if (s.skipped_revoked) parts.push(`수신거부 ${s.skipped_revoked}`);
        setMsg('발송 접수 — ' + parts.join(' · '));
        clearAll(); setContent(''); resetReqId();
      }
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally { setSending(false); }
  }

  const meta = messageMeta(content);
  const firstStudent = rows.find((v) => v.on)?.student;
  const recipientText = [...recipientFields].map((f) => RECIPIENT_LABELS[f]).join('·');

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">💬 카카오 발송 <span className="mc-tag" style={{ background: '#0a6e49' }}>목록·검색·누적</span></div>
        <div className="bulk-split">
          <div className="bulk-left">
            <p className="bulk-col-title">받는 사람</p>
            <div className="bulk-filters">
              <select aria-label="소속" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">소속 전체</option><option value="2단지">2단지</option><option value="10단지">10단지</option>
              </select>
              <select aria-label="수신 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="enrolled">재원</option><option value="all">재원+비원생</option><option value="non">비원생</option>
              </select>
              <GradeFilter value={grades} onChange={setGrades} />
            </div>
            <div className="mc-search">
              <input
                aria-label="대상 검색"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); commitSearch(); }
                }}
                placeholder="이름·학교·반 검색 후 엔터 (예: 노현담, 영도초6, PA101)"
              />
              <button onClick={commitSearch}>{q.trim() ? `결과 ${matches.length}명 담기` : '검색 결과 담기'}</button>
            </div>
            <div className="bulk-cart">
              <span>누적 대상 {checkedCount}명{sources.length ? ` (${sources.join(' + ')})` : ''}</span>
              <span className="bulk-cart-actions">
                <button onClick={() => setAllOn(true)} disabled={!picked.size}>전체선택</button>
                <button onClick={clearAll} disabled={!picked.size}>비우기</button>
              </span>
            </div>
            <ul className="bulk-list">
              {rows.map(({ student: s, on }) => (
                <li key={s.id} className={on ? '' : 'off'}>
                  <label className="bulk-row">
                    <input type="checkbox" checked={on} onChange={() => toggle(s.id)} />
                    <span className="bulk-name">{s.name}</span>
                    <span className="bulk-meta">{studentFullLabel(s)}{classOf(s) ? ` · ${classOf(s)}` : ''}</span>
                  </label>
                </li>
              ))}
              {picked.size === 0 && <li className="bulk-empty">검색해서 대상을 추가하세요.</li>}
            </ul>
          </div>

          <div className="bulk-mid">
            <p className="bulk-col-title">메시지</p>
            <p className="mc-field-label">받는이 {kind === 'promo' ? '(단일)' : '(다중 선택)'}</p>
            <div className="mc-seg">
              {['student', 'parent_1', 'parent_2'].map((f) => (
                <button key={f} type="button" className={recipientFields.has(f) ? 'on' : ''} aria-pressed={recipientFields.has(f)} onClick={() => toggleRecipient(f)}>
                  {RECIPIENT_LABELS[f]}
                </button>
              ))}
            </div>
            <p className="mc-field-label" style={{ marginTop: 8 }}>종류</p>
            <div className="mc-seg">
              <button type="button" className={kind === 'info' ? 'on' : ''} aria-pressed={kind === 'info'} onClick={() => selectKind('info')}>정보성</button>
              <button type="button" className={kind === 'promo' ? 'on' : ''} aria-pressed={kind === 'promo'} onClick={() => selectKind('promo')}>홍보성</button>
            </div>
            <div className="mc-content-head">
              <p className="mc-field-label" style={{ marginTop: 8 }}>내용</p>
              <div className="mc-vars">
                {VARS.map((v) => (
                  <button key={v} type="button" className="mc-var-btn" onClick={() => { setContent((c) => c + v); resetReqId(); }}>{v}</button>
                ))}
                {kind === 'promo' && (
                  <button type="button" className="mc-var-btn" title="발송 시 자동으로 붙지만, 미리보기로 확인하려면 클릭" onClick={() => { setContent((c) => ensurePromoCompliance(c)); resetReqId(); }}>+ (광고)·080</button>
                )}
              </div>
            </div>
            <TemplateBar content={content} onPick={(c) => { setContent(c); resetReqId(); }} />
            <textarea aria-label="메시지 내용" className="mc-textarea bulk-content" value={content} onChange={(e) => { setContent(e.target.value); resetReqId(); }}
              placeholder={kind === 'promo' ? `(광고) [임팩트세븐학원]\n\n...\n\n${OPT_OUT_LINE}` : '안내 내용을 입력하세요.'} />
            <div className="mc-meta">
              <span>{meta.chars}자 · {meta.bytes}byte</span>
              <span className={'mc-pill' + (meta.type === 'LMS' ? ' lms' : '')}>{meta.type}</span>
              <span>· {checkedCount}명 × {recipientFields.size}</span>
            </div>
            {kind === 'promo' && <div className="mc-note" style={{ marginTop: 8 }}>홍보성은 광고 수신동의자에게만 발송됩니다. 본문에 (광고)·무료수신거부를 포함하세요.</div>}
          </div>

          <div className="bulk-right">
            <p className="bulk-col-title">미리보기 &amp; 발송</p>
            <div className="mc-phone">
              <p className="mc-phone-sender">임팩트세븐학원 → {firstStudent ? `${firstStudent.name} ${recipientText}` : recipientText}</p>
              <div className={'mc-bubble' + (content ? '' : ' empty')}>
                {content ? applyVars(content, firstStudent) : '내용을 입력하면 여기에 표시됩니다.'}
              </div>
            </div>
            <p className="mc-preview-foot">{firstStudent ? `${firstStudent.name} 기준` : '대상 미선택'} · 실제는 각 대상에게 발송</p>
            <div className="bulk-summary">대상 {checkedCount}명 · 받는이 {recipientText} · {meta.type} · {kind === 'promo' ? '홍보성' : '정보성'}</div>
            <div className="bulk-send-row">
              <div className="mc-seg">
                <button type="button" className={when === 'now' ? 'on' : ''} aria-pressed={when === 'now'} onClick={() => setWhen('now')}>즉시</button>
                <button type="button" className={when === 'schedule' ? 'on' : ''} aria-pressed={when === 'schedule'} onClick={() => setWhen('schedule')}>예약</button>
              </div>
              {when === 'schedule' && <input aria-label="예약 발송 시각" type="datetime-local" value={scheduledAt} onChange={(e) => { setScheduledAt(e.target.value); resetReqId(); }} />}
            </div>
            {confirming && (
              <div className="mc-note" role="alertdialog" aria-label="발송 확인" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                <span>
                  {checkedCount}명 · 받는이 {recipientText} · {kind === 'promo' ? '홍보성' : '정보성'}
                  {when === 'schedule' && scheduledAt ? ` · 예약 ${scheduledAt.replace('T', ' ')}` : ' · 즉시 발송'}
                  — 맞으면 아래 버튼을 다시 눌러 발송하세요.
                </span>
                <button type="button" className="mc-var-btn" onClick={() => setConfirming(false)}>취소</button>
              </div>
            )}
            <button className="mc-send bulk-send-btn" disabled={sending} onClick={onSendClick}>
              {sending ? '발송 중…' : confirming ? `확인 후 ${checkedCount}명에게 발송` : `${checkedCount}명에게 발송`}
            </button>
            {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 8 }}>{msg}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

import React, { useState, useMemo, useRef } from 'react';
import { filterStudents } from '../bulk-select.js';
import GradeFilter from '../../dashboard/components/GradeFilter.jsx';
import { createBulkMessage, createPromoCampaign } from '../../../data-layer.js';

function newReqId() { return 'bulk-' + Math.random().toString(36).slice(2) + '-' + performance.now().toString(36); }
function newChipId() { return 'chip-' + Math.random().toString(36).slice(2) + '-' + performance.now().toString(36); }

export default function BulkSendCard({ students = [] }) {
  const [branch, setBranch] = useState('');
  const [grades, setGrades] = useState(new Set());
  const [status, setStatus] = useState('all'); // all|enrolled|non
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map()); // id -> {student, sources:Set} (누적, 출처 refcount)
  const [searchChips, setSearchChips] = useState([]); // {id, label, criteria} 누적 검색 이력
  const [recipientField, setRecipientField] = useState('parent_1');
  const [kind, setKind] = useState('info'); // 'info'(정보성) | 'promo'(광고)
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [when, setWhen] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const reqIdRef = useRef(newReqId());
  const resetReqId = () => { reqIdRef.current = newReqId(); };

  const matches = useMemo(
    () => filterStudents(students, { branch, grades, status, q }),
    [students, branch, grades, status, q],
  );

  // 현재 검색어(+필터)로 매칭된 학생을 누적에 추가하고, 검색어는 칩으로 쌓는다(제거형 아닌 추가형).
  // 각 학생은 자신을 추가한 출처(칩 id 또는 'manual') 집합을 들고, 칩 제거 시 그 출처만 빼 겹침을 보존한다.
  function commitSearch() {
    const token = q.trim();
    const criteria = { branch, grades: new Set(grades), status, q: token };
    const found = token ? filterStudents(students, criteria) : matches;
    if (!found.length) { setMsg(token ? `"${token}" 검색 결과 없음` : '추가할 대상이 없습니다.'); return; }
    const source = token ? newChipId() : 'manual';
    setPicked((prev) => {
      const next = new Map(prev);
      for (const s of found) {
        const cur = next.get(s.id);
        const sources = new Set(cur ? cur.sources : null);
        sources.add(source);
        next.set(s.id, { student: s, sources });
      }
      return next;
    });
    if (token) setSearchChips((prev) => [...prev, { id: source, label: token, criteria }]);
    setQ(''); setMsg(''); resetReqId();
  }
  function removeChip(id) {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const [sid, entry] of next) {
        if (!entry.sources.has(id)) continue;
        if (entry.sources.size === 1) next.delete(sid);
        else { const sources = new Set(entry.sources); sources.delete(id); next.set(sid, { ...entry, sources }); }
      }
      return next;
    });
    setSearchChips((prev) => prev.filter((c) => c.id !== id));
    resetReqId();
  }
  function clearPicked() { setPicked(new Map()); setSearchChips([]); resetReqId(); }
  function removeOne(id) { setPicked((prev) => { const n = new Map(prev); n.delete(id); return n; }); resetReqId(); }

  async function onSend() {
    if (sending) return;
    const ids = [...picked.keys()];
    if (!ids.length) { setMsg('대상이 없습니다. 필터/검색으로 추가하세요.'); return; }
    if (!content.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    setSending(true); setMsg('');
    try {
      const payload = { title: title.trim() || '대용량 발송', content, studentIds: ids, recipientField, requestId: reqIdRef.current };
      if (when === 'schedule') payload.scheduledAt = scheduledAt.slice(0, 16).replace('T', ' ') + ':00';
      let res;
      if (kind === 'promo') { payload.targeting = 'M'; res = await createPromoCampaign(payload); }
      else { res = await createBulkMessage(payload); }
      if (res.duplicate) setMsg('이미 발송된 요청입니다.');
      else {
        const s = res.stats || {};
        setMsg(`발송 접수 ${s.queued ?? ids.length}명${s.skipped_no_phone ? ` · 번호없음 ${s.skipped_no_phone}` : ''}${s.skipped_revoked ? ` · 수신거부 ${s.skipped_revoked}` : ''}`);
        clearPicked(); setContent(''); resetReqId();
      }
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally { setSending(false); }
  }

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">📣 대용량 발송 <span className="mc-tag" style={{ background: '#0a6e49' }}>필터·검색·누적</span></div>
        <div className="bulk-split">
          <div className="bulk-left">
            <div className="bulk-filters">
              <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">소속 전체</option><option value="2단지">2단지</option><option value="10단지">10단지</option>
              </select>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">재원+비원생</option><option value="enrolled">재원</option><option value="non">비원생</option>
              </select>
              <GradeFilter value={grades} onChange={setGrades} />
            </div>
            <div className="mc-search">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === 'Tab') && q.trim()) { e.preventDefault(); commitSearch(); }
                }}
                placeholder="이름·학교·반 검색 후 엔터(예: 노동현, 월촌중1, pa101)"
              />
              <button onClick={commitSearch}>검색 결과 {matches.length}명 추가</button>
            </div>
            {searchChips.length > 0 && (
              <div className="bulk-chips">
                {searchChips.map((c) => (
                  <span key={c.id} className="bulk-chip">{c.label}<button onClick={() => removeChip(c.id)}>×</button></span>
                ))}
              </div>
            )}
            <div className="bulk-cart">
              <span>누적 대상 {picked.size}명</span>
              <button className="bulk-clear" onClick={clearPicked}>비우기</button>
            </div>
            <ul className="bulk-picked">
              {[...picked.values()].slice(0, 50).map(({ student: s }) => (
                <li key={s.id}><span>{s.name}</span><button onClick={() => removeOne(s.id)}>×</button></li>
              ))}
              {picked.size > 50 && <li className="bulk-more">… 외 {picked.size - 50}명</li>}
            </ul>
          </div>
          <div className="bulk-right">
            <p className="mc-field-label">수신 대상</p>
            <div className="mc-seg">
              {['student', 'parent_1', 'parent_2'].map((f) => (
                <button key={f} className={recipientField === f ? 'on' : ''} onClick={() => { setRecipientField(f); resetReqId(); }}>
                  {f === 'student' ? '학생' : f === 'parent_1' ? '학부모1' : '학부모2'}
                </button>
              ))}
            </div>
            <p className="mc-field-label" style={{ marginTop: 8 }}>종류</p>
            <div className="mc-seg">
              <button className={kind === 'info' ? 'on' : ''} onClick={() => { setKind('info'); resetReqId(); }}>정보성</button>
              <button className={kind === 'promo' ? 'on' : ''} onClick={() => { setKind('promo'); resetReqId(); }}>광고</button>
            </div>
            <p className="mc-field-label" style={{ marginTop: 8 }}>내용</p>
            <textarea className="mc-textarea" value={content} onChange={(e) => { setContent(e.target.value); resetReqId(); }}
              placeholder={kind === 'promo' ? '(광고) [임팩트세븐학원]\n\n...\n\n무료수신거부 080-...' : '안내 내용을 입력하세요.'} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <div className="mc-seg">
                <button className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>즉시</button>
                <button className={when === 'schedule' ? 'on' : ''} onClick={() => setWhen('schedule')}>예약</button>
              </div>
              {when === 'schedule' && <input type="datetime-local" value={scheduledAt} onChange={(e) => { setScheduledAt(e.target.value); resetReqId(); }} />}
              <button className="mc-send" style={{ marginLeft: 'auto' }} disabled={sending} onClick={onSend}>
                {sending ? '발송 중…' : `${picked.size}명에게 발송`}
              </button>
            </div>
            {kind === 'promo' && <div className="mc-note" style={{ marginTop: 8 }}>광고는 동의자에게만 SMS 대체됩니다. 본문에 (광고)·무료수신거부를 포함하세요.</div>}
            {msg && <p className="mc-field-label" style={{ marginTop: 8 }}>{msg}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

import React, { useMemo, useState } from 'react';
import { studentFullLabel } from '@impact7/shared/student-label';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import { filterStudents } from '../bulk-select.js';
import { getRecipientMessageHistory } from '../../../data-layer.js';
import { onlyDigits } from '../message-format.js';

// 수신자별 발송 이력 타임라인. 카카오 관리자센터는 API 발송(알림톡/BMS) 원문을 보여주지 않으므로
// 학부모 답장이 왔을 때 "무엇을 보냈는지"를 여기서 확인한다.
// 학생 검색은 영구(student_id), 전화번호 검색은 평문 번호가 남아있는 최근(purge 전) 발송만 매칭.

const KIND_LABEL = {
  attendance: '출결', parent_notice: '안내', report: '안내', parent_bms: '안내',
  promo: '홍보', promo_sms: '홍보 문자', direct: '문자', bulk_info: '단체 안내', staff: '직원',
};
const STATUS_META = {
  pending: { label: '대기', cls: 'pending' },
  processing: { label: '처리중', cls: 'pending' },
  awaiting_delivery_result: { label: '결과 확인중', cls: 'pending' },
  sent: { label: '발송완료', cls: 'sent' },
  failed_retryable: { label: '재시도 대기', cls: 'retry' },
  failed_permanent: { label: '실패', cls: 'failed' },
  converted_to_sms: { label: '문자 전환', cls: 'converted' },
  archived: { label: '보관됨', cls: 'archived' },
};

export default function RecipientHistoryCard({ students = [] }) {
  const [q, setQ] = useState('');
  const [target, setTarget] = useState(null); // { label } — 조회 대상 표시용
  const [items, setItems] = useState(null);   // null=미조회
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const candidates = useMemo(() => {
    if (!q.trim()) return [];
    return filterStudents(students, { q }).slice(0, 8);
  }, [students, q]);
  const phoneDigits = onlyDigits(q);
  const phoneSearchable = phoneDigits.length >= 9 && phoneDigits.length <= 11;

  async function load(payload, label) {
    setLoading(true); setMsg(''); setTarget({ label });
    try {
      const res = await getRecipientMessageHistory(payload);
      setItems(res.items || []);
    } catch (e) {
      setItems(null);
      setMsg('조회 실패: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  const searchStudent = (s) => { setQ(''); load({ studentId: s.id }, `${s.name} (${studentFullLabel(s)})`); };
  const searchPhone = () => { setQ(''); load({ phone: phoneDigits }, `번호 ${phoneDigits}`); };

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">🕘 수신자별 발송 이력</div>
        <p className="mc-field-label">
          이 학부모/번호에게 우리가 보낸 알림톡·문자 원문을 시간순으로 확인합니다.
          (카카오 관리자센터에는 API 발송 원문이 표시되지 않음)
        </p>
        <div className="mc-search rh-search">
          <input
            aria-label="학생 이름 또는 전화번호 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (candidates.length === 1) searchStudent(candidates[0]);
              else if (!candidates.length && phoneSearchable) searchPhone();
            }}
            placeholder="학생 이름·학교·반 또는 전화번호"
          />
        </div>
        {(candidates.length > 0 || phoneSearchable) && (
          <ul className="rh-candidates">
            {candidates.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => searchStudent(s)}>
                  {s.name} <span className="rh-cand-meta">{studentFullLabel(s)}</span>
                </button>
              </li>
            ))}
            {phoneSearchable && (
              <li>
                <button type="button" onClick={searchPhone}>
                  번호로 조회 <span className="rh-cand-meta">{phoneDigits}</span>
                </button>
              </li>
            )}
          </ul>
        )}

        {msg && <p className="mc-field-label" role="status" aria-live="polite">{msg}</p>}
        {loading && <div className="dash-empty">불러오는 중…</div>}

        {!loading && items && (
          <div className="rh-result">
            <div className="rh-target">
              {target?.label} — {items.length ? `최근 ${items.length}건` : '발송 이력 없음'}
              <span className="rh-note">
                {' '}(전화번호 검색·알림톡 본문은 개인정보 보존기간 7일 내 발송만)
              </span>
            </div>
            <ul className="rh-timeline">
              {items.map((it) => {
                const st = STATUS_META[it.status] || { label: it.status || '-', cls: 'pending' };
                return (
                  <li key={it.id} className="rh-item">
                    <div className="rh-item-head">
                      <span className="rh-time">{it.createdAt ? formatDateTimeKST(it.createdAt) : '-'}</span>
                      <span className="rh-kind">{KIND_LABEL[it.kind] || it.kind || '-'}</span>
                      <span className={`msg-badge msg-${st.cls}`}>{st.label}</span>
                      <span className="rh-cand-meta">{it.recipientMasked || ''}</span>
                      {it.lastErrorCode && <span className="rh-err">오류 {it.lastErrorCode}</span>}
                    </div>
                    <div className="rh-content">
                      {it.content || (it.piiPurged ? '(보존기간 경과로 본문이 삭제되었습니다)' : '(본문 없음)')}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

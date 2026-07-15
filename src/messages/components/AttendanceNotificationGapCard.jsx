import React, { useEffect, useState } from 'react';
import { Icon } from '@impact7/ui';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import { getAttendanceNotificationGaps } from '../../../data-layer.js';
import { downloadCsv } from '../../shared/csv.js';
import { ICON_NAME } from '../../dashboard/icon-map.js';

const STATUS_LABEL = { not_queued: '미작성', retry_failed: '재시도 실패', retrying: '재시도 중', pending: '발송 미확정' };

export default function AttendanceNotificationGapCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try { setData(await getAttendanceNotificationGaps()); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const items = data?.items ?? [];
  function downloadList() {
    downloadCsv(
      `학부모알림_미작성_${data.dateKST}.csv`,
      ['날짜', '학생명', '반명', '담당선생님', '등원여부', '발송상태'],
      items.map((item) => [
        data.dateKST,
        item.student_name,
        item.class_name || '',
        item.teacher_name || '',
        item.attendance_status,
        STATUS_LABEL[item.notification_status] || item.notification_status,
      ]),
    );
  }
  let content;
  if (error) {
    content = <div className="mc-note">조회 실패: {error}</div>;
  } else if (!data?.generated) {
    content = <div className="mc-note">{data?.dateKST || '전날'} 명단은 오늘 오후 3:00에 생성됩니다.</div>;
  } else if (items.length === 0) {
    content = <div className="mc-gap-empty">{data.dateKST} 학부모 알림 작성 미발송 없음 · 정규·자유학기 등원 {data.attendedCount}명</div>;
  } else {
    content = (
      <details className="mc-gap-details">
        <summary>{data.dateKST} 미발송 {data.missingCount}명 · 정규·자유학기 등원 {data.attendedCount}명 <span>{formatDateTimeKST(data.generatedAt)} 생성</span></summary>
        <ul className="mc-gap-list">
          {items.map((item) => (
            <li key={item.student_id}>
              <strong>{item.student_name}</strong>
              <span>{item.class_name || '-'}{item.teacher_name ? ` · ${item.teacher_name}` : ''}</span>
              <span>{item.attendance_status}</span>
              <span className={`mc-gap-status ${item.notification_status}`}>{STATUS_LABEL[item.notification_status] || item.notification_status}</span>
            </li>
          ))}
        </ul>
      </details>
    );
  }

  return (
    <section className="mc-section">
      <div className="mc-card">
        <div className="mc-section-title">
          <Icon name={ICON_NAME.notification_missing} size={20} aria-hidden="true" /> 전날 학부모 알림 작성 미발송
          <span className="mc-tag">매일 오후 3:00 생성</span>
          <button type="button" className="mc-var-btn mc-title-action" disabled={!items.length} onClick={downloadList}>
            <Icon name={ICON_NAME.download} size={14} aria-hidden="true" /> 명단 다운로드
          </button>
          <button type="button" className="mc-var-btn" disabled={loading} onClick={load}>{loading ? '불러오는 중…' : '새로고침'}</button>
        </div>
        {content}
      </div>
    </section>
  );
}

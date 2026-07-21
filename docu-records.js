// 기록 탭 순수 로직 — Firestore/Storage I/O 없음 (테스트 격리용).

const TYPES = ['reflection', 'etc'];

// occurred_at 내림차순. 같으면 안정 정렬 유지.
function sortDesc(records) {
  return [...records].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
}

export function splitRecordsByType(records) {
  const list = Array.isArray(records) ? records : [];
  return {
    reflections: sortDesc(list.filter(r => r.type === 'reflection')),
    etc: sortDesc(list.filter(r => r.type === 'etc')),
  };
}

export function toFileMeta(file, path) {
  return { path, name: file.name, size: file.size, contentType: file.type };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// created_at(Firestore Timestamp/Date/숫자/ISO) 또는 occurred_at('YYYY-MM-DD')을 ms로 정규화.
function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// 기록 하나가 nowMs 기준 windowDays(기본 14일) 이내인지. created_at·occurred_at 중 더 최근 값으로 판정.
export function isRecentRecord(rec, nowMs, windowDays = 14) {
  if (!rec) return false;
  const cutoff = nowMs - windowDays * DAY_MS;
  const candidates = [toMillis(rec.created_at), toMillis(rec.occurred_at)].filter(t => t != null);
  // 미래 날짜(예: 예약된 시험일·상담일)는 '최근'으로 보지 않는다 — 뱃지 오탐 방지
  return candidates.some(t => t >= cutoff && t <= nowMs);
}

// 최근(2주 이내) 기록이 하나라도 있으면 true — 기록 탭 뱃지용.
export function hasRecentRecord(records, nowMs, windowDays = 14) {
  const list = Array.isArray(records) ? records : [];
  return list.some(r => isRecentRecord(r, nowMs, windowDays));
}

function compareRecordRecency(a, b) {
  const occurred = String(a?.occurred_at || '').localeCompare(String(b?.occurred_at || ''));
  if (occurred) return occurred;
  return (toMillis(a?.created_at) || 0) - (toMillis(b?.created_at) || 0);
}

export function importantRecordsByStudent(records) {
  const result = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.important !== true || !record.student_id) continue;
    const current = result.get(record.student_id);
    if (!current || compareRecordRecency(current, record) < 0) result.set(record.student_id, record);
  }
  return result;
}

export function importantRecordTooltip(record, maxLength = 160) {
  if (!record) return '';
  const type = record.type === 'reflection' ? '반성문' : '기타 기록';
  const date = record.occurred_at ? ` · ${record.occurred_at}` : '';
  const content = String(record.content || '').replace(/\s+/g, ' ').trim() || '내용 없음';
  const summary = content.length > maxLength ? `${content.slice(0, maxLength)}…` : content;
  return `중요 메모 (${type}${date})\n${summary}`;
}

export function latestImportantMemo(memos) {
  const list = Array.isArray(memos) ? memos : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.important === true) return list[i];
  }
  return null;
}

export function visibleStudentMemos(memos, selectedDate) {
  const list = Array.isArray(memos) ? memos : [];
  return list.flatMap((memo, index) => {
    if (!memo || typeof memo !== 'object') return [];
    if (memo.pinned || memo.important) return [{ ...memo, _idx: index, _source: 'persistent' }];
    if (memo.date === selectedDate) return [{ ...memo, _idx: index, _source: 'today' }];
    return [];
  });
}

export function importantMemoTooltip(memo, maxLength = 160) {
  if (!memo) return '';
  const date = memo.date || memo.created_at;
  const content = String(memo.text || '').replace(/\s+/g, ' ').trim() || '내용 없음';
  const summary = content.length > maxLength ? `${content.slice(0, maxLength)}…` : content;
  return `중요 메모${date ? ` · ${date}` : ''}\n${summary}`;
}

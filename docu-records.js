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

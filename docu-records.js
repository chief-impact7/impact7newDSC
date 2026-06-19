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

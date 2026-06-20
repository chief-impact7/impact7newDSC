// 자주 쓰는 문구를 브라우저 localStorage에 저장/불러오기. 서버 없이 직원 개인 단말 기준.
const KEY = 'dsc-message-templates';

export function loadTemplates() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 용량 초과(QuotaExceededError)·프라이빗 모드 등에서 throw하므로 호출부가 깨지지 않게 격리.
function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// 같은 제목이면 덮어쓴다. 반환은 갱신된 목록.
export function saveTemplate(title, content) {
  const name = String(title ?? '').trim();
  if (!name || !String(content ?? '').trim()) return loadTemplates();
  const list = loadTemplates().filter((t) => t.title !== name);
  list.unshift({ title: name, content });
  save(list);
  return list;
}

export function deleteTemplate(title) {
  const list = loadTemplates().filter((t) => t.title !== title);
  save(list);
  return list;
}
